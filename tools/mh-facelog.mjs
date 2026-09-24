// mh-facelog.mjs —— 从预览页里把「骨架表情 / 眼球」的真实数据捞出来
// ===========================================================================
// 预览台用的不是主 App 的 makehumanFace.js / makehumanEyes.js，而是它自己那套
// （先把外观定下来，再接进 App）。所以这里只能读到：
//   · 骨架里到底有哪些候选表情骨（名字 + 父骨 + 相对 head 的位置）
//   · 眼球网格的绑定状态（skinIndex 是否全 0）
// 真正的 App 侧驱动要靠主 App 起来之后用 __aivaDebug.faceAngles() 验。
//
// 用法: node tools/mh-facelog.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4850);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhfacelog-${Date.now()}`,
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
  const THREE = window.__dbg.THREE_NS;
  const body = window.__dbg.find ? null : null;
  // 找出身体网格（名字含 AIVA_Body）和它的骨架
  let bodyMesh=null;
  window.__dbg.walk(o=>{ if(!bodyMesh && o.isSkinnedMesh && /AIVA_Body/i.test(o.name||'')) bodyMesh=o; });
  if(!bodyMesh){
    // 兜底：顶点最多的那个 SkinnedMesh
    let best=null;
    window.__dbg.walk(o=>{ if(o.isSkinnedMesh && (!best||o.geometry.attributes.position.count>best.geometry.attributes.position.count)) best=o; });
    bodyMesh=best;
  }
  const bones=[]; window.__dbg.walk(o=>{ if(o.isBone) bones.push(o); });
  // ⚠️ 必须先 updateWorldMatrix 再取 rotation / position：
  //    否则 matrixWorld 还是初始值，量出来的 dFromHead 全是 0 或 NaN。
  //    父链也要更新（true），因为 head 在 neck 下面。
  const ensure = (b) => { if (!b) return null; b.updateWorldMatrix(true, false); return b; };
  // head 骨：名字可能是 head / head01 之类，用 startsWith 更稳
  const head = ensure(bones.find(b=>/^head/i.test(b.name || '')) || null);
  const headPos = head ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld) : null;

  // ---- 1) 直接列出「head 骨的直接+二级子骨」—— 这才是表情骨的真实集合 ----
  // ⚠️ 不要靠正则猜名字。所有面部肌肉骨都是 head 的后代，直接按树往下走最可靠。
  const faceBones=[];
  (function walk(o, depth){
    if(!o||!o.children||depth>2) return;
    o.children.forEach(c=>{
      if(c.isBone && c.matrixWorld){
        c.updateWorldMatrix(true, false);
        const p=new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
        faceBones.push({name:c.name, depth,
          pos:[+p.x.toFixed(4),+p.y.toFixed(4),+p.z.toFixed(4)],
          dFromHead: headPos?+p.distanceTo(headPos).toFixed(4):null,
          rest:[c.rotation.x,c.rotation.y,c.rotation.z].map(v=>+(v*180/Math.PI).toFixed(2)),
        });
        walk(c, depth+1);
      }
    });
  })(head, 0);

  // 全骨名清单，用来核对命名风格（eyeL vs eye.L 这类）
  const allNames=bones.map(b=>b.name);
  const detail=faceBones;

  // ---- 3) 眼球网格的绑定状态 ----
  const eyes=[];
  window.__dbg.walk(o=>{
    if(!(o.isMesh||o.isSkinnedMesh)||!/^Eye(Pos|Neg)X/i.test(o.name||'')) return;
    const g=o.geometry;
    const si=g.attributes.skinIndex, sw=g.attributes.skinWeight;
    let allZero=true, allOne=true;
    if(si&&sw){ const n=Math.min(si.count,2000);
      for(let i=0;i<n;i++){ if(si.getComponent(i,0)!==0) allZero=false; if(sw.getComponent(i,0)!==1) allOne=false; } }
    const base=new THREE.Vector3().setFromMatrixPosition(o.bindMatrix);
    eyes.push({ name:o.name, isSkinnedMesh:!!o.isSkinnedMesh,
      verts:g.attributes.position.count,
      hasSkinIndex:!!si, hasSkinWeight:!!sw,
      allJoints0:si?allZero:null, allWeights1:sw?allOne:null,
      bindMatrixTranslation:[+base.x.toFixed(4),+base.y.toFixed(4),+base.z.toFixed(4)],
      skeletonBone0:o.skeleton?o.skeleton.bones[0].name:null,
      skeletonSize:o.skeleton?o.skeleton.bones.length:0,
    });
  });

  return JSON.stringify({headPos: headPos?[+headPos.x.toFixed(4),+headPos.y.toFixed(4),+headPos.z.toFixed(4)]:null,
    headName: head?head.name:null,
    boneCount:bones.length, allNames, eyes, faceBones:detail}, null, 1);
})()`);

if (typeof out === 'string' && out.startsWith('ERR')) console.error(out);
else {
  const j = JSON.parse(out);
  console.log('head 骨名 =', j.headName, '| 头骨中心', JSON.stringify(j.headPos), '| 骨骼总数', j.boneCount);
  console.log('\n== 眼球网格绑定状态 ==');
  for (const e of j.eyes) console.log(JSON.stringify(e));
  console.log('\n== head 的子/孙骨（这才是表情骨的真实集合）==');
  for (const c of j.faceBones) console.log(
    'd' + c.depth + '  ' + String(c.name).padEnd(20) +
    ' dFromHead=' + String(c.dFromHead).padStart(7) +
    ' rest=' + JSON.stringify(c.rest) + ' pos=' + JSON.stringify(c.pos));
  console.log('\n== 全部骨名 ==');
  console.log(j.allNames.join(' '));
}
srv.close(); chrome.kill(); process.exit(0);
