// 给线上后台页面截图（真域名，能看到 SDK 已加载 + 登录页真实渲染）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const out = process.argv[3];
const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9363;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=900,900', url], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (_) {} });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url });
await sleep(7000);
const r = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
console.log('saved', out);
chrome.kill();
process.exit(0);
