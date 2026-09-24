#!/usr/bin/env node
// 摸头失败的现场取证：把 hitTest 在一条竖线上的命中点 y 和它自己的头/身分界线打出来。
// 判据是 `h.point.y >= hitBottom + (hitTop-hitBottom)*0.78`，所以只要 hitTop 被
// 舞台里某个很高的东西（背景板 / 粒子）顶上去，头就永远判不出来。
//
// 用法: node tools/cdp-hitprobe.mjs <url>
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const LOG = '../tmp/hitprobe.log';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.HIT_PORT || 9477);

const buf = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  buf.push(line); console.log(line);
};
const flush = () => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, buf.join('\n') + '\n', 'utf8'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0; const logs = [];
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push((m.params.type || 'log') + ': ' + t.slice(0, 240));
    }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close(), logs };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=414,896', 'about:blank',
], { stdio: 'ignore' });

try {
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  const ev = (expression) => c.send('Runtime.evaluate', { returnByValue: true, expression })
    .then((r) => r.result?.result?.value);

  await c.send('Runtime.enable'); await c.send('Page.enable');
  // ⚠️ 不预置存档的话 App 会停在「角色选择页」等用户点 CTA，__aivaDebug 永远不会挂上来。
  //    跟 cdp-gesture-check 一样先把人选定好，让它直接进主页。
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try {
        var KEY = 'aiva.companion.v1';
        if (!localStorage.getItem(KEY)) {
          localStorage.setItem(KEY, JSON.stringify({
            personaId: 'girlfriend',
            relations: { girlfriend: { affection: 10, mood: 80, energy: 95,
              createdAt: Date.now() - 2 * 86400000, totalPets: 0, totalChats: 0 } },
            coins: 100, giftCount: {}, memory: [], chatHistory: {},
            lastSeenAt: Date.now(),
            config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'night' },
          }));
        }
      } catch (e) {}
    `,
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await c.send('Page.navigate', { url });

  let ready = false;
  for (let i = 0; i < 120; i++) { if (await ev(`!!(window.__aivaDebug && window.__aivaDebug.hitTest)`)) { ready = true; break; } await sleep(500); }
  say('__aivaDebug 就绪:', ready);
  if (!ready) throw new Error('3D 没起来');
  await sleep(14000);

  // 1) 能拿到的调试信息全列一遍
  say('\n=== __aivaDebug 上的键 ===');
  say('  ' + JSON.stringify(await ev(`Object.keys(window.__aivaDebug || {})`)));

  // 2) stage 的整体包围盒 vs 角色包围盒（看是不是背景板把顶撑高了）
  const boxes = await ev(`(() => {
    const d = window.__aivaDebug;
    if (!d || !d.root) return { err: 'no root' };
    const THREE = window.__THREE__;
    const stage = d.root;
    const b = (o) => { try { return o.geometry ? o.geometry.boundingBox : null; } catch(e){ return null; } };
    const list = [];
    stage.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      let minY = null, maxY = null;
      try {
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox.clone();
        bb.applyMatrix4(o.matrixWorld);
        minY = bb.min.y; maxY = bb.max.y;
      } catch (e) {}
      list.push({ name: o.name || '(匿名)', type: o.type, minY, maxY, vis: o.visible });
    });
    list.sort((a, b) => (b.maxY ?? -1e9) - (a.maxY ?? -1e9));
    return { count: list.length, top: list.slice(0, 12), bottom: list.slice(-4) };
  })()`);
  say('\n=== 舞台里所有网格按最高点排序（前 12）===');
  for (const m of (boxes.top || [])) {
    say(`  ${String(m.maxY ?? '-').padStart(9)} ← ${String(m.name).slice(0, 34).padEnd(34)} ${m.type} vis=${m.vis}`);
  }
  say('  --- 最低的 4 个 ---');
  for (const m of (boxes.bottom || [])) {
    say(`  minY=${String(m.minY ?? '-').padStart(9)}  ${String(m.name).slice(0, 34)} ${m.type}`);
  }

  // 2.5) 头/身分界线的真实取值
  const hb = await ev(`window.__aivaDebug.hitBounds ? window.__aivaDebug.hitBounds() : null`);
  say('\n=== 头/身分界线（hitBounds）===');
  say('  ' + JSON.stringify(hb, null, 1).replace(/\n/g, ' '));

  // 3) 竖线采样：每格报 part 和命中 y
  say('\n=== 竖线采样（nx=0，ny 从 +0.9 到 -0.9）===');
  const col = await ev(`(() => {
    const out = [];
    for (let i = 0; i <= 18; i++) {
      const ny = 0.9 - (1.8 * i) / 18;
      const h = window.__aivaDebug.hitTest(0, ny);
      out.push({ ny: +ny.toFixed(3), part: h ? h.part : null, y: h ? +h.point.y.toFixed(3) : null,
                 obj: h ? (h.object.name || h.object.type) : null });
    }
    return out;
  })()`);
  for (const r of col) say(`  ny=${String(r.ny).padStart(6)}  ${String(r.part).padEnd(5)}  y=${String(r.y).padStart(7)}  ${r.obj}`);

  const parts = col.filter((r) => r.part);
  const head = parts.filter((r) => r.part === 'head');
  say(`\n  命中 ${parts.length} 格，其中判成 head 的：${head.length}`);
  const ys = parts.map((r) => r.y).filter((y) => y != null);
  if (ys.length) say(`  命中 y 范围: ${Math.min(...ys).toFixed(3)} ~ ${Math.max(...ys).toFixed(3)}`);

  const errs = c.logs.filter((l) => /EXCEPTION|error:/i.test(l));
  if (errs.length) { say('\n=== 异常 ==='); errs.slice(0, 6).forEach((l) => say('  ' + l)); }
  c.close();
} catch (e) {
  say('探针失败：' + e.message);
} finally {
  flush(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
