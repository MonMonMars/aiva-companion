// vrm-shot.mjs —— 给 tools/vrm-verify.html 拍照（静态服务 + headless Chrome CDP）
// 用法: node tools/vrm-shot.mjs <glb路径相对ROOT> <输出png> [expr] [w] [view]
//   例: node tools/vrm-shot.mjs /assets/models4/aiva-shino-apose.glb out.png "" 1 full
//   例: node tools/vrm-shot.mjs /assets/models4/aiva-shino-apose.glb blink.png eyeBlinkLeft,eyeBlinkRight 1 face
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.env.VRMSHOT_PORT || 7831);
const GLB = process.argv[2] || '/assets/models4/aiva-shino-apose.glb';
const OUT = process.argv[3] || 'C:/Users/Simon Lai/AppData/Local/Temp/vrm-shot.png';
const EXPR = process.argv[4] || '';
const W = process.argv[5] ?? '1';
const VIEW = process.argv[6] || 'full';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css',
  '.hdr': 'application/octet-stream', '.ktx2': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const [raw, qs] = (req.url || '/').split('?');
  const url = decodeURIComponent(raw);
  let file = path.join(ROOT, url === '/' ? '/tools/vrm-verify.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const url = `http://127.0.0.1:${PORT}/?glb=${encodeURIComponent(GLB)}&view=${VIEW}&expr=${encodeURIComponent(EXPR)}&w=${W}&debug=1&panel=${process.env.VRMSHOT_PANEL||0}` + (process.env.VRMSHOT_EXTRA||"");
const userDir = 'C:/Users/Simon Lai/AppData/Local/Temp/_chrome-vrmshot';
const proc = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + (PORT + 1),
  '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // ⚠️ 不能加 --disable-gpu：SwiftShader 会跟着起不来，WebGL 拿不到 context
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
  '--window-size=1200,1000',
  url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* 还没起来 */ }
}
if (!target) { console.log('连不上 Chrome'); server.close(); proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  if (msg.method === 'Log.entryAdded') logs.push('[' + msg.params.entry.level + '] ' + msg.params.entry.text);
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// headless=new 下 attach 之后必须显式导航一次，否则停在一开始的 about:blank
await send('Page.navigate', { url });

// 等 __v 出现（模型加载是异步的）
let diag = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: 'window.__v ? JSON.stringify(window.__v) : null' });
  if (r.result?.value) { diag = JSON.parse(r.result.value); break; }
}
if (!diag) { console.log('超时：页面没有产出 __v'); console.log(logs.join('\n')); ws.close(); proc.kill(); server.close(); process.exit(1); }

console.log('\n== 页面诊断 ==');
console.log('  加载 ' + (diag.loaded ? '成功' : '失败 ' + diag.error));
console.log('  bbox ' + diag.bbox);
for (const m of diag.meshes) console.log(`    ${m.name.padEnd(14)} ${String(m.verts).padStart(6)}点 ${m.mat.padEnd(20)} map=${m.hasMap ? '有' : '无'} targets=${m.targets}`);
console.log('  morph ' + diag.morphs.length + ' 个: ' + diag.morphs.join(' '));
if (diag.headBone) console.log('  头骨世界坐标 ' + JSON.stringify(diag.headBone) + '  脸盒 ' + JSON.stringify(diag.faceBox) + '  尺寸 ' + JSON.stringify(diag.faceSize));
if (diag.cam) console.log('  相机 ' + JSON.stringify(diag.cam));
if (diag.texInfo) console.log('  首个贴图: ' + JSON.stringify(diag.texInfo));
if (diag.seen) console.log('  three 看到的: ' + JSON.stringify(diag.seen));
if (diag.probe) console.log('  逐 target 取值: ' + JSON.stringify(diag.probe));
if (diag.stack) console.log('\n堆栈：\n' + diag.stack);
console.log('  已灌 ' + JSON.stringify(diag.applied));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('\n截图 -> ' + OUT + '  (' + (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB)');
if (logs.length) console.log('\n-- console --\n' + logs.join('\n'));

ws.close(); proc.kill(); server.close();
process.exit(0);
