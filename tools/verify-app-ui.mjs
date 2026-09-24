#!/usr/bin/env node
// 验收 App UI 是否真的按新设计系统渲染出来了
// ---------------------------------------------------------------------------
// 为什么要这个脚本：我看不了截图（读 PNG 会被系统拦掉，只会返回"不支持"），
// 所以"好不好看"我判断不了，但"有没有渲染出来、颜色 token 对不对、
// 有没有运行时报错"这些**可数值化**的东西必须自动验，不能靠嘴说。
//
// 做法：静态服务把 dist/ 暴露出去 → 无头 Chrome 打开 → CDP 读页面 →
// 统计**所有元素**的 computed 背景色/文字色，看新 token 有没有真的生效。
//
// 三个踩过的坑：
//   坑① 不能用 --dump-dom。在这个 app 上 Chrome 会一直挂着不返回
//       （实测 spawnSync 等满 180s 被超时杀掉，stdout 全空），
//       看起来像"页面崩了"，其实是这个 flag 组合的问题。走 CDP 就没事。
//   坑② 不能用 --use-gl=swiftshader，必须 --use-angle=swiftshader。
//       前者会让 WebGL 上下文在 ~300ms 集体丢失（verify-compare-page 里踩过）。
//   坑③ 别去 outerHTML 里 grep 颜色。react-native-web 把 StyleSheet 编译成
//       原子 CSS class 塞进 <style>，DOM 属性里根本没有颜色字符串。
//       必须读 getComputedStyle —— 实测这样才量得到。
//
// 用法：node tools/verify-app-ui.mjs [项目根]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 npx expo export --platform web');
  process.exit(1);
}

// 期望值：和 src/theme.js 的 UI token 对齐。改了 theme 这里要跟着改，否则一直红。
const EXPECT = {
  'bg #0A0B10': 'rgb(10, 11, 16)',
  'surface #14151F': 'rgb(20, 21, 31)',
  'accent #FF2B4E': 'rgb(255, 43, 78)',
  'text #F3F3F8': 'rgb(243, 243, 248)',
};
// 期望卡数直接从 theme.js 读，别手写常数：手写的 11 在加了 cute 档之后就过时了
// （实际 3 可爱 + 6 写实 + 4 FF + 1 VTuber = 14），对着过时数字报红会误导排查。
// 期望卡数既不写死、也不动态 import theme.js（Windows 上动态 import 一个
// 绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME，得先转 file:// URL，太脆）。
// 改成让页面自己报数：每个档位分组头都写 "N 位"，把 N 加起来就是应有卡数，
// 分组和卡片对不上就说明 TIERS 配置或分组逻辑坏了。
const CDP_PORT = Number(process.env.UI_CDP_PORT || 9425);

