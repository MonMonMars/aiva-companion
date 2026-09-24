// 探测：这台机器上的 Chrome 在各组启动参数下到底能不能拿到 WebGL2。
// 3D 舞台、渐进加载队列都依赖它，拿不到就会整片测不到。
// 用法: node webgl-probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMBOS = [
  { name: 'A 默认 headless=new', args: [] },
  { name: 'B angle+swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  { name: 'C swiftshader-webgl', args: ['--use-gl=swiftshader-webgl', '--enable-unsafe-swiftshader'] },
  { name: 'D angle+swiftshader+disable-gpu-sandbox', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--no-sandbox'] },
  { name: 'E 旧 headless', args: ['--headless', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
];

async function probe(combo, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glprobe-'));
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', ...combo.args,
    'data:text/html,<canvas id=c></canvas>'];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (_) {}
    await sleep(300);
  }
  if (!wsUrl) { chrome.kill(); return { name: combo.name, err: 'no cdp' }; }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const c = document.createElement('canvas');
      const g2 = c.getContext('webgl2');
      const g1 = c.getContext('webgl');
      const dbg = g2 && g2.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: !!g2,
        webgl1: !!g1,
        renderer: dbg ? g2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      };
    })()`,
  });
  ws.close(); chrome.kill();
  return { name: combo.name, ...(r.result?.result?.value || {}) };
}

for (let i = 0; i < COMBOS.length; i++) {
  const out = await probe(COMBOS[i], 9400 + i);
  console.log(JSON.stringify(out));
}
