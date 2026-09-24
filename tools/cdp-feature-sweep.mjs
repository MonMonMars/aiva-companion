// 功能巡检：每个功能真的点一遍，断言存档真的变了，顺带抓控制台报错
// ---------------------------------------------------------------------------
// 重叠审计管的是"长得好不好看"，这个脚本管的是"点了有没有用"。
// 判据不是"页面有没有跳"，而是 **localStorage 里的数字有没有变** ——
// 只有存下来的才叫真的做了。
//
// 用法: node cdp-feature-sweep.mjs <url>
// 环境: SWEEP_PORT 指定 CDP 端口（并行跑时别撞）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.SWEEP_PORT || 9420);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--mute-audio', url,
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const l = await r.json();
    const p = (l || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
// 每个步骤独立记账，最后才能说清"报错是哪一步冒出来的"
const logs = [];          // { step, type, text }
let step = '启动';
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  // ⚠️ RNW 的 Alert.alert 在网页上就是 window.alert —— headless 下会把页面挂住。
  //    必须自动收下，否则点「保存 / 清空聊天记录」之后整个脚本卡死。
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.type || 'log';
    if (t !== 'error' && t !== 'warning') return;
    const s = (m.params.args || []).map((a) => a.value ?? a.description ?? (a.preview?.description || '')).join(' ');
    logs.push({ step, type: 'console.' + t, text: s.slice(0, 200) });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    logs.push({ step, type: 'exception', text: (d.exception?.description || d.text || '').slice(0, 200) });
  }
  if (m.method === 'Log.entryAdded') {
    const en = m.params.entry || {};
    if (en.level === 'error' || en.level === 'warning') {
      logs.push({ step, type: 'log.' + en.level, text: String(en.text || '').slice(0, 200) });
    }
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const SEED = `
  try {
    localStorage.setItem('aiva.companion.v1', JSON.stringify({
      personaId: 'girlfriend',
      relations: { girlfriend: { affection: 42, mood: 70, energy: 80 } },
      coins: 500, giftCount: {}, totalPets: 0, totalChats: 0,
      memory: [{ ts: 1, text: '喜欢喝美式，不加糖' }],
      chatHistory: { girlfriend: [
        { role: 'user', content: '今天过得怎么样呀', ts: 1 },
        { role: 'assistant', content: '几好呀，不过挂住你啰。', ts: 2 }] },
      lastSeenAt: Date.now(), lastCheckInDay: null,
      config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'auto', kidMode: false },
    }));
  } catch (e) {}
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });

// ---- 小工具 ---------------------------------------------------------------
const HELPERS = `
  window.__scope = () => {
    const host = document.getElementById('root') || document.body;
    const layers = Array.from(host.children).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.85;
    });
    return layers.length ? layers[layers.length - 1] : host;
  };
  window.__text = () => document.body.innerText || '';
  window.__rectFor = (txt, exact) => {
    const hits = Array.from(window.__scope().querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect(); const s = e.textContent || '';
      return (exact ? s.trim() === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    window.__lastEl = el; // 留给调用方做 scrollIntoView
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: (el.textContent || '').slice(0, 30) };
  };
  window.__store = () => {
    try { return JSON.parse(localStorage.getItem('aiva.companion.v1') || '{}'); } catch (e) { return {}; }
  };
  window.__findInput = (ph) => {
    const el = Array.from(document.querySelectorAll('input'))
      .find((e) => (e.placeholder || '').includes(ph) && e.getBoundingClientRect().width > 0);
    if (!el) return false;
    el.focus();
    return true;
  };
`;

// ⚠️ 必须先 scrollIntoView 再派发鼠标事件。长列表（角色卡片、设置页开关）里
//    目标常常在 y > 视口高度，直接按原坐标点 = 点到空气，脚本静默失败、
//    看起来就像"功能坏了"。实测踩了两次。
async function clickText(txt, exact = false) {
  await evaluate(HELPERS);
  const found = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!found) return false;
  await evaluate(`(() => { if (window.__lastEl) window.__lastEl.scrollIntoView({ block: 'center' }); })()`);
  await sleep(280);
  const r = await evaluate(`(() => {
    const el = window.__lastEl; if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.x, y: r.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return true;
}
const typeInto = async (ph, text) => {
  await evaluate(HELPERS);
  const ok = await evaluate(`window.__findInput(${JSON.stringify(ph)})`);
  if (!ok) return false;
  await send('Input.insertText', { text });
  return true;
};
const store = async () => { await evaluate(HELPERS); return evaluate('window.__store()'); };
const txt = async () => { await evaluate(HELPERS); return evaluate('window.__text()'); };
const has = async (s) => (await txt()).includes(s);

// ⚠️ 养成计数存在 relations[id] 上，不在顶层 ——
//    snapshot() 才把它摊平成 snap.totalChats，localStorage 里没有这一层。
const rel = async () => {
  const s = await store();
  return (s.relations || {})[s.personaId] || {};
};

/** 滚到可视区再点：设置页很长，开关常常在 y=1400 之外，直接派发鼠标事件等于没点 */
async function clickSelector(pickExpr) {
  await evaluate(HELPERS);
  const pt = await evaluate(`(() => {
    const el = (${pickExpr})();
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pt) return false;
  await sleep(300);
  const pt2 = await evaluate(`(() => {
    const el = (${pickExpr})();
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type: t, x: pt2.x, y: pt2.y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1,
    });
  }
  return true;
}

// ⚠️ 各页返回键文案不一样：菜单是「‹ 关闭 / ‹ 返回」，
//    而语音设置 / 设置 / 聊天记录 只有单独一个「‹」。混用会点不到，后面全线串味。
const backFromScreen = () => clickText('‹', true);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- 等主页 ---------------------------------------------------------------
for (let i = 0; i < 150; i++) {
  if (await evaluate(`Array.from(document.querySelectorAll('input')).some((e)=>(e.placeholder||'').includes('跟她说'))`)) break;
  await sleep(400);
}
await sleep(9000);

// ---- ① 发一条消息 ---------------------------------------------------------
step = '① 发消息';
const s0 = await store();
const rel0 = await rel();          // 基线必须在发送**之前**取
const ch0 = (s0.chatHistory?.girlfriend || []).length;
await typeInto('跟她说', '今天天气怎么样');
await sleep(400);
await clickText('➤', true);
await sleep(4000);
const s1 = await store();
const ch1 = (s1.chatHistory?.girlfriend || []).length;
check('① 发消息：对话真的落档', ch1 >= ch0 + 2,
  `${ch0} → ${ch1} 条，最后一句「${String((s1.chatHistory?.girlfriend || []).slice(-1)[0]?.content || '').slice(0, 18)}」`);
const rel1 = await rel();
check('① 发消息：累计聊轮 +1（存在 relations 上）', (rel1.totalChats || 0) > (rel0.totalChats || 0),
  `${rel0.totalChats} → ${rel1.totalChats}`);

// ---- ② 每日签到 -----------------------------------------------------------
step = '② 签到';
await clickText('☰', true); await sleep(1200);
const beforeCoins = (await store()).coins;
await clickText('每日签到', false); await sleep(1200);
const afterCoins = (await store()).coins;
const toastOk = await has('签到 +') || await has('今天已经领过');
check('② 每日签到：金币变化 + 有反馈', afterCoins !== beforeCoins && toastOk,
  `🪙 ${beforeCoins} → ${afterCoins}`);

// ---- ③ 送礼 ---------------------------------------------------------------
step = '③ 送礼';
await clickText('送礼物', false); await sleep(1100);
const g0 = await store();
await clickText('🌸', false) || await clickText('💐', false) || await clickText('🍰', false);
await sleep(1200);
const g1 = await store();
check('③ 送礼：扣金币 + 加亲密',
  (g1.coins < g0.coins) && (g1.relations.girlfriend.affection > g0.relations.girlfriend.affection),
  `🪙 ${g0.coins}→${g1.coins}，亲密 ${g0.relations.girlfriend.affection}→${g1.relations.girlfriend.affection}`);
await clickText('‹ 返回', false); await sleep(900);

// ---- ④ 记忆增删 ----------------------------------------------------------
step = '④ 记忆';
await clickText('她的记忆', false); await sleep(1100);
const m0 = (await store()).memory.length;
await typeInto('例：喜欢喝美式', '测试记忆条目XYZ');
await sleep(400);
await clickText('记下', false); await sleep(1000);
const m1 = (await store()).memory.length;
await clickText('删除', false); await sleep(1000);
const m2 = (await store()).memory.length;
check('④ 记忆：加一条再删一条', m1 === m0 + 1 && m2 === m1 - 1, `${m0} → ${m1} → ${m2}`);
await clickText('‹ 返回', false); await sleep(900);

// ---- ⑤ 回正视角 ----------------------------------------------------------
step = '⑤ 回正视角';
await clickText('回正视角', false); await sleep(1000);
check('⑤ 回正视角：有反馈', await has('视角已回正'));

// ---- ⑥ 儿童模式开关 ------------------------------------------------------
step = '⑥ 儿童模式';
await clickText('语音设置', false); await sleep(1600);
// RNW 的 Switch 在网页上就是 <input type="checkbox" role="switch">。
// ⚠️ 这一页很长，开关在 y≈1459（视口外），必须先 scrollIntoView 再点。
const kidFound = await clickSelector(
  `() => Array.from(window.__scope().querySelectorAll('*')).find((e) => e.tagName === 'INPUT' && e.type === 'checkbox')`
);
await sleep(1200);
const kidAfter = (await store()).config?.kidMode;
check('⑥ 儿童模式开关：写进存档', kidFound && kidAfter === true, `kidMode=${kidAfter}`);

// 语音设置 → 设置 → 主页（两页的返回键都是单独的「‹」）
await backFromScreen(); await sleep(1200);
await backFromScreen(); await sleep(1400);

// ---- ⑦ 换角色 ------------------------------------------------------------
step = '⑦ 换角色';
await clickText('☰', true); await sleep(1400);
await clickText('换角色', false); await sleep(2000);
const p0 = (await store()).personaId;
// ⚠️ 别用「开始相处」定位卡片：底部 CTA 的文案是「开始相处 · 小柔」，
//    最小命中元素会落在 CTA 上，等于什么都没选。用**另一个角色的名字**最稳。
await clickText('Noa', false) || await clickText('林秘书', false) || await clickText('Sora', false);
await sleep(1000);
const ctaClicked = await clickText('换成', false);
await sleep(2000);
const p1 = (await store()).personaId;
check('⑦ 换角色：选别人 → CTA → 存档换人', ctaClicked && p1 && p1 !== p0, `${p0} → ${p1}`);

// ---- 汇报 ----------------------------------------------------------------
console.log('\n=== 控制台噪声（按步骤） ===');
if (!logs.length) console.log('   ✅ 全程 0 条 error / warning / exception');
const byStep = new Map();
logs.forEach((l) => {
  if (!byStep.has(l.step)) byStep.set(l.step, []);
  byStep.get(l.step).push(l);
});
byStep.forEach((arr, st) => {
  console.log('  ' + st + '  (' + arr.length + ')');
  arr.slice(0, 6).forEach((l) => console.log('     [' + l.type + '] ' + l.text));
});

const bad = results.filter((r) => !r.ok).length;
console.log(`\n功能 ${results.length - bad}/${results.length} 通过   控制台噪声 ${logs.length} 条`);
cleanup();
process.exit(0);