// ---------- 静态服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.map': 'application/json',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ---------- Chrome ----------
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--window-size=420,900',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  const WS = globalThis.WebSocket || (await import('ws')).default;
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => {
    sock.addEventListener?.('open', res); sock.addEventListener?.('error', rej);
    if (sock.on) { sock.on('open', res); sock.on('error', rej); }
  });
  const events = [];
  function onMsg(raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      events.push('EXCEPTION: ' + (d.exception?.description || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      events.push('CONSOLE: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  }
  sock.addEventListener ? sock.addEventListener('message', (e) => onMsg(e.data)) : sock.on('message', onMsg);
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close(), events };
}

const PROBE = `(() => {
  const txt = document.body.innerText || '';
  const els = [...document.querySelectorAll('*')];
  const bg = {}, fg = {};
  for (const e of els) {
    const cs = getComputedStyle(e);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
      bg[cs.backgroundColor] = (bg[cs.backgroundColor] || 0) + 1;
    if (cs.color) fg[cs.color] = (fg[cs.color] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a,b) => b[1]-a[1]).slice(0, n);

  // 暗底黑字检查：这是切成深色主题后最容易翻车的地方，而我看不到画面。
  // 只看"自己直接持有文本节点"的元素 —— 光靠 getComputedStyle 会把大量
  // 纯布局 View 也算进去（它们继承的 color 是黑色，但根本不画字），
  // 一上来就报 194 个黑字，全是噪音。
  const lum = (c) => {
    const m = c.match(/(\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? 0.299*(+m[1]) + 0.587*(+m[2]) + 0.114*(+m[3]) : 255;
  };
  // 两类假阳性必须先排掉，否则这条断言全是噪音、没人会看：
  //   ① <style>/<script>/<noscript> 里的文本——它们本来就不是给用户看的字，
  //      而且不受 RN 的 color 控制（实测报出 "/* These styles ma"、
  //      "You need to enable JavaScript"）。
  //   ② 纯 emoji 节点（💗💙💼📖…）：emoji 由字体自己上色，CSS color 对它们无效，
  //      写成黑字也照样是彩色的。只要文本里一个"字"都没有就跳过。
  const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK']);
  const hasWord = (s) => /[0-9A-Za-z\\u4e00-\\u9fff]/.test(s);
  const darkText = [];
  for (const e of els) {
    if (SKIP_TAGS.has(e.tagName)) continue;
    if (e.closest && e.closest('style,script,noscript')) continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const t = e.textContent.trim();
    if (!hasWord(t)) continue;                       // 纯 emoji，跳过
    const c = getComputedStyle(e).color;
    if (lum(c) < 70) darkText.push({ text: t.slice(0, 18), color: c });
  }

  return JSON.stringify({
    ready: txt.includes('今天想陪在谁身边？'),
    nodes: els.length,
    starts: (txt.match(/开始相处/g) || []).length,
    conts: (txt.match(/继续这段关系/g) || []).length,
    // \\s* 而不是单个空格：RN Web 渲染出来的空白可能被折叠或换成别的空白字符，
    // 写死一个空格会一个都匹配不到（实测第一版返回 0）。
    tierMeta: (txt.match(/(\\d+)\\s*位/g) || []).map((s) => parseInt(s, 10)),
    sample: txt.slice(0, 260),
    bgTop: top(bg, 8),
    fgTop: top(fg, 8),
    bgAll: bg, fgAll: fg,
    darkText: darkText.slice(0, 12),
    darkTextN: darkText.length,
  });
})()`;

let conn;
let bad = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) bad++; };

try {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = await getJSON('/json/list'); if (list.length) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!list || !list.length) throw new Error('DevTools 端口没起来');
  conn = await cdp(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  await conn.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

  // 4.9MB 的 bundle + 一堆模型资源，固定 sleep 不够，轮询到 UI 就绪
  let out = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const r = await conn.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    if (r.result?.exceptionDetails) continue;
    const v = r.result?.result?.value;
    if (!v) continue;
    out = JSON.parse(v);
    if (out.ready) break;
  }

  if (!out) throw new Error('页面没返回任何探测结果');

  console.log(`节点数 ${out.nodes}\n`);
  if (!((out.tierMeta || []).length)) {
    console.log('⚠️ 档位计数没抓到，页面文本采样：\n' + (out.sample || '') + '\n');
  }
  ok(out.ready, 'PersonaSelect 渲染出来了');
  const metaSum = (out.tierMeta || []).reduce((a, b) => a + b, 0);
  const cards = out.starts + out.conts;
  ok(cards > 0 && cards === metaSum,
    `人格卡 ${cards} 张 = 各档位声明之和 ${metaSum}（${(out.tierMeta || []).join('+')}）：` +
    `开始 ${out.starts} / 继续 ${out.conts}`);

  console.log('\n— 实际生效的背景色 Top8 —');
  for (const [c, n] of out.bgTop) console.log(`   ${String(n).padStart(4)} × ${c}`);
  console.log('— 实际生效的文字色 Top8 —');
  for (const [c, n] of out.fgTop) console.log(`   ${String(n).padStart(4)} × ${c}`);
  console.log('');

  for (const [name, rgb] of Object.entries(EXPECT)) {
    const n = (out.bgAll[rgb] || 0) + (out.fgAll[rgb] || 0);
    ok(n > 0, `${name} (${rgb}) 已生效 —— ${n} 个元素在用`);
  }

  ok(out.darkTextN === 0,
    `没有"暗底黑字"${out.darkTextN ? '（' + out.darkTextN + ' 处）：\n     ' +
      out.darkText.map((d) => `"${d.text}" ${d.color}`).join('\n     ') : ''}`);

  const errs = conn.events.filter((e) => !/favicon|Warning: /i.test(e));
  ok(errs.length === 0, `无运行时报错${errs.length ? '：\n     ' + errs.slice(0, 6).join('\n     ') : ''}`);

  console.log(bad === 0 ? '\n✅ App UI 渲染验收通过' : `\n❌ ${bad} 项不通过`);
} catch (e) {
  console.error('验收脚本自身出错：', e.message);
  bad++;
} finally {
  conn?.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 无所谓 */ }
}
process.exit(bad === 0 ? 0 : 1);
