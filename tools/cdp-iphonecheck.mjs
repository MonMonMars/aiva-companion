#!/usr/bin/env node
// 验收 iPhone 上的两个老大难：
//   ① 输入框聚焦时 iOS Safari 整页放大（根因：font-size < 16px）
//   ② 双指捏合被浏览器抢去做页面缩放（根因：舞台没 touch-action / 没拦 gesture*）
//
// 这两个都**没法在 Windows 上真机复现**，所以这里验的是它们的**前置条件**：
// 只要条件不满足，iOS 上就一定不会犯；条件满足 = 该踩的坑都堵上了。
//
// 用法：node tools/cdp-iphonecheck.mjs http://127.0.0.1:8800/
//
// ⚠️ 踩过的坑（别再犯）：
//   · Windows 控制台写中文会乱码 → 日志**同时**落盘 tmp/iphonecheck.log（utf8），以文件为准。
//   · 固定 sleep 等页面 = 必翻车。这里一律**轮询**到条件满足，超时才算失败。
//   · RNW 的 Pressable 挂在父节点上，Text 只是子节点 → 点**最内层**含文案的节点，事件冒泡上去。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const LOG = process.env.IPHONE_LOG || '../tmp/iphonecheck.log';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9473);

// ---- 日志：屏幕也要、文件也要（文件是准的）--------------------------------
const buf = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  buf.push(line); console.log(line);
};
const flush = () => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, buf.join('\n') + '\n', 'utf8'); } catch {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0;
  const logs = [];
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push((m.params.type || 'log') + ': ' + t.slice(0, 200));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close(), logs };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iphone-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

// ---- 页面扫描：输入框字号 + 舞台手势 + viewport 全局开关 -------------------
// ⚠️ iOS Safari 只在**会弹键盘的文本输入**上放大页面；
//    RNW 的 <Switch> 会渲染一个 opacity:0 的原生 <input type=checkbox> 做无障碍，
//    它既看不见也点不到，聚焦它不会触发缩放 —— 所以只有 TEXTY 类型进闸门，
//    其余类型照样列出来但标记为 skip，别把探针自己的误报当成 bug。
const TEXTY = /^(text|password|email|number|search|tel|url|textarea)$/i;
// textarea 的 el.type 是 'textarea'，input[type=text] 的 tag 是 'input' → 两个都试
const verdict = (i) => {
  if (!TEXTY.test(i.type || i.tag)) return 'skip';
  return i.px >= 16 ? 'OK  ' : 'FAIL';
};
const SCAN = `(() => {
  const out = [], seen = new Set();
  document.querySelectorAll('input,textarea').forEach((el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;           // 隐藏的不算
    const key = el.type + '|' + cs.fontSize + '|' + Math.round(r.width) + '|' + (el.placeholder||'');
    if (seen.has(key)) return; seen.add(key);
    out.push({ tag: el.tagName.toLowerCase(), type: el.type || '', font: cs.fontSize,
      px: parseFloat(cs.fontSize), w: Math.round(r.width), h: Math.round(r.height),
      opacity: cs.opacity, vis: cs.visibility,
      placeholder: (el.placeholder || '').slice(0, 18) });
  });
  let stage = null;
  document.querySelectorAll('div').forEach((el) => {
    if (stage) return;
    const cs = getComputedStyle(el);
    if (cs.touchAction === 'none' && el.getBoundingClientRect().height > 200) {
      stage = { h: Math.round(el.getBoundingClientRect().height), ta: cs.touchAction };
    }
  });
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return {
    viewport: (document.querySelector('meta[name=viewport]') || {}).content || null,
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
    textAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust,
    inputs: out, stage,
    hasKizuna: /Kizuna|\\u7eca\\u7231/.test(t),
    where: t.slice(0, 70),
  };
})()`;

// ---- 点一下：最内层含指定文案的节点（RNW Pressable 在父级，冒泡上去）------
const TAP = `(needle) => {
  const els = Array.from(document.querySelectorAll('div,span'))
    .filter(e => (e.textContent || '').includes(needle));
  if (!els.length) return { ok:false, reason:'not-found' };
  els.sort((a,b) => a.textContent.length - b.textContent.length);
  const el = els[0], r = el.getBoundingClientRect();
  if (!r.width && !r.height) return { ok:false, reason:'zero-size' };
  const cx = r.left + Math.min(8, r.width/2), cy = r.top + Math.min(8, r.height/2);
  ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(
    new MouseEvent(t, { bubbles:true, cancelable:true, clientX:cx, clientY:cy })));
  return { ok:true, hit:(el.textContent||'').trim().slice(0,20) };
}`;

