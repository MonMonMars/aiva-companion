// 粤语设置的运行时验证
// ---------------------------------------------------------------------------
// 单元测试证明的是"模块逻辑对"，这个脚本证明的是"跑起来的 App 真的用了粤语"：
//   1) 页面正常渲染、没有异常（改了这么多文件，先确认没改坏）
//   2) 存档里的 spokenLang 真的是 zh-HK（验证默认值 + 老存档迁移都生效）
//   3) 这台机器上到底有没有粤语声音（决定能不能真的听到粤语）
// 无头 Chrome 通常在 Windows 上只装了 en-US/zh-CN，所以第 3 项大概率是"没有" ——
// 这不是代码问题，iOS 上自带粤语声音。这里如实报告即可。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-yuecheck.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9344;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yuechk-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--mute-audio',
  // 直接用目标 URL 启动：这样 /json/list 里马上就有对应的 page target，
  // 连它的 webSocketDebuggerUrl 才能拿到真正的执行上下文。
  // 连 /json/version 那个浏览器级端点的话，Runtime.evaluate 会静默返回空。
  url,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

console.log('>>> 打开：' + url);
await send('Page.navigate', { url });
await sleep(12000);

// ---- 1. 渲染 & 异常 ------------------------------------------------------
const rootInfo = await evaluate(`(() => {
  const root = document.getElementById('root');
  return { children: root ? root.childElementCount : -1, text: (document.body.innerText||'').slice(0,120) };
})()`);
console.log('=== 渲染 ===');
console.log('  #root 子节点:', rootInfo?.children);
console.log('  可见文字:', JSON.stringify(rootInfo?.text));
console.log('  异常数:', exceptions.length);
exceptions.slice(0, 5).forEach((e) => console.log('   [EXCEPTION]', e.slice(0, 200)));

// ---- 1.5 点进一个角色：store 只有真正写入时才会 persist，
//          所以要点一下才能看到存档里到底存了什么语言 -----------------------
const clicked = await evaluate(`(() => {
  const all = Array.from(document.querySelectorAll('div,span,text'));
  const hits = all.filter(e => (e.textContent || '').includes('开始相处'));
  if (!hits.length) return { ok: false, reason: '没找到角色卡' };
  // 取最内层：外层容器也含这段文案，点了外层等于没点
  const card = hits.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  })[0];
  const r = card.getBoundingClientRect();
  for (const t of ['mousedown', 'mouseup', 'click']) {
    card.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }
  return { ok: true, picked: (card.textContent || '').slice(0, 24) };
})()`);
console.log('=== 点选角色 ===');
console.log(' ', JSON.stringify(clicked));
await sleep(9000);

// ---- 2. 存档里的语言设置 --------------------------------------------------
const cfg = await evaluate(`(() => {
  try {
    const raw = localStorage.getItem('aiva.companion.v1');
    if (!raw) return { found: false };
    const s = JSON.parse(raw);
    return {
      found: true,
      spokenLang: s.config?.spokenLang,
      sttLanguage: s.config?.voice?.sttLanguage,
      migrated: s.config?.langMigratedToYue,
    };
  } catch (e) { return { found: false, err: String(e) }; }
})()`);
console.log('=== 存档里的语言设置 ===');
console.log(' ', JSON.stringify(cfg));

// ---- 3. 这台机器的粤语声音 ------------------------------------------------
const voices = await evaluate(`(() => {
  const vs = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  return vs.map(v => v.name + ' [' + v.lang + ']' + (v.localService ? '' : ' (network)'));
})()`);
console.log('=== 系统音色 (' + (voices?.length || 0) + ' 个) ===');
(voices || []).slice(0, 25).forEach((v) => console.log('  ' + v));
const yueOnes = (voices || []).filter((v) => /zh-HK|yue/i.test(v));
console.log('  其中粤语:', yueOnes.length ? yueOnes.join(' | ') : '（无）');

// ---- 3. 老存档迁移 --------------------------------------------------------
// 你之前已经用过这个 App，存档里 spokenLang 存的是 'auto'，而存档会覆盖默认值。
// 光改默认值救不了老用户，所以这里专门验证：塞一份 auto 的旧存档 → 刷新 → 看有没有被迁成粤语。
await evaluate(`(() => {
  localStorage.setItem('aiva.companion.v1', JSON.stringify({
    relations: {}, coins: 30, giftCount: {}, chatHistory: {}, memory: [],
    config: { spokenLang: 'auto', voice: { sttLanguage: 'auto' } },
  }));
  return 'seeded';
})()`);
console.log('=== 老存档迁移（塞入 spokenLang=auto 后刷新）===');
await send('Page.navigate', { url });
await sleep(11000);
const after = await evaluate(`(() => {
  const raw = localStorage.getItem('aiva.companion.v1');
  if (!raw) return { found: false };
  const s = JSON.parse(raw);
  return { found: true, spokenLang: s.config?.spokenLang, sttLanguage: s.config?.voice?.sttLanguage, migrated: s.config?.langMigratedToYue };
})()`);
console.log(' ', JSON.stringify(after));

// ---- 判定 ----------------------------------------------------------------
console.log('\n=== 判定 ===');
const renderOk = (rootInfo?.children ?? 0) > 0 && exceptions.length === 0;
const langOk = cfg?.found && cfg.spokenLang === 'zh-HK';
const migrateOk = after?.found && after.spokenLang === 'zh-HK' && after.migrated === true;
console.log((renderOk ? 'PASS' : 'FAIL') + '  页面渲染正常且无异常');
console.log((langOk ? 'PASS' : 'FAIL') + '  新用户默认就是粤语 (zh-HK)');
console.log((migrateOk ? 'PASS' : 'FAIL') + '  老存档 auto 已迁移成粤语');
console.log('INFO  粤语声音可用性取决于设备：本机=' + (yueOnes.length ? '有' : '无（Windows 无头 Chrome 通常没装，iOS 自带）'));

cleanup();
process.exit(renderOk && langOk && migrateOk ? 0 : 1);
