// ─────────────────────────────────────────────────────────────────────────────
// mheye-audit.mjs —— 眼球深度审计（真实渲染页世界坐标）
//
// 为什么需要这个脚本：
//   前几轮我用"眼眶矩形内棕色像素占比"当判据，得出 brown 92.8% / dark 2.0%
//   的"好成绩"，但截图里眼窝完全是空的。原因是脸壳自己的肤色像素被算作了
//   虹膜 —— 这个判据从一开始就是错的。
//
//   正确做法：直接把眼球和脸部机身放进**同一世界坐标系**量。
//     - 眼球世界包围盒中心 + 半径
//     - 脸部（head 机身）在眼球 (x,y) 邻域内的最大 Z（前轮廓）
//     - 两者之差 protrusion：>0 = 凸出脸外，<0 = 埋进脸里
//
//   正常人头：眼球半径 ~0.012 m，眼眶前轮廓到眼球中心约 -0.004~-0.006 m
//   （也就是球心比轮廓略靠后一点点，但眼球前半球必须凸出到轮廓外）。
//
// 用法：node tools/mheye-audit.mjs <port> [page]
//   服务必须以 llm-companion 为根启动（tools/serve.mjs <root> <port>），
//   因为预览页引用的是绝对路径 /tools/... 和 /node_modules/...
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8802';
const PAGE = process.argv[3] || 'tools/mh-preview2.html';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PROFILE = `C:/Users/Simon Lai/AppData/Local/Temp/mh2/prof-audit-${Date.now()}`;

const get = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(b));
  }).on('error', rej);
});

// 极简 CDP 客户端（只做一件事：attach page → Runtime.evaluate）
const listTargets = () => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9333, path: '/json/list' }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const main = async () => {
  // 确认预览页在跑
  const html = await get('/' + PAGE).catch(() => '');
  if (!html) { console.log(`✗ 端口 ${PORT} 无响应，先起预览页`); process.exit(1); }

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  await new Promise(r => setTimeout(r, 2500));

  let targets = [];
  for (let i = 0; i < 20; i++) {
    targets = await listTargets().catch(() => []);
    if (targets.some(t => t.type === 'page')) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.log('✗ 找不到 page target'); chrome.kill(); process.exit(1); }

  // 极简 WebSocket：用 node 内置能力手搓够麻烦，这里直接用 DevTools HTTP + ws 不方便，
  // 所以改走 chrome 的 /json/new?url= 直接在需要时打开，并用 Runtime.evaluate 通过
  // 常驻调试通道 —— 为避免引入依赖，改用 Node 22 内置的 WebSocket。
  const wsUrl = page.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  // ★ 关键坑：--headless=new 下 target 列表显示的是启动 URL，但文档可能仍在 about:blank。
  //   必须显式 Page.navigate。
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${PAGE}` });

  // 等预览页把模型挂到 window 上
  let ok = false;
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{ try { return !!(window.__dbg && window.__dbg.eyeAudit); } catch(e){ return false; } })()`,
      returnByValue: true,
    });
    if (r.result?.result?.value) { ok = true; break; }
    await new Promise(r2 => setTimeout(r2, 700));
  }
  if (!ok) {
    const r = await send('Runtime.evaluate', {
      expression: `Object.keys(window).filter(k=>/dbg|DEBUG|__/i.test(k)).join(',')`,
      returnByValue: true,
    });
    console.log('✗ 预览页未暴露 __dbg.eyeAudit，window 上的候选键：', r.result?.result?.value);
    ws.close(); chrome.kill(); process.exit(1);
  }

  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify(window.__dbg.eyeAudit(), null, 1)`,
    returnByValue: true,
  });
  const txt = r.result?.result?.value;
  console.log('══ 眼球深度审计 ══');
  if (!txt) { console.log('✗ 无返回：', JSON.stringify(r).slice(0, 400)); }
  else {
    const d = JSON.parse(txt);
    console.log('脸部机身网格：');
    for (const [k, v] of Object.entries(d.face || {})) {
      console.log(`  ${k}\n    min ${JSON.stringify(v.min)}\n    max ${JSON.stringify(v.max)}`);
    }
    console.log('眼球：');
    for (const e of d.eyes || []) {
      console.log(`  ${e.n}`);
      console.log(`    球心世界坐标 ${JSON.stringify(e.center)}  半径 ${e.radius}`);
      console.log(`    脸前轮廓 Z ${e.faceFrontZ}`);
      console.log(`    protrusion ${e.protrusion}  ${e.protrusion > 0 ? '→ 凸出脸外' : '→ 埋进脸里'}`);
    }
  }

  ws.close(); chrome.kill();
  await new Promise(r2 => setTimeout(r2, 300));
  process.exit(0);
};

main().catch(e => { console.log('✗', e.message); process.exit(1); });
