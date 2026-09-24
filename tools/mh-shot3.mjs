// mh-shot3.mjs —— MakeHuman 预览台三视图截图（全身 / 头部 / 面部）
// ===========================================================================
// ★ 唯一的取像素方式：gl.readPixels 直读 framebuffer。
//   canvas.toDataURL() 和 Page.captureScreenshot 在 --headless=new + SwiftShader
//   下都会把画面**周期性平铺**（实测 4 份 → 2 份 → 3.46 份），是浏览器合成层的
//   bug，不是 three.js 的问题。readPixels 绕开合成层，永远是对的。
//   （完整排查过程见 mheye-shot.mjs 顶部注释与 headless-threejs-capture skill）
// readPixels 的 y 轴自下而上，必须翻转。
//
// 用法: node tools/mh-shot3.mjs [port] [outName]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4591);
const OUTNAME = process.argv[3] || 'wear';
const OUTDIR = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/_shots/wear';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/mh-preview2.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhshot3-${Date.now()}`,
  '--window-size=1000,1000', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {}
}
if (!page) { console.error('无法连接 Chrome'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    const s = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${s}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); logs.forEach((l) => console.log(l)); process.exit(1); }

for (const l of logs) if (/部件|眼球|错误|error|失败|exception/i.test(l)) console.log('PAGE ' + l);

const VIEWS = [
  { k: 'full', cam: [0, 1.05, 2.9, 0, 1.0, 0] },
  { k: 'head', cam: [0, 1.60, 0.75, 0, 1.575, 0.05] },
  { k: 'face', cam: [0, 1.578, 0.36, 0, 1.575, 0.10] },
];

await ev(`(()=>{
  const r = window.__dbg.getRenderer && window.__dbg.getRenderer();
  if (!r) return 'no getRenderer';
  const c = r.domElement;
  r.setPixelRatio(1);
  r.setSize(c.clientWidth || innerWidth, c.clientHeight || innerHeight, false);
  for (const id of ['panel','boot','views','meta']) { const e = document.getElementById(id); if (e) e.style.display='none'; }
  return JSON.stringify({ canvas: [c.width, c.height] });
})()`).then((x) => console.log('渲染器状态:', x));

const grab = async () => {
  await ev('window.__dbg.forceRender()');
  await sleep(150);
  return await ev(`(()=>{
    const r = window.__dbg.getRenderer();
    const gl = r.getContext(); const c = r.domElement;
    const w = c.width, h = c.height;
    const buf = new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    const out = new Uint8Array(w*h*3);
    for (let y=0;y<h;y++){ const s=(h-1-y)*w*4, d=y*w*3;
      for (let x=0;x<w;x++){ out[d+x*3]=buf[s+x*4]; out[d+x*3+1]=buf[s+x*4+1]; out[d+x*3+2]=buf[s+x*4+2]; } }
    let bin=''; const CH=0x8000;
    for (let i=0;i<out.length;i+=CH) bin += String.fromCharCode.apply(null, out.subarray(i,i+CH));
    return btoa(bin);
  })()`);
};

for (const v of VIEWS) {
  await ev(`window.__dbg.setCam(${v.cam.join(',')})`);
  await sleep(500);
  const b64 = await grab();
  if (!b64) { console.log(v.k + ' 截图失败'); continue; }
  const rgb = Buffer.from(b64, 'base64');
  const w = await ev('window.__dbg.getRenderer().domElement.width');
  const h = await ev('window.__dbg.getRenderer().domElement.height');
  const png = encodePNG(w, h, rgb);
  const f = path.join(OUTDIR, `${OUTNAME}-${v.k}.png`);
  fs.writeFileSync(f, png);
  console.log(`${v.k}: ${w}x${h} -> ${f}  ${(png.length / 1024).toFixed(0)}KB`);
}

srv.close(); chrome.kill();
console.log('done');
process.exit(0);
