// 菜单里每个功能"点了真的有用吗" —— 不看页面开没开，看存档里的数有没有变
// ---------------------------------------------------------------------------
// 上一版扫雷（cdp-screens-sweep）只证明"每一屏能打开"，这是必要但不充分的：
// 送礼页能打开 ≠ 金币真的扣了、亲密真的加了。这里逐个验**副作用**：
//   签到 → coins +25 / 送礼 → coins 减、affection 加 / 记一条 → memory 多一条
//   / 换人 → personaId 真的换了 / 删记忆 → memory 少一条
// 判据一律读 localStorage（store 的 persist 落的就是它）。
//
// 用法: node cdp-menu-effects.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-menu-effects.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9354;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meff-'));

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
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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

const HELPERS = `
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
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: (el.textContent || '').slice(0, 40) };
  };
  window.__text = () => document.body.innerText || '';
  window.__isHome = () => {
    const t = window.__text();
    const inp = Array.from(document.querySelectorAll('input'))
      .some((e) => (e.placeholder || '').includes('跟她说'));
    return inp && t.includes('☰') && !t.includes('‹');
  };
  window.__store = () => {
    const raw = localStorage.getItem('aiva.companion.v1');
    const s = raw ? JSON.parse(raw) : {};
    const r = (s.relations || {})[s.personaId] || {};
    return {
      personaId: s.personaId, coins: s.coins,
      affection: r.affection, memory: (s.memory || []).length,
      giftCount: Object.values(s.giftCount || {}).reduce((a, b) => a + b, 0),
    };
  };
`;

async function clickText(txt, exact = false) {
  const rect = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!rect) return { ok: false, reason: 'not found: ' + txt };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: rect.x, y: rect.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return { ok: true, txt: rect.txt };
}

