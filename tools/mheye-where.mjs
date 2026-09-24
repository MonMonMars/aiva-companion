// mheye-where.mjs —— 直接问页面：眼睛上的点在世界空间里朝哪，以及眼球球心在哪
// ===========================================================================
// 前面一直在离线推测"虹膜朝向 = +Z"，但渲染出来总是偏外侧，说明推测不对。
// 与其继续猜，不如**直接从渲染页面里读真实数据**：
//   1) 眼球球心（局部几何包围盒中心）在世界空间的位置
//   2) 把"UV 落在虹膜盘内的顶点"筛出来，看它们在**世界空间**里的方向
//      → 这就是真正该看的"注视方向"
//   3) 头部/眼眶骨骼（eyeL/eyeR/head）的世界朝向
// 有了这些，就能算出"要转多少度才能让虹膜朝正前方"，一次到位。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = 4593;
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

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT + 1}`,
  `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhwhere-${Date.now()}`,
  '--window-size=1384,749', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40 && !page; i++) { await sleep(400); try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); page = l.find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 80; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
await sleep(800);

const out = await ev(`(()=>{
  const THREE = window.__dbg.THREE || null;
  const res = { eyes: [], bones: [], head: null };
  const eyes = [];
  window.__dbg.walk(o => { if (o.isMesh && /^Eye(L|R)/.test(o.name||'')) eyes.push(o); });
  const obj = {};
  for (const m of eyes) {
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox.clone();
    const c = b.getCenter(new (m.position.constructor)());
    const worldC = c.clone();
    m.localToWorld(worldC);
    // 把 UV 落在虹膜盘内的顶点找出来（用 UV 距离），求世界空间方向均值
    const uv = m.geometry.attributes.uv, pos = m.geometry.attributes.position;
    const v = new (m.position.constructor)();
    // 这一版 UV 已经被重采样到 [0,1]，虹膜大致在以 (0.5,0.5) 为心、半径约 0.35 的圆内
    const dirs = [];
    let nzMax = -9, nzMin = 9;
    for (let i = 0; i < pos.count; i++) {
      const du = uv.getX(i) - 0.5, dv = uv.getY(i) - 0.5;
      if (Math.hypot(du, dv) > 0.40) continue;
      v.fromBufferAttribute(pos, i);
      const d = [v.x - c.x, v.y - c.y, v.z - c.z];
      const r = Math.hypot(d[0],d[1],d[2]) || 1;
      dirs.push([d[0]/r, d[1]/r, d[2]/r]);
      if (d[2]/r > nzMax) nzMax = d[2]/r;
      if (d[2]/r < nzMin) nzMin = d[2]/r;
    }
    let s=[0,0,0];
    for (const d of dirs) for (let k=0;k<3;k++) s[k]+=d[k];
    const Ln = Math.hypot(...s) || 1;
    obj[m.name] = {
      localCenter: c.toArray().map(x=>+x.toFixed(5)),
      worldCenter: worldC.toArray().map(x=>+x.toFixed(5)),
      nIrisSamples: dirs.length,
      irisDirLocal: s.map(x=>+(x/Ln).toFixed(4)),
      nzRange: [+nzMin.toFixed(3), +nzMax.toFixed(3)],
      parentName: m.parent ? m.parent.name : null,
      isSkinned: !!m.isSkinnedMesh,
      boneNames: m.skeleton ? m.skeleton.bones.slice(0,3).map(b=>b.name) : [],
    };
  }
  // 骨骼世界朝向
  const bn = {};
  window.__dbg.walk(o => {
    if (o.isBone && ['eyeL','eyeR','head','neck','spine03'].includes(o.name)) {
      o.updateWorldMatrix(true,false);
      const e = o.matrixWorld.elements;
      bn[o.name] = {
        pos: [+e[12].toFixed(5), +e[13].toFixed(5), +e[14].toFixed(5)],
        // 骨骼局部轴在世界空间的方向
        xAx: [+e[0].toFixed(4), +e[1].toFixed(4), +e[2].toFixed(4)],
        yAx: [+e[4].toFixed(4), +e[5].toFixed(4), +e[6].toFixed(4)],
        zAx: [+e[8].toFixed(4), +e[9].toFixed(4), +e[10].toFixed(4)],
      };
    }
  });
  return JSON.stringify({ eyes: obj, bones: bn }, null, 1);})()`);
console.log(out);
ws.close(); chrome.kill(); srv.close();
