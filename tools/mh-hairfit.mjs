// mh-hairfit.mjs —— 头发/配饰与头部皮层的穿模量化
// ===========================================================================
// 目的：把"看起来穿模"变成可比较的数字。
//
// 思路：
//   1. 从身体网格（AIVA_Body）里筛出"头部区域"的顶点（Y > 下巴线，默认 1.42m），
//      这些点构成头皮的散点云。
//   2. 对每个头发顶点 H，在头皮点云里找最近的 K 个点，用它们的平均法向/位置
//      估一个"头皮局部面"。判断 H 在这个面的内侧还是外侧，距离多少。
//      简化但够用的做法：取最近 N 个头皮点，算它们的**最近点平均** C，
//      再用 H→C 与头皮在 C 处的近似法向点积。
//   3. 输出：
//      - 侵入顶点数 / 总顶点数、百分比
//      - 最深侵入距离（米）
//      - 侵入顶点的 Y/X/Z 分布（定位在哪一块）
//      - 若把头发整体沿 +X/-X 平移 d，能减少多少侵入（扫描不同 d）
//
// 头皮近似法向用「顶点在头局部椭球上的归一化坐标」代替：以头骨中心 O 为准，
// n = normalize(V - O)。头是近椭球，这个近似对"内外"判断足够。
//
// 用法: node tools/mh-hairfit.mjs [port] [partRegex]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4630);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhhair-${Date.now()}`,
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

