// 真域名上的云链路验收：
//   1) 主 app 有没有真的去拉 app_settings，拿到的是不是我们灌进去的 9 个开关
//   2) 有没有 401 / 42501（Origin 不匹配 / RLS 漏配会在这里暴露）
//   3) 后台页面能不能把 SDK 从 CDN 拉起来并完成初始化
//
// 为什么必须在真域名上跑：Auth 和数据面都绑定应用的 HTTPS 发布域名，
// localhost 上根本不会发这些请求，本地全绿也证明不了线上能用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://cloud-ai-companion.app.workbuddy.host';
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9361;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--mute-audio', '--window-size=390,844', BASE + '/',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (_) {} });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
const cloudHits = [];
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.responseReceived') {
    const u = m.params?.response?.url || '';
    if (u.includes('/.cloud/')) {
      cloudHits.push({ url: u, status: m.params.response.status, id: m.params.requestId, type: m.params.response.mimeType });
    }
  }
  if (m.method === 'Network.loadingFailed') {
    const u = (m.params?.errorText || '');
    errors.push('加载失败 ' + u);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    errors.push(String((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 160));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('异常 ' + String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 160));
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');

console.log('=== 1) 主 app：等首屏 + 云请求 ===');
await send('Page.navigate', { url: BASE + '/' });
await sleep(26000);

const booted = await evaluate(`!!document.body && (document.body.innerText || '').includes('AIVA')`);
console.log('  首页渲染:', booted ? '✅' : '❌');
console.log('  云数据面请求 ' + cloudHits.length + ' 条：');
for (const h of cloudHits) console.log('    [' + h.status + '] ' + h.url.replace(BASE, ''));

const settingsHit = cloudHits.find((h) => /app_settings/.test(h.url));
if (settingsHit) {
  const body = await send('Network.getResponseBody', { requestId: settingsHit.id });
  const raw = body.result?.body || '';
  console.log('  app_settings 状态码:', settingsHit.status === 200 ? '✅ 200' : '❌ ' + settingsHit.status);
  let rows = [];
  try { rows = JSON.parse(raw); } catch (_) { console.log('  解析失败，原始:', raw.slice(0, 200)); }
  if (Array.isArray(rows)) {
    console.log('  拿到开关 ' + rows.length + ' 个：');
    for (const r of rows) console.log('    ' + r.key + ' = ' + JSON.stringify(r.value));
  }
} else {
  console.log('  ❌ 没有发出 app_settings 请求 —— 云没接上');
}

console.log('\n=== 2) 后台页面 ===');
await send('Page.navigate', { url: BASE + '/admin.html' });
await sleep(9000);
const adminState = await evaluate(`JSON.stringify({
  title: document.title,
  hasLoginBtn: !!document.getElementById('go'),
  sdkLoaded: typeof window.WorkBuddyCloud !== 'undefined',
  body: (document.body.innerText || '').slice(0, 220)
})`);
console.log(' ', adminState);

console.log('\n=== 3) 控制台异常 ===');
if (!errors.length) console.log('  ✅ 无异常');
else errors.slice(0, 12).forEach((e) => console.log('  ⚠ ' + e));

chrome.kill();
process.exit(0);
