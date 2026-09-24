// mh-appverify.mjs —— 主 App 侧的 MakeHuman 档验收
// ===========================================================================
// 验三件事，每件都要有"数出来的"证据，不靠肉眼看截图下结论：
//   1) 模型挂上了没有、挂的是哪一档（看 __aivaDebug.partCount / boneDump）
//   2) **眼球绑对了没有**（eyeInfo：PosX 必须落在 +X，NegX 在 −X）
//   3) **嘴真的会张吗**（speak 之后 faceAngles 里 jaw 的角度必须离开 0）
//
// 用法: node tools/mh-appverify.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePNG } from './pngutil.mjs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const DIST = ROOT + '/dist';
const PORT = Number(process.argv[2] || 4870);
const OUTDIR = ROOT + '/_shots/wear';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.gz': 'application/gzip', '.br': 'application/brotli' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhapp-${Date.now()}`,
  '--window-size=1000,900', '--no-first-run', '--no-default-browser-check',
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
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  // ErrorBoundary 会把异常吞掉，所以必须直接听 console
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${txt}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`[EXC] ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
  }
});
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

// ⚠️ App 从标题页开始，3D 场景在 Home 挂载时才建 —— 所以 __aivaDebug 一开始
//    必然不存在。必须先走完「标题页 → 角色选择页 → 点一张角色卡」。
//    盲点屏幕中央是没用的：角色卡是整行 860×153 的 div，中央的 y=450 正好落在
//    两张卡之间的空隙里（卡在 y=384 和 y=549）。所以这里先**查 DOM 找可点元素**，
//    再按它的实际中心坐标派发真实鼠标事件 —— RNW 的 Pressable 只认真事件。
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

// 找目标元素的屏幕中心。pred 在浏览器里跑，返回第一个命中的可点块中心。
const findBtn = (pred) => ev(`(()=>{
  let best=null;
  document.querySelectorAll('[role="button"],button,[tabindex]').forEach(e=>{
    if(best) return;
    const r=e.getBoundingClientRect();
    if(r.width<40||r.height<24) return;
    if(r.bottom<0||r.top>innerHeight) return;
    const t=(e.textContent||'').trim();
    if(!(${pred})) return;
    best={x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2),
          t:t.slice(0,30), w:Math.round(r.width), h:Math.round(r.height)};
  });
  return best;
})()`);

let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  if (await ev('!!(globalThis.__aivaDebug)')) { ready = true; break; }

  // ① 角色选择页：先点一张角色卡（选中），再点底部 CTA（确认进入）。
  //    ⚠️ 这是两步，不是一步 —— 卡片 onPress 只做"高亮选择"，
  //       真正跳转在底部 CTA 的 onDone 上。只点卡片会一直停在这一屏。
  const card = await findBtn(`/小柔/.test(t) && r.width>400 && r.height>100`);
  if (card) {
    console.log('① 点角色卡:', JSON.stringify(card));
    await clickAt(card.x, card.y);
    await sleep(600);
    const cta = await findBtn(`/(开始相处|继续这段关系|换成)/.test(t) && r.height<90`);
    if (cta) { console.log('② 点底部 CTA:', JSON.stringify(cta)); await clickAt(cta.x, cta.y); }
    else console.log('② 没找到底部 CTA');
    await sleep(1400);
    continue;
  }

  // ② 标题页：整屏都是 Pressable，点中央
  console.log('（标题页）点屏幕中央');
  await clickAt(450, 450);
  await sleep(1200);
}
console.log('__aivaDebug 就绪:', ready);
if (!ready) { console.log(logs.join('\n')); srv.close(); chrome.kill(); process.exit(1); }

// 等主模型排进 preload 队列并跑完（priority 100，所以就是第一个任务）
await ev('globalThis.__aivaPreload && globalThis.__aivaPreload.drain(45000)');
await sleep(1500);

console.log('\n== 模型挂载 ==');
console.log('partCount :', await ev('__aivaDebug.partCount()'));
console.log('hasRig    :', await ev('__aivaDebug.hasRig()'));
console.log('hasEyes   :', await ev('__aivaDebug.hasEyes()'));
console.log('eyeInfo   :', JSON.stringify(await ev('JSON.stringify(__aivaDebug.eyeInfo())')));
console.log('faceCh    :', JSON.stringify(await ev('JSON.stringify(__aivaDebug.faceChannels())')));

console.log('\n== 张嘴测试（speak 前后 jaw 的角度）==');
console.log('静止 faceAngles:', JSON.stringify(await ev('JSON.stringify(__aivaDebug.faceAngles())')));
await ev('__aivaDebug.speak("你好呀，我系 AIVA，好高兴见到你！")');
await sleep(420);
console.log('说话 faceAngles:', JSON.stringify(await ev('JSON.stringify(__aivaDebug.faceAngles())')));
console.log('说话 faceWeights:', JSON.stringify(await ev('JSON.stringify(__aivaDebug.faceWeights())')));
console.log('morph weights   :', JSON.stringify(await ev('JSON.stringify(__aivaDebug.weights())')));
await ev('__aivaDebug.stopSpeaking()');
await sleep(900);
console.log('停后 faceAngles:', JSON.stringify(await ev('JSON.stringify(__aivaDebug.faceAngles())')));

console.log('\n== 相机 + 截图 ==');
await ev(`(async()=>{
  // 关掉 UI，只留 canvas；然后拉到胸像机位
  for(const id of ['root','panel','boot']){const e=document.getElementById(id); if(e) e.style.display='none';}
  return 1;})()`);
await sleep(300);
const shot = async (name) => {
  const b64 = await ev(`(()=>{const cv=document.querySelector('canvas');const gl=cv.getContext('webgl2')||cv.getContext('webgl');
    const w=cv.width,h=cv.height,buf=new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    const out=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++){const s=(h-1-y)*w*4,d=y*w*3;for(let x=0;x<w;x++){out[d+x*3]=buf[s+x*4];out[d+x*3+1]=buf[s+x*4+1];out[d+x*3+2]=buf[s+x*4+2];}}
    let bin='';const CH=0x8000;for(let i=0;i<out.length;i+=CH)bin+=String.fromCharCode.apply(null,out.subarray(i,i+CH));
    return btoa(bin);})()`);
  if (typeof b64 !== 'string' || b64.startsWith('ERR')) { console.log(name, b64); return; }
  const f = path.join(OUTDIR, name + '.png');
  const cvSize = await ev(`(()=>{const c=document.querySelector('canvas');return c.width+'x'+c.height})()`);
  const [W, H] = cvSize.split('x').map(Number);
  fs.writeFileSync(f, encodePNG(W, H, Buffer.from(b64, 'base64')));
  console.log(name, cvSize, '->', f);
};
await ev(`__aivaDebug.resetCamera && __aivaDebug.resetCamera()`);
await sleep(500);
await shot('app1-default');
await ev(`__aivaDebug.zoom && __aivaDebug.zoom(2.4)`);
await sleep(600);
await shot('app2-face');

console.log('\n== 控制台日志（前 60 条）==');
console.log(logs.slice(0, 60).join('\n'));
srv.close(); chrome.kill(); process.exit(0);
