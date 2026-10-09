'use strict';
// 侦察脚本：用真实浏览器打开门户，记录它调用的接口、控制台日志和页面结构。
// 当前处于已联网状态，本脚本不会断开连接。

const { launch, openPage, evaluate, sleep } = require('./cdp');

const ENTRY = process.argv[2] || 'http://110.184.24.61/portal/entry/pc/index';
const WAIT_MS = Number(process.argv[3] || 25000);

(async () => {
  const cdp = await launch({ port: 9333, headless: true });
  console.log('浏览器:', cdp.browser);
  console.log('导航到:', ENTRY);
  console.log('='.repeat(70));

  const reqs = new Map();
  const logs = [];

  cdp.on('Network.requestWillBeSent', (p, sid) => {
    if (!p.request) return;
    reqs.set(p.requestId, { url: p.request.url, method: p.request.method, postData: p.request.postData });
  });

  cdp.on('Network.responseReceived', async (p, sid) => {
    if (!p.response) return;
    const u = p.response.url;
    if (!/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)(\?|$)/i.test(u)) {
      const info = reqs.get(p.requestId) || {};
      let loc = '';
      const h = p.response.headers || {};
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'location') loc = h[k];
      console.log(`[NET] ${p.response.status} ${info.method || ''} ${u}${loc ? '  -> ' + loc : ''}`);
      if (info.postData) console.log('      请求体: ' + String(info.postData).slice(0, 400));
    }
  });

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || [])
      .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
      .join(' ');
    logs.push(`[${p.type}] ${text}`);
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    logs.push('[exception] ' + (p.exceptionDetails && p.exceptionDetails.text));
  });

  const { sessionId } = await openPage(cdp, ENTRY);
  await sleep(WAIT_MS);

  console.log('');
  console.log('='.repeat(70));
  console.log('最终地址:', await evaluate(cdp, sessionId, 'location.href'));
  console.log('页面标题:', await evaluate(cdp, sessionId, 'document.title'));
  console.log('');
  console.log('---------- 可见文本 ----------');
  console.log(await evaluate(cdp, sessionId, '(document.body.innerText||"").slice(0, 3000)'));
  console.log('');
  console.log('---------- 表单控件 ----------');
  console.log(
    await evaluate(
      cdp,
      sessionId,
      `JSON.stringify(Array.from(document.querySelectorAll('input,button,a')).map(function(e){
        return {tag:e.tagName, type:e.type||'', id:e.id||'', name:e.name||'',
                placeholder:e.placeholder||'', cls:(e.className||'').toString().slice(0,60),
                text:(e.innerText||e.value||'').trim().slice(0,40)};
      }).slice(0,60), null, 1)`,
    ),
  );
  console.log('');
  console.log('---------- localStorage ----------');
  console.log(
    await evaluate(
      cdp,
      sessionId,
      `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(function(k){
        var v=localStorage.getItem(k); return [k, v && v.length>300 ? v.slice(0,300)+'...' : v];
      })), null, 1)`,
    ),
  );
  console.log('');
  console.log('---------- 控制台日志 ----------');
  for (const l of logs.slice(-80)) console.log(l.slice(0, 400));

  cdp.kill();
  process.exit(0);
})().catch((e) => {
  console.error('侦察失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
