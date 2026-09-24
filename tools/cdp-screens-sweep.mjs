// 全屏扫雷：把每个二级页面都打开一遍，专抓"某个页面一挂载就炸"这类问题
// ---------------------------------------------------------------------------
// 为什么需要它：本项目栽过两次一模一样的坑 —— Avatar3D.web.js 少了 schedule /
// warmOtherModels 的 import，Menu.js 用了没声明的 pre，都是 ReferenceError。
// 而这类错误会被 React 的 ErrorBoundary **吃掉**，Runtime.exceptionThrown 根本不触发，
// 主流程断言（cdp-uicheck）照样报 0 异常、全绿。只有真的打开那一屏才看得见
// "⚠️ 应用出错了"。
//
// 所以这里两路取证：
//   1) 屏幕上有没有出现 ErrorBoundary 的兜底文案
//   2) console.error（ErrorBoundary 在 componentDidCatch 里打的）
//
// 用法: node cdp-screens-sweep.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-screens-sweep.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9352;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
  url,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
  // ⚠️ ErrorBoundary 把渲染异常 catch 掉了，不会冒到 exceptionThrown。
  //    它走的是 componentDidCatch 里的 console.error —— 必须单独收。
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleErrors.push(txt);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const CLICK_HELPER = `
  window.__rectFor = (txt, exact) => {
    const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect();
      const s = e.textContent || '';
      return (exact ? s === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
             w: r.width, h: r.height, txt: (el.textContent || '').slice(0, 30) };
  };
  window.__text = () => document.body.innerText || '';
  // 主页判据：Home 在浮层底下从不卸载，所以"有输入框"不能证明在主页 ——
  // 得同时满足"有 ☰"且"没有 ‹"（各浮层的返回键都带 ‹）
  window.__isHome = () => {
    const t = window.__text();
    const inp = Array.from(document.querySelectorAll('input'))
      .some((e) => (e.placeholder || '').includes('跟她说'));
    return inp && t.includes('☰') && !t.includes('‹');
  };
  window.__crashed = () => window.__text().includes('应用出错了');
`;

async function clickText(txt, exact = false) {
  const rect = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!rect) return { ok: false, reason: 'not found: ' + txt };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return { ok: true, txt: rect.txt };
}

await send('Runtime.enable');
await send('Page.enable');

