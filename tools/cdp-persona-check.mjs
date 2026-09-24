#!/usr/bin/env node
/**
 * 在真实 App 里点开某个角色，抓取控制台，确认 3D 模型真的挂上了。
 *
 * 为什么需要：前面的 GLB 验证都只是"这个资源本身没问题"，
 * 但 App 这条链路（require 资源 → readAssetBytes → GLTFLoader.parse
 * → attachModel → applyBuiltinMorph）是另一回事，中间任何一环断了
 * 都会静默降级成程序化小人 —— 界面照样能点，只是角色不对。
 * 唯一的证据是 companion.js 打出来的那几行 [rig] / [morph] 日志。
 *
 * 用法：
 *   CHROME_PATH=... node tools/cdp-persona-check.mjs <url> <角色名>
 *   例：node tools/cdp-persona-check.mjs http://127.0.0.1:8124/ "Kizuna AI"
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8124/';
const WHO = process.argv[3] || 'Kizuna AI';
/** --shot=<路径> 时额外截一张图，交给 tools/analyze-shot.py 做像素统计 */
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const SHOT = shotArg ? shotArg.slice(7) : null;
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9415);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const logs = [];
async function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0;
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Log.entryAdded') logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description
        || m.params.exceptionDetails?.text || ''));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

let out = null;
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
  await sleep(4000);

  // 找到写着角色名的卡片并点它。RN Web 的事件挂在祖先节点上，
  // 点最内层 + 往上两层都点一遍，总会有一层命中。
  const clicked = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const hit = [...document.querySelectorAll('div,span')]
        .filter(e => (e.textContent || '').includes(${JSON.stringify(WHO)}));
      if (!hit.length) return 'not-found';
      // 取文本最短的那个（最内层，避免点到整个列表容器）
      hit.sort((a,b) => (a.textContent||'').length - (b.textContent||'').length);
      const el = hit[0];
      el.scrollIntoView?.();
      let n = el, depth = 0;
      while (n && depth < 3) { n.dispatchEvent(new MouseEvent('click', {bubbles:true})); n.click?.(); n = n.parentElement; depth++; }
      return 'clicked:' + (el.textContent||'').slice(0, 40);
    })()`,
  });
  console.log('点击结果：', clicked.result?.result?.value);

  // 模型 7.8MB + 软渲染，给足时间
  await sleep(12000);

  const state = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      canvases: document.querySelectorAll('canvas').length,
      webgl: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })(),
      text: (document.body.innerText || '').slice(0, 300)
    })`,
  });
  out = JSON.parse(state.result?.result?.value || '{}');

  if (SHOT) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
      console.log(`\n截图已存：${SHOT}（${(fs.statSync(SHOT).size / 1024).toFixed(0)} KB）`);
    } else {
      console.log('\n截图失败：', JSON.stringify(shot.result).slice(0, 200));
    }

    // 隔一会儿再拍一张。角色待机时一直在呼吸/摆臂，两帧之间必然有差异；
    // 如果画布是空的（只剩背景渐变），差异率会接近 0。
    // 这个判据不依赖背景色 —— 比"非背景像素占比"可靠得多。
    await sleep(2500);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    if (shot2.result?.data) {
      const p2 = SHOT.replace(/\.png$/, '.b.png');
      fs.writeFileSync(p2, Buffer.from(shot2.result.data, 'base64'));
      console.log(`第二帧：${p2}（隔 2.5s）`);
    }
  }
  c.close();
} catch (e) {
  console.error('检查失败：', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n=== 打开「${WHO}」后的控制台 ===\n`);
const interesting = logs.filter((l) => /\[(rig|morph|model|companion|three)\]|THREE|Error|error|warn/i.test(l));
if (!logs.length) console.log('  （一条控制台输出都没有 —— 页面可能没跑起来）');
for (const l of (interesting.length ? interesting : logs).slice(0, 40)) {
  console.log('  ' + l.slice(0, 220));
}

const hasRig = logs.some((l) => /\[rig\] 骨架已接管/.test(l));
const hasMorph = logs.some((l) => /\[morph\] 表情已接管（内置 blendshape）/.test(l));
const morphLine = logs.find((l) => /\[morph\]/.test(l)) || '';
const rigLine = logs.find((l) => /\[rig\]/.test(l)) || '';
const hasError = logs.some((l) => /\[model\].*(失败|没接上)/.test(l) || /exception|Uncaught/i.test(l));

console.log(`\n=== 判定 ===`);
console.log(`  canvas 数量：${out?.canvases ?? '?'} · WebGL2 可用：${out?.webgl ?? '?'}`);
console.log(`  ${hasRig ? '✅' : '❌'} 骨架已接管  ${rigLine.slice(0, 90)}`);
console.log(`  ${hasMorph ? '✅' : '❌'} 内置表情已接管  ${morphLine.slice(0, 110)}`);
console.log(`  ${hasError ? '❌' : '✅'} 没有加载错误`);
console.log('');
process.exit(hasRig && hasMorph && !hasError ? 0 : 1);
