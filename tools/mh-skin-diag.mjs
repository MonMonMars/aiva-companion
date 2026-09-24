// mh-skin-diag.mjs —— 量「蒙皮后」的真实顶点位置
// 几何本身是对的（mhproxy-diag 已证明），但浏览器里 Box3 报的包围盒是错的，
// 说明顶点被骨骼变换带跑了。这里用 skeleton 的真实矩阵重算一遍，找出元凶。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4611);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhsk-${Date.now()}`,
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

const out = await ev(`(()=>{
  const res = {};
  const meshes = [];
  window.__dbg.walk((o)=>{ if(o.isMesh||o.isSkinnedMesh) meshes.push(o); });
  const pick = (re)=>meshes.find((o)=>re.test(o.name||'')) || null;

  const report = (o) => {
    if(!o) return null;
    const g=o.geometry, p=g.attributes.position;
    const si=g.attributes.skinIndex, sw=g.attributes.skinWeight;
    const n=p.count;
    // --- 原始（仅 matrixWorld） ---
    let rmn=[1e9,1e9,1e9], rmx=[-1e9,-1e9,-1e9];
    const e=o.matrixWorld.elements;
    for(let i=0;i<n;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=e[0]*x+e[4]*y+e[8]*z+e[12], Y=e[1]*x+e[5]*y+e[9]*z+e[13], Z=e[2]*x+e[6]*y+e[10]*z+e[14];
      if(X<rmn[0])rmn[0]=X; if(Y<rmn[1])rmn[1]=Y; if(Z<rmn[2])rmn[2]=Z;
      if(X>rmx[0])rmx[0]=X; if(Y>rmx[1])rmx[1]=Y; if(Z>rmx[2])rmx[2]=Z;
    }
    // --- 蒙皮后 ---
    let smn=[1e9,1e9,1e9], smx=[-1e9,-1e9,-1e9];
    let wsumMin=1e9, wsumMax=-1e9, badW=0, maxDev=0, worst=null;
    const sk = o.skeleton;
    const bm = sk ? sk.boneMatrices : null;
    for(let i=0;i<n;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      // bindMatrix * v
      const be=o.bindMatrix.elements;
      const bx=be[0]*x+be[4]*y+be[8]*z+be[12];
      const by=be[1]*x+be[5]*y+be[9]*z+be[13];
      const bz=be[2]*x+be[6]*y+be[10]*z+be[14];
      let X=0,Y=0,Z=0, ws=0;
      for(let k=0;k<4;k++){
        const w=sw?sw.getComponent(i,k):0; ws+=w;
        if(!bm) continue;
        const j=si?si.getComponent(i,k):0; const o16=j*16;
        X+=w*(bm[o16]*bx+bm[o16+4]*by+bm[o16+8]*bz+bm[o16+12]);
        Y+=w*(bm[o16+1]*bx+bm[o16+5]*by+bm[o16+9]*bz+bm[o16+13]);
        Z+=w*(bm[o16+2]*bx+bm[o16+6]*by+bm[o16+10]*bz+bm[o16+14]);
      }
      if(ws<wsumMin)wsumMin=ws; if(ws>wsumMax)wsumMax=ws;
      if(Math.abs(ws-1)>1e-3) badW++;
      const d=Math.hypot(X-rmn[0]-0,0); // 只记位置
      if(X<smn[0])smn[0]=X; if(Y<smn[1])smn[1]=Y; if(Z<smn[2])smn[2]=Z;
      if(X>smx[0])smx[0]=X; if(Y>smx[1])smx[1]=Y; if(Z>smx[2])smx[2]=Z;
      const dev=Math.hypot(X-Y*0-Y, 0); // placeholder
      const dv = Math.hypot(X-(e[0]*x+e[4]*y+e[8]*z+e[12]), Y-(e[1]*x+e[5]*y+e[9]*z+e[13]), Z-(e[2]*x+e[6]*y+e[10]*z+e[14]));
      if(dv>maxDev){ maxDev=dv; worst={i, raw:[+(e[0]*x+e[4]*y+e[8]*z+e[12]).toFixed(4),+(e[1]*x+e[5]*y+e[9]*z+e[13]).toFixed(4),+(e[2]*x+e[6]*y+e[10]*z+e[14]).toFixed(4)], skinned:[+X.toFixed(4),+Y.toFixed(4),+Z.toFixed(4)], w:[0,1,2,3].map(k=>+(sw?sw.getComponent(i,k):0).toFixed(3)), j:[0,1,2,3].map(k=>(si?si.getComponent(i,k):0))}; }
    }
    return {
      name:o.name, verts:n,
      raw:{min:rmn.map(v=>+v.toFixed(4)),max:rmx.map(v=>+v.toFixed(4))},
      skinned:{min:smn.map(v=>+v.toFixed(4)),max:smx.map(v=>+v.toFixed(4))},
      weightSum:[+wsumMin.toFixed(4),+wsumMax.toFixed(4)], badWeightVerts:badW,
      maxDeviation:+maxDev.toFixed(4), worst,
      bones: sk?sk.bones.length:0, boneInverses: sk&&sk.boneInverses?sk.boneInverses.length:0,
      bindMatrixIdentity: (()=>{const b=o.bindMatrix.elements; return b[0]===1&&b[5]===1&&b[10]===1&&b[12]===0&&b[13]===0&&b[14]===0;})(),
      boneNames: sk?sk.bones.slice(0,3).map(b=>b.name):[],
    };
  };

  for(const [k,re] of [['lashes',/Lash/i],['brows',/Brow/i],['hair',/Hair/i],['eyeL',/EyePosX/]])
    res[k]=report(pick(re));

  // 骨骼静息世界位置抽样（验证 IBM 与 boneMatrixWorld 是否互逆）
  const boneProbe=[];
  window.__dbg.walk((o)=>{ if(o.isBone && /^(head|eye\\.L|eye\\.R|neck03|spine01)$/.test(o.name)) boneProbe.push({name:o.name, pos:[o.matrixWorld.elements[12],o.matrixWorld.elements[13],o.matrixWorld.elements[14]].map(v=>+v.toFixed(4))}); });
  res.boneProbe=boneProbe;
  return JSON.stringify(res,null,1);
})()`);
console.log(out);
srv.close(); chrome.kill(); process.exit(0);
