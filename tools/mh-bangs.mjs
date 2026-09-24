// mh-bangs.mjs —— 量化刘海/前发对眼部的遮挡
// ===========================================================================
// 判据（几何层面，不靠肉眼）：
//   1. 从相机方向（+Z 朝前）沿"正前方"发一条射线，穿过脸最前方。
//      对每个眼中心 (x_eye, y_eye) 采样一个网格，看**有没有头发顶点**
//      落在该视线段的包围盒里。
//   2. 更直接：统计"头发顶点在脸部前方平面之前的数量，按 Y 分段"。
//      若 Y ∈ [眼高-8mm, 眼高+8mm] 的头发顶点多且集中在 |X| < 0.06 的区域，
//      说明刘海正盖在眼上。
//   3. 输出眼高区间内、脸部中轴带（|X|<0.07）的头发顶点 X/Y/Z 分布，
//      以及它们距眼球的最近距离。
//
// 用法: node tools/mh-bangs.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4710);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhbangs-${Date.now()}`,
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
  function worldVerts(o){const g=o.geometry,p=g.attributes.position,e=o.matrixWorld.elements;
    const out=new Float32Array(p.count*3);
    for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      out[i*3]=e[0]*x+e[4]*y+e[8]*z+e[12];out[i*3+1]=e[1]*x+e[5]*y+e[9]*z+e[13];out[i*3+2]=e[2]*x+e[6]*y+e[10]*z+e[14];}
    return out;}
  const hair=[],eyes=[],body=[];
  // ⚠️ 部件网格的 name 是中文（如"长发"），不是 "Hair" —— mhproxy 用 --name 写进去的。
  //    所以不能靠名字正则识别。改用几何特征：眼球在眼高有极小包围盒、头发是
  //    除身体外体积最大的那个。更稳的办法是让预览页暴露 wearRoots。
  const all=[];
  window.__dbg.walk((o)=>{if(!(o.isMesh||o.isSkinnedMesh)||!o.visible)return;all.push(o);});
  for(const o of all){
    const nm=o.name||'';
    const g=o.geometry; g.computeBoundingBox();
    const bb=g.boundingBox; const sz=[bb.max.x-bb.min.x,bb.max.y-bb.min.y,bb.max.z-bb.min.z];
    const vol=sz[0]*sz[1]*sz[2];
    o.userData.__sz=sz; o.userData.__vol=vol;
    if(/Eye/i.test(nm)) eyes.push(o);
    else if(/AIVA_Body|Body/i.test(nm)) body.push(o);
  }
  // 头发 = 非身体、非眼球、顶点最多的那个
  const others=all.filter(o=>!/Eye/i.test(o.name||'')&&!/AIVA_Body|Body/i.test(o.name||''));
  others.sort((a,b)=>b.geometry.attributes.position.count-a.geometry.attributes.position.count);
  if(others.length) hair.push(others[0]);

  // 眼球中心（按左右分别）
  const eyeInfo=[];
  for(const o of eyes){
    const P=worldVerts(o); let cx=0,cy=0,cz=0,n=P.length/3;
    let mnz=1e9,mxz=-1e9;
    for(let i=0;i<n;i++){cx+=P[i*3];cy+=P[i*3+1];cz+=P[i*3+2];if(P[i*3+2]<mnz)mnz=P[i*3+2];if(P[i*3+2]>mxz)mxz=P[i*3+2];}
    eyeInfo.push({name:o.name,ctr:[+(cx/n).toFixed(4),+(cy/n).toFixed(4),+(cz/n).toFixed(4)],frontZ:+mxz.toFixed(4),backZ:+mnz.toFixed(4)});
  }
  eyeInfo.sort((a,b)=>b.ctr[0]-a.ctr[0]);
  const eyeY = eyeInfo.length ? eyeInfo[0].ctr[1] : 1.5768;
  const eyeFrontZ = eyeInfo.length ? Math.max(...eyeInfo.map(e=>e.frontZ)) : 0.143;

  // 脸部前轮廓（|X|<0.035，眼高±8mm）
  let faceFrontAtEye=-1e9, faceFrontAll=-1e9, faceFrontY=0;
  for(const o of body){const P=worldVerts(o);
    for(let i=0;i<P.length/3;i++){const X=P[i*3],Y=P[i*3+1],Z=P[i*3+2];
      if(Math.abs(X)>0.035)continue;
      if(Z>faceFrontAll){faceFrontAll=Z;faceFrontY=Y;}
      if(Math.abs(Y-eyeY)<0.008&&Z>faceFrontAtEye)faceFrontAtEye=Z;}}

  // 头发顶点：按 Y 分段统计"落在脸部前方（Z > faceFrontAtEye*0.97）且 |X|<0.08"的数量
  const HP=[];
  for(const o of hair){const P=worldVerts(o);HP.push(P);}
  const bands={};
  let inFrontOfEyes=0, coveringEyes=0;
  const coverPts=[];
  const EYE_HALF_W=0.045, EYE_HALF_H=0.016;   // 眼裂半宽/半高（估算）
  for(const P of HP) for(let i=0;i<P.length/3;i++){
    const X=P[i*3],Y=P[i*3+1],Z=P[i*3+2];
    const bk=(Math.floor(Y*100)/100).toFixed(2);
    if(!bands[bk])bands[bk]={n:0,minZ:1e9,maxZ:-1e9,cx:0};
    const b=bands[bk]; b.n++; if(Z<b.minZ)b.minZ=Z; if(Z>b.maxZ)b.maxZ=Z; b.cx+=X;
    // 是否在眼高带内
    if(Math.abs(Y-eyeY)<0.020 && Z>faceFrontAtEye-0.02){
      inFrontOfEyes++;
      // 是否落在眼球前方投影区内
      for(const e of eyeInfo){
        if(Math.abs(X-e.ctr[0])<EYE_HALF_W && Math.abs(Y-e.ctr[1])<EYE_HALF_H && Z>e.frontZ-0.005){
          coveringEyes++; coverPts.push([+X.toFixed(4),+Y.toFixed(4),+Z.toFixed(4)]);
          break;
        }
      }
    }
  }
  // 每段的平均 X 与 Z 范围，取眼高附近几段
  const bandList=[];
  for(let y=1.50;y<=1.70;y+=0.01){
    const k=(Math.floor(y*100)/100).toFixed(2);
    const b=bands[k];
    bandList.push(b?{y:+k,n:b.n,minZ:+b.minZ.toFixed(4),maxZ:+b.maxZ.toFixed(4),meanX:+(b.cx/b.n).toFixed(4)}:null);
  }

  return JSON.stringify({
    eyeInfo, eyeY:+eyeY.toFixed(4), eyeFrontZ:+eyeFrontZ.toFixed(4),
    faceFrontAtEye:+faceFrontAtEye.toFixed(4), faceFrontAll:+faceFrontAll.toFixed(4), faceFrontY:+faceFrontY.toFixed(4),
    hairVertsNearEyeBand: inFrontOfEyes,
    coveringEyeVerts: coveringEyes,
    coverSample: coverPts.slice(0,15),
    bandsPer1cm: bandList,
  },null,1);
})()`;

console.log(await ev(script));
srv.close(); chrome.kill(); process.exit(0);
