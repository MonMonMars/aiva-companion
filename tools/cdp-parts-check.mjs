#!/usr/bin/env node
// 验证「可换装部件」链路：base + outfit + hair 三个 GLB 拼出来的角色，
// 到底还在不在、骷髅和表情还通不通。
//
// 为什么单开一个脚本（不复用 cdp-modelcheck.mjs）：
//   那个脚本用「包含小柔三个字」去找卡片，会命中整个页面容器，
//   永远点不进 Home（实测不可见 case）。真正的 CTA 文案是「开始相处 · 小柔」，
//   必须匹配 ^开始相处 · 前缀，见 cdp-uicheck.mjs 第 261 行的注释。
//
// 用法：node tools/cdp-parts-check.mjs http://127.0.0.1:8800/ [输出png]
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const OUT = process.argv[3] || 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/tmp/shot-parts.png';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9461);

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
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? (a.preview?.description || '')).join(' ');
      logs.push((m.params.type || 'log') + ': ' + t.slice(0, 220));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + (ex.exception?.description || ex.text || '').slice(0, 400));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close(), logs };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'partscheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

try {
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  if (!v) throw new Error('DevTools 没起来');
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url });
  await sleep(6000);

  // --- 点 CTA 进 Home ---
  const click = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const els = Array.from(document.querySelectorAll('div,span'));
    const hit = els.filter(e => {
      const s = (e.textContent || '').trim();
      return /^开始相处 \\u00b7 /.test(s) || (/^换成 /.test(s) && !/^换成谁/.test(s));
    });
    if (!hit.length) return { ok: false, reason: '没找到 CTA', sample: els.slice(0, 0).length };
    // 取最内层：外层容器也含这段文案
    hit.sort((a, b) => a.textContent.length - b.textContent.length);
    const el = hit[0];
    const r = el.getBoundingClientRect();
    const fire = (t) => el.dispatchEvent(new MouseEvent(t, {
      bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8,
    }));
    fire('mousedown'); fire('mouseup'); fire('click');
    return { ok: true, picked: (el.textContent || '').trim().slice(0, 24) };
  })()` });
  console.log('>>> 点 CTA：' + JSON.stringify(click.result?.result?.value));

  // 三个 GLB 合计 5.6MB，解析要时间，等久一点
  await sleep(18000);

  const probe = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const d = window.__aivaDebug;
    const glb = (performance.getEntriesByType('resource') || [])
      .filter(r => /\\.glb(\\?|$)/.test(r.name))
      .map(r => ({ f: r.name.split('/').pop().slice(0, 46), kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024) }));
    let partsHidden = null, meshes = null;
    try {
      if (d && d.hideParts) { d.hideParts(false); }
      const cv = document.querySelector('canvas');
      if (cv) { meshes = cv.width + 'x' + cv.height; }
    } catch (e) { partsHidden = 'ERR ' + e.message; }
    return {
      hasDebug: !!d,
      hasRig: d ? !!d.hasRig() : null,
      hasFace: d ? !!d.hasFace() : null,
      pose: d ? (d.currentPose() || null) : null,
      glb,
      canvas: meshes,
      home: !((document.body && document.body.innerText || '').includes('今天想陪在谁身边')),
      text: (document.body && document.body.innerText || '').slice(0, 120),
    };
  })()` });
  const val = probe.result?.result?.value || {};

  console.log('\n=== 部件链路状态 ===');
  console.log('  已进入主页     :', val.home);
  console.log('  调试钩子       :', val.hasDebug);
  console.log('  骨架已接管     :', val.hasRig);
  console.log('  表情已接管     :', val.hasFace, '  ← 必须为 true，否则就是拆片时丢了 morph');
  console.log('  当前待机姿势   :', val.pose);
  console.log('  canvas 尺寸    :', val.canvas);
  console.log('  请求的 GLB     :');
  for (const g of (val.glb || [])) console.log('      ' + String(g.kb).padStart(6) + ' KB  ' + g.f);
  console.log('  可见文字       :', JSON.stringify((val.text || '').slice(0, 80)));

  console.log('\n=== 控制台（含 parts / model / morph 关键字的全部 + 异常）===');
  const want = c.logs.filter((l) => /parts|model|morph|rig|EXCEPTION|error/i.test(l));
  (want.length ? want : c.logs.slice(-12)).forEach((l) => console.log('  ' + l.slice(0, 220)));

  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot.result?.data;
  if (b64) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log('\n  截图 -> ' + OUT + '  ' + Math.round(fs.statSync(OUT).size / 1024) + ' KB');
  }
  c.close();
} catch (e) {
  console.error('探针失败：', e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
