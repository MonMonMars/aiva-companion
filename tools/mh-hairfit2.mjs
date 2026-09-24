// mh-hairfit2.mjs —— 头发径向放大扫描：求"最小侵入"的最优 scale
// ===========================================================================
// mh-hairfit.mjs 已证明平移（X/Y/Z 全轴）单调变差 → 穿模是"头发半径偏小"，
// 必须在**头骨中心 O 的径向**上放大。
//
// 本工具扫描三个自由度：
//   1. 统一径向倍数 k        H' = O + (H-O)*k
//   2. 分轴倍数 (kx,ky,kz)   H' = O + (H-O)*diag(kx,ky,kz)
//   3. 只放大"侵入的那部分"  用权重 w(depth) 做局部推开（软推）
// 输出各方案后的侵入顶点数与最深深度，找侵入 → 0 的最小 k。
//
// 用法: node tools/mh-hairfit2.mjs [port] [partRegex]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4640);
const PART = process.argv[3] || 'Hair';
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhhair2-${Date.now()}`,
  '--window-size=900,900', '--no-first-run', '--no-default-browser-check',
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

const script = `(()=>{
  const PART = ${JSON.stringify(PART)};
  function worldVerts(o){
    const g=o.geometry, p=g.attributes.position; const e=o.matrixWorld.elements;
    const out=new Float32Array(p.count*3);
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      out[i*3]  = e[0]*x+e[4]*y+e[8]*z+e[12];
      out[i*3+1]= e[1]*x+e[5]*y+e[9]*z+e[13];
      out[i*3+2]= e[2]*x+e[6]*y+e[10]*z+e[14];
    }
    return out;
  }
  const body=[], part=[];
  window.__dbg.walk((o)=>{
    if(!(o.isMesh||o.isSkinnedMesh)) return;
    if(!o.visible) return;
    const nm=o.name||'';
    if(/AIVA_Body|Body/i.test(nm) && !/Hair|Brow|Lash|Eye/i.test(nm)) body.push(o);
    if(new RegExp(PART,'i').test(nm)) part.push(o);
  });
  if(!body.length||!part.length) return JSON.stringify({err:'网格缺失'});
  const bv=body.map(worldVerts), pv=part.map(worldVerts);

  const CHIN_Y=1.42;
  const hx=[],hy=[],hz=[];
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
  for(const w of bv) for(let i=0;i<w.length;i+=3){
    const Y=w[i+1]; if(Y<CHIN_Y) continue;
    hx.push(w[i]);hy.push(Y);hz.push(w[i+2]);
    if(w[i]<mnx)mnx=w[i]; if(Y<mny)mny=Y; if(w[i+2]<mnz)mnz=w[i+2];
    if(w[i]>mxx)mxx=w[i]; if(Y>mxy)mxy=Y; if(w[i+2]>mxz)mxz=w[i+2];
  }
  const nH=hx.length;
  const O=[(mnx+mxx)/2,(mny+mxy)/2,(mnz+mxz)/2];
  const CELL=0.02, key=(a,b,c)=>a+'_'+b+'_'+c;
  const grid=new Map();
  for(let i=0;i<nH;i++){const k=key(Math.floor(hx[i]/CELL),Math.floor(hy[i]/CELL),Math.floor(hz[i]/CELL));let a=grid.get(k);if(!a){a=[];grid.set(k,a);}a.push(i);}
  function nearest(x,y,z){
    const cx=Math.floor(x/CELL),cy=Math.floor(y/CELL),cz=Math.floor(z/CELL);
    let best=-1,bd=1e18;
    for(let r=1;r<=4;r++){
      for(let a=cx-r;a<=cx+r;a++)for(let b=cy-r;b<=cy+r;b++)for(let c=cz-r;c<=cz+r;c++){
        if(r>1&&Math.abs(a-cx)!==r&&Math.abs(b-cy)!==r&&Math.abs(c-cz)!==r)continue;
        const arr=grid.get(key(a,b,c)); if(!arr)continue;
        for(const i of arr){const dx=hx[i]-x,dy=hy[i]-y,dz=hz[i]-z;const d=dx*dx+dy*dy+dz*dz;if(d<bd){bd=d;best=i;}}
      }
      if(best>=0&&r>=3)break;
    }
    return {i:best,d:Math.sqrt(bd)};
  }
  // 侵入统计（对给定变换函数 fn 作用后的点）
  function evaluate(fn){
    let ins=0,deep=0,sum=0,bad=0;
    const buckets={};
    for(const w of pv) for(let i=0;i<w.length;i+=3){
      const q=fn(w[i],w[i+1],w[i+2]);
      const nr=nearest(q[0],q[1],q[2]); if(nr.i<0){bad++;continue;}
      const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
      let nx=cx-O[0],ny=cy-O[1],nz=cz-O[2];
      const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
      const dot=(q[0]-cx)*nx+(q[1]-cy)*ny+(q[2]-cz)*nz;
      if(dot<0){ins++;const d=-dot;sum+=d;if(d>deep)deep=d;
        const bk=(Math.floor(q[1]*20)/20).toFixed(2);buckets[bk]=(buckets[bk]||0)+1;}
    }
    return {ins,deepMM:+(deep*1000).toFixed(1),meanMM:+(sum/Math.max(1,ins)*1000).toFixed(1),arc:+((ins/nH*100)).toFixed(1),buckets};
  }

  const res={O:O.map(v=>+v.toFixed(4)),nH,nPartVerts:pv.reduce((a,w)=>a+w.length/3,0)};

  // A. 统一径向放大
  res.uniform=[];
  for(const k of [1.0,1.02,1.04,1.06,1.08,1.10,1.12,1.15,1.18,1.20,1.25,1.30]){
    const e=evaluate((x,y,z)=>[O[0]+(x-O[0])*k, O[1]+(y-O[1])*k, O[2]+(z-O[2])*k]);
    res.uniform.push([k,e.ins,e.deepMM,e.meanMM]);
  }

  // B. 只放大 X（头发"变宽"）与只放大 Z（"变厚"）
  res.axisOnly={};
  for(const ax of ['x','y','z']){
    res.axisOnly[ax]=[];
    for(const k of [1.0,1.1,1.2,1.3,1.4,1.5,1.6]){
      const e=evaluate((x,y,z)=>{
        const d={x:1,y:1,z:1}; d[ax]=k;
        return [O[0]+(x-O[0])*d.x, O[1]+(y-O[1])*d.y, O[2]+(z-O[2])*d.z];
      });
      res.axisOnly[ax].push([k,e.ins,e.deepMM,e.meanMM]);
    }
  }

  // C. 两轴组合：X×Z 网格搜索
  res.gridXZ=[];
  for(const kx of [1.0,1.05,1.10,1.15,1.20,1.25]){
    for(const kz of [1.0,1.05,1.10,1.15,1.20,1.25]){
      const e=evaluate((x,y,z)=>[O[0]+(x-O[0])*kx, y, O[2]+(z-O[2])*kz]);
      res.gridXZ.push([kx,kz,e.ins,e.deepMM]);
    }
  }

  // D. 只把"侵入的顶点"沿法向推出（软推，保持外侧形状不变）—— 这才是最干净的修法
  //    做法：先算每个顶点的侵入深度 d。若 d>0，沿头皮法向把顶点推 d+margin。
  res.pushFix=[];
  for(const margin of [0.0,0.001,0.002,0.003,0.005,0.008]){
    // 预计算每个顶点的推出量
    const push=[];
    for(const w of pv){const arr=[];
      for(let i=0;i<w.length;i+=3){
        const X=w[i],Y=w[i+1],Z=w[i+2];
        const nr=nearest(X,Y,Z);
        if(nr.i<0){arr.push(0,0,0);continue;}
        const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
        let nx=cx-O[0],ny=cy-O[1],nz=cz-O[2];
        const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
        const dot=(X-cx)*nx+(Y-cy)*ny+(Z-cz)*nz;
        if(dot<0){const need=-dot+margin;arr.push(nx*need,ny*need,nz*need);}
        else if(dot<margin){const need=margin-dot;arr.push(nx*need,ny*need,nz*need);}
        else arr.push(0,0,0);
      }
      push.push(arr);
    }
    let ins=0,deep=0;
    pv.forEach((w,wi)=>{const arr=push[wi];
      for(let i=0;i<w.length;i+=3){
        const q=[w[i]+arr[i],w[i+1]+arr[i+1],w[i+2]+arr[i+2]];
        const nr=nearest(q[0],q[1],q[2]);if(nr.i<0)continue;
        const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
        let nx=cx-O[0],ny=cy-O[1],nz=cz-O[2];
        const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
        const dot=(q[0]-cx)*nx+(q[1]-cy)*ny+(q[2]-cz)*nz;
        if(dot<0){ins++;const d=-dot;if(d>deep)deep=d;}
      }});
    res.pushFix.push([margin,ins,+(deep*1000).toFixed(1)]);
  }

  return JSON.stringify(res,null,1);
})()`;

console.log(await ev(script));
srv.close(); chrome.kill(); process.exit(0);
