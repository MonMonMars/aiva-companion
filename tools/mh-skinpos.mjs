// mh-skinpos.mjs —— 对比"原始顶点位置"与"蒙皮后顶点位置"，找出渲染真实位置
// ===========================================================================
// 为什么必须做：three.js 的 Raycaster 对 SkinnedMesh 求交时用的是**未蒙皮的顶点**，
// 所以任何基于 geometry.attributes.position 的探针都可能给出与实际渲染不符的结果。
// 实测证据：反投影屏幕暗块命中 AIVA_HairLong @ (-0.0414, 1.5859, 0.1619)，
// 但手写三角形求交在整块左脸区域 0 命中 —— 两者矛盾，必有一方算错了坐标。
//
// 本工具在页面里按 three.js 的蒙皮公式重算顶点世界位置：
//   skinned = Σ_i w_i · (boneMatrixWorld_i · boneInverse_i) · bindMatrix · pos
// 并与 matrixWorld · pos 对比，输出最大偏差、以及"蒙皮后落在左眼前方"的顶点数。
//
// 用法: node tools/mh-skinpos.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4780);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhsp-${Date.now()}`,
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
  const THREE = window.__dbg.THREE_NS;
  const meshes=[];
  window.__dbg.walk(o=>{if((o.isMesh||o.isSkinnedMesh)&&o.visible)meshes.push(o);});
  const hair=meshes.find(o=>/Hair|长发/i.test(o.name||''));
  if(!hair) return JSON.stringify({err:'no hair'});
  if(!hair.isSkinnedMesh) return JSON.stringify({err:'hair 不是 SkinnedMesh'});

  const g=hair.geometry, p=g.attributes.position;
  const si=g.attributes.skinIndex, sw=g.attributes.skinWeight;
  const bones=hair.skeleton.bones, inv=hair.skeleton.boneInverses, bm=hair.bindMatrix;

  const boneMats=bones.map(b=>{
    const m=new THREE.Matrix4().multiplyMatrices(b.matrixWorld, inv[bones.indexOf(b)] || new THREE.Matrix4());
    return m;
  });

  const bindIdent = (()=>{const I=new THREE.Matrix4().identity();
    let d=0; for(let i=0;i<16;i++) d=Math.max(d,Math.abs(bm.elements[i]-I.elements[i])); return d;})();

  let maxDev=0, sumDev=0, n=0;
  let inFrontLeftEye=0, inFrontRightEye=0;
  const samples=[];
  const v=new THREE.Vector3(), acc=new THREE.Vector3(), tmp=new THREE.Vector3();

  for(let i=0;i<p.count;i++){
    // 原始（matrixWorld 变换）
    v.set(p.getX(i),p.getY(i),p.getZ(i)).applyMatrix4(hair.matrixWorld);
    const rx=v.x, ry=v.y, rz=v.z;
    // 蒙皮
    acc.set(0,0,0);
    let wsum=0;
    for(let k=0;k<4;k++){
      const bi=si.getComponent(i,k), w=sw.getComponent(i,k);
      if(!w) continue;
      wsum+=w;
      tmp.copy(new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i)));
      // bindMatrix 先行
      tmp.applyMatrix4(bm);            // 到绑定空间
      tmp.applyMatrix4(boneMats[bi]);  // 骨矩阵×IBM
      acc.addScaledVector(tmp, w);
    }
    // 最后再乘 mesh 的 matrixWorld 的旋转部分（这里 mesh 无旋转，直接用父级）
    let sx=acc.x, sy=acc.y, sz=acc.z;
    if(hair.parent && hair.parent.parent && hair.parent.parent !== hair){
      // 部件 root 无变换，跳过
    }
    const d=Math.hypot(sx-rx,sy-ry,sz-rz);
    if(d>maxDev){maxDev=d;}
    sumDev+=d; n++;
    if(d>1e-4 && samples.length<8) samples.push({i, raw:[+rx.toFixed(4),+ry.toFixed(4),+rz.toFixed(4)], skinned:[+sx.toFixed(4),+sy.toFixed(4),+sz.toFixed(4)], d:+d.toFixed(4)});
    // 统计"蒙皮后"落在左/右眼前方的量（Z > 0.1453 且 |X±0.0314|<0.016 且 |Y-1.5775|<0.018）
    if(sz>0.1453){
      if(Math.abs(sy-1.5775)<0.018){
        if(Math.abs(sx-(-0.0314))<0.016) inFrontLeftEye++;
        if(Math.abs(sx-(0.0314))<0.016) inFrontRightEye++;
      }
    }
  }
  return JSON.stringify({
    verts:n, boneCount:bones.length,
    bindMatrixIdentityDeviation:+bindIdent.toFixed(8),
    maxDevRawVsSkinned:+maxDev.toFixed(6),
    meanDevRawVsSkinned:+(sumDev/n).toFixed(6),
    // 若 maxDev 显著 >0，说明**渲染的几何与 geometry.position 不是一回事**
    inFrontLeftEye_skinned:inFrontLeftEye,
    inFrontRightEye_skinned:inFrontRightEye,
    devSamples:samples,
  },null,1);
})()`);
console.log('=== 蒙皮位置 vs 原始位置 ===');
console.log(out);
srv.close(); chrome.kill(); process.exit(0);