await send('Runtime.enable');
await send('Page.enable');

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      var KEY = 'aiva.companion.v1';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({
          personaId: 'girlfriend',
          relations: { girlfriend: { affection: 10, mood: 80, energy: 90,
            createdAt: Date.now() - 2 * 86400000, totalPets: 0, totalChats: 0 } },
          coins: 500, giftCount: {}, memory: [], chatHistory: {},
          lastSeenAt: Date.now(), lastCheckInDay: null,
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

let atHome = false;
for (let i = 0; i < 100; i++) {
  await evaluate(HELPERS);
  if (await evaluate('window.__isHome()')) { atHome = true; break; }
  await sleep(300);
}
if (!atHome) { console.log('!!! 没进主页'); cleanup(); process.exit(1); }
await sleep(11000); // 等模型 / 预热

async function ensureHome(maxTries = 6) {
  await evaluate(HELPERS);
  for (let i = 0; i < maxTries; i++) {
    if (await evaluate('window.__isHome()')) return true;
    let clicked = false;
    for (const [txt, exact] of [['‹ 返回', false], ['‹', true], ['关闭', false], ['返回', false]]) {
      const r = await clickText(txt, exact);
      if (r && r.ok) { clicked = true; break; }
    }
    await sleep(1000);
    await evaluate(HELPERS);
    if (!clicked) break;
  }
  return await evaluate('window.__isHome()');
}

const openMenu = async () => {
  await ensureHome();
  await clickText('☰', true);
  await sleep(1200);
  await evaluate(HELPERS);
  return await evaluate(`window.__text().includes('‹ 关闭')`);
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
};

// ---- 1. 每日签到：金币 +25 -------------------------------------------------
{
  await openMenu();
  const b = await evaluate('window.__store()');
  const hit = await clickText('每日签到', true);
  await sleep(1600);
  await evaluate(HELPERS);
  const a = await evaluate('window.__store()');
  const toasted = await evaluate(`/签到 \\+\\d+|已经领过/.test(window.__text())`);
  record('① 每日签到 → 金币 +25', !!hit?.ok && a.coins === b.coins + 25 && toasted,
    `点中=${hit?.ok}, coins ${b.coins}→${a.coins}, 提示=${toasted}`);

  // 再点一次：今天已经领过，不该再加
  const c = await evaluate('window.__store()');
  await clickText('每日签到', true);
  await sleep(1400);
  const d = await evaluate('window.__store()');
  record('② 重复签到当天不再发金币', d.coins === c.coins,
    `coins ${c.coins}→${d.coins}`);
}

// ---- 2. 送礼物：金币减、亲密加、送礼计数 +1 ---------------------------------
{
  await openMenu();
  await clickText('送礼物', true);
  await sleep(1400);
  await evaluate(HELPERS);
  const b = await evaluate('window.__store()');
  // 找一个买得起的礼物：文案形如 "🪙 30" 且价格 ≤ 金币
  const gift = await evaluate(`(() => {
    const t = window.__text();
    const prices = (t.match(/🪙\\s*(\\d+)/g) || []).map((s) => Number(s.replace(/\\D/g, '')));
    const ok = prices.filter((p) => p > 0 && p <= ${b.coins});
    return ok.length ? Math.min(...ok) : null;
  })()`);
  const hit = gift == null ? { ok: false } : await clickText(`🪙 ${gift}`, true);
  await sleep(1600);
  await evaluate(HELPERS);
  const a = await evaluate('window.__store()');
  record('③ 送礼物 → 扣金币 + 加亲密 + 计数 +1',
    !!hit?.ok && a.coins === b.coins - gift && a.affection > b.affection
      && a.giftCount === b.giftCount + 1,
    `点中=${hit?.ok} (🪙${gift}), coins ${b.coins}→${a.coins}, ` +
    `亲密 ${b.affection}→${a.affection}, 已送 ${b.giftCount}→${a.giftCount}`);
}

// ---- 3. 她的记忆：写一条进去 -----------------------------------------------
{
  await ensureHome();
  await openMenu();
  await clickText('她的记忆', true);
  await sleep(1400);
  await evaluate(HELPERS);
  const b = await evaluate('window.__store()');
  // 往输入框里打字：先把焦点点上去
  const box = await evaluate(`(() => {
    const i = Array.from(document.querySelectorAll('input'))
      .find((e) => (e.placeholder || '').includes('喜欢喝美式'));
    if (!i) return null;
    i.focus();
    const r = i.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (box) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mouseReleased' ? 0 : 1,
      });
    }
    await send('Input.insertText', { text: '他怕黑，睡觉要留一盏小灯' });
    await sleep(500);
  }
  const addHit = await clickText('记下', true);
  await sleep(1600);
  await evaluate(HELPERS);
  const a = await evaluate('window.__store()');
  const shown = await evaluate(`window.__text().includes('他怕黑，睡觉要留一盏小灯')`);
  record('④ 她的记忆 → 写一条真的存下来',
    !!box && !!addHit?.ok && a.memory === b.memory + 1 && shown,
    `输入框=${!!box}, 点记下=${addHit?.ok}, memory ${b.memory}→${a.memory}, 上屏=${shown}`);

  // 删掉它，确认删除也生效
  const delHit = await clickText('删除', true);
  await sleep(1600);
  await evaluate(HELPERS);
  const c = await evaluate('window.__store()');
  record('⑤ 记忆能删掉', !!delHit?.ok && c.memory === b.memory,
    `点删除=${delHit?.ok}, memory ${a.memory}→${c.memory}`);
}

// ---- 4. 换角色：真的换人 ---------------------------------------------------
{
  await ensureHome();
  await openMenu();
  await clickText('换角色 / 换舞台', false);
  await sleep(1600);
  await evaluate(HELPERS);
  const b = await evaluate('window.__store()');
  // 换人页是 ScrollView，先把 Noa 滚进来
  let noaRect = null;
  for (let i = 0; i < 14; i++) {
    await evaluate(HELPERS);
    noaRect = await evaluate(`window.__rectFor('Noa', false)`);
    if (noaRect && noaRect.y > 60 && noaRect.y < 820) break;
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 207, y: 520, deltaX: 0, deltaY: 300 });
    await sleep(320);
  }
  const cardHit = noaRect ? await clickText('Noa', false) : { ok: false };
  await sleep(1200);
  // 换人模式的 CTA 是「换成 X」
  await evaluate(HELPERS);
  const ctaHit = await clickText('换成 ', false);
  await sleep(2500);
  await evaluate(HELPERS);
  const a = await evaluate('window.__store()');
  const atHomeNow = await evaluate('window.__isHome()');
  record('⑥ 换角色 → 真的换人并回到主页',
    !!cardHit?.ok && !!ctaHit?.ok && a.personaId === 'realistic-noa' && atHomeNow,
    `点卡片=${cardHit?.ok}, 点CTA=${ctaHit?.ok}, personaId ${b.personaId}→${a.personaId}, 回主页=${atHomeNow}`);
}

// ---- 5. 全程不许炸 ---------------------------------------------------------
record('⑦ 全程无异常', exceptions.length === 0 && consoleErrors.length === 0,
  `exception=${exceptions.length}, console.error=${consoleErrors.length}`);
exceptions.slice(0, 6).forEach((e) => console.log('    [EXCEPTION]', e.slice(0, 240)));
consoleErrors.slice(0, 6).forEach((e) => console.log('    [console.error]', e.slice(0, 240)));

const bad = results.filter((r) => !r.ok).length;
console.log('\n' + (bad === 0 ? '菜单功能全部生效' : '有问题：' + bad + ' 项'));
cleanup();
process.exit(bad === 0 ? 0 : 1);
