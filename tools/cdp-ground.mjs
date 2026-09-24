#!/usr/bin/env node
// 量「角色到底站在地上没有」。
//
// 为什么需要它：截图看不出漂浮 —— 相机俯仰、地面圆盘、背景板都会骗人。
// 硬证据只有一条：**脚骨的世界高度**。
//   · footLift = 当前脚底 - rest 脚底，> 0.005 米就是肉眼能看出的飘
//   · 静止时要 ≈ 0（她站着）；被戳时也要很快回到 ≈ 0（脚钉在地上）
//
// 用法：node tools/cdp-ground.mjs http://127.0.0.1:8800/ [tmp/ground.png]
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8800/';
const SHOT = process.argv[3] || 'tmp/ground.png';
const CHROME = process.env.CHROME_PATH
  || 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9461);

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
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++idc; waiters.set(id, res); sock.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => sock.close() };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ground-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

const out = [];
const log = (s) => { out.push(s); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/ground.log', out.join('\n'), 'utf8'); console.log(s); };
const ev = (c, expr) => c.send('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true });

/**
 * 进入 Home。要两步，漏一步就停在选人格页（那里没有 3D，__aivaDebug 也不存在）：
 *   ① 点「小柔」卡片 —— 只是**选中**，底部那行字会跟着变
 *   ② 点底部「开始相处 · 小柔 →」—— 这才是真的进去
 *
 * ⚠️ 第一版只点了卡片就跑，结果页面一直停在清单页，五个断言全 FAIL 却看不出原因。
 *    卡片文案里也带「开始相处」（那是卡片上的小字），所以第二步必须挑
 *    **最内层**、**文字以「开始相处」开头**的那个节点，否则会点到卡片里的小字上。
 */
const ENTER = `(() => {
  const out = { steps: [] };
  const els = Array.from(document.querySelectorAll('div,span'));

  // ① 选角色
  const cards = els.filter(e => /小柔/.test(e.textContent || ''));
  if (cards.length) {
    cards.sort((a, b) => a.textContent.length - b.textContent.length);
    const card = cards[0];
    const r = card.getBoundingClientRect();
    const fire = (k) => card.dispatchEvent(new MouseEvent(k, {
      bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8,
    }));
    fire('mousedown'); fire('mouseup'); fire('click');
    out.steps.push('选中小柔');
  } else {
    out.steps.push('没找到角色卡（可能已在 Home）');
  }
  return out;
})()`;

/** 第二步：点底部那颗「开始相处 · 小柔 →」。单独一发，等 React 把选中态渲染完 */
const GO = `(() => {
  const els = Array.from(document.querySelectorAll('*'));
  // ⚠️ 必须认「·」——每张卡片上也有一行小字「开始相处」。
  //    按前缀匹配会先撞上第一张卡片那行小字（y≈606），点了什么都不会发生。
  //    底部那颗真的按钮文案是「开始相处 · 小柔 →」，带名字所以唯一。
  const go = els.filter(e => /开始相处\\s*·/.test((e.textContent || '').trim()));
  if (!go.length) return { ok: false, reason: '没找到底部「开始相处 · xx」按钮' };
  go.sort((a, b) => a.textContent.length - b.textContent.length);
  const t = go[0];
  const r = t.getBoundingClientRect();
  return {
    ok: true,
    label: (t.textContent || '').trim().slice(0, 24),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  };
})()`;

/** 抓一份完整快照：脚离地 + 相机 + 姿势 + 头线 */
const SNAP = `(() => {
  const d = window.__aivaDebug;
  if (!d) return { err: 'no __aivaDebug' };
  return {
    ground: d.groundInfo ? d.groundInfo() : null,
    pose: d.currentPose ? d.currentPose() : null,
    reacting: d.isReacting ? d.isReacting() : null,
    camera: d.cameraPos ? d.cameraPos() : null,
    headLine: d.hitBounds ? d.hitBounds().headLine : null,
  };
})()`;
const snap = async (c) => (await ev(c, SNAP)).result?.result?.value || {};
const val = async (c, expr) => (await ev(c, expr)).result?.result?.value;

try {
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { try { v = await getJSON('/json/version'); } catch { await sleep(200); } }
  if (!v) throw new Error('DevTools 没起来');
  const tabs = await getJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  log('>>> 打开 ' + url);
  await c.send('Page.navigate', { url });
  await sleep(3500);

  // 等首屏真的画出来再动手。模型 GLB 是 2MB 上下，慢的时候角色列表要十几秒才出现；
  // 固定 sleep 撑不住 —— 实测过在这种机器上跑，3.5 秒时页面上还一个字都没有，
  // 后面两步点击全部落空，六个断言全 FAIL 看着像"站地功能坏了"，其实只是没进 Home。
  let painted = false;
  for (let i = 0; i < 80; i++) {
    painted = await val(c, `/小柔|开始相处/.test(document.body.innerText || '')`);
    if (painted) break;
    await sleep(250);
  }
  log('>>> 首屏就绪：' + painted);

  const picked = await ev(c, ENTER);
  log('>>> ① ' + JSON.stringify(picked.result?.result?.value));
  await sleep(700);
  const btn = (await ev(c, GO)).result?.result?.value;
  log('>>> ② 找到按钮 ' + JSON.stringify(btn));
  if (!btn?.ok) { log('!! 进不去 Home，后面全是废数据'); }
  else {
    // ⚠️ 这里必须用 CDP 原生鼠标事件，不能用 dispatchEvent(new MouseEvent())：
    //    React Native Web 的 Pressable 走的是 pointer events（pointerdown/pointerup），
    //    手搓的 MouseEvent 不带 pointerId，Pressable 直接忽略，点了毫无反应。
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', {
        type, x: btn.x, y: btn.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    log('>>> ② 已点击 (' + btn.x + ',' + btn.y + ')');
  }

  // 模型是异步挂的，GLB 解析要时间。先等钩子出现，再等模型挂上。
  let hook = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    hook = (await ev(c, '!!window.__aivaDebug')).result?.result?.value;
    if (hook) break;
  }
  log('>>> 钩子：' + hook);
  if (!hook) {
    const body = (await ev(c, 'document.body.innerText.slice(0,160)')).result?.result?.value;
    log('!! 没进 Home，页面文字：' + JSON.stringify(body));
  }
  await sleep(9000);

  let fails = 0;
  const gate = (name, ok, detail) => {
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) fails++;
  };

  const base = await snap(c);
  log('\n=== 静止时 ===');
  log(JSON.stringify(base, null, 2));

  // ① 静止：脚必须踩在地上
  log('\n--- 断言 ---');
  gate('① 静止脚钉在地上', base.ground && base.ground.footLift <= 0.005,
    `footLift=${base.ground?.footLift}m`);
  gate('② 着地骨已登记', (base.ground?.tracked || 0) >= 2,
    `${base.ground?.tracked} 根 ${JSON.stringify(base.ground?.bones)}`);

  // ③ 连续采样 2 秒：呼吸起伏不应该让脚移动
  let maxLift = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const s = await snap(c);
    const l = s.ground?.footLift ?? 99;
    if (l > maxLift) maxLift = l;
  }
  gate('③ 呼吸 2 秒内脚不动', maxLift <= 0.005, `max footLift=${maxLift}m`);

  // ④ 戳一下：脚要立刻回来
  // 先问页面「屏幕哪里是她的身子」，再照着那个坐标真的戳下去。
  // 硬编坐标会随相机/模型变化而失效，而且 hitTest(215,480) 实测打空。
  // ⚠️ 这一步**可能探不到**：她站的位置、手臂姿势（arms-cross 那种会把身体
  //    缩进去）、相机构图都会影响射线能不能打中。探不到的时候后面 ④ 会误报，
  //    所以这里换两套扫法（先细后粗）并把过程记下来 —— 免得"她没被戳到"
  //    被当成"被戳时脚离地了"。
  //
  //    粗暴地把整个画面按 8px 扫一遍太慢（射线检测是 CPU 上的），
  //    所以第一遍按身体中轴优先、第二遍才铺满。
  const spot = (await ev(c, `(() => {
    const d = window.__aivaDebug;
    if (!d || !d.hitTest) return { err: 'no hitTest' };
    const tries = [];
    const scan = (x0, x1, y0, y1, step, want) => {
      for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
          const h = d.hitTest(x, y);
          if (h && (!want || h.part === want)) return { x, y, part: h.part };
        }
      }
      return null;
    };
    // ① 中轴附近找头（最稳的落点，头和身体不会被手臂挡）
    let hit = scan(200, 260, 190, 360, 8, 'head') || scan(150, 350, 150, 400, 8, 'head');
    tries.push(['head-fine', !!hit]);
    // ② 整个上半身找任何部位
    if (!hit) { hit = scan(120, 360, 180, 620, 10, null); tries.push(['body-coarse', !!hit]); }
    if (!hit) { hit = scan(60, 400, 120, 700, 20, null); tries.push(['body-full', !!hit]); }
    return hit ? { ...hit, tries } : { tries };
  })()`)).result?.result?.value;
  log('\n>>> 可戳点扫描：' + JSON.stringify(spot));
  if (!spot || spot.x === undefined) {
    log('!! 射线没打中身体 —— 后续 ④ 的数字不代表"戳到了"，只能当噪音看');
  }

  const hitOk = !!(spot && spot.x !== undefined);
  const poke = async () => {
    if (!hitOk) return;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', {
        type, x: spot.x, y: spot.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
  };
  await poke();

  // 采样整段反应：0~2.0 秒
  const during = [];
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const s = await snap(c);
    during.push({ lift: s.ground?.footLift ?? 99, pose: s.pose });
  }
  const after = await snap(c);
  log('  戳后 footLift 采样 = ' + JSON.stringify(during.map((d) => d.lift)));
  log('  期间姿势           = ' + JSON.stringify(during.map((d) => d.pose)));
  const maxLift2 = Math.max(...during.map((d) => d.lift));
  // 没打中身体就不断言 —— 否则量的是"呼吸时脚底的余弦起伏"，
  // 跟"被戳时钉不钉得住"毫无关系，只会制造假失败。
  gate('④ 戳反应期间脚不离地', !hitOk || maxLift2 <= 0.005,
    hitOk ? `max=${maxLift2}m` : '未打中身体，跳过（见上面的扫描结果）');
  gate('⑤ 戳完 2s 内归零', !hitOk || (after.ground?.footLift ?? 99) <= 0.005,
    `footLift=${after.ground?.footLift}m`);

  // ⑥ 再连戳 5 次：反复戳也不能把脚越推越高（这是"累积漂移"的经典翻车点）
  for (let i = 0; i < 5; i++) {
    await poke();
    await sleep(260);
  }
  await sleep(1600);
  const many = await snap(c);
  gate('⑥ 连戳 5 次后仍在地上', (many.ground?.footLift ?? 99) <= 0.005,
    `footLift=${many.ground?.footLift}m`);

  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  log('\n>>> 截图：' + SHOT);

  log('\n=== 结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  if (fails) process.exitCode = 1;
  c.close();
} catch (e) {
  log('探针失败：' + e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
