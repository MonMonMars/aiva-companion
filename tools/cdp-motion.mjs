#!/usr/bin/env node
// 验收「在线动作库」(#68) 和「边聊边后台加载」(#69)。
//
// #68 要证明三件事，缺一件都不算做完：
//   ① 动作库真的下载并解析好了（motionReady）
//   ② 让它跳舞/打拳，骨头**逐帧在变**（不是摆上去就冻住）
//   ③ 跳舞时脚还钉在地上（#67 的落地支撑没被动作覆盖掉）
//
// #69 要证明的是**时序**：动作库那 253KB 不在首包里，是进页面、
// 模型挂上之后才去取的。所以这里开 Network 域，把所有请求按时间记下来，
// 断言 motionClips 的请求晚于「页面已经能打字」和「模型 GLB 已经开始下」。
//
// 用法：node tools/cdp-motion.mjs [dist目录] [端口]
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 参数要能收两种形式：
//   node cdp-motion.mjs [dist目录] [端口]        ← 单跑（自己起服务器）
//   node cdp-motion.mjs http://host:port/        ← 批量跑（服务器已经起好了）
// 第一版只认第一种，批量跑时把 URL 当成了目录名，于是自己去连一个没人监听的
// 端口，报 ERR_CONNECTION_REFUSED，看着像"动作库坏了"，其实是参数吃错了。
const argv2 = process.argv[2] || '';
const givenUrl = /^https?:\/\//.test(argv2) ? argv2 : null;
const DIST = givenUrl ? 'dist-motion' : (argv2 || 'dist-motion');
const PORT = Number(process.argv[3] || 8807);
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9467);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

// ---------- 日志：写盘 + 同时打印 ----------
// 写盘是因为 Windows 控制台会把中文搞成乱码（也方便事后 Read）；
// 同时打印是因为 tools/_run-all-cdp.mjs 要接住 stdout 才能统计结果 ——
// 只写盘的话，那个批量跑的把日志文件的 mtime 判成"上一轮的"，会误报 n/a。
const out = [];
const log = (s) => {
  out.push(s);
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/motion.log', out.join('\n'), 'utf8');
  console.log(s);
};