try {
  const allInputs = [];
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  const ev = (expr) => c.send('Runtime.evaluate', { returnByValue: true, expression: expr })
    .then((r) => r.result?.result?.value);
  const tap = (needle) => ev(`((${TAP})(${JSON.stringify(needle)}))`);

  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.send('Page.navigate', { url });

  // ---- ① 等首屏：轮询到「开始相处 · xxx」出现再点 --------------------------
  let clicked = null;
  for (let i = 0; i < 40 && !clicked; i++) {
    await sleep(1000);
    clicked = await ev(`(() => {
      const hit = Array.from(document.querySelectorAll('div,span'))
        .filter(e => /^\\u5f00\\u59cb\\u76f8\\u5904\\s*\\u00b7/.test((e.textContent||'').trim()));
      if (!hit.length) return null;
      hit.sort((a,b)=>a.textContent.length-b.textContent.length);
      const el = hit[0], r = el.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(
        new MouseEvent(t,{bubbles:true,cancelable:true,clientX:r.left+8,clientY:r.top+8})));
      return el.textContent.trim().slice(0, 24);
    })()`);
  }
  say('=== ① 进入主页 ===');
  say('  点到的 CTA :', clicked ? JSON.stringify(clicked) : '❌ 40s 内没出现「开始相处 ·」');
  if (!clicked) { const s = await ev(SCAN); say('  当前页面 :', s?.where); throw new Error('进不去主页，后续免谈'); }

  // ---- ② 等主页真正就绪（舞台 or 输入框出现）------------------------------
  let home = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    home = await ev(SCAN);
    if (home?.stage || (home?.inputs || []).length) break;
  }
  say('\n=== ② viewport / 全局 ===');
  say('  viewport        :', home?.viewport);
  say('  overscroll-y    :', home?.htmlOverscroll, '（none = 橡皮筋已关）');
  say('  text-size-adjust:', home?.textAdjust);
  say('  当前页面        :', home?.where);
  say('\n=== ③ 主页输入框字号（必须全部 ≥ 16px）===');
  for (const i of (home?.inputs || [])) {
    say(verdict(i) + ` ${i.font.padStart(7)}  ${i.tag}[${i.type}] ${i.w}x${i.h}  "${i.placeholder}"`);
    allInputs.push(i);
  }
  if (!(home?.inputs || []).length) say('  （主页没扫到输入框）');
  say('\n=== ④ 舞台手势 ===');
  say('  touch-action:none 的容器 :', JSON.stringify(home?.stage));

  // ---- ⑤ 逐屏扫：菜单 → 入口 → 扫 → 返回 ----------------------------------
  // 设置/语音/聊天记录都是**独立页面**，不返回就点不到下一个菜单项。
  const screens = [
    ['她的记忆', '她的记忆'],
    ['账号 · 云同步', '账号'],
    ['设置', '设置'],
    ['语音设置', '语音设置'],
    ['聊天记录', '聊天记录'],
  ];
  let step = 0, menuDump = false;
  for (const [label, needle] of screens) {
    await tap('☰'); await sleep(900);
    if (!menuDump) {                                  // 只打一次菜单内容，方便核对入口名
      const m = await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,220)`);
      say('\n  [菜单内容] ' + m);
      menuDump = true;
    }
    const t = await tap(needle);
    await sleep(1800);
    const s = await ev(SCAN);
    const ins = s?.inputs || [];
    say(`\n=== ${step + 5}. ${label} ===`);
    say('  点击:', JSON.stringify(t), ' 页面:', s?.where?.slice(0, 40));
    if (!ins.length) say('  （这屏没有输入框）');
    for (const i of ins) {
      say(verdict(i) + ` ${i.font.padStart(7)}  ${i.tag}[${i.type}] "${i.placeholder}"`);
      allInputs.push(i);
    }
    step++;
    await tap('返回'); await sleep(900);
  }

  say('\n=== ⑩ 合规：公开页面里不该再出现 Kizuna ===');
  say('  body 含 Kizuna/绊爱 :', home?.hasKizuna, '（false = 已下架）');

  const seen = new Set();
  const uniq = allInputs.filter((i) => {
    const k = i.type + '|' + i.placeholder + '|' + i.font;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const texty = uniq.filter((i) => TEXTY.test(i.type || i.tag));
  const bad = texty.filter((i) => i.px < 16);
  const skipped = uniq.filter((i) => !TEXTY.test(i.type || i.tag));
  say('\n=== 汇总 ===');
  say(`  扫到 ${uniq.length} 个输入框（${texty.length} 个会弹键盘 / ${skipped.length} 个不会）`);
  say(`  会弹键盘的里面 < 16px 的：${bad.length}`);
  for (const i of texty) say(`    ${verdict(i)} ${i.font.padStart(7)}  [${i.type}] "${i.placeholder}"`);
  for (const i of skipped) say(`    skip ${i.font.padStart(7)}  [${i.type}] (opacity=${i.opacity}) 不弹键盘，不参与判定`);
  say(bad.length ? '  ❌ 还有漏网的' : '  ✅ 全部达标，iOS Safari 不会再聚焦放大');

  const errs = c.logs.filter((l) => /EXCEPTION|error:|Error:/i.test(l));
  if (errs.length) { say('\n=== 异常 ==='); errs.slice(0, 8).forEach((l) => say('  ' + l)); }
  c.close();
} catch (e) {
  say('探针失败：' + e.message);
} finally {
  flush();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
