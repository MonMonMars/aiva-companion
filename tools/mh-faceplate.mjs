// mh-faceplate.mjs —— 定位"脸上那块黑色面片"到底是什么几何
// ===========================================================================
// 现象：截图里左脸（-X 侧）有一块多边形把颧骨/下颌盖住。
// 已排除：不是穿模（mh-hairfit 实测侵入 0）、不是材质（材质已是带贴图的 MASK）。
// 现在要查：那块面片在不在脸的前方？它是头发整体的一绺，还是孤立的翻面片？
//
// 做法：
//   1. 从正面（+Z 向 -Z）对脸区域做射线，**记录命中点的 Z、所属三角形法线朝向**。
//      若命中点 Z 远小于脸皮 Z（比如小于 0.06），说明它是"贴在脸前面的一层"。
//   2. 统计命中三角形的法线·视线 的符号 —— 大量负值说明是**背面**（翻面），
//      这是低模头发的常见问题（法线朝内 → 光照全黑 → 看起来就是黑块）。
//   3. 输出该区域顶点的 UV，检查贴图那一片是否本身是深色。
//
// 用法: node tools/mh-faceplate.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4750);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhplate-${Date.now()}`,
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

const script = `(()=>{
  // 从"脸的正前方"沿 -Z 打射线，逐格记录：命中 Z、命中点法线朝向、UV、所属网格名
  // 关键判据：法线·(0,0,1) < 0 → 我们看到的是三角形的背面
  const meshes=[];
  window.__dbg.walk(m=>{if((m.isMesh||m.isSkinnedMesh)&&m.visible)meshes.push(m);});
  const hair=meshes.filter(m=>/Hair|长发/i.test(m.name||''));
  if(!hair.length) return JSON.stringify({err:'no hair'});

  function worldTris(o){
    const g=o.geometry,p=g.attributes.position,nr=g.attributes.normal,uv=g.attributes.uv;
    const e=o.matrixWorld.elements;
    const idx=g.index?Array.from(g.index.array):null;
    const cnt=idx?idx.length:p.count;
    const T=[];
    for(let t=0;t<cnt;t+=3){
      const ii=idx?[idx[t],idx[t+1],idx[t+2]]:[t,t+1,t+2];
      const V=[],N=[],UV=[];
      for(const k of ii){
        const x=p.getX(k),y=p.getY(k),z=p.getZ(k);
        V.push(e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]);
        if(nr){const a=nr.getX(k),b=nr.getY(k),c=nr.getZ(k);
          const X=e[0]*a+e[4]*b+e[8]*c, Y=e[1]*a+e[5]*b+e[9]*c, Z=e[2]*a+e[6]*b+e[10]*c;
          const L=Math.hypot(X,Y,Z)||1; N.push(X/L,Y/L,Z/L);}
        if(uv)UV.push(uv.getX(k),uv.getY(k));
      }
      T.push({V,N,UV});
    }
    return T;
  }
  const TR=[];
  for(const o of hair) TR.push(...worldTris(o));

  // 射线-三角形（起点已知，方向 D=(0,0,-1)）
  //   P = D × e2 ；D=(0,0,-1) 时：
  //     Px = Dy*e2z - Dz*e2y = 0*e2z - (-1)*e2y =  e2y
  //     Py = Dz*e2x - Dx*e2z = (-1)*e2x - 0     = -e2x
  //     Pz = Dx*e2y - Dy*e2x = 0 - 0            =  0
  //   ⚠️ 早期版本写成 px=-e2y, py=e2x（符号反了），导致全区域 0 命中，
  //      得出"左脸没有头发"的错误结论，白绕了一大圈。
  function hit(S,V){
    const ax=V[0],ay=V[1],az=V[2],bx=V[3],by=V[4],bz=V[5],cx=V[6],cy=V[7],cz=V[8];
    const e1=[bx-ax,by-ay,bz-az], e2=[cx-ax,cy-ay,cz-az];
    const px=e2[1], py=-e2[0], pz=0;
    const det=e1[0]*px+e1[1]*py+e1[2]*pz;
    if(Math.abs(det)<1e-12) return null;
    const inv=1/det;
    const tv=[S[0]-ax,S[1]-ay,S[2]-az];
    const u=(tv[0]*px+tv[1]*py+tv[2]*pz)*inv;
    if(u<0||u>1) return null;
    // Q = tv × e1
    const qx=tv[1]*e1[2]-tv[2]*e1[1], qy=tv[2]*e1[0]-tv[0]*e1[2], qz=tv[0]*e1[1]-tv[1]*e1[0];
    // v = D·Q * inv，D=(0,0,-1) → -Qz
    const v=(-qz)*inv;
    if(v<0||u+v>1) return null;
    // t = e2·Q * inv
    const tt=(e2[0]*qx+e2[1]*qy+e2[2]*qz)*inv;
    return tt;   // 沿 D=(0,0,-1) 走的距离；命中点 Z = S.z - tt
  }

  // 在脸的左半区扫（X -0.10..0.01, Y 1.44..1.62），起点 Z = 0.30
  const SZ=0.30;
  const rows=[];
  const back=[];   // 背面命中统计
  let hits=0, backHits=0, frontHits=0;
  const zHist=[];
  for(let y=1.44;y<=1.62;y+=0.01){
    let row='';
    for(let x=-0.10;x<=0.0101;x+=0.01){
      let best=null;
      for(const T of TR){const t=hit([x,y,SZ],T.V); if(t!==null&&t>1e-6){if(best===null||t<best.t){best={t,T};}}}
      if(!best){row+='.';continue;}
      hits++;
      const hitZ=SZ-best.t;
      // 命中三角形的几何法线（用顶点顺序算）
      const V=best.T.V;
      const a=[V[3]-V[0],V[4]-V[1],V[5]-V[2]], b=[V[6]-V[0],V[7]-V[1],V[8]-V[2]];
      const gn=[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const gl=Math.hypot(gn[0],gn[1],gn[2])||1;
      const facing = (gn[2]/gl);   // 几何法线 Z 分量；>0 面向相机，<0 背向
      // 顶点法线 Z 分量
      const vnz = best.T.N.length? best.T.N[2] : 0;
      if(facing<0) backHits++; else frontHits++;
      zHist.push(+hitZ.toFixed(4));
      row += facing<0 ? 'B' : 'F';     // B=背面 F=正面
    }
    rows.push('y='+y.toFixed(2)+' '+row);
  }
  zHist.sort((a,b)=>a-b);
  return JSON.stringify({
    hairMeshes:hair.map(m=>m.name),
    tris:TR.length,
    hits, frontHits, backHits,
    hitZ: zHist.length ? {min:+zHist[0].toFixed(4), med:+zHist[Math.floor(zHist.length/2)].toFixed(4), max:+zHist[zHist.length-1].toFixed(4)} : null,
    legend:'F=正面朝向相机  B=背面朝向相机(光照为黑)',
    grid:rows,
  },null,1);
})()`;

console.log(await ev(script));
srv.close(); chrome.kill(); process.exit(0);