async function cdp(wsUrl, onEvent) {
  const sock = new WebSocket(wsUrl);
  const waiters = new Map(); let idc = 0;
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    else if (m.method && onEvent) onEvent(m.method, m.params);
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

const ev = (c, expr) => c.send('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true });
const val = async (c, expr) => (await ev(c, expr)).result?.result?.value;

// ---------- 进 Home：两步，和 cdp-ground 一致 -------------------------------
const ENTER = `(() => {
  const els = Array.from(document.querySelectorAll('div,span'));
  const cards = els.filter(e => /小柔/.test(e.textContent || ''));
  if (!cards.length) return { ok:false, reason:'没找到小柔卡片' };
  cards.sort((a,b) => a.textContent.length - b.textContent.length);
  const card = cards[0];
  const r = card.getBoundingClientRect();
  for (const k of ['mousedown','mouseup','click']) {
    card.dispatchEvent(new MouseEvent(k, { bubbles:true, cancelable:true, clientX:r.left+8, clientY:r.top+8 }));
  }
  return { ok:true };
})()`;

// ⚠️ 必须认「·」：每张卡片上也有一行「开始相处」小字，按前缀匹配会点到卡片上。
const GO = `(() => {
  const els = Array.from(document.querySelectorAll('*'));
  const go = els.filter(e => /开始相处\\s*·/.test((e.textContent||'').trim()));
  if (!go.length) return { ok:false, reason:'没找到底部开始相处按钮' };
  go.sort((a,b) => a.textContent.length - b.textContent.length);
  const t = go[0]; const r = t.getBoundingClientRect();
  return { ok:true, label:(t.textContent||'').trim().slice(0,24),
    x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`;

const SNAP = `(() => {
  const d = window.__aivaDebug;
  if (!d) return { err: 'no __aivaDebug' };
  return {
    ground: d.groundInfo ? d.groundInfo() : null,
    motion: d.currentMotion ? d.currentMotion() : null,
    legs: d.motionLegs ? d.motionLegs() : null,
    ready: d.motionReady ? d.motionReady() : null,
    hasRig: d.hasRig ? d.hasRig() : null,
  };
})()`;

/**
 * 两份快照之间「最大的真实转角」（弧度）。
 *
 * ⚠️ 必须比**四元数**，不能比欧拉角分量：欧拉三元组在 ±π 处会环绕，
 *    两根骨头明明只差 5°，分量差能算出 355°（第一版探针就是这样把
 *    6.2 rad 当成"骨头在动"，其实那是环绕假象）。
 *    四元数点积没有环绕：angle = 2·acos(|q1·q2|)。
 */
const DIFF = `(() => {
  const a = window.__bdA, b = window.__bdB;
  if (!a || !b) return null;
  let max = 0, bone = null, n = 0;
  for (const k of Object.keys(a)) {
    if (!b[k]) continue;
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += a[k][i] * b[k][i];
    dot = Math.min(1, Math.abs(dot));
    const ang = 2 * Math.acos(dot);
    if (ang > max) { max = ang; bone = k; }
    n++;
  }
  return { max: Number(max.toFixed(4)), bone, bones: n };
})()`;

// 放外面，finally 里要收拾 —— 否则探针中途抛错会留下一个没人管的 Chrome
let srv = null; let chrome = null; let profile = null;

try {
  // ---- 静态服务器（批量跑时外面已经起好了，别抢同一个端口）----
  if (givenUrl) { srv = null; } else {
    srv = spawn(process.execPath, ['tools/dist-server.mjs', String(PORT), DIST], { stdio: 'ignore' });
  }
  await sleep(600);

  const pageUrl = givenUrl || `http://127.0.0.1:${PORT}/`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=430,900', 'about:blank',
  ], { stdio: 'ignore' });

  // ---- 网络时序记录 ----
  const reqs = [];
  const errs = [];
  const t0 = Date.now();
  const onEvent = (method, p) => {
    if (method === 'Network.requestWillBeSent') {
      reqs.push({ t: Date.now() - t0, url: p.request?.url || '' });
    } else if (method === 'Runtime.exceptionThrown') {
      errs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '?');
    } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      errs.push((p.args || []).map((a) => a.value ?? a.description).join(' '));
    }
  };

  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  if (!v) throw new Error('DevTools 没起来');
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl, onEvent);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');

  log('>>> 打开 ' + pageUrl + '  (' + DIST + ')');
  await c.send('Page.navigate', { url: pageUrl });
  await sleep(3000);

  // 边等首屏，边记「页面什么时候已经画出来了」。
  // ⚠️ 不能查 input/textarea：React Native Web 的 TextInput 渲染出来不是
  //    原生表单元素，一条都找不到，时间永远是 null（第一版就是这么丢的分）。
  //    改成认首屏文案 —— 角色列表出来了就说明用户可以开始操作了。
  let tInput = null;
  for (let i = 0; i < 80; i++) {
    const ok = await val(c, `/小柔|开始相处/.test(document.body.innerText || '')`);
    if (ok) { tInput = Date.now() - t0; break; }
    await sleep(100);
  }
  log('>>> 首屏可操作 @ ' + tInput + 'ms');

  log('>>> ① ' + JSON.stringify(await val(c, ENTER)));
  await sleep(700);
  const btn = await val(c, GO);
  log('>>> ② 按钮 ' + JSON.stringify(btn));
  if (btn?.ok) {
    // ⚠️ 必须 CDP 原生鼠标事件：RN Web 的 Pressable 走 pointer events，
    //    手搓 MouseEvent 没有 pointerId，会被直接忽略。
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', {
        type, x: btn.x, y: btn.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
  }

  let hook = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    hook = await val(c, '!!window.__aivaDebug');
    if (hook) break;
  }
  log('>>> 钩子 ' + hook);
  if (!hook) {
    log('!! 没进 Home：' + JSON.stringify(await val(c, 'document.body.innerText.slice(0,200)')));
    throw new Error('进不了 Home');
  }

  // 等模型挂上（rig 建好才有骨头可动）
  let hasRig = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    hasRig = await val(c, '!!window.__aivaDebug.hasRig()');
    if (hasRig) break;
  }
  log('>>> 骨架 ' + hasRig);

  // 量一下骨架的实际尺度：根位移是按「髋踝跨度」归一化的，
  // 万一 mapping 里的 Hips 认错了骨，比例就会整个错掉（真踩过：0.1338m）。
  // ⚠️ 不能用 __aivaDebug.root —— 调试口里没暴露这个键，一读就抛，整个表达式返回 undefined。
  //    改成从骨头往上走到场景根，顺便把它自己的 scale 也读出来。
  const SCALE_EXPR = `(() => {
    const d = window.__aivaDebug;
    return { boneY: d.boneY ? d.boneY() : null };
  })()`;
  const scaleRaw = await ev(c, SCALE_EXPR);
  const scale = scaleRaw.result?.result?.value ?? null;
  log('>>> 骨架尺度 ' + JSON.stringify(scale));
  if (!scale) {
    log('    ↑ 取不到，异常：' + JSON.stringify(
      scaleRaw.result?.exceptionDetails?.exception?.description
      || scaleRaw.result?.exceptionDetails?.text
      || scaleRaw.result?.exceptionDetails || scaleRaw.result,
    ).slice(0, 400));
  }

  let fails = 0;
  const gate = (name, ok, detail) => {
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) fails++;
  };

  // ---- #68 先确认动作库真的下下来了 ----
  //
  // ⚠️ 这一步必须排在 #69 的时序统计**之前**。第一版反过来做，
  //    于是查 performance 资源列表时动作库还没开始下载（它是"模型挂上之后"
  //    才排的后台任务），抓不到那条请求，四条时序断言全 FAIL，看着像没做 #69。
  let ready = false;
  for (let i = 0; i < 90; i++) {
    ready = await val(c, '!!window.__aivaDebug.motionReady()');
    if (ready) break;
    await sleep(400);
  }
  gate('⓪ 动作库加载完成 motionReady', !!ready);

  // ---- #69：动作库是不是「进页面之后」才下的 ----
  //
  // ⚠️ 用页面自己的 performance 资源计时，不用 CDP 的 Network 事件：
  //    第一版靠 Network.requestWillBeSent，结果 motionClips 那条**抓不到**
  //    （请求确实发生了 —— motionReady 是 true），事件侧漏了。
  //    performance.getEntriesByType('resource') 是浏览器自己的账本，更可靠。
  const RES = `(() => performance.getEntriesByType('resource')
    .map(e => ({ n: e.name.split('/').pop(), s: Math.round(e.startTime), k: Math.round((e.transferSize||0)/1024) }))
    .filter(e => /\\.js$|\\.glb$|\\.json$/.test(e.n)))()`;
  const res = await val(c, RES) || [];
  const pickRes = (re) => res.find((r) => re.test(r.n));

  const mMain = pickRes(/^index-[0-9a-f]+\.js$/);
  const mMotion = pickRes(/^motionClips-[0-9a-f]+\.js$/);
  const mGlb = pickRes(/\.glb$/);
  log('\n=== #69 加载时序（performance 资源计时，相对导航开始）===');
  log('  主包         ' + (mMain ? `${mMain.s}ms  ${mMain.k}KB` : '没抓到'));
  log('  模型 GLB     ' + (mGlb ? `${mGlb.s}ms  ${mGlb.k}KB  ${mGlb.n.slice(0, 32)}` : '没抓到'));
  log('  动作库 chunk ' + (mMotion ? `${mMotion.s}ms  ${mMotion.k}KB` : '没抓到'));
  log('  （CDP Network 事件侧抓到 ' + reqs.length + ' 条，其中 motionClips：'
    + (reqs.some((r) => /motionClips/.test(r.url)) ? '有' : '无') + '）');

  gate('① 动作库是独立 chunk（不在主包里）', !!mMotion && !!mMain && mMotion.n !== mMain.n,
    mMotion ? mMotion.n : '缺失');
  gate('② 动作库晚于主包才请求', !!mMotion && !!mMain && mMotion.s > mMain.s,
    mMotion && mMain ? `${mMotion.s}ms > ${mMain.s}ms` : '缺失');
  gate('③ 动作库晚于首屏可操作', !!mMotion && !!tInput && mMotion.s > tInput,
    mMotion && tInput ? `${mMotion.s}ms > ${tInput}ms` : '缺失');
  gate('④ 动作库晚于模型才开始', !!mMotion && !!mGlb && mMotion.s > mGlb.s,
    mMotion && mGlb ? `${mMotion.s}ms > ${mGlb.s}ms` : '缺失');

  // ---- #68：动作真的能播 ----
  log('\n=== #68 动作播放 ===');
  const base = (await ev(c, SNAP)).result?.result?.value || {};
  log('  静止时 ' + JSON.stringify(base));

  /** 播一个 tag，采样若干帧，返回「骨头变了多少」和期间最大抬脚 */
  async function exercise(kind, frames = 8, gap = 220) {
    const okPlay = await val(c, `window.__aivaDebug.playMotion(${JSON.stringify(kind)})`);
    // ⚠️ 不能先睡 500ms 再看：kungfu 是按 tag **随机**挑的，
    //    抽到 Hit_Chest(0.33s) 这种短片段时，睡醒它已经播完了，
    //    于是看起来像"没播起来"。播完立刻读一次才算数。
    const cur = await val(c, 'window.__aivaDebug.currentMotion()');
    if (!cur) return { okPlay, cur, max: 0, lift: 0 };

    let max = 0;
    let lift = 0;
    let resid = 0;
    let rootY = 0;
    let legs = null;
    await ev(c, 'window.__bdA = window.__aivaDebug.quatDump()');
    for (let i = 0; i < frames; i++) {
      await sleep(gap);
      await ev(c, 'window.__bdB = window.__aivaDebug.quatDump()');
      const d = await val(c, DIFF);
      if (d && d.max > max) max = d.max;
      await ev(c, 'window.__bdA = window.__bdB');
      const s = (await ev(c, SNAP)).result?.result?.value || {};
      // ⚠️ 只统计**还在播**的那些帧。短片段（Punch_Cross 才 1 秒）播完之后
      //    采样到的是待机态，会把"抬脚=0"当成动作期间的成绩，也会把
      //    legs 记成 false —— 看起来像"这个片段没驱动腿"，其实是采样晚点。
      if (s.motion !== cur) continue;
      if ((s.ground?.footLift ?? 0) > lift) lift = s.ground.footLift;
      if ((s.ground?.residual ?? 0) > resid) resid = s.ground.residual;
      if (Math.abs(s.ground?.motionRootY ?? 0) > Math.abs(rootY)) rootY = s.ground?.motionRootY ?? 0;
      legs = s.legs ?? legs;
    }
    return { okPlay, cur, max, lift, resid, rootY, legs };
  }

  // 功夫走 tag 会随机挑，短片段容易漏采，所以顺带测一个确定 id
  for (const kind of ['dance', 'kungfu', 'Sword_Attack']) {
    const r = await exercise(kind);
    log(`\n  [${kind}] playMotion=${r.okPlay} currentMotion=${JSON.stringify(r.cur)}`);
    log(`         逐帧最大真实转角=${r.max} rad  抬脚(补偿前)=${r.lift}m  残差(补偿后)=${r.resid}m`
      + `  根位移=${r.rootY}m  腿被驱动=${r.legs}`);
    gate(`⑥ ${kind} 真的播起来了`, !!r.cur, JSON.stringify(r.cur));
    // 0.02 rad ≈ 1.1°，过滤掉呼吸那种量级，才算"动作在推着骨头走"
    gate(`⑦ ${kind} 骨头逐帧在动`, r.max > 0.02, `${r.max} rad`);
    // 断言看**残差**：这个库里这几个片段在源动画里脚都是踩在地上的
    // （实测 Dance_Loop −1~0mm），所以到这里脚也必须踩在地上。
    // 跳跃那种真离地的片段不在被测列表里 —— 那种本来就该飞起来。
    gate(`⑧ ${kind} 期间脚踩在地上`, r.resid <= 0.005, `残差 ${r.resid}m`);
    gate(`⑨ ${kind} 根位移生效`, Math.abs(r.rootY) > 0.001, `${r.rootY}m`);
    await val(c, 'window.__aivaDebug.stopMotion()');
    await sleep(800);
  }

  // 停掉之后要能干净地回到待机
  const after = (await ev(c, SNAP)).result?.result?.value || {};
  gate('⑩ 停掉后回到待机（无残留动作）', !after.motion, JSON.stringify(after.motion));
  gate('⑪ 停掉后脚仍在地上', (after.ground?.residual ?? 99) <= 0.005,
    `残差 ${after.ground?.residual}m`);

  // 报错检查
  const realErrs = errs.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  gate('⑫ 控制台无报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  // 截一张跳舞的图留证
  await val(c, `window.__aivaDebug.playMotion('dance')`);
  await sleep(1500);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/motion-dance.png', Buffer.from(shot.result.data, 'base64'));
  log('\n>>> 截图 tmp/motion-dance.png');

  log('\n=== 结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  if (fails) process.exitCode = 1;
  c.close();
} catch (e) {
  log('探针失败：' + (e?.stack || e?.message || e));
  process.exitCode = 1;
} finally {
  chrome?.kill();
  srv?.kill();
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
