// 麦克风链路的运行时验证（iPhone 那条路）
// ---------------------------------------------------------------------------
// 修的是什么：iOS Safari 从来没有 webkitSpeechRecognition，旧代码拿它当唯一入口，
// 于是 iPhone 上点麦克风→直接"不支持"，系统麦克风权限一次都不弹。
// 修完必须证明四件事，否则等于没修：
//   ① 点麦真的调了 getUserMedia，而且拿到了音频轨（= 权限弹窗会弹、麦真的开了）
//   ② MediaRecorder 真的开录，而且吐出了字节（不是空 Blob）
//   ③ 这段音频真的被 POST 给了听写服务（拦下来看 Content-Type 和 body 大小）
//   ④ 识别结果真的进了对话（字幕出现 "> xxx"，并且拿到大模型回复）
//
// 手法：Chrome 的假麦克风（--use-fake-device-for-media-stream 会灌一条正弦音，
// --use-fake-ui-for-media-stream 自动同意权限），再用 CDP 的 Fetch 域把两个外部
// 请求（听写 + 大模型）拦下来喂固定结果，这样整条链路能在无网无 Key 的情况下跑完。
//
// 用法: node cdp-miccheck.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-miccheck.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9361;
const LOG = path.join(process.cwd(), '../tmp/miccheck.log');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mic-'));

const buf = [];
const say = (s) => { buf.push(s); console.log(s); };
const flush = () => fs.writeFileSync(LOG, buf.join('\n'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
  // ↓ 关键两条：给一条假音频轨 + 自动同意麦克风权限
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  url,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', () => { cleanup(); });

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
if (!wsUrl) { say('无法连接 Chrome'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
const sttSeen = [];
const llmSeen = [];

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }

  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }

  // 拦下听写和大模型，喂固定结果 —— 没有真 Key 也能把链路跑通
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    let body = null;
    try { body = await send('Fetch.getResponseBody', { requestId }); } catch (_) {}
    const info = { url: request.url, method: request.method, bytes: body?.body?.length || 0 };

    // 跨域 POST 一定会先发 OPTIONS 预检。第一次跑就栽在这：我给预检回了 200+JSON
    // 却没带 Allow-Headers，浏览器直接判 CORS 失败 → 页面显示 "Failed to fetch"，
    // 看起来像"识别接口坏了"，其实是**探针自己**没演好服务端。
    if (request.method === 'OPTIONS') {
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 204,
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
          { name: 'Access-Control-Max-Age', value: '600' },
        ],
        body: '',
      });
      return;
    }

    if (/siliconflow/.test(request.url)) {
      const len = request.postDataEntries?.reduce((n, p) => n + (p.bytes?.length || 0), 0)
        || (request.postData ? request.postData.length : 0);
      sttSeen.push({ ...info, len });
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: b64(JSON.stringify({ text: '你喺邊度呀' })),
      });
      return;
    }
    if (/deepseek|chat\/completions/.test(request.url)) {
      llmSeen.push(info);
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: b64(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: 'deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: '我喺你隔離呀。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })),
      });
      return;
    }
    await send('Fetch.continueRequest', { requestId });
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

await send('Runtime.enable');
await send('Page.enable');

