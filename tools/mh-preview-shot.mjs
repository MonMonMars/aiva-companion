// 捏人预览台 截图器（静态服务 + headless Chrome CDP）
// 用法: node tools/mh-preview-shot.mjs [port] [outPng] [waitMs] ["预设名"]
//   例: node tools/mh-preview-shot.mjs 7799 out.png 11000 "健美"
// 静态服务 ROOT = llm-companion，所以 HTML 里可以直接 import /node_modules/three/... + load /assets/models4/*.glb
// 静态服务 + headless Chrome（CDP）截图 + 收集 console 错误
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 7799);
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const OUT = process.argv[3] || 'C:/Users/Simon Lai/AppData/Local/Temp/mh-preview.png';
const WAIT = Number(process.argv[4] || 9000);
const PRESET = process.argv[5] || '';   // 可选：先点某个预设再截图

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url === '/' ? '/tools/mh-preview.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log('serving ' + ROOT + ' -> http://127.0.0.1:' + PORT + '/');

const userDir = 'C:/Users/Simon Lai/AppData/Local/Temp/_chrome-mh';
const proc = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + (PORT + 1),
  '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // ⚠️ 绝对不能加 --disable-gpu：那样 SwiftShader 也起不来，WebGL 直接拿不到 context
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
  '--window-size=1440,900',
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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push('[' + msg.params.entry.level + '] ' + msg.params.entry.text);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
await sleep(WAIT);

if (PRESET) {
  const js = `
    (() => {
      const b = [...document.querySelectorAll('#presets .btn')].find(x => x.textContent === ${JSON.stringify(PRESET)});
      if (!b) return '找不到预设 ' + ${JSON.stringify(PRESET)};
      b.click();
      document.querySelector('[data-tab="Body"]').click();
      return 'clicked';
    })()`;
  console.log('预设：' + JSON.stringify(await send('Runtime.evaluate', { expression: js, returnByValue: true }).then((r) => r.result.value)));
  await sleep(2500);
}

const diag = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const c = document.querySelector('canvas');
    return JSON.stringify({
      ready: window.__mhReady === true,
      canvas: c ? c.width + 'x' + c.height : 'no canvas',
      meta: document.getElementById('meta')?.textContent || '',
      boot: document.getElementById('boot')?.textContent || '',
      sliders: document.querySelectorAll('#sliders input[type=range]').length,
      presets: document.querySelectorAll('#presets .btn').length,
      webgl: !!document.createElement('canvas').getContext('webgl2'),
    });
  })()`,
}).then((r) => r.result.value);
console.log('页面状态：' + diag);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('截图 -> ' + OUT + '  (' + (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB)');
console.log('\n--- console ---');
console.log(logs.length ? logs.join('\n') : '（无）');

fs.writeFileSync('C:/Users/Simon Lai/AppData/Local/Temp/_mh-shot-log.txt', logs.join('\n'), 'utf8');
ws.close(); proc.kill(); server.close();
process.exit(0);
