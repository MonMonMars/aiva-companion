// mh-wear-diag.mjs —— 换装部件诊断：用页面自带的 __dbg.scene()（three.js 原生 Box3）
// 看三件事：部件世界包围盒是否落在解剖位置上、眼球是否陷进脸里、相机视线是否对得上眼。
// 用法: node tools/mh-wear-diag.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4601);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhdiag-${Date.now()}`,
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
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); logs.forEach((l) => console.log(l)); process.exit(1); }

console.log('--- 场景里所有网格 ---');
const list = await ev('JSON.stringify(window.__dbg.scene(), null, 1)');
console.log(list);

console.log('\n--- 眼球几何审计（page 内的 eyeAudit 或自算）---');
const eyes = await ev(`(()=>{
  const out=[];
  window.__dbg.walk((o)=>{
    if(!(o.isMesh||o.isSkinnedMesh)) return;
    if(!/Eye/i.test((o.name||'')+'|'+(o.geometry&&o.geometry.name||''))) return;
    const g=o.geometry, p=g.attributes.position;
    let cx=0,cy=0,cz=0, maxZ=-1e9, minZ=1e9, maxX=-1e9;
    const e=o.matrixWorld.elements;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=e[0]*x+e[4]*y+e[8]*z+e[12], Y=e[1]*x+e[5]*y+e[9]*z+e[13], Z=e[2]*x+e[6]*y+e[10]*z+e[14];
      cx+=X;cy+=Y;cz+=Z; if(Z>maxZ)maxZ=Z; if(Z<minZ)minZ=Z; if(X>maxX)maxX=X;
    }
    const n=p.count;
    out.push({name:o.name, verts:n, ctr:[+(cx/n).toFixed(4),+(cy/n).toFixed(4),+(cz/n).toFixed(4)], minZ:+minZ.toFixed(4), maxZ:+maxZ.toFixed(4), maxX:+maxX.toFixed(4)});
  });
  return JSON.stringify(out,null,1);
})()`);
console.log(eyes);

console.log('\n--- 脸部前轮廓（眼球高度附近，中轴 |X|<0.035）---');
const face = await ev(`(()=>{
  let best=-1e9, bestY=0, atEyeY=-1e9;
  window.__dbg.walk((o)=>{
    if(!(o.isMesh||o.isSkinnedMesh)) return;
    if(!o.visible) return;
    if(/Eye|Hair|Brow|Lash|teeth|tongue|lash/i.test(o.name||'')) return;
    const p=o.geometry&&o.geometry.attributes.position; if(!p) return;
    const e=o.matrixWorld.elements;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=e[0]*x+e[4]*y+e[8]*z+e[12], Y=e[1]*x+e[5]*y+e[9]*z+e[13], Z=e[2]*x+e[6]*y+e[10]*z+e[14];
      if(Math.abs(X)>0.035) continue;
      if(Z>best){best=Z;bestY=Y;}
      if(Math.abs(Y-1.5768)<0.008 && Z>atEyeY) atEyeY=Z;
    }
  });
  return JSON.stringify({headMostAnteriorZ:+best.toFixed(4), atY:+bestY.toFixed(4), faceFrontZ_atEyeY:+atEyeY.toFixed(4)});
})()`);
console.log(face);

console.log('\n--- 各部件包围盒（按可见性分组）---');
const parts = await ev(`(()=>{
  const groups={};
  window.__dbg.walk((o)=>{
    if(!(o.isMesh||o.isSkinnedMesh)) return;
    const nm=(o.name||'');
    let k=null;
    if(/Hair/i.test(nm)) k='hair'; else if(/Brow/i.test(nm)) k='brows'; else if(/Lash/i.test(nm)) k='lashes';
    else if(/Eye/i.test(nm)) k='eyes'; else if(/AIVA_Body/i.test(nm)||o.isSkinnedMesh&&!/Hair|Brow|Lash|Eye/i.test(nm)) k='body';
    if(!k) return;
    const g=o.geometry,p=g.attributes.position; const e=o.matrixWorld.elements;
    let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const X=e[0]*x+e[4]*y+e[8]*z+e[12], Y=e[1]*x+e[5]*y+e[9]*z+e[13], Z=e[2]*x+e[6]*y+e[10]*z+e[14];
      if(X<mn[0])mn[0]=X; if(Y<mn[1])mn[1]=Y; if(Z<mn[2])mn[2]=Z;
      if(X>mx[0])mx[0]=X; if(Y>mx[1])mx[1]=Y; if(Z>mx[2])mx[2]=Z;
    }
    (groups[k]=groups[k]||[]).push({name:nm, vis:o.visible, min:mn.map(v=>+v.toFixed(4)), max:mx.map(v=>+v.toFixed(4))});
  });
  return JSON.stringify(groups,null,1);
})()`);
console.log(parts);

console.log('\n--- 相机 ---');
console.log(await ev('JSON.stringify(window.__dbg.cam())'));

srv.close(); chrome.kill(); process.exit(0);
