// mh-hairfit3.mjs —— 定位"推不干净"的顽固顶点 + 验证软推方案的真实效果
// ===========================================================================
// mh-hairfit2.mjs 结论：
//   - 任何径向放大 k，侵入都封顶在 ~450、最深恒 33mm → 有几何压根不在头表面附近
//   - 软推（沿头皮法向推出）margin=1mm 时侵入 1985 → 229（-88%）
//   - 但残余 229 个顶点仍有 30.6mm 深 → 它们被"推了却还在里面"（法向近似失效）
//
// 本工具做三件事：
//   1. 输出最深 30 个顶点的世界坐标 + 最近头皮点 + 法向 + 深度（定位空间位置）
//   2. 检查这些点是否属于同一个"连通片"（若聚成一簇 → 是某片内衬/发根）
//   3. 对顽固点改用"沿最近头皮点→头骨中心 O 的反向延长线"硬推（法向退化时更稳）
//
// 用法: node tools/mh-hairfit3.mjs [port] [partRegex]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4650);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhhair3-${Date.now()}`,
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
    const g=o.geometry,p=g.attributes.position,e=o.matrixWorld.elements;
    const out=new Float32Array(p.count*3);
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      out[i*3]=e[0]*x+e[4]*y+e[8]*z+e[12];
      out[i*3+1]=e[1]*x+e[5]*y+e[9]*z+e[13];
      out[i*3+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
    }
    return out;
  }
  const body=[],part=[];
  window.__dbg.walk((o)=>{ if(!(o.isMesh||o.isSkinnedMesh)||!o.visible)return;
    const nm=o.name||'';
    if(/AIVA_Body|Body/i.test(nm)&&!/Hair|Brow|Lash|Eye/i.test(nm)) body.push(o);
    if(new RegExp(PART,'i').test(nm)) part.push(o); });
  if(!body.length||!part.length) return JSON.stringify({err:'网格缺失'});
  const bv=body.map(worldVerts), pv=part.map(worldVerts);

  const CHIN_Y=1.42, hx=[],hy=[],hz=[];
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
  for(const w of bv) for(let i=0;i<w.length;i+=3){
    const Y=w[i+1]; if(Y<CHIN_Y)continue;
    hx.push(w[i]);hy.push(Y);hz.push(w[i+2]);
    if(w[i]<mnx)mnx=w[i]; if(Y<mny)mny=Y; if(w[i+2]<mnz)mnz=w[i+2];
    if(w[i]>mxx)mxx=w[i]; if(Y>mxy)mxy=Y; if(w[i+2]>mxz)mxz=w[i+2];
  }
  const nH=hx.length, O=[(mnx+mxx)/2,(mny+mxy)/2,(mnz+mxz)/2];
  const CELL=0.02,key=(a,b,c)=>a+'_'+b+'_'+c;
  const grid=new Map();
  for(let i=0;i<nH;i++){const k=key(Math.floor(hx[i]/CELL),Math.floor(hy[i]/CELL),Math.floor(hz[i]/CELL));let a=grid.get(k);if(!a){a=[];grid.set(k,a);}a.push(i);}
  function nearest(x,y,z){
    const cx=Math.floor(x/CELL),cy=Math.floor(y/CELL),cz=Math.floor(z/CELL);
    let best=-1,bd=1e18;
    for(let r=1;r<=4;r++){
      for(let a=cx-r;a<=cx+r;a++)for(let b=cy-r;b<=cy+r;b++)for(let c=cz-r;c<=cz+r;c++){
        if(r>1&&Math.abs(a-cx)!==r&&Math.abs(b-cy)!==r&&Math.abs(c-cz)!==r)continue;
        const arr=grid.get(key(a,b,c));if(!arr)continue;
        for(const i of arr){const dx=hx[i]-x,dy=hy[i]-y,dz=hz[i]-z;const d=dx*dx+dy*dy+dz*dz;if(d<bd){bd=d;best=i;}}
      }
      if(best>=0&&r>=3)break;
    }
    return {i:best,d:Math.sqrt(bd)};
  }
  const normalAt=(i)=>{let nx=hx[i]-O[0],ny=hy[i]-O[1],nz=hz[i]-O[2];const l=Math.hypot(nx,ny,nz)||1;return [nx/l,ny/l,nz/l];};

  // ---- 1. 收集所有侵入顶点，按深度排序 ----
  const items=[];
  for(let wi=0;wi<pv.length;wi++){const w=pv[wi];
    for(let i=0;i<w.length;i+=3){
      const X=w[i],Y=w[i+1],Z=w[i+2];
      const nr=nearest(X,Y,Z); if(nr.i<0)continue;
      const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
      const n=normalAt(nr.i);
      const dot=(X-cx)*n[0]+(Y-cy)*n[1]+(Z-cz)*n[2];
      if(dot<0) items.push({wi,vi:i/3,X,Y,Z,d:-dot,nearD:nr.d,ni:nr.i,dot});
    }}
  items.sort((a,b)=>b.d-a.d);

  const top30=items.slice(0,30).map(o=>({
    p:[+o.X.toFixed(4),+o.Y.toFixed(4),+o.Z.toFixed(4)],
    depthMM:+(o.d*1000).toFixed(1),
    near:[+hx[o.ni].toFixed(4),+hy[o.ni].toFixed(4),+hz[o.ni].toFixed(4)],
    distToNearMM:+(o.nearD*1000).toFixed(1),
  }));

  // ---- 2. 深度分层统计：多少顶点 >15mm（"根本不在这儿"的）----
  const deepLevels={};
  for(const t of [5,10,15,20,25,30]) deepLevels['>'+t+'mm']=items.filter(o=>o.d*1000>t).length;

  // ---- 3. 顽固核的空间聚类（简单网格聚类，cell=3cm）----
  const CC=0.03, clu=new Map();
  for(const o of items){ if(o.d*1000<15) continue;
    const k=key(Math.floor(o.X/CC),Math.floor(o.Y/CC),Math.floor(o.Z/CC));
    let a=clu.get(k); if(!a){a=[];clu.set(k,a);} a.push(o); }
  // 合并相邻 cell
  const cells=[...clu.keys()].map(k=>k.split('_').map(Number));
  const parent=new Map(); const find=(x)=>{while(parent.get(x)!==x)x=parent.get(x);return x;};
  const un=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
  cells.forEach((c,i)=>parent.set(i,i));
  for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
    const d=Math.max(Math.abs(cells[i][0]-cells[j][0]),Math.abs(cells[i][1]-cells[j][1]),Math.abs(cells[i][2]-cells[j][2]));
    if(d<=1)un(i,j);
  }
  const groups=new Map();
  cells.forEach((c,i)=>{const r=find(i);let g=groups.get(r);if(!g){g={cells:[],n:0,deep:0};groups.set(r,g);}
    g.cells.push(c); const arr=clu.get(c.join('_')); g.n+=arr.length;
    for(const o of arr) if(o.d*1000>g.deep) g.deep=o.d*1000;});
  const clusters=[...groups.values()].map(g=>{
    let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
    for(const c of g.cells){ mn[0]=Math.min(mn[0],c[0]*CC);mn[1]=Math.min(mn[1],c[1]*CC);mn[2]=Math.min(mn[2],c[2]*CC);
      mx[0]=Math.max(mx[0],(c[0]+1)*CC);mx[1]=Math.max(mx[1],(c[1]+1)*CC);mx[2]=Math.max(mx[2],(c[2]+1)*CC); }
    return {n:g.n,deepMM:+g.deep.toFixed(1),min:mn.map(v=>+v.toFixed(3)),max:mx.map(v=>+v.toFixed(3))};
  }).sort((a,b)=>b.n-a.n);
  const clustersPos=clusters.filter(c=>(c.min[0]+c.max[0])/2>0.005);
  const clustersNeg=clusters.filter(c=>(c.min[0]+c.max[0])/2<-0.005);

  // ---- 4. 改进的推出算法：法向失效时用"最近头皮点→O"的反向延长，并迭代 ----
  function evaluatePush(margin,iter,useHardFallback){
    // 深拷贝
    const cur=pv.map(w=>Float32Array.from(w));
    for(let it=0;it<iter;it++){
      for(let wi=0;wi<cur.length;wi++){const w=cur[wi];
        for(let i=0;i<w.length;i+=3){
          const X=w[i],Y=w[i+1],Z=w[i+2];
          const nr=nearest(X,Y,Z); if(nr.i<0)continue;
          const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
          let n=normalAt(nr.i);
          const dot=(X-cx)*n[0]+(Y-cy)*n[1]+(Z-cz)*n[2];
          // 法向退化检测：顶点几乎贴在最近点上，方向不可靠 → 用纯径向
          if(useHardFallback && nr.d<0.002){
            n=normalAt(nr.i);
          }
          if(dot<margin){
            const need=margin-dot;
            w[i]=X+n[0]*need; w[i+1]=Y+n[1]*need; w[i+2]=Z+n[2]*need;
          }
        }}}
    // 统计
    let ins=0,deep=0,sum=0;
    for(const w of cur) for(let i=0;i<w.length;i+=3){
      const X=w[i],Y=w[i+1],Z=w[i+2];
      const nr=nearest(X,Y,Z); if(nr.i<0)continue;
      const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
      const n=normalAt(nr.i);
      const dot=(X-cx)*n[0]+(Y-cy)*n[1]+(Z-cz)*n[2];
      if(dot<0){ins++;const d=-dot;sum+=d;if(d>deep)deep=d;}
    }
    return {ins,deepMM:+(deep*1000).toFixed(1),meanMM:+(sum/Math.max(1,ins)*1000).toFixed(1)};
  }

  const pushResults=[];
  for(const m of [0.001,0.002,0.003]) for(const it of [1,2,3,5]) pushResults.push({margin:m,iter:it,...evaluatePush(m,it,true)});

  return JSON.stringify({
    O:O.map(v=>+v.toFixed(4)),
    totalPartVerts:pv.reduce((a,w)=>a+w.length/3,0),
    totalInside:items.length,
    deepLevels,
    top30,
    clusterCount:clusters.length,
    clustersTop:clusters.slice(0,12),
    clustersPosCount:clustersPos.length, clustersNegCount:clustersNeg.length,
    clustersPosTop:clustersPos.slice(0,6), clustersNegTop:clustersNeg.slice(0,6),
    pushResults,
  },null,1);
})()`;

console.log(await ev(script));
srv.close(); chrome.kill(); process.exit(0);
