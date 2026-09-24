// mh-ab.mjs —— A/B 截图对照：隐藏头发 vs 显示头发
// ===========================================================================
// 目的：确认左脸那块黑色面片到底是不是头发造成的。
// 做法：同一相机、同一光照，先隐藏所有配件截一张（A），再全部显示截一张（B），
//       然后逐像素比对，输出"差异像素的包围盒 + 差异率"。
//       差异像素若正好落在左脸区域 → 确认是配件造成的。
//       若两张一样 → 那块黑色来自身体网格本身（贴图/法线问题）。
//
// 用法: node tools/mh-ab.mjs [port] [outName]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4760);
const OUTNAME = process.argv[3] || 'ab';
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhab-${Date.now()}`,
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
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
});
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); logs.forEach((l) => console.log(l)); process.exit(1); }

await ev(`(()=>{
  const r = window.__dbg.getRenderer(); const c = r.domElement;
  r.setPixelRatio(1); r.setSize(c.clientWidth||innerWidth, c.clientHeight||innerHeight, false);
  for (const id of ['panel','boot','views','meta']) { const e=document.getElementById(id); if(e) e.style.display='none'; }
  return 1;
})()`);

const grab = async () => {
  await ev('window.__dbg.forceRender()');
  await sleep(200);
  return await ev(`(()=>{
    const r=window.__dbg.getRenderer(), gl=r.getContext(), c=r.domElement;
    const w=c.width,h=c.height,buf=new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    const out=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++){const s=(h-1-y)*w*4,d=y*w*3;
      for(let x=0;x<w;x++){out[d+x*3]=buf[s+x*4];out[d+x*3+1]=buf[s+x*4+1];out[d+x*3+2]=buf[s+x*4+2];}}
    let bin='';const CH=0x8000;
    for(let i=0;i<out.length;i+=CH) bin+=String.fromCharCode.apply(null,out.subarray(i,i+CH));
    return btoa(bin);
  })()`);
};

const setWear = async (on) => {
  return await ev(`(()=>{
    const out=[];
    window.__dbg.walk(o=>{ if((o.isMesh||o.isSkinnedMesh) && /Hair|Brow|Lash|Eye|长发/i.test(o.name||'')){ o.visible=${on}; out.push(o.name+':'+o.visible); } });
    return out.join(' ');
  })()`);
};

const FACE_CAM = [0, 1.578, 0.36, 0, 1.575, 0.10];

// A: 关掉所有配件
await ev(`window.__dbg.setCam(${FACE_CAM.join(',')})`);
await setWear(false);
await sleep(500);
const b64A = await grab();
// B: 全开
await setWear(true);
await sleep(500);
const b64B = await grab();

const W = await ev('window.__dbg.getRenderer().domElement.width');
const H = await ev('window.__dbg.getRenderer().domElement.height');
const A = Buffer.from(b64A, 'base64'), B = Buffer.from(b64B, 'base64');
fs.writeFileSync(path.join(OUTDIR, `${OUTNAME}-A-noparts.png`), encodePNG(W, H, A));
fs.writeFileSync(path.join(OUTDIR, `${OUTNAME}-B-allparts.png`), encodePNG(W, H, B));

// 逐像素差异
let diff = 0;
let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
const TH = 40;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  if (d > TH) { diff++; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
}
console.log(`画布 ${W}x${H}`);
console.log(`差异像素 ${diff} / ${W * H} = ${(diff / (W * H) * 100).toFixed(2)}%`);
console.log(diff ? `差异包围盒 px: x ${mnx}..${mxx}, y ${mny}..${mxy}（左上原点）` : '两图完全一致（在阈值内）→ 那块黑色不来自配件');
console.log(`A(无配件) -> ${path.join(OUTDIR, OUTNAME + '-A-noparts.png')}`);
console.log(`B(全配件) -> ${path.join(OUTDIR, OUTNAME + '-B-allparts.png')}`);
logs.filter((l) => /部件|眼球/.test(l)).forEach((l) => console.log('PAGE ' + l));

srv.close(); chrome.kill(); process.exit(0);
