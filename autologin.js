'use strict';
/**
 * 校园网自动认证登录
 *
 * 思路：不逆向门户的加密流程，而是用 CDP 驱动一个真实（无头）浏览器，
 * 让门户自己的 JS 走完 NAS → 门户 → CAS 单点登录的整条链路，
 * 脚本只负责「把账号密码填进登录框并点登录」。
 *
 * 用法：
 *   node autologin.js                 # 已联网则直接退出；否则自动登录
 *   node autologin.js --force         # 强制走一遍登录
 *   node autologin.js --dry-run       # 只打开页面并填表，不点登录（验证用）
 *   node autologin.js --entry=<url>   # 手动指定认证入口 URL
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { launch, openPage, evaluate, evalJson, sleep } = require('./cdp');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(ROOT, 'state.json');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const ENTRY_OVERRIDE = (process.argv.find((a) => a.startsWith('--entry=')) || '').slice(8);

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `autologin-${new Date().toISOString().slice(0, 10)}.log`);

function log(...args) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + os.EOL);
  } catch {}
}

// 常驻模式下，网络抖动（ECONNRESET 之类）不该让监听整体挂掉；
// 一次性执行时则视为致命错误，退出码 1 让计划任务知道失败了。
process.on('uncaughtException', (e) => {
  log('未捕获异常:', (e && e.stack) || String(e));
  if (WATCH) {
    log('（常驻模式：忽略该异常，继续监听）');
    return;
  }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('未处理的 Promise 拒绝:', (e && e.stack) || String(e));
  if (WATCH) return;
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/* 网络状态                                                             */
/* ------------------------------------------------------------------ */

// 204 探测点：被门户劫持时会返回 302/200，只有真正通网才是 204
const PROBE_204 = ['http://connect.rom.miui.com/generate_204', 'http://www.gstatic.com/generate_204'];
const PROBE_TXT = 'http://www.msftconnecttest.com/connecttest.txt';
// 用来诱发网关重定向的探针（任何一个都行，多几个覆盖 DNS 异常的情况）
const PROBE_REDIRECT = 'http://www.msftconnecttest.com/redirect';
const REDIRECT_PROBES = [
  PROBE_REDIRECT,
  ...PROBE_204,
  'http://www.baidu.com/',
  'http://223.5.5.5/',
];

async function httpGet(url, { timeout = 6000, redirect = 'manual' } = {}) {
  const res = await fetch(url, {
    redirect,
    signal: AbortSignal.timeout(timeout),
    headers: { 'Cache-Control': 'no-cache' },
  });
  const text = res.status === 200 ? await res.text().catch(() => '') : '';
  return { status: res.status, location: res.headers.get('location') || '', text, url: res.url };
}

async function isOnline(quick = false) {
  // 测试钩子：设了该环境变量就假装离线，用来验证掉线补认证逻辑
  if (process.env.AUTOLOGIN_TEST_OFFLINE === '1') return false;
  const probes = quick ? PROBE_204.slice(0, 1) : PROBE_204;
  for (const u of probes) {
    try {
      const r = await httpGet(u, { timeout: quick ? 4000 : 6000 });
      if (r.status === 204) return true;
    } catch {}
  }
  if (quick) return false;
  try {
    const r = await httpGet(PROBE_TXT);
    if (r.status === 200 && /Microsoft Connect Test/i.test(r.text)) return true;
  } catch {}
  return false;
}

/* ------------------------------------------------------------------ */
/* 本机网络参数                                                         */
/* ------------------------------------------------------------------ */

function isWifiName(name) {
  return /wlan|wi-?fi|wireless|无线/i.test(name);
}

function localNet() {
  const ifaces = os.networkInterfaces();
  const names = Object.keys(ifaces);
  const ordered = [...names.filter(isWifiName), ...names.filter((n) => !isWifiName(n))];
  for (const name of ordered) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // APIPA：还没拿到地址
      return { name, ip: a.address, mac: (a.mac || '').toLowerCase() };
    }
  }
  return null;
}

