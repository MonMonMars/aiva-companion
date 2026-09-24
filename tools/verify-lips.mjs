/**
 * 在真实浏览器里验证口型：进角色页 → 说话前截图 → 调 speak() → 说话中截图 → stopSpeaking → 闭嘴截图
 *
 * 为什么必须看截图而不是只跑单元测试：
 *   单元测试证明的是"morph 权重被推动了"，但权重推对了、**网格没变化**
 *   （比如 shapeSlots 接错、morphTargetsRelative 设错）是完全可能的。
 *   只有像素能证明嘴真的张了。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets', 'preview');
const URL_ = process.argv[2] || 'http://127.0.0.1:8130/';
const PORT = 9333;

/** 自动找 Chrome：别写死版本号，浏览器升级一次这个脚本就废了（踩过） */
function findChrome() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);

  // .agent-browser 下按版本号排序取最新
  try {
    const base = path.join(home, '.agent-browser', 'browsers');
    const dirs = fs.readdirSync(base)
      .filter((d) => d.startsWith('chrome-'))
      .sort()
      .reverse();
    for (const d of dirs) candidates.push(path.join(base, d, 'chrome.exe'));
  } catch {}

  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

const CHROME = findChrome();

if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH'); process.exit(1); }
console.log('Chrome:', CHROME);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--window-size=430,932', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu-sandbox',
  '--user-data-dir=' + path.join(root, 'tools', '.tmp-chrome'),
  'about:blank',
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 起不来');
}

const wsUrl = await cdp();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const logs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description || 'exception' });
  }
};

const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

// 建一个页面 target 并 attach
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride',
  { width: 430, height: 932, deviceScaleFactor: 2, mobile: true }, sessionId);

await send('Page.navigate', { url: URL_ }, sessionId);
await sleep(9000);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description };
  return { value: r?.result?.value };
};

/** 点一个含指定文字的按钮 */
await evalJs(`(() => {
  const els = [...document.querySelectorAll('div,button,span,a')];
  const hit = els.reverse().find(e => (e.innerText||'').includes('开始相处'));
  if (hit) { hit.click(); return 'clicked'; }
  return 'not-found';
})()`);
await sleep(9000);

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
};

const info = await evalJs(`(() => {
  const c = document.querySelector('canvas');
  return { canvas: c ? c.width + 'x' + c.height : 'none' };
})()`);
console.log('canvas:', info.value?.canvas);

// 找到场景句柄：Avatar3D.web 把 comp 存在 ref 上，外部拿不到 ——
// 但 react-native-web 会把 props 留在 DOM 上，退而求其次：
// 直接通过全局的 THREE 场景不可行，所以这里用"真实用户操作"触发口型。
// 语音没配 Key，所以改用 setFaceEmotion 的等价路径：点击头部区触发 react('pet')，
// 再直接注入一段 speak 通过暴露的调试钩子。
//
// 为此在 window 上挂一个调试口（见 Avatar3D.web.js 的 __aivaDebug）。

const hasDebug = await evalJs(`!!(window.__aivaDebug && window.__aivaDebug.speak)`);
console.log('window.__aivaDebug 可用:', hasDebug.value);

await shot('lips-idle.png');

if (hasDebug.value) {
  // 说一句长话，取中段截图
  await evalJs(`window.__aivaDebug.speak('你好呀，我今天特别开心，想跟你说好多好多话', { emotion: 'excited' })`);
  await sleep(300);
  const p1 = await shot('lips-speaking-1.png');
  await sleep(350);
  const p2 = await shot('lips-speaking-2.png');
  await sleep(350);
  const p3 = await shot('lips-speaking-3.png');
  console.log('说话中截图:', [p1, p2, p3].map((p) => path.basename(p)).join(', '));

  // 读出当前的 morph 权重，作为"数字证据"
  const inf = await evalJs(`(() => {
    const d = window.__aivaDebug;
    return d.weights ? d.weights() : null;
  })()`);
  console.log('说话中 morph 权重:', JSON.stringify(inf.value));

  await evalJs(`window.__aivaDebug.stopSpeaking()`);
  await sleep(1200);
  await shot('lips-stopped.png');
  const inf2 = await evalJs(`window.__aivaDebug.weights ? window.__aivaDebug.weights() : null`);
  console.log('停止后 morph 权重:', JSON.stringify(inf2.value));
}

console.log('\n=== 控制台 ===');
for (const l of logs) {
  if (l.type === 'error' || l.type === 'exception') console.log(' ', l.type.toUpperCase(), l.text.slice(0, 200));
}
const errs = logs.filter((l) => l.type === 'error' || l.type === 'exception');
console.log(errs.length ? `\n有 ${errs.length} 条错误 ✗` : '\n无错误 ✓');

ws.close();
chrome.kill();
process.exit(0);