const partRe = JSON.stringify(PART);
const script = `(()=>{
  const PART = ${partRe};
  // ---- 1. 采集世界坐标 ----
  function worldVerts(o){
    const g=o.geometry, p=g.attributes.position; const e=o.matrixWorld.elements;
    // 若有蒙皮，用 bindMatrix 逆变换后的原始位置（静息姿态下 matrixWorld 已经够）
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
  if(!body.length) return JSON.stringify({err:'没有找到身体网格'});
  if(!part.length) return JSON.stringify({err:'没有找到部件网格: '+PART});

  let bv=[];
  for(const o of body){ const w=worldVerts(o); bv.push(w); }
  let pv=[];
  for(const o of part){ const w=worldVerts(o); pv.push(w); }

  // ---- 2. 头部区域筛选 ----
  const CHIN_Y = 1.42;
  const hx=[], hy=[], hz=[];
  let headMinY=1e9, headMaxY=-1e9, headMinZ=1e9, headMaxZ=-1e9, headMinX=1e9, headMaxX=-1e9;
  for(const w of bv) for(let i=0;i<w.length;i+=3){
    const Y=w[i+1]; if(Y<CHIN_Y) continue;
    hx.push(w[i]); hy.push(Y); hz.push(w[i+2]);
    if(Y<headMinY)headMinY=Y; if(Y>headMaxY)headMaxY=Y;
    if(w[i+2]<headMinZ)headMinZ=w[i+2]; if(w[i+2]>headMaxZ)headMaxZ=w[i+2];
    if(w[i]<headMinX)headMinX=w[i]; if(w[i]>headMaxX)headMaxX=w[i];
  }
  const nH = hx.length;
  if(!nH) return JSON.stringify({err:'头部区域没有顶点'});

  // 头骨中心（用头部区域包围盒中心；这是椭球近似原点）
  const O = [ (headMinX+headMaxX)/2, (headMinY+headMaxY)/2, (headMinZ+headMaxZ)/2 ];

  // ---- 3. 空间哈希加速最近点查询 ----
  const CELL = 0.02;
  const grid = new Map();
  const key=(a,b,c)=>a+'_'+b+'_'+c;
  for(let i=0;i<nH;i++){
    const k=key(Math.floor(hx[i]/CELL),Math.floor(hy[i]/CELL),Math.floor(hz[i]/CELL));
    let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i);
  }
  function nearestIndex(x,y,z){
    const cx=Math.floor(x/CELL),cy=Math.floor(y/CELL),cz=Math.floor(z/CELL);
    let best=-1,bd=1e18;
    for(let r=1;r<=4;r++){
      let found=false;
      for(let a=cx-r;a<=cx+r;a++)for(let b=cy-r;b<=cy+r;b++)for(let c=cz-r;c<=cz+r;c++){
        // 只扫壳层
        if(r>1 && Math.abs(a-cx)!==r && Math.abs(b-cy)!==r && Math.abs(c-cz)!==r) continue;
        const arr=grid.get(key(a,b,c)); if(!arr) continue;
        for(const i of arr){
          const dx=hx[i]-x,dy=hy[i]-y,dz=hz[i]-z; const d=dx*dx+dy*dy+dz*dz;
          if(d<bd){bd=d;best=i;found=true;}
        }
      }
      if(best>=0 && !found) break;
      if(best>=0 && r>=3) break;
    }
    return {i:best, d:Math.sqrt(bd)};
  }

  // ---- 4. 逐头发顶点判定"在皮下多少" ----
  // 头皮在最近点 C 处的近似法向 n = normalize(C - O)。
  // 若 (H - C)·n < 0 → H 在皮内，侵入深度 = |(H-C)·n|
  let nP=0, inside=0, deepest=0, deepPt=null;
  const buckets={};   // 按 Y 分段统计侵入顶点数
  const hist=[0,0,0,0,0,0]; // 侵入深度直方图: <5mm,5-10,10-20,20-40,40-80,>80mm
  let sumDepth=0, maxXinside=-1e9,minXinside=1e9, maxYinside=-1e9,minYinside=1e9, maxZinside=-1e9,minZinside=1e9;
  const insideBySide={neg:0,pos:0};
  for(const w of pv) for(let i=0;i<w.length;i+=3){
    const X=w[i],Y=w[i+1],Z=w[i+2];
    nP++;
    const nr=nearestIndex(X,Y,Z);
    if(nr.i<0) continue;
    const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
    let nx=cx-O[0],ny=cy-O[1],nz=cz-O[2];
    const nl=Math.hypot(nx,ny,nz)||1; nx/=nl;ny/=nl;nz/=nl;
    const dot=(X-cx)*nx+(Y-cy)*ny+(Z-cz)*nz;
    if(dot<0){
      inside++; const d=-dot; sumDepth+=d;
      if(d>deepest){deepest=d;deepPt=[+X.toFixed(4),+Y.toFixed(4),+Z.toFixed(4)];}
      const mm=d*1000;
      if(mm<5)hist[0]++;else if(mm<10)hist[1]++;else if(mm<20)hist[2]++;else if(mm<40)hist[3]++;else if(mm<80)hist[4]++;else hist[5]++;
      const bk=(Math.floor(Y*20)/20).toFixed(2); buckets[bk]=(buckets[bk]||0)+1;
      if(X>maxXinside)maxXinside=X; if(X<minXinside)minXinside=X;
      if(Y>maxYinside)maxYinside=Y; if(Y<minYinside)minYinside=Y;
      if(Z>maxZinside)maxZinside=Z; if(Z<minZinside)minZinside=Z;
      if(X<0)insideBySide.neg++; else insideBySide.pos++;
    }
  }

  // ---- 5. 平移扫描：整体挪动能否改善 ----
  const scan={};
  for(const axis of ['x','y','z']){
    const res=[];
    for(const d of [-0.08,-0.05,-0.03,-0.02,-0.01,0,0.01,0.02,0.03,0.05,0.08]){
      let ins=0, dp=0;
      for(const w of pv) for(let i=0;i<w.length;i+=3){
        const X=w[i]+(axis==='x'?d:0), Y=w[i+1]+(axis==='y'?d:0), Z=w[i+2]+(axis==='z'?d:0);
        const nr=nearestIndex(X,Y,Z); if(nr.i<0) continue;
        const cx=hx[nr.i],cy=hy[nr.i],cz=hz[nr.i];
        let nx=cx-O[0],ny=cy-O[1],nz=cz-O[2];
        const nl=Math.hypot(nx,ny,nz)||1; nx/=nl;ny/=nl;nz/=nl;
        const dot=(X-cx)*nx+(Y-cy)*ny+(Z-cz)*nz;
        if(dot<0){ins++; dp+=-dot;}
      }
      res.push([d, ins, +(dp*1000/Math.max(1,nP)).toFixed(2)]);
    }
    scan[axis]=res;
  }

  return JSON.stringify({
    partMeshes: part.map(o=>o.name),
    partVerts: nP,
    headVerts: nH,
    headBBox: {min:[+headMinX.toFixed(4),+headMinY.toFixed(4),+headMinZ.toFixed(4)], max:[+headMaxX.toFixed(4),+headMaxY.toFixed(4),+headMaxZ.toFixed(4)]},
    ellipsoidCenter: O.map(v=>+v.toFixed(4)),
    insideVerts: inside,
    insidePct: +(inside/nP*100).toFixed(2),
    deepestMM: +(deepest*1000).toFixed(1),
    deepestPt: deepPt,
    meanDepthMM: +(sumDepth/Math.max(1,inside)*1000).toFixed(1),
    histMM: {'<5':hist[0],'5-10':hist[1],'10-20':hist[2],'20-40':hist[3],'40-80':hist[4],'>80':hist[5]},
    insideBBox: inside?{min:[+minXinside.toFixed(3),+minYinside.toFixed(3),+minZinside.toFixed(3)],max:[+maxXinside.toFixed(3),+maxYinside.toFixed(3),+maxZinside.toFixed(3)]}:null,
    insideBySide,
    yBuckets: Object.fromEntries(Object.entries(buckets).sort((a,b)=>+a[0]-+b[0])),
    shiftScan: scan,
  },null,1);
})()`;

const out = await ev(script);
console.log(out);
srv.close(); chrome.kill(); process.exit(0);
