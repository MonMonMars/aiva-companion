/**
 * 启动各阶段到底各占多久 —— 给 fetch / XHR 打桩，按请求粒度量。
 *
 * 为什么要有这个（**这个脚本两次推翻了我的错误结论，所以转正了**）：
 *
 *   ① 看到「进入下一屏 10.9 秒」，我断定是 loadSettings 慢，加了 2 秒上限 ——
 *      上线后只降到 10407ms，几乎没变。打桩一量才发现：CORS 失败其实 0.3 秒
 *      就返回，那 8 秒是 SDK 的退避重试（默认 retryEnabled，3~4 次）。
 *      **总耗时根本推不出因果，必须按请求拆开看。**
 *   ② 加了 `.retry(false)` 之后，第一次量出「4 条请求、反而变多」，差点以为
 *      改坏了 —— 真相是那次抓到了部署切换瞬间的残响应（bundle 只有 9KB）。
 *      **量之前先确认线上跑的是不是你以为的那个包。**
 *
 * 教训：给「慢」开药方之前先按阶段量；量出来不符预期时，先怀疑测量本身。
 *
 * 用法： node tools/diag-startup-phases.mjs [url]
 *        默认 https://monmonmars.github.io/aiva-companion/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const url = process.argv[2] || 'https://monmonmars.github.io/aiva-companion/';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, 'tools', '.chrome-profile-phases');
const PORT = 9354;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,932', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); throw new Error('Chrome 没起来'); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true }, sessionId);

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__t0 = performance.now();
      window.__net = [];
      const _fetch = window.fetch;
      window.fetch = function (...a) {
        const rec = { kind: 'fetch', url: String(a[0] && a[0].url || a[0]), t0: performance.now() };
        window.__net.push(rec);
        return _fetch.apply(this, a).then(
          (r) => { rec.t1 = performance.now(); rec.status = r.status; return r; },
          (e) => { rec.t1 = performance.now(); rec.err = String(e); throw e; }
        );
      };
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, u) {
        this.__rec = { kind: 'xhr', url: String(u), t0: performance.now() };
        window.__net.push(this.__rec);
        return _open.apply(this, arguments);
      };
      const _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const rec = this.__rec;
        this.addEventListener('loadend', () => { if (rec) { rec.t1 = performance.now(); rec.status = this.status; } });
        return _send.apply(this, arguments);
      };
    `,
  }, sessionId);

  const t0 = Date.now();
  await send('Page.navigate', { url }, sessionId);

  const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId).then((r) => r.result?.value);
  const IS_PAST = `/(想陪在谁身边|换成谁)/.test(document.body.innerText || '')`;

  // 每 250ms 探一次，抓「进入下一屏」的时刻
  let pastAt = null;
  for (let i = 0; i < 80; i++) {
    if (await ev(IS_PAST)) { pastAt = Date.now() - t0; break; }
    await sleep(250);
  }
  // 再等 3 秒收集剩余（迟到的重试）
  await sleep(3000);

  console.log('进入下一屏:', pastAt === null ? '20 秒内没到' : pastAt + ' ms');
  console.log('\n=== 请求时间线（相对导航）===');
  const net = JSON.parse((await ev(`JSON.stringify(window.__net.map(r => ({...r, t0: Math.round(r.t0), t1: r.t1 ? Math.round(r.t1) : null})))`)) || '[]');
  for (const r of net) {
    const dur = r.t1 ? String(r.t1 - r.t0) + 'ms' : '未结束';
    console.log(
      String(Math.round(r.t0)).padStart(6) + 'ms 起  ' +
      dur.padStart(8) + '  ' +
      String(r.status ?? r.err ?? '').padEnd(22) + '  ' +
      String(r.url).replace(/^https?:\/\//, '').slice(0, 88)
    );
  }
} finally {
  ws.close(); chrome.kill(); await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
