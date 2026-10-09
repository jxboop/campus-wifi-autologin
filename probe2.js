'use strict';
// 探测 CAS 登录表单结构（主文档 + 同源 iframe + shadow DOM）

const { launch, openPage, evaluate, sleep } = require('./cdp');

const ENTRY = process.argv[2];
const WAIT_MS = Number(process.argv[3] || 30000);

const COLLECT = `(function(){
  var out = [];
  function walk(root, path){
    var all = root.querySelectorAll('*');
    for (var i=0;i<all.length;i++){
      var el = all[i];
      if (el.shadowRoot) walk(el.shadowRoot, path + ' >>shadow>> ' + el.tagName);
    }
    var n = root.querySelectorAll('input,button,select,textarea,a[role=button],[class*=login],[class*=submit]');
    for (var j=0;j<n.length;j++){
      var e = n[j];
      out.push({
        path: path,
        tag: e.tagName,
        type: e.type||'',
        id: e.id||'',
        name: e.name||'',
        cls: (e.className||'').toString().slice(0,80),
        ph: e.placeholder||'',
        txt: (e.innerText||'').trim().slice(0,30),
        vis: !!(e.offsetParent||e.getClientRects().length)
      });
    }
  }
  try { walk(document, 'top'); } catch(err){ out.push({path:'top', err:String(err)}); }
  var ifr = document.querySelectorAll('iframe');
  for (var k=0;k<ifr.length;k++){
    try { if (ifr[k].contentDocument) walk(ifr[k].contentDocument, 'iframe['+k+']'); }
    catch(err){ out.push({path:'iframe['+k+']', err:'跨域: '+err}); }
  }
  return JSON.stringify({href: location.href, frames: ifr.length, items: out}, null, 1);
})()`;

(async () => {
  const cdp = await launch({ port: 9333, headless: true });
  const { sessionId } = await openPage(cdp, ENTRY);

  // 让页面看起来像普通 Edge，避免 headless 被识别
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
  await cdp.send('Page.navigate', { url: ENTRY }, sessionId);

  await sleep(WAIT_MS);
  console.log('最终地址:', await evaluate(cdp, sessionId, 'location.href'));
  console.log('');
  console.log(await evaluate(cdp, sessionId, COLLECT));
  cdp.kill();
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
