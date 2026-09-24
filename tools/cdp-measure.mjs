#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 连到无头 Chrome，在真实页面里跑 JS 测量布局。
 *
 * 为什么需要它：截图只能"看"，看不出「到底哪个元素超宽了」。
 * 排查布局溢出时，唯一靠谱的答案是页面自己算出来的 scrollWidth / getBoundingClientRect。
 *
 * 用法：node tools/cdp-measure.mjs <url> [表达式...]
 *   内置默认表达式会报告滚动宽度与卡片盒模型。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const url = process.argv[2] || 'http://127.0.0.1:8193/';
const exprs = process.argv.slice(3);
const PORT = Number(process.env.CDP_PORT || 9411);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=430,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) =>
  new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });

async function waitForDevtools() {
  for (let i = 0; i < 50; i++) {
    try { return await getJSON('/json/version'); } catch { await sleep(200); }
  }
  throw new Error('Chrome DevTools 端口没起来');
}

/** CDP 客户端：优先用 Node 内建 WebSocket（Node 22+），退回 ws 包 */
async function cdp(wsUrl) {
  let WS = globalThis.WebSocket;
  if (!WS) {
    const mod = await import('ws');
    WS = mod.default || mod.WebSocket;
  }
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;

  await new Promise((res, rej) => {
    sock.addEventListener?.('open', res);
    sock.addEventListener?.('error', rej);
    if (sock.on) { sock.on('open', res); sock.on('error', rej); }
  });

  const onMsg = (raw) => {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  };
  if (sock.addEventListener) sock.addEventListener('message', (e) => onMsg(e.data));
  else sock.on('message', onMsg);

  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc;
    waiters.set(id, res);
    sock.send(JSON.stringify({ id, method, params }));
  });

  return { send, close: () => sock.close() };
}

const DEFAULT_EXPR = `(() => {
  const de = document.documentElement, b = document.body;
  const cards = [...document.querySelectorAll('div')]
    .filter(e => e.textContent.includes('小柔') && e.textContent.includes('未开始'));
  const card = cards[cards.length - 1];
  const out = {
    innerWidth: window.innerWidth,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: b.scrollWidth,
    overflowX: de.scrollWidth - window.innerWidth,
  };
  if (card) {
    const r = card.getBoundingClientRect();
    out.card = { left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1) };
    const p = card.parentElement.getBoundingClientRect();
    out.parent = { left: +p.left.toFixed(1), right: +p.right.toFixed(1), width: +p.width.toFixed(1) };
    // 找出所有右边界超出视口的元素
    out.overflowing = [...document.querySelectorAll('*')]
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(o => o.r.right > window.innerWidth + 1 && o.r.width > 0)
      .slice(0, 6)
      .map(o => ({
        tag: o.e.tagName,
        cls: (o.e.className || '').toString().slice(0, 40),
        text: (o.e.textContent || '').slice(0, 18),
        right: +o.r.right.toFixed(1),
        width: +o.r.width.toFixed(1),
      }));
  }
  return JSON.stringify(out, null, 2);
})()`;

try {
  const ver = await waitForDevtools();
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);

  await c.send('Page.enable');
  await c.send('Page.navigate', { url });
  await sleep(3500);

  for (const e of (exprs.length ? exprs : [DEFAULT_EXPR])) {
    const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      console.log('表达式报错：', r.result.exceptionDetails.text);
    } else {
      console.log(r.result?.result?.value ?? JSON.stringify(r.result));
    }
  }
  c.close();
} catch (e) {
  console.error('测量失败：', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
