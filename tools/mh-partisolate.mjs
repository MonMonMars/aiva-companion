// mh-partisolate.mjs —— 把头发按"连通片"染色渲染，一次看清是哪一片出问题
// ===========================================================================
// 前面已经排除了：穿模（侵入0）、蒙皮（dev=0）、bindMatrix（单位阵）、
// 大范围法线翻转（修到2.5%后渲染无变化）。
//
// 现在这一刀最直接：把头发网格的每个连通片用不同颜色画出来，截图。
// 之后一眼就能看出"左脸那块"是哪个连通片、这片有多大、是不是内衬。
// 同时输出每个连通片的信息（面数、包围盒、平均法线朝向），方便对着颜色找。
//
// 用法: node tools/mh-partisolate.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4810);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhiso-${Date.now()}`,
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
  for(const id of ['panel','boot','views','meta']){const e=document.getElementById(id);if(e)e.style.display='none';}return 1;})()`);

// 把头发按连通片染色（借用 mhproxy 的 flood-fill 思路，在页面里对几何做）
const info = await ev(`(()=>{
  const THREE=window.__dbg.THREE_NS;
  const meshes=[]; window.__dbg.walk(o=>{if((o.isMesh||o.isSkinnedMesh)&&o.visible)meshes.push(o);});
  const hair=meshes.find(o=>/Hair|长发/i.test(o.name||''));
  if(!hair) return JSON.stringify({err:'no hair'});
  const g=hair.geometry, idx=g.index?g.index.array:null;
  if(!idx) return JSON.stringify({err:'non-indexed, 本工具需要 index'});
  const T=idx.length/3;
  // 无向边邻接
  const em=new Map();
  const ek=(p,q)=>p<q?p+'_'+q:q+'_'+p;
  for(let t=0;t<T;t++){const v=[idx[t*3],idx[t*3+1],idx[t*3+2]];
    for(const [p,q] of [[v[0],v[1]],[v[1],v[2]],[v[2],v[0]]]){const k=ek(p,q);let l=em.get(k);if(!l){l=[];em.set(k,l);}l.push(t);}}
  const comp=new Int32Array(T).fill(-1);
  let cid=0;
  for(let s=0;s<T;s++){ if(comp[s]>=0) continue;
    const st=[s]; comp[s]=cid;
    while(st.length){const t=st.pop();const v=[idx[t*3],idx[t*3+1],idx[t*3+2]];
      for(const [p,q] of [[v[0],v[1]],[v[1],v[2]],[v[2],v[0]]]) for(const nb of em.get(ek(p,q))||[]) if(comp[nb]<0){comp[nb]=cid;st.push(nb);} }
    cid++; }
  // 每片包围盒 + 面数
  const P=g.attributes.position, m=hair.matrixWorld.elements;
  const stat=[];
  for(let c=0;c<cid;c++) stat.push({c,n:0,mn:[1e9,1e9,1e9],mx:[-1e9,-1e9,-1e9]});
  for(let t=0;t<T;t++){const s=stat[comp[t]]; s.n++;
    for(const k of [0,1,2]){const vi=idx[t*3+k];
      const x=P.getX(vi),y=P.getY(vi),z=P.getZ(vi);
      const X=m[0]*x+m[4]*y+m[8]*z+m[12],Y=m[1]*x+m[5]*y+m[9]*z+m[13],Z=m[2]*x+m[6]*y+m[10]*z+m[14];
      if(X<s.mn[0])s.mn[0]=X;if(Y<s.mn[1])s.mn[1]=Y;if(Z<s.mn[2])s.mn[2]=Z;
      if(X>s.mx[0])s.mx[0]=X;if(Y>s.mx[1])s.mx[1]=Y;if(Z>s.mx[2])s.mx[2]=Z;}}
  stat.sort((a,b)=>b.n-a.n);
  // 建 color attribute：每片一个色（用 HSV 均匀采样）
  const N=P.count;
  const col=new Float32Array(N*3);
  const pal=[];
  for(let c=0;c<cid;c++){
    const h=(c*0.6180339887)%1, s=0.85, v=0.95;
    const i=Math.floor(h*6), f=h*6-i, p=v*(1-s), q=v*(1-f*s), tt=v*(1-(1-f)*s);
    let r,g2,b;
    if(i===0){r=v;g2=tt;b=p;}else if(i===1){r=q;g2=v;b=p;}else if(i===2){r=p;g2=v;b=tt;}
    else if(i===3){r=p;g2=q;b=v;}else if(i===4){r=tt;g2=p;b=v;}else{r=v;g2=p;b=q;}
    pal.push([r,g2,b]);
  }
  for(let t=0;t<T;t++){const c=pal[comp[t]];
    for(const k of [0,1,2]){const vi=idx[t*3+k];col[vi*3]=c[0];col[vi*3+1]=c[1];col[vi*3+2]=c[2];}}
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  // 换成不受光材质，颜色就是片的编号色
  hair.material = new THREE.MeshBasicMaterial({vertexColors:true, side:THREE.DoubleSide});
  hair.material.needsUpdate = true;
  return JSON.stringify({
    cid, totalTris:T,
    top: stat.slice(0,18).map(s=>({c:s.c,n:s.n,
      hex:('#'+pal[s.c].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('')),
      mn:s.mn.map(v=>+v.toFixed(3)), mx:s.mx.map(v=>+v.toFixed(3))})),
  },null,1);
})()`);
console.log('=== 连通片染色 ===');
console.log(info);

const grab = async () => {
  await ev('window.__dbg.forceRender()');
  await sleep(200);
  return await ev(`(()=>{const r=window.__dbg.getRenderer(),gl=r.getContext(),c=r.domElement;
    const w=c.width,h=c.height,buf=new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    const out=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++){const s=(h-1-y)*w*4,d=y*w*3;
      for(let x=0;x<w;x++){out[d+x*3]=buf[s+x*4];out[d+x*3+1]=buf[s+x*4+1];out[d+x*3+2]=buf[s+x*4+2];}}
    let bin='';const CH=0x8000;for(let i=0;i<out.length;i+=CH)bin+=String.fromCharCode.apply(null,out.subarray(i,i+CH));
    return btoa(bin);})()`);
};

for (const [k, cam] of [['head', [0, 1.60, 0.75, 0, 1.575, 0.05]], ['face', [0, 1.578, 0.36, 0, 1.575, 0.10]]]) {
  await ev(`window.__dbg.setCam(${cam.join(',')})`);
  await sleep(400);
  const b64 = await grab();
  const W = await ev('window.__dbg.getRenderer().domElement.width');
  const H = await ev('window.__dbg.getRenderer().domElement.height');
  const f = path.join(OUTDIR, `iso-${k}.png`);
  fs.writeFileSync(f, encodePNG(W, H, Buffer.from(b64, 'base64')));
  console.log(`${k}: -> ${f}`);
}
srv.close(); chrome.kill(); process.exit(0);