// 存档：人选定好 + 听写配硅基流动（假 Key 就够触发录音路径）+ 大模型也给个假 Key
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      var KEY = 'aiva.companion.v1';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({
          personaId: 'girlfriend',
          relations: { girlfriend: { affection: 10, mood: 80, energy: 95,
            createdAt: Date.now() - 2*86400000, totalPets: 0, totalChats: 0 } },
          coins: 100, giftCount: {}, memory: [], chatHistory: {},
          lastSeenAt: Date.now(),
          config: {
            spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'night',
            baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-fake-for-probe', model: 'deepseek-chat',
            voice: { sttProvider: 'siliconflow', sttLanguage: 'yue', siliconKey: 'sk-fake-for-probe' },
          },
        }));
      }
    } catch (e) {}

    // 探针：getUserMedia 到底有没有被调、拿到几条音频轨
    window.__gum = { calls: 0, ok: 0, tracks: 0, err: null };
    try {
      const md = navigator.mediaDevices;
      if (md && md.getUserMedia) {
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = async (c) => {
          window.__gum.calls++;
          try {
            const s = await orig(c);
            window.__gum.ok++;
            window.__gum.tracks = s.getAudioTracks().length;
            return s;
          } catch (err) { window.__gum.err = err && err.name; throw err; }
        };
      } else { window.__gum.noApi = true; }
    } catch (e) { window.__gum.installErr = String(e); }

    // 场景 B：把浏览器自带的语音识别摘掉，模拟 iPhone（WebKit 根本没实现它）
    try {
      if (localStorage.getItem('aiva.probe.nosr') === '1') {
        delete window.SpeechRecognition;
        delete window.webkitSpeechRecognition;
      }
    } catch (e) {}

    // 探针：MediaRecorder 有没有真开录、吐了多少字节
    window.__rec = { started: 0, bytes: 0, mime: null };
    try {
      const MR = window.MediaRecorder;
      if (MR) {
        window.MediaRecorder = class extends MR {
          constructor(...a) {
            super(...a);
            window.__rec.mime = a[1] && a[1].mimeType ? a[1].mimeType : '(default)';
            this.addEventListener('dataavailable', (ev) => {
              window.__rec.bytes += (ev.data && ev.data.size) || 0;
            });
          }
          start(...a) { window.__rec.started++; return super.start(...a); }
        };
      }
    } catch (e) { window.__rec.installErr = String(e); }
  `,
});

await send('Fetch.enable', {
  patterns: [{ urlPattern: '*siliconflow*' }, { urlPattern: '*deepseek*' }],
});

await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

say('>>> 打开：' + url);
await send('Page.navigate', { url });

let ready = false;
for (let i = 0; i < 120; i++) {
  if (await evaluate(`!!(window.__aivaDebug && window.__aivaDebug.hitTest)`)) { ready = true; break; }
  await sleep(500);
}
if (!ready) {
  say('!!! 3D 没起来：' + JSON.stringify(await evaluate(`(document.body.innerText||'').slice(0,200)`)));
  flush();
  process.exit(1);
}
say('3D 就绪');
await sleep(6000);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  say((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
};

/** 按可见文字找元素（RNW 渲染成普通 div，没有稳定 testId） */
const rectOf = (txt) => evaluate(`(() => {
  const all = Array.from(document.querySelectorAll('div,span'));
  const el = all.filter(e => (e.textContent||'').trim() === ${JSON.stringify(txt)})
               .sort((a,b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
})()`);

async function tap(pt) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
}

// ---- 0. 环境本身 -----------------------------------------------------------
const env = await evaluate(`({ secure: window.isSecureContext, gum: !!navigator.mediaDevices?.getUserMedia,
  mr: typeof MediaRecorder !== 'undefined', sr: !!window.webkitSpeechRecognition })`);
say('环境: ' + JSON.stringify(env));

// ---- 1. 点麦克风 → getUserMedia 真的被调用 ---------------------------------
const mic = await rectOf('🎙️');
if (!mic) { say('!!! 页面上找不到 🎙️ 按钮'); flush(); process.exit(1); }
say('麦克风按钮: ' + JSON.stringify(mic));

await tap(mic);
await sleep(2500);

const gum = await evaluate(`window.__gum`);
const rec = await evaluate(`window.__rec`);
say('getUserMedia 探针: ' + JSON.stringify(gum));
say('MediaRecorder 探针: ' + JSON.stringify(rec));

record('① 点麦真的调了 getUserMedia', (gum.calls || 0) >= 1,
  `calls=${gum.calls}${gum.err ? ' err=' + gum.err : ''}`);
record('② 拿到音频轨（= 麦真的开了）', (gum.ok || 0) >= 1 && (gum.tracks || 0) >= 1,
  `ok=${gum.ok}, audioTracks=${gum.tracks}`);
record('③ MediaRecorder 开录并吐出字节', (rec.started || 0) >= 1 && (rec.bytes || 0) > 0,
  `started=${rec.started}, bytes=${rec.bytes}, mime=${rec.mime}`);

const listening = await evaluate(`(document.body.innerText||'').indexOf('我在听') >= 0`);
record('④ 界面进入「我在听…」', listening === true, `listening=${listening}`);

// ---- 2. 再点一次（⬛）立刻发出去 --------------------------------------------
const stopBtn = await rectOf('⬛');
if (stopBtn) await tap(stopBtn); else await tap(mic);
await sleep(3500);

const posted = sttSeen.filter((s) => s.method === 'POST');
record('⑤ 音频被 POST 给听写服务', posted.length >= 1,
  posted.length ? `${posted[0].url} · POST · ${posted[0].len} 字节`
    : `只有预检没有真 POST（${sttSeen.map((s) => s.method).join(',') || '无'}）`);

const txt = await evaluate(`(document.body.innerText||'')`);
const heard = txt.indexOf('你喺邊度呀') >= 0;
record('⑥ 识别结果进了对话', heard === true, `字幕含「你喺邊度呀」=${heard}`);

record('⑦ 大模型被叫到并回了话', llmSeen.length >= 1 && txt.indexOf('我喺你隔離呀') >= 0,
  `llm 请求 ${llmSeen.length} 次，回复可见=${txt.indexOf('我喺你隔離呀') >= 0}`);

// ---- 3. 场景 B：iPhone 且没配 Key（旧版在这里只会甩一句"此浏览器不支持"）------
await evaluate(`
  localStorage.setItem('aiva.probe.nosr', '1');
  const raw = JSON.parse(localStorage.getItem('aiva.companion.v1') || '{}');
  raw.config = { ...(raw.config||{}), voice: { ...((raw.config||{}).voice||{}), siliconKey: '', openaiKey: '', groqKey: '', azureKey: '' } };
  localStorage.setItem('aiva.companion.v1', JSON.stringify(raw));
`);
await send('Page.reload', { ignoreCache: true });
await sleep(1500);
let readyB = false;
for (let i = 0; i < 120; i++) {
  if (await evaluate(`!!(window.__aivaDebug && window.__aivaDebug.hitTest)`)) { readyB = true; break; }
  await sleep(500);
}
say('\n--- 场景 B：iPhone（无自带识别）+ 没配听写 Key');
say('    webkitSpeechRecognition 存在 = ' + await evaluate(`!!window.webkitSpeechRecognition`));
if (readyB) {
  await sleep(4000);
  const micB = await rectOf('🎙️');
  if (micB) await tap(micB);
  await sleep(2000);
  const txtB = await evaluate(`(document.body.innerText||'')`);
  const guided = txtB.indexOf('还没配') >= 0;
  record('⑨ 没 Key 时给的是「去哪配」的指引，不是干巴巴的"不支持"', guided === true,
    guided ? '页面上出现了 "还没配…" 的提示' : '页面文本：' + JSON.stringify(txtB.slice(-160)));
} else {
  record('⑨ 场景 B', false, '3D 没起来');
}

// ---- 4. 全程不许炸 ---------------------------------------------------------
record('⑧ 全程无异常', exceptions.length === 0 && consoleErrors.length === 0,
  `exception=${exceptions.length}, console.error=${consoleErrors.length}`);
exceptions.slice(0, 6).forEach((x) => say('    [EXCEPTION] ' + x.slice(0, 240)));
consoleErrors.slice(0, 6).forEach((x) => say('    [console.error] ' + x.slice(0, 240)));

const bad = results.filter((r) => !r.ok).length;
say('\n' + (bad === 0 ? '麦克风链路全部通过（iPhone 那条路打通了）' : '有问题：' + bad + ' 项'));
say('页面尾部文本: ' + JSON.stringify(txt.slice(-260)));
flush();
cleanup();
process.exit(bad === 0 ? 0 : 1);