function macDashed(mac) {
  return (mac || '').replace(/:/g, '-');
}

async function waitForWifi(seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const n = localNet();
    if (n) return n;
    if (Date.now() > deadline) return null;
    await sleep(2000);
  }
}

/** 当前连接的 WiFi 名称（SSID） */
function currentSsid() {
  try {
    const out = require('node:child_process').execSync('netsh wlan show interfaces', {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    // 形如 "    SSID                   : ChinaTelecom-EDU5.8G"
    const lines = out.split(/\r?\n/);
    for (const l of lines) {
      const m = /^\s*SSID\s*:\s*(.+?)\s*$/.exec(l);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function ssidAllowed(ssid) {
  if (!cfg.onlyOnKnownSsid) return true;
  if (!ssid) return false;
  return (cfg.wifiSsidPatterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(ssid);
    } catch {
      return ssid.includes(p);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 取网关下发的认证入口 URL                                             */
/* ------------------------------------------------------------------ */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const s = { ...readState(), ...patch };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
  return s;
}

/**
 * 未认证时随便发一个明文 HTTP 请求，网关会 302 到门户，
 * Location 里带着 userip / nasip / wlanparameter 等参数 —— 这就是认证入口。
 */
async function getEntryUrl(net) {
  for (const probe of REDIRECT_PROBES) {
    try {
      const r = await httpGet(probe, { redirect: 'manual', timeout: 8000 });
      const loc = r.location;
      if (r.status >= 300 && r.status < 400) {
        log(`探针 ${probe} -> ${r.status} ${loc || '(无 Location)'}`);
      }
      if (loc && loc.includes(cfg.portalHost) && loc.includes('/eportal/')) {
        log('✅ 网关重定向入口:', loc);
        const nasip = /[?&]nasip=([^&]*)/.exec(loc);
        const userip = /[?&]userip=([^&]*)/.exec(loc);
        writeState({
          nasip: nasip ? nasip[1] : undefined,
          userip: userip ? userip[1] : undefined,
          lastEntry: loc,
        });
        return { url: loc, fromGateway: true };
      }
    } catch (e) {
      log('探针失败', probe, String(e && e.message));
    }
  }

  // 兜底：用本机参数和上次记录的 nasip 拼一个入口（nasip 缺一不可）
  const st = readState();
  const url =
    `http://${cfg.portalHost}/eportal/index.jsp?userip=${net.ip}` +
    `&wlanacname=&nasip=${st.nasip || ''}&wlanparameter=${macDashed(net.mac)}` +
    `&url=${encodeURIComponent(PROBE_REDIRECT)}&userlocation=`;
  log('⚠ 未探测到网关重定向，尝试兜底入口:', url);
  return { url, fromGateway: false };
}

/** 校验入口 URL 是否真的能跳到门户主流程（避免浏览器卡在错误页上空等） */
async function validateEntry(url) {
  try {
    const r = await httpGet(url, { redirect: 'manual', timeout: 10000 });
    const ok = r.status >= 300 && r.status < 400 && /portal-main|portal\/entry/.test(r.location || '');
    log(`入口校验：${r.status} ${r.location || ''} -> ${ok ? '通过' : '不通过'}`);
    return ok;
  } catch (e) {
    log('入口校验异常:', String(e && e.message));
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 页面内脚本                                                           */
/* ------------------------------------------------------------------ */

const FIND_FORM = `(function(){
  var diag = [];
  var docs = [{d: document, tag: 'top'}];
  var ifr = document.querySelectorAll('iframe');
  for (var i = 0; i < ifr.length; i++) {
    try {
      var cd = ifr[i].contentDocument;
      if (cd) {
        docs.push({d: cd, tag: 'iframe['+i+']'});
        diag.push('iframe['+i+'] inputs=' + cd.querySelectorAll('input').length);
      } else {
        diag.push('iframe['+i+'] contentDocument=null');
      }
    } catch(e) { diag.push('iframe['+i+'] 不可访问'); }
  }
  diag.push('top inputs=' + document.querySelectorAll('input').length);
  for (var k = 0; k < docs.length; k++) {
    var d = docs[k].d;
    var u = d.querySelector('#nameInput')
         || d.querySelector('input[name="username"]')
         || d.querySelector('input[type="text"]');
    var p = d.querySelector('input[type="password"]');
    if (u && p) {
      var cap = d.querySelector('input[placeholder*="验证码"], #captchaInput, input[name="captcha"]');
      return {found: true, where: docs[k].tag, hasCaptcha: !!cap, diag: diag,
              title: ((d.body && d.body.innerText) || '').slice(0, 200)};
    }
  }
  return {found: false, where: null, diag: diag,
          hint: ((document.body && document.body.innerText) || '').slice(0, 300)};
})()`;

function fillFormScript(account, password) {
  return `(function(){
  function setVal(el, val){
    var w = el.ownerDocument.defaultView;
    var proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    ['input','change','keyup','blur'].forEach(function(t){
      el.dispatchEvent(new w.Event(t, {bubbles: true}));
    });
  }
  var docs = [document];
  var ifr = document.querySelectorAll('iframe');
  for (var i = 0; i < ifr.length; i++) {
    try { if (ifr[i].contentDocument) docs.push(ifr[i].contentDocument); } catch(e) {}
  }
  for (var k = 0; k < docs.length; k++) {
    var d = docs[k];
    var u = d.querySelector('#nameInput')
         || d.querySelector('input[name="username"]')
         || d.querySelector('input[type="text"]');
    var p = d.querySelector('input[type="password"]');
    if (!u || !p) continue;
    setVal(u, ${JSON.stringify(account)});
    setVal(p, ${JSON.stringify(password)});
    return JSON.stringify({ok: true, where: 'doc['+k+']', u: u.value, pLen: p.value.length});
  }
  return JSON.stringify({ok: false});
})()`;
}

const CLICK_LOGIN = `(function(){
  var re = new RegExp(${JSON.stringify(cfg.loginButtonText)}, 'i');
  var docs = [document];
  var ifr = document.querySelectorAll('iframe');
  for (var i = 0; i < ifr.length; i++) {
    try { if (ifr[i].contentDocument) docs.push(ifr[i].contentDocument); } catch(e) {}
  }
  function depth(el){ var n = 0; while (el) { n++; el = el.parentElement; } return n; }

  for (var k = 0; k < docs.length; k++) {
    var d = docs[k];
    var pwd = d.querySelector('input[type="password"]');
    if (!pwd) continue;

    // 在所有可见、文本匹配的元素里挑最深的那个（外层容器也会匹配，必须排除）
    var nodes = d.querySelectorAll('button,a,span,div,p,input[type="submit"]');
    var best = null, bestDepth = -1;
    for (var j = 0; j < nodes.length; j++) {
      var e = nodes[j];
      if (e.children.length > 2) continue;
      if (!(e.offsetParent || e.getClientRects().length)) continue;
      var t = ((e.innerText || e.value || '') + '').trim();
      if (!t || !re.test(t)) continue;
      if (/忘记|注册|其他|切换|更多/.test(t)) continue;
      var dp = depth(e);
      if (dp > bestDepth) { bestDepth = dp; best = e; }
    }

    if (best) {
      var target = best.closest('button,a,[role="button"],input[type="submit"]') || best;
      var w = target.ownerDocument.defaultView;
      target.scrollIntoView({block: 'center'});
      ['mouseover','mousedown','mouseup','click'].forEach(function(type){
        target.dispatchEvent(new w.MouseEvent(type, {bubbles: true, cancelable: true, view: w}));
      });
      if (typeof target.click === 'function') target.click();
      return JSON.stringify({clicked: true, tag: target.tagName,
        cls: ((target.className||'')+'').slice(0,60), text: ((target.innerText||'')+'').trim().slice(0,20)});
    }

    // 找不到按钮就回车提交
    var w2 = pwd.ownerDocument.defaultView;
    pwd.focus();
    ['keydown','keypress','keyup'].forEach(function(type){
      pwd.dispatchEvent(new w2.KeyboardEvent(type, {bubbles: true, key: 'Enter', keyCode: 13, which: 13}));
    });
    return JSON.stringify({clicked: 'enter'});
  }
  return JSON.stringify({clicked: false});
})()`;

const LIST_BUTTONS = `(function(){
  var docs = [document];
  var ifr = document.querySelectorAll('iframe');
  for (var i = 0; i < ifr.length; i++) { try { if (ifr[i].contentDocument) docs.push(ifr[i].contentDocument); } catch(e) {} }
  var re = new RegExp(${JSON.stringify(cfg.loginButtonText)}, 'i');
  var out = [];
  for (var di = 0; di < docs.length; di++) {
    var nodes = docs[di].querySelectorAll('*');
    for (var j = 0; j < nodes.length; j++) {
      var e = nodes[j];
      if (['SCRIPT','STYLE','HTML','BODY'].indexOf(e.tagName) >= 0) continue;
      var t = ((e.innerText || e.value || '') + '').trim();
      if (!t || !re.test(t)) continue;
      out.push({doc: di, tag: e.tagName, cls: ((e.className || '') + '').slice(0, 70),
                id: e.id || '', txt: t.replace(/\\s+/g, ' ').slice(0, 30), kids: e.children.length,
                vis: !!(e.offsetParent || e.getClientRects().length)});
    }
  }
  return JSON.stringify(out.slice(0, 60), null, 1);
})()`;

const PAGE_STATE = `(function(){
  var docs = [document];
  var ifr = document.querySelectorAll('iframe');
  for (var i = 0; i < ifr.length; i++) {
    try { if (ifr[i].contentDocument) docs.push(ifr[i].contentDocument); } catch(e) {}
  }
  var txt = '';
  for (var k = 0; k < docs.length; k++) txt += ' ' + ((docs[k].body && docs[k].body.innerText) || '');
  return JSON.stringify({href: location.href, text: txt.replace(/\\s+/g, ' ').slice(0, 600)});
})()`;

const DUMP_FINISH = `(function(){
  var out = {href: location.href, text: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 900), items: [], storage: {}};
  var nodes = document.querySelectorAll('nz-switch, button, a, [class*="switch"], [class*="nosense"], [class*="Switch"]');
  for (var i = 0; i < nodes.length; i++) {
    var e = nodes[i];
    var t = ((e.innerText || '') + '').trim();
    var cls = ((e.className || '') + '').slice(0, 70);
    if (!t && !/switch|nosense/i.test(cls)) continue;
    out.items.push({tag: e.tagName, cls: cls, txt: t.slice(0, 40),
                    vis: !!(e.offsetParent || e.getClientRects().length)});
  }
  for (var k = 0; k < localStorage.length; k++) {
    var key = localStorage.key(k);
    if (/finish|terminal|mab|nosense|portal/i.test(key)) {
      var v = localStorage.getItem(key) || '';
      out.storage[key] = v.length > 600 ? v.slice(0, 600) + '…' : v;
    }
  }
  return JSON.stringify(out, null, 1);
})()`;

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function loginOnce(entryUrl) {
  const cdp = await launch({ port: 9333, headless: true });
  let ok = false;
  try {
    const { sessionId } = await openPage(cdp, 'about:blank');
    // 伪装成正常 Edge，避免 headless 被门户识别
    await cdp.send(
      'Network.setUserAgentOverride',
      {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Win32',
      },
      sessionId,
    );
    await cdp.send('Page.navigate', { url: entryUrl }, sessionId);

    // 1) 等登录表单出现
    const formDeadline = Date.now() + cfg.waitFormSeconds * 1000;
    let form = null;
    let formErr = null;
    while (Date.now() < formDeadline) {
      await sleep(1500);
      try {
        form = await evalJson(cdp, sessionId, FIND_FORM);
      } catch (e) {
        formErr = String((e && e.message) || e);
      }
      if (form && form.found) break;
      if (!DRY_RUN && !FORCE && (await isOnline())) {
        log('等待表单期间已恢复联网');
        ok = true;
        break;
      }
    }
    if (ok) return true;
    if (!form || !form.found) {
      log('未找到登录表单，页面状态:', await evaluate(cdp, sessionId, PAGE_STATE).catch(() => '{}'));
      log('诊断:', JSON.stringify((form && form.diag) || []), formErr ? '错误: ' + formErr : '');
      return false;
    }
    log(`找到登录表单（${form.where}）`, form.hasCaptcha ? '⚠ 页面出现验证码，可能无法自动登录' : '');

    // 2) 填表
    log('填表结果:', await evaluate(cdp, sessionId, fillFormScript(cfg.account, cfg.password)));

    if (DRY_RUN) {
      log('干跑校验（不提交）:', JSON.stringify(await evalJson(cdp, sessionId, FIND_FORM)));
      if (process.argv.includes('--dump')) {
        log('按钮候选:\n' + (await evaluate(cdp, sessionId, LIST_BUTTONS)));
      }
      return false;
    }

    // 3) 提交
    log('提交结果:', await evaluate(cdp, sessionId, CLICK_LOGIN));

    // 4) 观察提交后的页面变化
    await sleep(6000);
    log('提交后页面:', await evaluate(cdp, sessionId, PAGE_STATE).catch(() => '{}'));

    // 5) 等联网恢复
    const okDeadline = Date.now() + cfg.waitSuccessSeconds * 1000;
    while (Date.now() < okDeadline) {
      await sleep(2000);
      if (await isOnline()) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      log('登录后仍未联网，页面状态:', await evaluate(cdp, sessionId, PAGE_STATE).catch(() => '{}'));
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        const p = path.join(LOG_DIR, `fail-${Date.now()}.png`);
        fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
        log('已保存失败截图:', p);
      } catch {}
    }
    if (process.argv.includes('--inspect')) {
      await sleep(3000);
      log('页面结构检查:\n' + (await evaluate(cdp, sessionId, DUMP_FINISH).catch((e) => String(e))));
    }
    return ok;
  } finally {
    cdp.kill();
  }
}

/* ------------------------------------------------------------------ */
/* 一次性执行 / 常驻监听                                                */
/* ------------------------------------------------------------------ */

/** 完成一轮完整登录尝试，返回是否成功 */
async function doLogin({ net, entryOverride = null, allowFallback = true, retries } = {}) {
  const tries = retries || cfg.retryTimes;
  const n = net || (await waitForWifi(cfg.waitWifiSeconds));
  if (!n) {
    log(`等待 ${cfg.waitWifiSeconds}s 仍未获取到 WiFi IP，本轮放弃`);
    return false;
  }
  const ssid = currentSsid();
  log(`网卡 ${n.name}  IP ${n.ip}  MAC ${n.mac}  SSID ${ssid || '(未知)'}`);

  // 安全性：不在校园网就不动作，免得在家/热点上乱试
  if (!entryOverride && !ssidAllowed(ssid)) {
    log('当前 WiFi 不在配置的校园网列表中，跳过（改 config.json 的 wifiSsidPatterns 可调整）');
    return false;
  }

  const entry = entryOverride ? { url: entryOverride, fromGateway: true } : await getEntryUrl(n);
  if (entryOverride) log('使用指定入口:', entry.url);

  // 保守策略：没探测到网关重定向时先不动手，避免网络只是慢就去做一次 CAS 登录
  if (!entry.fromGateway && !allowFallback) {
    log('未探测到网关重定向，本轮先不登录（稍后会升级为兜底尝试）');
    return false;
  }

  // 入口必须能跳到门户主流程，否则浏览器只会卡在错误页上空等
  if (!(await validateEntry(entry.url))) {
    log('❌ 认证入口不可用：可能不在校园网，或网关未下发重定向');
    return false;
  }

  for (let i = 1; i <= tries; i++) {
    log(`--- 第 ${i}/${tries} 次尝试登录 ---`);
    try {
      if (await loginOnce(entry.url)) {
        log('✅ 认证成功，网络已连通');
        writeState({ lastSuccess: new Date().toISOString() });
        return true;
      }
    } catch (e) {
      log('本次尝试异常:', e && e.stack ? e.stack : String(e));
    }
    if (i < tries) await sleep(4000);
  }
  return false;
}

/** 常驻监听：Wi-Fi 一断就尽快补认证 */
async function watchLoop() {
  log(`常驻监听启动（每 ${cfg.watchIntervalSeconds} 秒检查一次）`);
  let streak = 0;
  let cycles = 0;
  const heartbeatEvery = Math.max(1, Math.round(1800 / cfg.watchIntervalSeconds)); // 约 30 分钟
  for (;;) {
    try {
      if (await isOnline(true)) {
        if (streak > 0) log('网络已恢复');
        streak = 0;
      } else {
        streak++;
        const net = localNet();
        const ssid = currentSsid();
        if (!net || !ssidAllowed(ssid)) {
          // 不在校园网，静默等待，不刷日志
        } else {
          const secs = streak * cfg.watchIntervalSeconds;
          const firstTry = streak === 1;
          // 离线超过 5 分钟后放慢到每 5 分钟一次，避免长时间故障时疯狂开浏览器
          const every = secs >= 300 ? 20 : 4;
          const escalated = secs >= cfg.watchGraceSeconds && streak % every === 0;
          if (firstTry || escalated) {
            log(`检测到离线约 ${secs}s`);
            await doLogin({ net, allowFallback: escalated, retries: 1 });
          }
        }
      }
    } catch (e) {
      log('监听循环异常:', (e && e.stack) || String(e));
    }
    cycles++;
    if (cycles % heartbeatEvery === 0) {
      log(`心跳：常驻监听已运行约 ${Math.round((cycles * cfg.watchIntervalSeconds) / 60)} 分钟`);
    }
    await sleep(cfg.watchIntervalSeconds * 1000);
  }
}

/** 保证同一时刻只有一个常驻实例：占用本地端口，进程退出即自动释放，无竞态 */
function acquireWatchLock() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null)); // 端口被占 => 已有实例
    srv.once('listening', () => resolve(srv));
    srv.listen(9334, '127.0.0.1');
  });
}

(async () => {
  log('='.repeat(60));

  if (WATCH) {
    log('自动认证（常驻监听模式）启动');
    const lock = await acquireWatchLock();
    if (!lock) {
      log('已有常驻实例在运行，本实例退出');
      process.exit(0);
    }
    await watchLoop();
    return;
  }

  log('自动认证启动');

  if (!FORCE && !DRY_RUN && (await isOnline())) {
    log('当前已联网，无需登录');
    process.exit(0);
  }
  if (FORCE || DRY_RUN) log('强制模式：跳过联网检测');

  const net = await waitForWifi(cfg.waitWifiSeconds);
  if (!net) {
    log(`等待 ${cfg.waitWifiSeconds}s 仍未获取到 WiFi IP，退出`);
    process.exit(1);
  }

  if (DRY_RUN) {
    const entry = ENTRY_OVERRIDE ? { url: ENTRY_OVERRIDE } : await getEntryUrl(net);
    if (!(await validateEntry(entry.url))) {
      log('❌ 认证入口不可用');
      process.exit(1);
    }
    await loginOnce(entry.url);
    log('干跑结束（未提交登录）');
    process.exit(0);
  }

  if (await doLogin({ net, entryOverride: ENTRY_OVERRIDE })) process.exit(0);
  log('❌ 自动认证失败，请手动打开浏览器登录');
  process.exit(1);
})();
