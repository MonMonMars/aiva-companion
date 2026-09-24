// mh-preview2-shot.mjs —— 预览台 v2 截图器（支持多视角 + 多预设）
// 用法: node tools/mh-preview2-shot.mjs [port] [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 7821);
const OUTDIR = process.argv[3] || 'C:/Users/Simon Lai/AppData/Local/Temp/mh2';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

fs.mkdirSync(OUTDIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url === '/' ? '/tools/mh-preview2.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log('serving -> http://127.0.0.1:' + PORT + '/');

const userDir = 'C:/Users/Simon Lai/AppData/Local/Temp/_chrome-mh2-' + Date.now();
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + (PORT + 1), '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // ⚠️ 不能加 --disable-gpu，否则 SwiftShader 起不来，WebGL 拿不到 context
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--window-size=1400,900',
  'http://127.0.0.1:' + PORT + '/',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* 还没起来 */ }
}
if (!target) { console.log('无法连接 Chrome'); server.close(); proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded') logs.push('[' + m.params.entry.level + '] ' + m.params.entry.text);
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });

// 等模型就绪
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(400);
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: 'window.__mhReady === true' });
  ready = r.result.value === true;
}
const diag = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const c = document.querySelector('canvas');
    return JSON.stringify({ ready: window.__mhReady === true, canvas: c ? c.width+'x'+c.height : 'no canvas',
      meta: document.getElementById('meta')?.textContent || '', webgl: !!document.createElement('canvas').getContext('webgl2') });
  })()`,
}).then((r) => r.result.value);
console.log('页面状态：' + diag);

const shot = async (name) => {
  // ⚠️ 坑：headless 下 Page.captureScreenshot 对 WebGL canvas 常常抓成空白
  //    （合成器拿不到 GPU 帧）。可靠做法是直接从 canvas 取 toDataURL
  //    —— 前提是建 renderer 时开了 preserveDrawingBuffer: true。
  //    这里两种都留：优先 canvas 直取，拿不到再退回 captureScreenshot。
  await send('Runtime.evaluate', {
    expression: 'window.__dbg && window.__dbg.forceRender && window.__dbg.forceRender()',
    returnByValue: true,
  });
  const r = await send('Runtime.evaluate', {
    expression: "document.querySelector('canvas').toDataURL('image/png')",
    returnByValue: true,
  });
  const url = r.result.value;
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length > 20000) {
    const out = path.join(OUTDIR, name + '.png');
    fs.writeFileSync(out, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
    console.log('  -> ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB, canvas)');
    return;
  }
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const out = path.join(OUTDIR, name + '.png');
  fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
  console.log('  -> ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB, page)');
};

// 点预设 + 视角
const clickPreset = async (name) => {
  const js = `(() => { const b=[...document.querySelectorAll('#presets .btn')].find(x=>x.textContent===${JSON.stringify(name)}); if(!b) return 'notfound'; b.click(); return 'ok'; })()`;
  const r = await send('Runtime.evaluate', { expression: js, returnByValue: true });
  return r.result.value;
};
const clickView = async (id) => {
  await send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)}).click()`, returnByValue: true });
};

console.log('\n=== 截图 ===');
await clickView('front'); await sleep(900); await shot('01-正面-默认');
await clickView('face'); await sleep(900); await shot('02-面部-默认');
for (const p of ['男生', '娇小', '健美', '精灵']) {
  await clickPreset(p); await sleep(700);
  await clickView('front'); await sleep(700);
  await shot('1x-正面-' + p);
  await clickView('face'); await sleep(600);
  await shot('2x-面部-' + p);
}

console.log('\n--- console ---');
console.log(logs.length ? logs.filter((l) => !l.includes('GL Driver') && !l.includes('GPU stall')).join('\n') || '（仅 GPU 性能警告）' : '（无）');

ws.close(); proc.kill(); server.close();
process.exit(0);