// 存档：直接把人选定好，跳过选人页（标题页之后就进主页），省 10 秒
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      var KEY = 'aiva.companion.v1';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({
          personaId: 'girlfriend',
          relations: { girlfriend: { affection: 42, mood: 78, energy: 66,
            createdAt: Date.now() - 3 * 86400000, totalPets: 9, totalChats: 12 } },
          coins: 500, giftCount: {},
          memory: [{ text: '他怕黑', ts: 1 }, { text: '他在学做菜', ts: 2 }],
          chatHistory: { girlfriend: [
            { role: 'user', content: '今天过得怎么样呀', ts: 1 },
            { role: 'assistant', content: '几好呀，不过挂住你啰。', ts: 2 },
          ] },
          lastSeenAt: Date.now(),
          config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'night' },
        }));
      }
    } catch (e) {}
  `,
});

await send('Emulation.setDeviceMetricsOverride', {
  width: 414, height: 896, deviceScaleFactor: 2, mobile: true,
});
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

console.log('>>> 打开：' + url);
await send('Page.navigate', { url });

// 等主页（带存档 → 标题页停 ~2.2s 后直接进主页）
let atHome = false;
for (let i = 0; i < 100; i++) {
  await evaluate(CLICK_HELPER);
  if (await evaluate('window.__isHome()')) { atHome = true; break; }
  await sleep(300);
}
if (!atHome) {
  console.log('!!! 没进主页，后面没法跑。当前文字：',
    JSON.stringify(await evaluate(`window.__text().slice(0, 300)`)));
  cleanup();
  process.exit(1);
}
console.log('已进入主页');

await sleep(12000); // 让 3D 模型 / 后台预热先跑完，免得抢 CPU 影响点击

/**
 * 回到主页：各浮层的返回键都带 ‹，一路点回去。
 * ⚠️ clickText 失败时返回的是 {ok:false,...} —— 对象恒为真！
 *    写成 `a || b` 会永远锁死在第一次调用上，一个返回键都点不出去
 *    （表现为"回不去主页"，然后后面每一屏都因不在主页而连菜单都进不去）。
 */
async function ensureHome(maxTries = 6) {
  await evaluate(CLICK_HELPER);
  for (let i = 0; i < maxTries; i++) {
    if (await evaluate('window.__isHome()')) return true;
    let clicked = false;
    for (const [txt, exact] of [['‹ 返回', false], ['‹', true], ['关闭', false], ['返回', false]]) {
      const r = await clickText(txt, exact);
      if (r && r.ok) { clicked = true; break; }
    }
    await sleep(1000);
    await evaluate(CLICK_HELPER);
    if (!clicked) break;
  }
  return await evaluate('window.__isHome()');
}

/** 兜底：实在回不去就整页重载，保证后面几屏还能继续测 */
async function hardResetHome() {
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    await evaluate(CLICK_HELPER);
    if (await evaluate('window.__isHome()')) return true;
    await sleep(300);
  }
  return false;
}

// 每条：先在菜单里点开，再点回主页。label 用精确匹配 ——
// 否则"设置"会撞上"语音设置"，"送礼物"会撞上送礼页里的其它文字。
const STEPS = [
  { name: '聊天记录 (Chat)',        open: ['聊天记录', true],       expect: ['小柔'] },
  { name: '设置 (Settings)',        open: ['设置', true],           expect: ['模型'] },
  { name: '语音设置 (Voice)',       open: ['语音设置', true],       expect: ['音色'] },
  { name: '送礼物 (gift 视图)',     open: ['送礼物', true],         expect: ['🪙'] },
  { name: '她的记忆 (memory 视图)', open: ['她的记忆', true],       expect: ['他怕黑'] },
  { name: '每日签到',               open: ['每日签到', true],       expect: ['签到'] },
  { name: '回正视角',               open: ['回正视角', true],       expect: ['视角已回正'] },
  // ⚠️ 换人模式的标题是"换成谁？"，不是首次启动那句"今天想陪在谁身边？"
  //    （PersonaSelect 按 switching 切换文案）——拿后者当判据会永远 FAIL。
  { name: '换角色 / 换舞台',        open: ['换角色 / 换舞台', false], expect: ['换成谁？', '换成'] },
];

const results = [];
for (const s of STEPS) {
  await evaluate(CLICK_HELPER);
  const beforeEx = exceptions.length;
  const beforeCe = consoleErrors.length;

  // 从主页进菜单
  await ensureHome();
  const menuOpen = await clickText('☰', true);
  await sleep(1200);
  await evaluate(CLICK_HELPER);
  const inMenu = await evaluate(`window.__text().includes('‹ 关闭')`);
  if (!inMenu) {
    results.push({ ...s, ok: false, why: '没进菜单: ' + JSON.stringify(menuOpen) });
    continue;
  }

  const opened = await clickText(s.open[0], s.open[1]);
  await sleep(1600);
  await evaluate(CLICK_HELPER);

  const snap = await evaluate(`(() => {
    const t = window.__text();
    return {
      crashed: window.__crashed(),
      found: ${JSON.stringify(s.expect)}.filter((k) => t.includes(k)),
      missing: ${JSON.stringify(s.expect)}.filter((k) => !t.includes(k)),
      head: t.slice(0, 70).replace(/\\n/g, ' | '),
    };
  })()`);

  const newEx = exceptions.slice(beforeEx);
  const newCe = consoleErrors.slice(beforeCe);
  const ok = !!opened?.ok && !snap.crashed && snap.missing.length === 0
    && newEx.length === 0 && newCe.length === 0;
  results.push({ name: s.name, ok, opened: opened?.ok, ...snap, newEx, newCe });

  await sleep(400);
  let backOk = await ensureHome();
  if (!backOk) backOk = await hardResetHome(); // 回不去就重载，别让后面几屏跟着陪葬
  await sleep(6000); // 重载后 3D / 预热要重跑，给它一点时间
  results[results.length - 1].backOk = backOk;
}

console.log('\n=== 全屏扫雷结果 ===');
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name +
    (r.why ? '  ← ' + r.why : '') +
    (r.opened === false ? '  ← 入口没点到' : '') +
    (r.crashed ? '  ← ⚠️ 应用出错了' : '') +
    (r.missing?.length ? '  ← 缺: ' + JSON.stringify(r.missing) : '') +
    (!r.backOk ? '  ← 回不去主页' : ''));
  if (!r.ok) {
    console.log('        画面:', JSON.stringify(r.head));
    r.newEx?.forEach((e) => console.log('        [EXCEPTION]', e.slice(0, 260)));
    r.newCe?.forEach((e) => console.log('        [console.error]', e.slice(0, 260)));
  }
}

// 最后再整体看一次：有没有任何一屏留下"应用出错了"
await evaluate(CLICK_HELPER);
const finalCrashed = await evaluate('window.__crashed()');
console.log('\n未捕获异常:', exceptions.length, '| console.error:', consoleErrors.length,
  '| 结束画面崩溃:', finalCrashed);
exceptions.slice(0, 8).forEach((e) => console.log('  [EXCEPTION]', e.slice(0, 260)));
consoleErrors.slice(0, 8).forEach((e) => console.log('  [console.error]', e.slice(0, 260)));

const allOk = bad === 0 && !finalCrashed && exceptions.length === 0 && consoleErrors.length === 0;
console.log('\n' + (allOk ? '全部通过' : '有问题：' + bad + ' 个页面'));
cleanup();
process.exit(allOk ? 0 : 1);
