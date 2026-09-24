// mh-exprcheck.mjs —— 把 mh-expr 生成的眨眼 blendshape 打到预览台的脸上的比对图
// ===========================================================================
// 为什么要 eyeball 看：数值上"52 个顶点下移 8.3mm"完全可能成立，
// 但**看起来对不对**是另一回事（比如睑缘没对齐会出现一条白缝、或者眼皮鼓包）。
// 输出：同一机位下的 0 / 0.5 / 1.0 三张脸特写，直接人眼看。
//
// 用法: node tools/mh-exprcheck.mjs [port] [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion';
const PORT = Number(process.argv[2] || 7831);
const OUTDIR = process.argv[3] || 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/_shots/expr';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
fs.mkdirSync(OUTDIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, url === '/' ? '/tools/mh-preview2.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=C:/Users/Simon Lai/AppData/Local/Temp/mhexpr-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // ⚠️ 不能加 --disable-gpu
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--window-size=900,900',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch {}
}
if (!target) { console.log('无法连接 Chrome'); server.close(); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 60; i++) {
  await sleep(400);
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: 'window.__mhReady === true' });
  if (r.result.value === true) break;
}
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

const shot = async (name) => {
  await ev('window.__dbg.forceRender()');
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: "document.querySelector('canvas').toDataURL('image/png')" });
  const url = r.result.value;
  const out = path.join(OUTDIR, name + '.png');
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length > 20000) {
    fs.writeFileSync(out, Buffer.from(url.slice(22), 'base64'));
    console.log('  -> ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB)');
    return;
  }
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
  console.log('  -> ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB, fallback)');
};

// ---- 1) 注入 morph -------------------------------------------------------
console.log(await ev(`(async () => {
  const T = window.__dbg.THREE_NS;
  let body = null;
  window.__dbg.walk(o => { if (o.isSkinnedMesh && o.name === 'AIVA_Body') body = o; });
  if (!body) return 'ERR 找不到 AIVA_Body';
  const data = await (await fetch('/assets/models4/aiva-expr-mh.json')).json();
  const nv = body.geometry.attributes.position.count;
  if (data.vertexCount !== nv) return 'ERR 顶点数不匹配: json ' + data.vertexCount + ' vs 网格 ' + nv;

  const names = Object.keys(data.channels);
  const attrs = [];
  for (const n of names) {
    const ch = data.channels[n];
    const arr = new Float32Array(nv * 3);
    for (let k = 0; k < ch.idx.length; k++) {
      const v = ch.idx[k];
      arr[v * 3] = ch.off[k * 3]; arr[v * 3 + 1] = ch.off[k * 3 + 1]; arr[v * 3 + 2] = ch.off[k * 3 + 2];
    }
    attrs.push(new T.BufferAttribute(arr, 3));
  }

  // ⚠️ three 的 morph 走 nominalTypes 那套 morphAttributes；自己塞进去之后
  //    必须重建 morphTargetInfluences / Dictionary，否则 set 了也不生效。
  const exist = body.geometry.morphAttributes.position || [];
  body.geometry.morphAttributes.position = exist.concat(attrs);
  const baseKeywords = Object.keys(body.morphTargetDictionary || {});
  body.morphTargetDictionary = body.morphTargetDictionary || {};
  const startIdx = exist.length;
  names.forEach((n, i) => { body.morphTargetDictionary[n] = startIdx + i; });
  const inf = body.morphTargetInfluences ? Array.from(body.morphTargetInfluences) : new Array(startIdx).fill(0);
  for (let i = 0; i < names.length; i++) inf[startIdx + i] = 0;
  body.morphTargetInfluences = inf;
  delete body.geometry._maxMorphCount;
  window.__exprNames = names;
  window.__exprSet = (n, v) => {
    const i = body.morphTargetDictionary[n];
    if (i === undefined) return 'no such channel ' + n;
    body.morphTargetInfluences[i] = v;
    return i;
  };
  return '已注入 ' + names.join(' ') + '（原有 ' + exist.length + ' 个 morph, 保留 ' + baseKeywords.length + ' 个滑块名）';
})()`));

// ---- 2) 双眼特写机位 -----------------------------------------------------
// 眼睛 (±0.0316, 1.5777, 0.1414)，机位放在两眼正中略前，target 落在两眼连线上
console.log(await ev('JSON.stringify(window.__dbg.setCam(0.0316, 1.5790, 0.3600, 0.0316, 1.5777, 0.1414))'));
await sleep(600);
await shot('00-open');

console.log(await ev('JSON.stringify(window.__exprSet && [window.__exprSet("eyeBlinkLeft",0.5), window.__exprSet("eyeBlinkRight",0.5)])'));
await ev('window.__dbg.forceRender()'); await sleep(400);
await shot('01-half');

console.log(await ev('JSON.stringify(window.__exprSet && [window.__exprSet("eyeBlinkLeft",0.30), window.__exprSet("eyeBlinkRight",0.30)])'));
await ev('window.__dbg.forceRender()'); await sleep(400);
await shot('01b-030');

console.log(await ev('JSON.stringify(window.__exprSet && [window.__exprSet("eyeBlinkLeft",1), window.__exprSet("eyeBlinkRight",1)])'));
await ev('window.__dbg.forceRender()'); await sleep(400);
await shot('02-closed');

// 只闭一只，看有没有串到左边/右边
console.log(await ev('JSON.stringify(window.__exprSet && [window.__exprSet("eyeBlinkLeft",1), window.__exprSet("eyeBlinkRight",0)])'));
await ev('window.__dbg.forceRender()'); await sleep(400);
await shot('03-only-left');

// 侧面看一眼有没有穿模/鼓包
console.log(await ev('JSON.stringify(window.__exprSet && [window.__exprSet("eyeBlinkLeft",1), window.__exprSet("eyeBlinkRight",1)])'));
console.log(await ev('JSON.stringify(window.__dbg.setCam(0.1250, 1.5790, 0.2600, 0.0316, 1.5777, 0.1414))'));
await ev('window.__dbg.forceRender()'); await sleep(400);
await shot('04-side-closed');

console.log('\n--- console ---');
console.log(logs.length ? logs.filter((l) => !/GL Driver|GPU stall/i.test(l)).join('\n') || '（仅 GPU 警告）' : '（无）');
ws.close(); chrome.kill(); server.close(); process.exit(0);
