/**
 * 用本机已有的 Chrome（走 CDP 协议）打开 dist/ 页面并截图。
 * 目的：肉眼确认真实 glb 模型在场景里的呈现效果 —— 是不是白模、比例对不对。
 *
 * 用法： node tools/shot.mjs <url> <输出png> [等待毫秒] [宽] [高]
 * 例：   node tools/shot.mjs http://127.0.0.1:8123/ assets/preview/home.png 6000
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const args = process.argv.slice(2);
const url = args[0];
const outFile = args[1];
const waitMs = Number(args[2] ?? 6000);
const width = Number(args[3] ?? 430);
const height = Number(args[4] ?? 932);
// 可选：--click "<按钮文字>"  用来先进入某个页面再截图
const clickParts = [];
for (let i = 5; i < args.length; i++) {
  if (args[i] === '--click') clickParts.push(args[i + 1]);
}
if (!url || !outFile) {
  console.error('用法: node tools/shot.mjs <url> <输出png> [等待毫秒] [宽] [高] [--click "文字"]...');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.isAbsolute(outFile) ? outFile : path.join(root, outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const profile = path.join(root, 'tools', '.chrome-profile');
const PORT = 9333;

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  // 无头 Chrome 默认用 SwiftShader 软件渲染，WebGL2 是能起来的
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 没起来');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, events };
}

const logs = [];

try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const { send, events } = cdp(ws);

  const logs = [];
  /** 把 CDP 事件里的 console / 异常捞成可读文本 */
  function drainLogs() {
    for (const ev of events.splice(0)) {
      if (ev.method === 'Runtime.consoleAPICalled') {
        const text = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${ev.params.type}] ${text}`);
      } else if (ev.method === 'Log.entryAdded') {
        logs.push(`[log:${ev.params.entry.level}] ${ev.params.entry.text}`);
      } else if (ev.method === 'Runtime.exceptionThrown') {
        logs.push(`[exception] ${ev.params.exceptionDetails?.text} ${ev.params.exceptionDetails?.exception?.description ?? ''}`);
      }
    }
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);

  /** 走一遍 flow：每次点击后都等页面渲染稳定 */
  async function settle(ms) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      drainLogs();
      await sleep(200);
    }
  }

  await send('Page.navigate', { url }, sessionId);
  await settle(waitMs);

  for (const text of clickParts) {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const hit = [...document.querySelectorAll('[role="button"],div,span')]
          .filter((el) => (el.innerText || '').includes(${JSON.stringify(text)}))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        if (!hit) return 'not-found';
        hit.scrollIntoView?.();
        hit.click();
        return 'clicked: ' + (hit.innerText || '').replace(/\\n/g, ' | ').slice(0, 60);
      })()`,
      returnByValue: true,
    }, sessionId);
    console.log(`点击「${text}」-> ${r.result?.value}`);
    await settle(3500);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));

  // 顺手把页面上的运行时错误也捞出来
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.querySelector('canvas');
      return JSON.stringify({
        canvas: c ? c.width + 'x' + c.height : null,
        body: document.body.innerText.slice(0, 300),
      });
    })()`,
    returnByValue: true,
  }, sessionId);

  // 自定义探针：直接问页面几个只有它知道的问题（用来定位资源加载链路）
  if (process.env.PROBE) {
    const p = await send('Runtime.evaluate', {
      expression: process.env.PROBE,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    console.log('PROBE ->', JSON.stringify(p.result?.value ?? p.result, null, 1));
  }

  console.log('截图 ->', outPath, fs.statSync(outPath).size + ' bytes');
  console.log('页面状态:', probe.result?.value);
  if (logs.length) {
    console.log('--- 控制台 ---');
    logs.slice(0, 40).forEach((l) => console.log(l));
  } else {
    console.log('控制台无输出（没有报错）');
  }

  ws.close();
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
