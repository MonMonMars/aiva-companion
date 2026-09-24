// mheye-shot.mjs —— 眼睛特写截图（自动按眼球投影框定位，不用手算坐标）
// ===========================================================================
// 为什么单独写这个：之前反复手工裁剪截图猜眼睛位置，费时且经常裁偏。
// 这个脚本从页面里取眼球 AABB 的投影坐标，自动居中裁剪并放大输出，
// 顺便打印「眼球区域内的棕/深色像素比例」作为虹膜是否出现的量化判据。
//
// 输出两张图：
//   <name>-face.png  正脸全身（看整体）
//   <name>-eye.png   双眼特写 6×（看细节）
//
// 判据参考：
//   全眼白  → 棕 ~0%    深 ~0%
//   有虹膜  → 棕 >20%   深 >2%
//
// 用法: node tools/mheye-shot.mjs [port] [outName]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodePNG, encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4581);
const OUTNAME = process.argv[3] || 'eyes-final';
const OUTDIR = 'C:/Users/Simon Lai/AppData/Local/Temp/mh2';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhshot-${Date.now()}`,
  '--window-size=1384,749', '--no-first-run', '--no-default-browser-check',
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
let id = 0; const pend = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    const s = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${s}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + JSON.stringify(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || m.params.exceptionDetails));
  }
});
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
// ⚠️ 必须显式设视口。--headless=new 的默认视口与 --window-size 不一致，
//   会导致预览页里 innerWidth/innerHeight 与 canvas drawing buffer 换算出错，
//   表现为 toDataURL/截图 里画面被水平平铺。设成固定视口后一切正常。
await send('Emulation.setDeviceMetricsOverride', {
  width: 900, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 80; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); logs.forEach((l) => console.log(l)); process.exit(1); }
await ev("document.getElementById('face').click()");
await sleep(1800);

// ⚠️ 坑：预览页的"面部"按钮走的是 OrbitControls 的阻尼插值，
//   点了之后相机是**渐进**过去的，sleep 1800ms 不一定到终点，
//   而且 forceRender 只渲染一帧、阻尼还没收敛。
//   → 这里直接用 __dbg.setCam 把相机放到确定位置（面部特写）。
//   实测：Y=1.575（眼睛高度），Z=1.05 时刚好框住整个头 + 一点肩。
await ev("window.__dbg.setCam(0, 1.545, 1.05, 0, 1.545, 0.10)");
await sleep(400);

// 打印页面日志（ErrorBoundary 会吞异常，只能靠 console）
for (const l of logs) if (/眼球|错误|error|失败|exception/i.test(l)) console.log('PAGE ' + l);

// ⚠️⚠️ 坑：canvas.toDataURL() 在 --headless=new 下**不可靠**。
//   实测：预览页 canvas 报 1368x598，但 toDataURL 出来的图里画面被
//   水平**平铺 4 份**（4 个并排的头）。原因是 headless 无 GPU 合成器时
//   drawing buffer 与 CSS 盒子的换算出错，preserveDrawingBuffer 也救不了。
//   → 改用 CDP 的 **Page.captureScreenshot**（走浏览器合成器，最可靠），
//     它按 CSS 像素输出，正是我们想要的。
await ev("window.__dbg.forceRender()");
// ⚠️⚠️ 平铺问题的**真正**根因（连试 3 轮才定位）：
//   预览页构造 renderer 时 setPixelRatio(min(devicePixelRatio,2))，
//   headless+Emulation 下 devicePixelRatio 可能报成 4，于是 drawing buffer
//   变成了 1360×4 = 5440 宽；但 setSize 只按 CSS 尺寸布局了 1 份内容，
//   于是 toDataURL 出来就是"1 份内容 + 3 份空白"的假平铺。
//   → 修法：截图前把 pixelRatio 强制设为 1 并重设尺寸，让 buffer 与 CSS 1:1。
// ★★★ 改用 gl.readPixels 直接读 framebuffer（连试 7 轮后的最终方案）
//
//   为什么放弃 canvas.toDataURL / Page.captureScreenshot：
//     实测两者在 --headless=new + SwiftShader 下都不可靠 —— 读出来的图里画面
//     周期性重复（换了视口尺寸后从 4 份变成 2 份再变成 3.46 份，周期总等于
//     "画布宽 / 某个整数"）。已排除的因素：
//       · canvas 数量（只有 1 个）      · drawingBuffer 尺寸（= CSS 尺寸）
//       · devicePixelRatio（= 1）       · camera.aspect（= 画布宽高比）
//       · #stage 的 position:fixed      · WebGL viewport（= 画布尺寸）
//     说明问题在**浏览器合成层**，不在 three.js。既然如此，就绕开合成层：
//     直接 bind 当前 framebuffer，用 readPixels 把像素拷出来。
//   注意：readPixels 的 y 轴是**自下而上**的，需要翻转。
await ev(`(()=>{
  const r = window.__dbg.getRenderer && window.__dbg.getRenderer();
  if (!r) return 'no getRenderer';
  const c = r.domElement;
  r.setPixelRatio(1);
  r.setSize(c.clientWidth || innerWidth, c.clientHeight || innerHeight, false);
  window.__dbg.forceRender();
  for (const id of ['panel', 'boot', 'views', 'meta']) {
    const e = document.getElementById(id); if (e) e.style.display = 'none';
  }
  window.__dbg.forceRender();
  return JSON.stringify({ canvas: [c.width, c.height], count: document.querySelectorAll('canvas').length });
})()`).then((x) => console.log('渲染器状态:', x));
await sleep(250);

const px = await ev(`(()=>{
  const r = window.__dbg.getRenderer();
  const gl = r.getContext();
  const c = r.domElement;
  const w = c.width, h = c.height;
  const buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  // 自下而上 → 转成自上而下（PNG 行序），同时丢弃 alpha（encodePNG 收 RGB）
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const srcOff = (h - 1 - y) * w * 4, dstOff = y * w * 3;
    for (let x = 0; x < w; x++) {
      out[dstOff + x * 3] = buf[srcOff + x * 4];
      out[dstOff + x * 3 + 1] = buf[srcOff + x * 4 + 1];
      out[dstOff + x * 3 + 2] = buf[srcOff + x * 4 + 2];
    }
  }
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < out.length; i += CH) bin += String.fromCharCode.apply(null, out.subarray(i, i + CH));
  return btoa(bin);
})()`);
if (!px || px.length < 100) { console.error('readPixels 失败：', String(px).slice(0, 200)); process.exit(1); }
{
  const c = await ev("(()=>{const k=window.__dbg.getRenderer().domElement;return JSON.stringify({w:k.width,h:k.height})})()");
  const { w: RW, h: RH } = JSON.parse(c);
  const raw = Buffer.from(px, 'base64');
  const src = { w: RW, h: RH, ch: 3, data: raw };
  console.log(`渲染图 ${src.w}x${src.h}（readPixels，${(raw.length / 1024).toFixed(0)}KB）`);

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, OUTNAME + '-face.png'), encodePNG(src.w, src.h, src.data));
  console.log(`写出 ${OUTNAME}-face.png`);

  // ② 眼睛投影框
  const rectRaw = await ev(`(()=>{
    const cs=[]; window.__dbg.walk(o=>{ if(o.isMesh && /^Eye(Pos|Neg)X|^Eye(L|R)/.test(o.name||'')) cs.push(o); });
    if(!cs.length) return null;
    const tmp=new (cs[0].position.constructor)();
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; const cam=window.__dbg.getCamera();
    for(const m of cs){
      m.geometry.computeBoundingBox();
      for(const [ax,ay,az] of [[0,0,0],[1,1,1]]){
        tmp.set(ax?m.geometry.boundingBox.max.x:m.geometry.boundingBox.min.x,
                ay?m.geometry.boundingBox.max.y:m.geometry.boundingBox.min.y,
                az?m.geometry.boundingBox.max.z:m.geometry.boundingBox.min.z);
        tmp.project(cam);
        const sx=(tmp.x*0.5+0.5)*innerWidth, sy=(-tmp.y*0.5+0.5)*innerHeight;
        x0=Math.min(x0,sx);x1=Math.max(x1,sx);y0=Math.min(y0,sy);y1=Math.max(y1,sy);
      }
    }
    return JSON.stringify({x0,y0,x1,y1,names:cs.map(m=>m.name)});})()`);
  if (!rectRaw) { console.error('页面里找不到眼球网格'); process.exit(1); }
  const R = JSON.parse(rectRaw);
  console.log(`眼球网格 ${R.names.join(',')}  投影 x${R.x0.toFixed(0)}-${R.x1.toFixed(0)} y${R.y0.toFixed(0)}-${R.y1.toFixed(0)}`);

  // ③ 裁眼睛特写（6×）
  const pad = 28;
  const x0 = Math.max(0, Math.floor(R.x0 - pad)), x1 = Math.min(src.w, Math.ceil(R.x1 + pad));
  const y0 = Math.max(0, Math.floor(R.y0 - pad)), y1 = Math.min(src.h, Math.ceil(R.y1 + pad));
  const zoom = 6;
  const ow = (x1 - x0) * zoom, oh = (y1 - y0) * zoom;
  const out2 = Buffer.alloc(ow * oh * 3);
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    const sx = Math.min(src.w - 1, x0 + Math.floor(i / zoom)), sy = Math.min(src.h - 1, y0 + Math.floor(j / zoom));
    const so = (sy * src.w + sx) * 3, d = (j * ow + i) * 3;
    out2[d] = src.data[so]; out2[d + 1] = src.data[so + 1]; out2[d + 2] = src.data[so + 2];
  }
  fs.writeFileSync(path.join(OUTDIR, OUTNAME + '-eye.png'), encodePNG(ow, oh, out2));
  console.log(`写出 ${OUTNAME}-eye.png (${ow}x${oh}) 裁剪 x${x0}-${x1} y${y0}-${y1}`);

  // ④ 眼睛区域像素统计（粗判虹膜是否显示）
  let brown = 0, dark = 0, white = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * src.w + x) * 3;
    const r2 = src.data[o], g2 = src.data[o + 1], b2 = src.data[o + 2];
    const lum = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;
    total++;
    if (lum < 70) dark++;
    else if (lum > 150 && Math.abs(r2 - b2) < 40) white++;
    else if (r2 - b2 > 20) brown++;
  }
  const pc = (n) => (n / Math.max(1, total) * 100).toFixed(1) + '%';
  console.log(`眼睛区域 ${total} 像素：棕(虹膜) ${pc(brown)}  深(瞳孔) ${pc(dark)}  浅(眼白) ${pc(white)}`);
}
// 顺便打印 irisProbe（正面顶点 UV），用来核对贴图选择
{
  const probe = await ev("JSON.stringify(window.__dbg.irisProbe())");
  console.log('\nirisProbe（各眼球最前顶点的 UV）:');
  try {
    for (const p of JSON.parse(probe)) console.log(`  ${p.side}  uv(${p.uv[0]}, ${p.uv[1]})  pos(${p.pos.join(', ')})`);
  } catch { console.log('  ' + probe); }
}

ws.close(); chrome.kill(); srv.close();
