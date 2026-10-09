'use strict';
// Minimal zero-dependency Chrome DevTools Protocol client.
// Node >= 22 (global WebSocket + fetch).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge / Chrome 可执行文件');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
        return;
      }
      const key = msg.method;
      const list = this.handlers.get(key);
      if (list) for (const fn of list) fn(msg.params || {}, msg.sessionId);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launch({ port = 9333, headless = true, profileDir } = {}) {
  const exe = findBrowser();
  const dir = profileDir || path.join(os.tmpdir(), 'dsh-cdp-profile-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');

  const child = spawn(exe, args, { stdio: 'ignore', detached: false });

  let info = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        info = await r.json();
        break;
      }
    } catch {}
  }
  if (!info) {
    try {
      child.kill();
    } catch {}
    throw new Error('浏览器调试端口未就绪');
  }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const cdp = new Cdp(ws);
  cdp.browser = info.Browser;
  cdp.profileDir = dir;
  cdp.kill = () => {
    try {
      ws.close();
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  return cdp;
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  if (url) await cdp.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        r.exceptionDetails.text ||
        'JS 执行异常',
    );
  }
  return r.result && r.result.value;
}

/** 求值并按 JSON 解析：对象直接返回，字符串再解析一次 */
async function evalJson(cdp, sessionId, expression) {
  const v = await evaluate(cdp, sessionId, expression);
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

module.exports = { launch, openPage, evaluate, evalJson, sleep, findBrowser };
