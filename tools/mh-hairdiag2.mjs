// mh-hairdiag2.mjs —— 精确定位"左脸黑块"两个独立成因
// ===========================================================================
// 已确认的事实（不要重测）：
//   · 穿模已修：软推后侵入顶点 0（mhproxy.mjs 输出）
//   · 蒙皮位置 == 原始位置（maxDev=0），bindMatrix 单位阵
//   · 屏幕上左脸黑块反投影命中 AIVA_HairLong @ (-0.0414, 1.5859, 0.1619)
//   · 脸前有 228 个发光命中，其中 96 个是**背面**（几何法线背向相机）
//
// 因此黑块由两个独立成因叠加：
//   (A) 几何遮挡：左眼前方 1.9cm 处有发片（真挡住眼睛）
//   (B) 法线翻转：96 个三角形法线朝内，doubleSided 渲染成近黑
//
// 本工具只做一件事：把 (A) 与 (B) 分开量化，给出各自的坐标范围和数量。
//
// 用法: node tools/mh-hairdiag2.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4790);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhd2-${Date.now()}`,
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

const out = await ev(`(()=>{
  const THREE=window.__dbg.THREE_NS;
  const meshes=[]; window.__dbg.walk(o=>{if((o.isMesh||o.isSkinnedMesh)&&o.visible)meshes.push(o);});
  const hair=meshes.find(o=>/Hair|长发/i.test(o.name||''));
  const eyes=meshes.filter(o=>/Eye/i.test(o.name||''));
  if(!hair) return JSON.stringify({err:'no hair'});

  // 眼球几何（世界空间）：眼中心、前极
  const eyeInfo=[];
  for(const e of eyes){
    const p=e.geometry.attributes.position, m=e.matrixWorld.elements;
    let cx=0,cy=0,cz=0,mxz=-1e9,n=p.count;
    for(let i=0;i<n;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=m[0]*x+m[4]*y+m[8]*z+m[12],Y=m[1]*x+m[5]*y+m[9]*z+m[13],Z=m[2]*x+m[6]*y+m[10]*z+m[14];
      cx+=X;cy+=Y;cz+=Z;if(Z>mxz)mxz=Z;}
    eyeInfo.push({name:e.name,ctr:[cx/n,cy/n,cz/n],frontZ:mxz});
  }
  // 眼球椭圆尺寸（用包围盒）
  const eyeRad=[];
  for(const e of eyes){
    const p=e.geometry.attributes.position,m=e.matrixWorld.elements;
    let mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9;
    for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=m[0]*x+m[4]*y+m[8]*z+m[12],Y=m[1]*x+m[5]*y+m[9]*z+m[13];
      if(X<mnx)mnx=X;if(X>mxx)mxx=X;if(Y<mny)mny=Y;if(Y>mxy)mxy=Y;}
    eyeRad.push({name:e.name,rx:(mxx-mnx)/2,ry:(mxy-mny)/2});
  }

  // 头发三角形（世界空间）
  const g=hair.geometry,p=g.attributes.position,nrm=g.attributes.normal;
  const e=hair.matrixWorld.elements;
  const idx=g.index?g.index.array:null;
  const cnt=idx?idx.length:p.count;
  const F=[];   // {V, nz}
  for(let t=0;t<cnt;t+=3){
    const ii=idx?[idx[t],idx[t+1],idx[t+2]]:[t,t+1,t+2];
    const V=[];
    for(const k of ii){const x=p.getX(k),y=p.getY(k),z=p.getZ(k);
      V.push(e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]);}
    // 顶点法线 Z（取三顶点平均）
    let nz=0;
    if(nrm) for(const k of ii){const a=nrm.getX(k),b=nrm.getY(k),c=nrm.getZ(k);
      nz += (e[2]*a+e[6]*b+e[10]*c);}
    nz/=3;
    // 几何法线 Z
    const u=[V[3]-V[0],V[4]-V[1],V[5]-V[2]], w=[V[6]-V[0],V[7]-V[1],V[8]-V[2]];
    const gn=[u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
    const gl=Math.hypot(gn[0],gn[1],gn[2])||1;
    F.push({V, nz, gnz:gn[2]/gl});
  }

  // 把"脸前方"的头发三角形分成两类
  //   脸前方定义：三角形重心 Z > 0.145（眼球前极 0.1432 之外）
  const frontFace=[], atEyes=[];
  for(const f of F){
    const c=[(f.V[0]+f.V[3]+f.V[6])/3,(f.V[1]+f.V[4]+f.V[7])/3,(f.V[2]+f.V[5]+f.V[8])/3];
    f.c=c;
    if(c[2]>0.145) frontFace.push(f);
  }
  // 其中位于"眼睛投影带"的
  for(const f of frontFace){
    for(const ei of eyeInfo){
      const er=eyeRad.find(x=>x.name===ei.name);
      const hw=(er?er.rx:0.012)*1.6, hh=(er?er.ry:0.010)*1.8;
      if(Math.abs(f.c[0]-ei.ctr[0])<hw && Math.abs(f.c[1]-ei.ctr[1])<hh){
        atEyes.push({f, eye:ei.name}); break;
      }
    }
  }
  const flipped = frontFace.filter(f=>f.gnz<0);
  const flippedAtEyes = atEyes.filter(x=>x.f.gnz<0);

  // 分面：按 |X| 与 Y 统计翻转三角形的分布
  function bbox(list, key){ if(!list.length) return null;
    let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
    for(const it of list){const c=(key==='f'?it:it.f).c;
      for(let k=0;k<3;k++){if(c[k]<mn[k])mn[k]=c[k];if(c[k]>mx[k])mx[k]=c[k];}}
    return {min:mn.map(v=>+v.toFixed(4)),max:mx.map(v=>+v.toFixed(4))};}

  return JSON.stringify({
    eyeInfo:eyeInfo.map(x=>({name:x.name,ctr:x.ctr.map(v=>+v.toFixed(4)),frontZ:+x.frontZ.toFixed(4)})),
    eyeRad:eyeRad.map(x=>({name:x.name,rx:+x.rx.toFixed(4),ry:+x.ry.toFixed(4)})),
    hairTris:F.length,
    // (A) 眼睛正前方的发片
    trisAtEyes: atEyes.length,
    trisAtEyesFlipped: flippedAtEyes.length,
    atEyesBBox: bbox(atEyes,'item'),
    atEyesList: atEyes.slice(0,10).map(x=>({c:x.f.c.map(v=>+v.toFixed(4)), gnz:+x.f.gnz.toFixed(3), eye:x.eye})),
    // (B) 整个"脸前方"层的法线翻转情况
    frontFaceTris: frontFace.length,
    frontFaceFlipped: flipped.length,
    frontFaceFlippedPct: +(flipped.length/Math.max(1,frontFace.length)*100).toFixed(1),
    flippedBBox: bbox(flipped,'f'),
    // 全网格法线翻转总数
    allFlipped: F.filter(f=>f.gnz<0).length,
    allFlippedPct: +(F.filter(f=>f.gnz<0).length/F.length*100).toFixed(1),
  },null,1);
})()`);
console.log(out);
srv.close(); chrome.kill(); process.exit(0);
