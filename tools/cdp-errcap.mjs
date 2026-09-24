#!/usr/bin/env node
// 只干一件事：打开一个 URL，把控制台消息 / 异常 / #root 是否挂载 全抓出来。
// 用来定位"白屏"到底是哪一行抛的。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9451);

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
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? (a.preview?.description || '')).join(' ');
      console.log('  [console.' + (m.params.type || 'log') + '] ' + t.slice(0, 400));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails;
      console.log('  [EXCEPTION] ' + (ex.exception?.description || ex.text || JSON.stringify(ex)).slice(0, 800));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'errcap-'));
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
  console.log('>>> 打开：' + url);
  await c.send('Page.navigate', { url });
  await sleep(6000);

  const rootInfo = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const r = document.getElementById('root');
    return { rootChildren: r ? r.childElementCount : -1, bodyLen: document.body ? document.body.innerHTML.length : -1,
             hasAppText: (document.body?.innerText || '').slice(0, 60) };
  })()` });
  console.log('>>> #root 子节点数：' + rootInfo.result?.result?.value?.rootChildren
    + '  body 长度：' + rootInfo.result?.result?.value?.bodyLen
    + '  可见文字：' + JSON.stringify(rootInfo.result?.result?.value?.hasAppText));
  c.close();
} catch (e) {
  console.error('探针失败：', e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
