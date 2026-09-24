// mheye-render-probe.mjs —— 量「渲染出来的」眼睛像素，而不是靠看截图猜
// ===========================================================================
// 背景：源 OBJ 的 UV 已经证明是对的（左眼前极点 vt801 uv(0.706,0.707) 正落在
//       贴图上半颗眼球的虹膜上，右眼前极点 vt525 uv(0.293,0.305) 落在下半颗）。
//       所以如果渲染出来还是只有眼白，问题只可能在下面几处：
//         a) GLB 里嵌的贴图不是 brown_eye.png（或贴图内容不对）
//         b) 材质把 map 丢了 / colorSpace 不对
//         c) 眼球被别的网格遮住、或法线朝内导致背面剔除
//       本脚本把 canvas 渲到 PNG，在 Node 侧解码，直接统计**眼睛区域的像素颜色分布**，
//       用「有没有棕色/深色像素」来判定虹膜到底有没有出现。
//
// 用法: node tools/mheye-render-probe.mjs [port]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] || 4551);
const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png' };
const srv = (await import('node:http')).createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/mh-preview2.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mh4-${Date.now()}`,
  '--window-size=1384,749', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (m.params.exceptionDetails.exception?.description || ''));
});
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 60; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }

// 切到面部视角
await ev("document.getElementById('face').click()");
await sleep(1200);

// 1) 材质状态
console.log('=== 眼球材质状态 ===');
console.log(await ev(`(()=>{const o=[];window.__dbg.walk(x=>{if(x.isMesh&&x.name==='Eyes')o.push({
  name:x.name, isSkinned:!!x.isSkinnedMesh,
  matType:x.material.type,
  hasMap:!!x.material.map,
  mapColorSpace:x.material.map?x.material.map.colorSpace:'-',
  imgW:x.material.map&&x.material.map.image?x.material.map.image.width:0,
  imgH:x.material.map&&x.material.map.image?x.material.map.image.height:0,
  side:x.material.side, visible:x.visible,
  transparent:x.material.transparent, opacity:x.material.opacity,
  doubleSided:x.material.side===2,
  vc:x.geometry.attributes.position.count,
  uv0:x.geometry.attributes.uv?[+x.geometry.attributes.uv.getX(0).toFixed(4),+x.geometry.attributes.uv.getY(0).toFixed(4)]:null,
  uvMinMax:(()=>{const a=x.geometry.attributes.uv;let u0=9,u1=-9,v0=9,v1=-9;
    for(let i=0;i<a.count;i++){const u=a.getX(i),v=a.getY(i);if(u<u0)u0=u;if(u>u1)u1=u;if(v<v0)v0=v;if(v>v1)v1=v;}
    return [+u0.toFixed(4),+u1.toFixed(4),+v0.toFixed(4),+v1.toFixed(4)];})(),
});});return JSON.stringify(o,null,1);})()`));

// 2) 取渲染图并在 Node 侧统计眼睛区域像素
const shot = await ev("(window.__dbg.forceRender(),document.querySelector('canvas').toDataURL('image/png'))");
if (typeof shot === 'string' && shot.startsWith('data:image/png;base64,')) {
  const buf = Buffer.from(shot.slice('data:image/png;base64,'.length), 'base64');
  const png = decodePNG(buf);
  console.log(`\n=== 渲染图 ${png.w}x${png.h} ===`);
  // 眼睛大致在画面中间偏上：统计几个水平条带里「棕色」和「深色」像素的比例
  const brownish = (r, g, b) => r > 60 && r < 200 && r > b + 22 && g < r && b < 140;
  const dark = (r, g, b) => r < 80 && g < 80 && b < 80;
  const skin = (r, g, b) => r > 170 && r > b + 25 && g > b && r - g < 90;
  console.log('按垂直条带统计（y 为像素行，重点看眼睛所在高度）：');
  for (let band = 0; band < 12; band++) {
    const y0 = Math.floor(png.h * band / 12), y1 = Math.floor(png.h * (band + 1) / 12);
    let nb = 0, nd = 0, ns = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < png.w; x += 2) {
      const i = y * png.w * png.ch + x * png.ch;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      n++; if (brownish(r, g, b)) nb++; if (dark(r, g, b)) nd++; if (skin(r, g, b)) ns++;
    }
    console.log(`  y ${String(y0).padStart(4)}-${String(y1).padStart(4)}  棕${(nb / n * 100).toFixed(2)}%  深${(nd / n * 100).toFixed(2)}%  肤${(ns / n * 100).toFixed(1)}%`);
  }
  // 精确一点：按眼球的世界坐标 AABB 投影到屏幕，统计该矩形内颜色
  const rect = await ev(`(()=>{
    let m=null;window.__dbg.walk(o=>{if(o.isMesh&&o.name==='Eyes')m=o;});
    if(!m)return 'no mesh';
    m.geometry.computeBoundingBox();
    const bb=m.geometry.boundingBox;
    const c=new (m.position.constructor)(),tmp=new (m.position.constructor)();
    const cam=window.__dbg.cam();
    // 用 three 的投影：借助 renderer 的 canvas 尺寸，手工做 MVP 变换
    const out=[];
    for(const corner of [[bb.min.x,bb.min.y,bb.min.z],[bb.max.x,bb.max.y,bb.max.z]]){
      c.set(corner[0],corner[1],corner[2]);
      m.localToWorld(c);
      c.project(window.__dbg.getCamera());
      out.push([ (c.x*0.5+0.5)*window.innerWidth, (-c.y*0.5+0.5)*window.innerHeight ]);
    }
    return JSON.stringify(out);
  })()`);
  console.log('\n眼球 AABB 投影到屏幕的包围矩形:', rect);
  if (typeof rect === 'string' && rect.startsWith('[[')) {
    const [a, b] = JSON.parse(rect);
    const x0 = Math.max(0, Math.min(a[0], b[0])), x1 = Math.min(png.w, Math.max(a[0], b[0]));
    const y0 = Math.max(0, Math.min(a[1], b[1])), y1 = Math.min(png.h, Math.max(a[1], b[1]));
    let nb = 0, nd = 0, n = 0;
    for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) {
      const i = y * png.w * png.ch + x * png.ch;
      const r = png.data[i], g = png.data[i + 1], bl = png.data[i + 2];
      n++; if (brownish(r, g, bl)) nb++; if (dark(r, g, bl)) nd++;
    }
    console.log(`\n眼球矩形区域 x ${x0.toFixed(0)}-${x1.toFixed(0)} y ${y0.toFixed(0)}-${y1.toFixed(0)} 共 ${n} 像素`);
    console.log(`  棕色像素 ${nb} (${(nb / n * 100).toFixed(2)}%)   深色像素 ${nd} (${(nd / n * 100).toFixed(2)}%)`);
  }
} else console.log('取渲染图失败:', String(shot).slice(0, 200));

console.log('\n--- console ---');
console.log(logs.join('\n') || '（无）');
ws.close(); chrome.kill(); srv.close();

// ------------------------------------------------------------- PNG 解码
function decodePNG(b) {
  let p = 8, w = 0, h = 0, ch = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p); p += 4;
    const type = b.toString('ascii', p, p + 4); p += 4;
    const data = b.subarray(p, p + len); p += len + 4;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, data: out };
}
