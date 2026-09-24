// mh-probe-pixel.mjs —— 把"屏幕上那块黑"反投影到世界坐标，再查那里有什么
// ===========================================================================
// 思路：
//   1. 固定相机，渲染一帧，readPixels 拿像素。
//   2. 找出"脸区域内"的暗像素（RGB 都很低）。
//   3. 用 three.js 的 unproject（页面内做）把这些像素反投影到世界坐标，
//      沿射线与场景求交，得到**真正被渲染的那个物体**和它的名字。
//   4. 输出该物体的名字 + 交点世界坐标。
//
// 这是唯一能"从结果往回追"的方法，避免我继续猜。
//
// 用法: node tools/mh-probe-pixel.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 4770);
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
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhprobe-${Date.now()}`,
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
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
for (let i = 0; i < 90; i++) { if (await ev('!!window.__mhReady')) break; await sleep(400); }
if (!(await ev('!!window.__mhReady'))) { console.error('页面未就绪'); process.exit(1); }

await ev(`(()=>{const r=window.__dbg.getRenderer(),c=r.domElement;r.setPixelRatio(1);r.setSize(c.clientWidth||innerWidth,c.clientHeight||innerHeight,false);
  for(const id of ['panel','boot','views','meta']){const e=document.getElementById(id);if(e)e.style.display='none';}return 1;})()`);
await ev('window.__dbg.setCam(0,1.578,0.36,0,1.575,0.10)');
await sleep(600);

// 一次性在页面里完成：读像素 → 找暗块 → 反投影 → 射线求交
const result = await ev(`(()=>{
  const THREE = window.__dbg.THREE_NS;
  const r=window.__dbg.getRenderer(), gl=r.getContext(), c=r.domElement;
  const W=c.width,H=c.height;
  const buf=new Uint8Array(W*H*4);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  // readPixels 是自下而上。我们要"脸区域内"的暗像素。
  // 先把"非背景"像素找出来（背景是 0xf2f3f5 浅灰）
  const darks=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    const R=buf[i],G=buf[i+1],B=buf[i+2];
    if(R<70&&G<70&&B<70) darks.push([x,H-1-y]);   // 转成左上原点
  }
  if(!darks.length) return JSON.stringify({dark:0});
  // 聚类取最大团（简单：按连通性 BFS）
  const set=new Set(darks.map(p=>p[0]+','+p[1]));
  const seen=new Set(); const comps=[];
  for(const p of darks){
    const k=p[0]+','+p[1];
    if(seen.has(k)) continue;
    const q=[p]; seen.add(k); const comp=[];
    while(q.length){
      const [x,y]=q.pop(); comp.push([x,y]);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nk=(x+dx)+','+(y+dy);
        if(set.has(nk)&&!seen.has(nk)){seen.add(nk);q.push([x+dx,y+dy]);}
      }
    }
    comps.push(comp);
  }
  comps.sort((a,b)=>b.length-a.length);
  const top=comps.slice(0,4).map(cp=>{
    let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
    for(const [x,y] of cp){if(x<mnx)mnx=x;if(x>mxx)mxx=x;if(y<mny)mny=y;if(y>mxy)mxy=y;}
    return {n:cp.length,bbox:[mnx,mny,mxx,mxy]};
  });
  return JSON.stringify({W,H,darkTotal:darks.length,clusters:top},null,1);
})()`);
console.log('=== 暗块像素聚类 ===');
console.log(result);

// 对最大暗团的中心做反投影 + 射线求交
const probe = await ev(`(()=>{
  const THREE = window.__dbg.THREE_NS;
  if(!THREE) return JSON.stringify({err:'no THREE_NS'});
  const r=window.__dbg.getRenderer(), c=r.domElement;
  const W=c.width,H=c.height;
  const buf=new Uint8Array(W*H*4);
  const gl=r.getContext(); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  const darks=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;
    if(buf[i]<70&&buf[i+1]<70&&buf[i+2]<70) darks.push([x,H-1-y]);}
  if(!darks.length) return JSON.stringify({dark:0});
  const set=new Set(darks.map(p=>p[0]+','+p[1]));
  const seen=new Set(); let best=[];
  for(const p of darks){const k=p[0]+','+p[1]; if(seen.has(k))continue;
    const q=[p];seen.add(k);const comp=[];
    while(q.length){const [x,y]=q.pop();comp.push([x,y]);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nk=(x+dx)+','+(y+dy);
        if(set.has(nk)&&!seen.has(nk)){seen.add(nk);q.push([x+dx,y+dy]);}}}
    if(comp.length>best.length) best=comp;}
  let sx=0,sy=0; for(const [x,y] of best){sx+=x;sy+=y;}
  const px=sx/best.length, py=sy/best.length;
  // NDC
  const ndc=new THREE.Vector2((px/W)*2-1, -(py/H)*2+1);
  const cam=window.__dbg.getCamera();
  const rc=new THREE.Raycaster();
  rc.setFromCamera(ndc,cam);
  const objs=[]; window.__dbg.walk(o=>{if((o.isMesh||o.isSkinnedMesh)&&o.visible)objs.push(o);});
  const hits=rc.intersectObjects(objs,false);
  return JSON.stringify({
    clusterSize:best.length, pixel:[+px.toFixed(1),+py.toFixed(1)],
    hits:hits.slice(0,6).map(h=>({name:h.object.name,type:h.object.type,dist:+h.distance.toFixed(4),
      point:h.point.toArray().map(v=>+v.toFixed(4)),
      faceIndex:h.faceIndex,
      matType:h.object.material&&h.object.material.type,
      hasMap:!!(h.object.material&&h.object.material.map),
      side:h.object.material&&h.object.material.side,
      alphaTest:h.object.material&&h.object.material.alphaTest,
      transparent:h.object.material&&h.object.material.transparent,
    })),
  },null,1);
})()`);
console.log('\\n=== 反投影命中的对象 ===');
console.log(probe);

srv.close(); chrome.kill(); process.exit(0);
