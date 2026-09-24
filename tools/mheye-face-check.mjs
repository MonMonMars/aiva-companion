// mheye-face-check.mjs —— 直接量「眼球正前方那个顶点采样到贴图的什么颜色」
// ===========================================================================
// 目的：判断虹膜朝向到底对不对。不靠肉眼看截图猜（截图里只有一条眼白，
//       很难分辨是"虹膜转到背面了"还是"贴图 v 方向反了"）。
//
// 做法：在页面里加一个探针，遍历眼球 mesh 的所有顶点，找出**最靠 +Z（正前方）
//       的那个顶点**，读出它的 UV；再在 Node 侧解码 brown_eye.png，把那个 UV
//       的颜色打印出来。
//   · 如果打印出来是棕色/黑色 → 虹膜朝向正确
//   · 如果打印出来是白色/粉色 → 虹膜确实在背面，需要把贴图 v 翻过来
//
// 用法: node tools/mheye-face-check.mjs [port]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] || 4499);
const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const PROFILE = 'C:/Users/Simon Lai/AppData/Local/Temp/mh2-eyecheck-' + Date.now();

// ---------------------------------------------------------- 极简静态服务器
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png' };
const srv = (await import('node:http')).createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/mh-preview2.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
console.log(`serving http://127.0.0.1:${PORT}/`);

// ------------------------------------------------------------- PNG 解码
function decodePNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ch = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p); p += 4;
    const type = b.toString('ascii', p, p + 4); p += 4;
    const data = b.subarray(p, p + len); p += len + 4;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, data: out };
}
const png = decodePNG(path.join(SRC, 'eyes/materials/brown_eye.png'));
const sample = (u, v) => {
  // OBJ 的 UV 原点在左下，PNG 在左上 → png_y = (1 - v) * h
  const x = Math.min(png.w - 1, Math.max(0, Math.round(u * png.w)));
  const y = Math.min(png.h - 1, Math.max(0, Math.round((1 - v) * png.h)));
  const i = y * png.w * png.ch + x * png.ch;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

// ----------------------------------------------------------- 启动 Chrome
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1384,749', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `http://127.0.0.1:${PORT}/tools/mh-preview2.html`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

// 找 page target
let list = null;
for (let i = 0; i < 40; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    if (list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
  } catch {}
  await sleep(400);
}
// ⚠️ 坑：Chrome 有多个 target（page / iframe / worker…），如果连错 target，
//    Runtime.evaluate 会在一个空上下文里执行，window.__dbg 就是 undefined。
//    而且 --headless=new 下有时候 target 的 url 显示的是命令行给的地址，
//    但文档其实还停在 about:blank（此时连 document.getElementById 都是 undefined）。
//    所以这里**不信任启动参数**，一律显式 Page.navigate 一次再等就绪。
const all = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
console.log('\n可用的 target：');
for (const t of all) console.log(`  [${t.type}] ${t.url?.slice(0, 80) || '(无 url)'}`);
const page = all.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('找不到可用 target'); process.exit(1); }
console.log('使用 target：', page.webSocketDebuggerUrl);

const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded') logs.push('[' + m.params.entry.level + '] ' + m.params.entry.text);
});
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/mh-preview2.html` });
await sleep(1200);
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const ex = r.result.exceptionDetails;
    return { __err: (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text };
  }
  return r.result?.result?.value;
};

for (let i = 0; i < 60; i++) {
  if (await evalJs('!!window.__mhReady')) break;
  await sleep(400);
}
console.log('页面就绪');
console.log('__dbg 存在？', await evalJs('typeof window.__dbg'));
console.log('__dbg 的键：', await evalJs('window.__dbg ? Object.keys(window.__dbg).join(",") : "无"'));
console.log('boot 文案：', JSON.stringify(await evalJs("document.getElementById('boot')?.textContent")));
console.log('meta 文案：', JSON.stringify(await evalJs("document.getElementById('meta')?.textContent")));
console.log('canvas 数：', await evalJs("document.querySelectorAll('canvas').length"));
console.log('滑块行数：', await evalJs("document.querySelectorAll('#sliders .row').length"));
console.log('场景里 SkinnedMesh 名：', await evalJs("(()=>{const n=[];const s=window.__threeScene;return 'no-global'})()"));

// 直接用独立探针。⚠️ 遍历必须从**真正的 scene** 开始 —— 页面里图省事从
// document 上取 Object3D 是拿不到的（之前返回空数组就是这个原因）。
// 这里通过 __dbg.eyePos() 已知能工作，说明 __dbg 里能拿到 scene 对象，
// 所以让页面暴露一个 traverse 出口最稳（见 __dbg.walk）。
const probeExpr = `(() => {
  const out = [];
  const visit = (o) => {
    if (o.isMesh && o.name === 'Eyes') {
      const pos = o.geometry.attributes.position, uv = o.geometry.attributes.uv;
      if (!uv) { out.push({ err: 'no uv' }); return; }
      const v = pos.constructor && new (o.position.constructor)();
      v.set(0, 0, 0);
      let bzn = -1e9, bzp = -1e9, uvn = null, uvp = null, pn = null, pp = null;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        o.localToWorld(v);
        if (v.x < 0) { if (v.z > bzn) { bzn = v.z; uvn = [uv.getX(i), uv.getY(i)]; pn = [v.x, v.y, v.z]; } }
        else { if (v.z > bzp) { bzp = v.z; uvp = [uv.getX(i), uv.getY(i)]; pp = [v.x, v.y, v.z]; } }
      }
      out.push({ side: '<0', z: +bzn.toFixed(4), uv: uvn.map(x => +x.toFixed(4)), pos: pn.map(x => +x.toFixed(4)) });
      out.push({ side: '>0', z: +bzp.toFixed(4), uv: uvp.map(x => +x.toFixed(4)), pos: pp.map(x => +x.toFixed(4)) });
    }
  };
  window.__dbg.walk(visit);
  return JSON.stringify(out);
})()`;

const r = await evalJs(probeExpr);
console.log('\n--- console ---');
console.log(logs.length ? logs.join('\n') : '（无）');
console.log('\nirisProbe(独立实现):', r);

if (r && r !== 'NO_PROBE' && !r.__err) {
  const d = JSON.parse(r);
  console.log('\n=== 正前方顶点采到的贴图颜色 ===');
  for (const e of d) {
    const c = sample(e.uv[0], e.uv[1]);
    const kind = (c[0] < 90 && c[1] < 90 && c[2] < 90) ? '深色(瞳孔/虹膜)'
      : (c[0] > 190 && c[1] > 180 && c[2] > 170) ? '白/粉(眼白)' : '中间调';
    console.log(`  X${e.side} UV(${e.uv[0].toFixed(4)}, ${e.uv[1].toFixed(4)}) -> RGB(${c.join(',')})  ${kind}`);
  }
}

ws.close(); chrome.kill();
srv.close();
