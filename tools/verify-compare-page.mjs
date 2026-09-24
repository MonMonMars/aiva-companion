#!/usr/bin/env node
/**
 * 验证 compare.html **真的把模型画出来了**，而不是只有 UI 壳子。
 *
 * 为什么需要它：compare.html 是单文件自包含的（three + 11 个 GLB 全内联），
 * 用 file:// 打开时最容易出现的失败是"脚本跑了但 WebGL 没出图"。
 * 那种情况 --dump-dom 看不出任何异常（DOM 齐全、下拉框也有 11 项），但画面是空的。
 *
 * 我**看不到图片**，所以判定只能靠像素统计。这条路踩过两个坑，都写在下面：
 *
 *   坑① 按左右半屏切分区域。
 *        实测两个 canvas 是**上下堆叠**的（x 都是 42，y 分别 323 / 939），
 *        窗口高 1000 时第二个 canvas 整个在视口外 ——
 *        于是"右半屏"量到的是纯空白页，"右视口没渲染"是彻底的假警报。
 *        必须先用 CDP 问出 canvas 的真实矩形，再按矩形截图。
 *
 *   坑② 把"近似纯白"当背景。
 *        舞台底色其实是一层暖灰渐变（主色 rgb(232,224,216) / rgb(232,232,224)），
 *        占全图 65% 却被算成"内容"，两个视口都报 72% 着色 —— 指标毫无分辨力。
 *        改成先从全图统计 dominant 色当背景调色板，再数偏离它的像素。
 *        （顺带一提：坑②③最后都被坑③取代了 —— 见下面第 2 节。）
 *
 *   坑③ headless 的 Page.captureScreenshot **不合成 WebGL 图层**。
 *        这是最坑的一条：renderer.info.render 明明报了 triangles=20562 / calls=2，
 *        场景里 mesh 也在、相机位置也对，但截图里 canvas 区域整片是背景色
 *        （着色 0.01%、色数 14）。按截图判定会得出"完全没渲染"的错误结论。
 *        最终改成 render 之后立刻 gl.readPixels 回读 drawing buffer —— 那才是真相。
 *
 * 用法：node tools/verify-compare-page.mjs [compare.html 路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const html = path.resolve(ROOT, process.argv[2] || 'assets/preview/compare.html');
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9417);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-verify-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--hide-scrollbars',
  // ⚠️ 绝不能加 --disable-gpu：那会强制 CPU 光栅化，WebGL 上下文直接创建失败，
  //    页面脚本会在 renderer 那一步抛错，nameA/nameB 永远是 "—"。
  //
  // ⚠️ 必须是 --use-angle=swiftshader，不能是 --use-gl=swiftshader。
  //    后者在 compare.html 上会让**两个上下文在 290ms 同时丢失**
  //    （webglcontextlost，statusMessage 为空，GPU 进程重启），
  //    之后所有渲染静默失效：info.render 照常报 triangles=20562 / calls=2，
  //    但画布全黑、截图全背景、readPixels 全 0 —— 看起来像"模型没画上"，
  //    其实是上下文早没了。对比实验：同一台机器、同一个页面，
  //      --use-gl=swiftshader   → lost=true
  //      --use-angle=swiftshader → lost=false  ← 用它
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--window-size=1600,1200',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function cdp(wsUrl) {
  const WS = globalThis.WebSocket || (await import('ws')).default;
  const sock = new WS(wsUrl);
  const waiters = new Map();
  let idc = 0;
  await new Promise((res, rej) => {
    sock.addEventListener?.('open', res); sock.addEventListener?.('error', rej);
    if (sock.on) { sock.on('open', res); sock.on('error', rej); }
  });
  sock.addEventListener ? sock.addEventListener('message', (e) => onMsg(e.data)) : sock.on('message', onMsg);
  const events = [];
  function onMsg(raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    // 页面里抛的异常 / console.error —— 脚本执行到一半崩掉时这是唯一的线索。
    // 注意 errs 那种"页面自己存的"变量在崩掉时根本没被赋值，只能靠这里。
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      events.push('EXCEPTION: ' + (d.exception?.description || d.text) +
                  ' @' + d.lineNumber + ':' + d.columnNumber);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      events.push('CONSOLE: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close(), events };
}

let conn;
try {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = await getJSON('/json/list'); if (list.length) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!list || !list.length) throw new Error('DevTools 端口没起来');
  const page = list.find((t) => t.type === 'page');
  conn = await cdp(page.webSocketDebuggerUrl);

  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  await conn.send('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });

  // ⚠️ 不能只 sleep 固定时长：11 个 GLB 全是内联 base64（共 12.5MB），
  //    解析完再把几何送进 GPU 要几秒到十几秒。
  //    实测 sleep(4000) 时下拉框还是 0 项、nameA/B 还是 "—"，
  //    会误判成"脚本没跑"。这里轮询到 UI 就绪为止。
  const PROBE = `(() => {
    const cv = [...document.querySelectorAll('canvas')].map(c => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY),
               w: Math.round(r.width), h: Math.round(r.height) };
    });
    return JSON.stringify({
      canvases: cv,
      nameA: (document.getElementById('nameA')||{}).textContent,
      nameB: (document.getElementById('nameB')||{}).textContent,
      metaA: (document.getElementById('metaA')||{}).textContent,
      metaB: (document.getElementById('metaB')||{}).textContent,
      options: document.querySelectorAll('#selB option').length,
      rows: document.querySelectorAll('#tbl tbody tr').length,
      // ⚠️ 这里不能用 typeof 去探 errs：它是页面里的 const，脚本执行到它之前
      //    处于 TDZ，typeof 同样抛 ReferenceError（实测就是这么炸的，
      //    probe 全程报错，看起来像页面崩了一样）。只能用 try/catch 兜。
      errs: (() => { try { return errs; } catch { return null; } })(),
      // ⚠️ 光看"画布是空的"没法定位：可能是 renderer 建不出来、可能是 mesh 没进场景、
      //    可能是镜头对着空气、也可能是 drawing buffer 尺寸是 0。
      //    所以这里把 render 之后的关键状态全捞出来，一次性区分开。
      diag: (() => { try {
        const d = (s) => ({
          buf: s.canvas.width + 'x' + s.canvas.height,
          css: Math.round(s.canvas.getBoundingClientRect().width) + 'x' + Math.round(s.canvas.getBoundingClientRect().height),
          hasMesh: !!s.current,
          verts: s.current ? s.current.geometry.attributes.position.count : 0,
          tris: s.renderer.info.render.triangles,
          calls: s.renderer.info.render.calls,
          bboxMax: s.current ? s.current.geometry.boundingBox.max.toArray().map((v) => +v.toFixed(2)) : null,
          cam: s.cam.position.toArray().map((v) => +v.toFixed(2)),
        });
        return { three: THREE.REVISION, a: d(A), b: d(B) };
      } catch (e) { return { err: String(e) }; } })(),
    });
  })()`;

  let st = null;
  let lastErr = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    // 先等文档就绪：navigate 刚发出时执行上下文可能还是 about:blank，
    // 那时 document 里既没有 canvas 也没有 #selB，probe 会一直返回空值。
    const ready = await conn.send('Runtime.evaluate', {
      returnByValue: true, expression: 'document.readyState + "|" + location.href.slice(-24)',
    });
    const rs = ready.result?.result?.value || '';
    if (!rs.startsWith('complete') || !rs.includes('compare.html')) continue;

    const r = await conn.send('Runtime.evaluate', { returnByValue: true, expression: PROBE });
    if (r.result?.exceptionDetails) {
      lastErr = JSON.stringify(r.result.exceptionDetails).slice(0, 400);
      continue;
    }
    st = JSON.parse(r.result?.result?.value || '{}');
    if (st.options >= 11 && st.nameB && st.nameB !== '—') break;
  }
  if (!st && lastErr) console.log('  probe 抛错：' + lastErr);
  if (st?.errs?.length) console.log('  页面内错误：\n    ' + st.errs.join('\n    '));
  console.log('页面状态：');
  console.log('  A = ' + st.nameA + '   ' + st.metaA);
  console.log('  B = ' + st.nameB + '   ' + st.metaB);
  console.log('  下拉 ' + st.options + ' 项 · 表格 ' + st.rows + ' 行');
  console.log('  canvas 矩形：' + JSON.stringify(st.canvases));
  console.log('  诊断：' + JSON.stringify(st.diag));

  if (conn.events.length) {
    console.log('  页面事件：');
    for (const e of conn.events.slice(0, 12)) console.log('    ' + e);
  }
  if (!st.canvases || st.canvases.length < 2) throw new Error('页面上找不到 2 个 canvas');

  // ---- 2. 直接读回 WebGL drawing buffer 统计 ----
  // ⚠️ 坑③：不能用 Page.captureScreenshot 判"画出来了没有"。
  //    实测 renderer.info.render 已经报 triangles=20562 / calls=2，场景里 mesh 也在，
  //    但 headless 合成层截图里 canvas 区域**整片是背景色**（着色 0.01%、色数 14）。
  //    也就是说合成器根本没把 WebGL 图层拍进截图 —— 截图空白 ≠ 没渲染。
  //    改成 render 之后立刻 gl.readPixels 回读，读的就是 GPU 真正写进去的东西。
  const MEASURE = `(() => {
    try {
      const q = (r,g,b) => (r>>3)<<10 | (g>>3)<<5 | (b>>3);
      const out = [];
      for (const s of [A, B]) {
        renderAll();
        const w = s.canvas.width, h = s.canvas.height;
        // ⚠️ 为什么绕开默认 drawing buffer 走 RenderTarget：
        //    直接 gl.readPixels 默认帧缓冲只有一种结果 —— 整片纯黑（实测色数 1）。
        //    分不清是"本来就没画上"还是"buffer 在合成后被丢弃了"
        //    （preserveDrawingBuffer 默认 false，headless 下尤其不稳）。
        //    渲到离屏 RenderTarget 再回读，跟 swap chain 完全无关，结果确定。
        const rt = new THREE.WebGLRenderTarget(w, h);
        s.renderer.setRenderTarget(rt);
        s.renderer.render(s.scene, s.cam);
        const px = new Uint8Array(w * h * 4);
        s.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
        s.renderer.setRenderTarget(null);
        rt.dispose();
        const hist = new Map();
        for (let p = 0; p < px.length; p += 4) {
          const k = q(px[p], px[p+1], px[p+2]);
          hist.set(k, (hist.get(k) || 0) + 1);
        }
        const n = w * h;
        const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]);
        const tk = sorted[0][0];
        out.push({ w, h, pct: +(((n - sorted[0][1]) / n) * 100).toFixed(2), colors: hist.size,
                   tris: s.renderer.info.render.triangles,
                   // 主色是什么必须打出来：全黑 = 只清了屏，全白 = 别的环节出问题，
                   // 有色 = 至少画上了东西。不看这个数字，"色数 1"可以有好几种解释。
                   top: 'rgb(' + [((tk >> 10) & 31) << 3, ((tk >> 5) & 31) << 3, (tk & 31) << 3].join(',') + ')' });
      }
      return JSON.stringify(out);
    } catch (e) { return JSON.stringify({ err: String(e && e.stack || e) }); }
  })()`;

  const mRes = await conn.send('Runtime.evaluate', { returnByValue: true, expression: MEASURE });
  const measured = JSON.parse(mRes.result?.result?.value || '{}');
  if (measured.err) throw new Error('readPixels 失败：' + measured.err);

  // ---- 2a. GL 自检：清屏成绿色再回读 ----
  // ⚠️ 这一步是**必须的**：如果回读通道本身在 swiftshader 下就是坏的，
  //    那后面"模型 0 像素 + 红球 0 像素"只能证明回读坏了，证明不了画面是空的。
  //    实测这一步返回 [0,255,0,255] 才说明 GL 与回读都正常。
  const GLSELF = `(() => {
    try {
      const gl = A.renderer.getContext();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 1, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const p = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return JSON.stringify({ px: [...p], lost: gl.isContextLost(),
                              ver: gl.getParameter(gl.VERSION),
                              err: gl.getError() });
    } catch (e) { return JSON.stringify({ err: String(e) }); }
  })()`;
  const gs = JSON.parse((await conn.send('Runtime.evaluate',
    { returnByValue: true, expression: GLSELF })).result?.result?.value || '{}');
  console.log('  GL 自检：清屏回读 ' + JSON.stringify(gs.px) +
              ' · contextLost=' + gs.lost + ' · ' + gs.ver + (gs.err ? ' · err=' + gs.err : ''));
  if (gs.err || !gs.px || gs.px[1] !== 255) {
    throw new Error('GL 自检没通过 —— 回读通道是坏的，后面的像素统计不可信');
  }

  // ---- 2b. 对照组：把"渲染管线坏了"和"模型本身没画上"分开 ----
  //    红球用 MeshBasicMaterial，不吃光照也不吃法线 —— 它能出现就说明
  //    场景/相机/renderer 整条链路是好的，问题只在模型几何或材质上。
  //    再把包围盒 8 个角投到 NDC：如果角点全在 [-1,1] 外，那就是镜头没对准。
  const CTRL = `(() => {
    try {
      const s = A, w = 240, h = 240;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12),
                                  new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      ball.position.set(0, 0.875, 0);
      s.scene.add(ball);
      const rt = new THREE.WebGLRenderTarget(w, h);
      s.renderer.setRenderTarget(rt);
      s.renderer.render(s.scene, s.cam);
      const px = new Uint8Array(w * h * 4);
      s.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
      s.renderer.setRenderTarget(null); rt.dispose();
      let red = 0;
      for (let p = 0; p < px.length; p += 4) if (px[p] > 60 && px[p+1] < 60) red++;
      s.scene.remove(ball);
      const bb = s.current.geometry.boundingBox, ndc = [];
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y])
          for (const z of [bb.min.z, bb.max.z]) {
            const v = new THREE.Vector3(x, y, z).project(s.cam);
            ndc.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]);
          }
      return JSON.stringify({ redPx: red, total: w * h, ndc,
                              bboxMin: bb.min.toArray().map((v) => +v.toFixed(2)) });
    } catch (e) { return JSON.stringify({ err: String(e && e.stack || e) }); }
  })()`;
  const ctrl = JSON.parse((await conn.send('Runtime.evaluate',
    { returnByValue: true, expression: CTRL })).result?.result?.value || '{}');
  console.log('  对照组：红球像素 ' + ctrl.redPx + '/' + ctrl.total +
              '   bboxMin ' + JSON.stringify(ctrl.bboxMin));
  console.log('  bbox 角点 NDC：' + JSON.stringify(ctrl.ndc));

  console.log('');
  const results = measured.map((r, i) => ({ i, ...r }));
  for (const r of results) {
    console.log('  canvas#' + (r.i + 1) + '  ' + r.w + '×' + r.h +
                '   着色 ' + r.pct.toFixed(2) + '%   色数 ' + r.colors +
                '   三角面 ' + r.tris.toLocaleString('en-US') + '   主色 ' + r.top);
  }

  const problems = [];
  const ok = (c, m) => { if (!c) problems.push(m); };
  ok(st.options === 11, `下拉框只有 ${st.options} 项（应为 11）`);
  ok(st.rows === 11, `表格只有 ${st.rows} 行（应为 11）`);
  ok(st.nameB && st.nameB !== '—', 'B 侧角色名还是 "—"，说明 UI 脚本没跑完');
  // 「全身」模式必须真把全身框进去。之前 dist 系数写 1.00 时包围盒角点 NDC 到了 ±2.2，
  // 头和脚全在画面外，但着色率照样 40%+ —— 只看像素比例发现不了构图错了。
  const worst = Math.max(...(ctrl.ndc || []).flatMap((v) => [Math.abs(v[0]), Math.abs(v[1])]));
  ok(worst <= 1.08, `全身模式没框住：包围盒角点 NDC 最大 ${worst.toFixed(2)}（应 ≤1.08）`);
  for (const r of results) {
    ok(r.pct > 3, `canvas#${r.i + 1} 着墨只有 ${r.pct.toFixed(2)}%，没画出模型`);
    ok(r.colors > 150, `canvas#${r.i + 1} 只有 ${r.colors} 种颜色，不像 3D 模型`);
  }

  console.log('');
  if (!problems.length) console.log('  ✓ 两个视口都渲染出了模型。');
  else { console.log('  ✗ 有问题：'); for (const p of problems) console.log('      ' + p); }
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  console.error('✗ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
}
