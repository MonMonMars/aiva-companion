// mh-look.mjs —— 多角度全身/半身"观感"截图（不裁剪、不贴脸）
// ===========================================================================
// 教训：face 视图（相机 Z=0.36）离脸太近，会把紧贴相机的发丝裁成大片黑块，
// 产生"模型很糟"的错觉。评估外观应该用正常观看距离。
//
// 本工具输出 4 个标准视角：
//   front  正面半身（Z=1.60）
//   bust   面部特写（Z=0.80，相机抬到眼高，俯角≈0）
//   side34 3/4 侧（偏 40°）
//   back   背面半身
//
// 用法: node tools/mh-look.mjs [port] [outName] [hairIdx]
//   hairIdx 省略 = 用页面默认发型（0=动漫高模，见 mh-preview2.js 的 HAIR_STYLES）；
//   传 1 = 长直发（面条发型）。对比两套时跑两次，输出 look1-* / look2-*。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4820);
const OUTNAME = process.argv[3] || 'look';
const HAIRIDX = process.argv[4] === undefined ? null : Number(process.argv[4]);
const OUTDIR = ROOT + '/_shots/wear';
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhlook-${Date.now()}`,
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
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

await ev(`(()=>{const r=window.__dbg.getRenderer(),c=r.domElement;r.setPixelRatio(1);r.setSize(c.clientWidth||innerWidth,c.clientHeight||innerHeight,false);
  for(const id of ['panel','boot','views','meta']){const e=document.getElementById(id);if(e)e.style.display='none';}
  // 关掉网格地面，避免干扰观感
  window.__dbg.walk(o=>{ if(o.type==='GridHelper') o.visible=false; });
  return 1;})()`);

const grab = async () => {
  await ev('window.__dbg.forceRender()');
  await sleep(220);
  return await ev(`(()=>{const r=window.__dbg.getRenderer(),gl=r.getContext(),c=r.domElement;
    const w=c.width,h=c.height,buf=new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    const out=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++){const s=(h-1-y)*w*4,d=y*w*3;
      for(let x=0;x<w;x++){out[d+x*3]=buf[s+x*4];out[d+x*3+1]=buf[s+x*4+1];out[d+x*3+2]=buf[s+x*4+2];}}
    let bin='';const CH=0x8000;for(let i=0;i<out.length;i+=CH)bin+=String.fromCharCode.apply(null,out.subarray(i,i+CH));
    return btoa(bin);})()`);
};

// 相机：绕角色目标点 (0,1.42,0) 摆放
// 切发型（异步：要等 GLB 下载 + 挂载完）
if (HAIRIDX !== null) {
  const r = await ev(`window.__setHair(${HAIRIDX}).then(()=>1).catch(e=>'ERR '+e)`);
  await sleep(1200);
  console.log('发型切换 ->', HAIRIDX, r);
  // 确认真的挂上了：数一下场景里的 SkinnedMesh 名字
  console.log('场景网格:', await ev(`(()=>{const o=[];window.__dbg.walk(x=>{if(x.isMesh||x.isSkinnedMesh)o.push(x.name+'('+x.geometry.attributes.position.count+')')});return o.join(' | ')})()`));
}

const TGT = [0, 1.42, 0.02];
// bust/side34 的相机高度刻意抬到接近眼高（1.52~1.55），俯角几乎为 0
// —— 这是检查"上下眼睑是否真的分开"的正确姿势。相机在胸口高度俯视时，
//    上眼睑会遮住虹膜上半，看起来像"眼睛没睁开"，那是视角问题不是模型问题。
const VIEWS = [
  { k: 'front', pos: [0, 1.45, 1.60] },
  { k: 'bust', pos: [0, 1.58, 0.80] },
  { k: 'side34', pos: [0.72, 1.56, 0.86] },
  { k: 'back', pos: [0, 1.45, -1.60] },
];

for (const v of VIEWS) {
  await ev(`window.__dbg.setCam(${v.pos.join(',')},${TGT.join(',')})`);
  await sleep(450);
  const b64 = await grab();
  const W = await ev('window.__dbg.getRenderer().domElement.width');
  const H = await ev('window.__dbg.getRenderer().domElement.height');
  const f = path.join(OUTDIR, `${OUTNAME}-${v.k}.png`);
  fs.writeFileSync(f, encodePNG(W, H, Buffer.from(b64, 'base64')));
  console.log(`${v.k}: ${W}x${H} -> ${f}`);
}
srv.close(); chrome.kill(); process.exit(0);
