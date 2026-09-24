// 三页结构的运行时验证
// ---------------------------------------------------------------------------
// 单元测试证明不了"屏幕上到底是几页、角色占多大"。这个脚本把 App 真跑起来，
// 顺着用户的路走一遍：
//   1) 标题页（品牌 + 载入进度）→ 自动进下一屏
//   2) 角色选择页：同时能选人（角色 tab）和选舞台（背景 tab），
//      选完真的写进存档，底部 CTA 进主页
//   3) 主页：前台只有顶栏两个入口 + 底部一条输入条，3D 舞台占满屏
//   4) 菜单页：所有功能都在里面（送礼/记忆是页内视图，不是再叠一层弹层）
//
// 用法: node cdp-uicheck.mjs <url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
if (!url) { console.log('用法: node cdp-uicheck.mjs <url>'); process.exit(1); }

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9351;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uichk-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  // ⚠️ 别加 --disable-gpu：新版 Chrome 里它会连 swiftshader 一起禁掉，
  //    WebGL2 直接不可用 → Avatar3D 走降级分支 → 3D 舞台 / 渐进加载队列全测不到。
  //    正确组合是显式指定 ANGLE + swiftshader 软渲染。
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
  url,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} };
process.on('exit', cleanup);

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
if (!wsUrl) { console.log('无法连接 Chrome'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
// 记下所有模型/表情请求。用来断言「前台默认模型到底是哪一个」——
// 光看页面渲染正常证明不了加载的是新模型，必须看网络层实际拉了哪个文件。
const modelReqs = [];
const allLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params?.request?.url || '';
    if (/\.glb($|\?)|\.morph\.json($|\?)/i.test(u)) modelReqs.push(decodeURIComponent(u.split('/').pop()));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
  // 全量 console：模型/部件这类"静默失败"（只 warn 不抛异常）光看 exceptions 看不出来，
  // 换装部件没挂上时，唯一的线索就是 console.warn 那一行。
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params?.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    allLogs.push('[' + m.params.type + '] ' + txt);
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

// 页面里通用的"找含某段文字的最内层有面积的元素，返回它的中心点"
// ⚠️ 只认真正有面积的元素：Modal / 浮层里有一层 h=0 的包裹层，
//    它也含同样的文字，面积 0 会被"取最小"逻辑选中，点了等于没点
const CLICK_HELPER = `
  window.__rectFor = (txt, exact) => {
    const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect();
      const s = e.textContent || '';
      return (exact ? s === txt : s.includes(txt)) && r.width > 0 && r.height > 0;
    });
    if (!hits.length) return null;
    const el = hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    })[0];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
             w: r.width, h: r.height, txt: (el.textContent || '').slice(0, 30) };
  };
  window.__topAt = (x, y) => {
    const e = document.elementFromPoint(x, y);
    return e ? (e.tagName + '.' + (e.className || '') + ' | ' + (e.textContent || '').slice(0, 40)) : null;
  };
  window.__text = () => document.body.innerText || '';
`;

/**
 * 真正的鼠标点击（走 CDP Input，而不是在页面里 dispatchEvent）。
 * 合成事件对 react-native-web 的 Pressable 时灵时不灵 —— 它内部有一套
 * responder 状态机，mousePressed/mouseReleased 才是它认的完整序列。
 * @param {string} txt  要点的文字
 * @param {boolean} [exact] 是否要求 textContent 完全相等
 */
async function clickText(txt, exact = false) {
  const rect = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, ${!!exact})`);
  if (!rect) return { ok: false, reason: 'not found: ' + txt };
  const top = await evaluate(`window.__topAt(${rect.x}, ${rect.y})`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  return { ok: true, txt: rect.txt, rect: [Math.round(rect.x), Math.round(rect.y)], top };
}

await send('Runtime.enable');
await send('Page.enable');

// ⚠️ 先塞一段聊天记录再让 App 启动。
//    ⑬ 那条断言要验"输入条上方只留最近几行"，可发真消息得有大模型 Key ——
//    这台 CI 机器上没有，chatWithTools 会直接抛错，catch 里只改气泡、
//    **不会 appendMessage**，于是 history 永远是空的、断言永远测不到东西。
//    所以这里用 addScriptToEvaluateOnNewDocument 在页面脚本跑之前写 localStorage
//    （web 版 AsyncStorage 就是裸 localStorage，无前缀 —— 见 store.js 的 KEY）。
//    personaId 故意留 null：这样 App 还是走"标题页 → 选人页 → 主页"的正常流程，
//    前面 ①~⑫ 的断言不受影响，只是进主页时这段历史已经在。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      var KEY = 'aiva.companion.v1';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({
          personaId: null,
          relations: {}, coins: 30, giftCount: {}, memory: [],
          chatHistory: { girlfriend: [
            { role: 'user',      content: '今天过得怎么样呀', ts: 1 },
            { role: 'assistant', content: '几好呀，不过挂住你啰。你呢，返工累唔累？', ts: 2 },
            { role: 'user',      content: '有点累，想听你讲两句', ts: 3 },
            { role: 'assistant', content: '咁你依家闭上眼，听我讲：你已经做得好好㗎啦。', ts: 4 },
            { role: 'user',      content: '你真好', ts: 5 },
            { role: 'assistant', content: '系因为你先令我变好㗎嘛。', ts: 6 },
          ] },
          lastSeenAt: Date.now(),
          lastCheckInDay: null,
          config: { spokenLang: 'zh-HK', langMigratedToYue: true, bgId: 'auto' },
        }));
      }
    } catch (e) {}
  `,
});

// 开网络监听（要在 navigate 之前，否则会漏掉首屏的模型请求）
await send('Network.enable');

// ⚠️ 必须先把视口设成手机尺寸。headless 默认是 800×600，
//    而这是个竖屏 App —— 角色选择页的 CTA 在 y≈600，正好落在视口外，
//    Input.dispatchMouseEvent 点了个寂寞（elementFromPoint 也返回 null）。
//    表现是"点到了但页面没动"，非常容易误判成 App 的 bug。
await send('Emulation.setDeviceMetricsOverride', {
  width: 414, height: 896, deviceScaleFactor: 2, mobile: true,
});
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

console.log('>>> 打开：' + url);
await send('Page.navigate', { url });

// ---- 1. 标题页 ------------------------------------------------------------
// ⚠️ 不能"睡 1.2s 再采一次"：本地站点（秒开）刚好能采到，但线上 6MB 的 bundle
//    要走网络，1.2s 时页面还全是空的 → ① 假 FAIL，可实际上标题页后头正常出现了。
//    这里改成轮询：一直采到 AIVA 出现为止（最多 25s），顺带记下真正花了多久。
const probeTitle = `(() => {
  const t = window.__text();
  return {
    brand: t.includes('AIVA'),
    kicker: t.includes('AI COMPANION'),
    loading: t.includes('正在读取存档') || t.includes('正在唤醒她') || t.includes('点一下进入'),
    text: t.slice(0, 90),
  };
})()`;
let title = null;
const t0 = Date.now();
for (let i = 0; i < 125; i++) {
  await evaluate(CLICK_HELPER);
  const s = await evaluate(probeTitle);
  // ⚠️ 必须同时认 loading：注入的启动兜底层也写着 "AIVA / AI COMPANION"，
  //    只认 brand 的话会在兜底层刚出现时就退出循环，测的是兜底页不是标题页。
  if (s.brand && s.loading) { title = s; break; }
  title = s; // 留最后一次样本，便于排查
  await sleep(200);
}
const titleAfterMs = Date.now() - t0;
console.log('=== 1. 标题页 ===');
console.log(' ', JSON.stringify(title), '| 首帧出现于', titleAfterMs + 'ms');

// ---- 2. 自动进到角色选择页 ------------------------------------------------
await sleep(10000);
await evaluate(CLICK_HELPER);
const sel = await evaluate(`(() => {
  const t = window.__text();
  return {
    isSelect: t.includes('今天想陪在谁身边'),
    hasCharTab: t.includes('角色'),
    hasBgTab: t.includes('背景'),
    hasCta: t.includes('开始相处'),
    cards: (t.match(/开始相处/g) || []).length,
    // 第二批扩列的 4 个原创角色（2026-09 新增模型）有没有真的进到列表里
    newFaces: ['Noa', 'Sora', 'Leon', 'Haruka'].filter((k) => t.includes(k)),
  };
})()`);
console.log('=== 2. 角色选择页 ===');
console.log(' ', JSON.stringify(sel));

// 切到背景 tab，选一个舞台
const tabClick = await clickText('背景', false);
await sleep(1200);
const bgList = await evaluate(`(() => {
  const t = window.__text();
  return ['跟随角色','樱花树下','夜色霓虹','海边黄昏','书房暖光','林间晨雾','深空','演唱舞台','自定义图片']
    .map((k) => k + ':' + (t.includes(k) ? 1 : 0)).join(' ');
})()`);
console.log('   背景 tab:', bgList, '| 点击:', JSON.stringify(tabClick));

const bgPick = await clickText('夜色霓虹', false);
await sleep(1200);

// 回到"角色"tab 选一个人。
// ⚠️ 坑中坑：这里原来直接 clickText('小柔')，结果选中的是**底部 CTA**
//    （CTA 文案是"开始相处 · 小柔"，作为单个元素面积比卡片小，"取最小"就挑中了它）。
//    于是这一下当场进了主页 —— 后面第 3 步再点 CTA 永远 not found，
//    "选人"和"点 CTA 进主页"两条断言同时变成空转，谁都没真测到。
//    正确做法：点**卡片**（用只在卡片上出现的 tagline 定位），留在选择页，
//    再显式点 CTA。顺带验证点别的卡片时 CTA 文案会跟着变。
await clickText('角色', false);
await sleep(900);

/**
 * 读底部 CTA 上跟着的那个人名。
 * ⚠️ 两种文案：首次启动是「开始相处 · 小柔」，换人模式是「换成 小柔」。
 *    而 PersonaSelect.choose() 会**立刻** selectPersona，所以首屏点一下卡片，
 *    整页当场翻成换人模式 —— 只认前一种写法的话，点完卡片就读到 null。
 *    标题「换成谁？」故意不含空格，用 /^换成 / 就能把它排除掉。
 */
const ctaText = () => evaluate(`(() => {
  const cands = Array.from(document.querySelectorAll('*')).filter((e) => {
    const s = (e.textContent || '').trim();
    return /^开始相处 · /.test(s) || (/^换成 /.test(s) && !/^换成谁/.test(s));
  });
  if (!cands.length) return null;
  const el = cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  })[0];
  const m = el.textContent.trim().match(/^(?:开始相处 · |换成 )(\\S+)/);
  return m ? m[1] : null;
})()`);

/** 滚到某段文字出现在视口内（卡片列表在 ScrollView 里，不滚就点不着） */
async function scrollUntilVisible(txt, dir = 1, tries = 12) {
  for (let i = 0; i < tries; i++) {
    await evaluate(CLICK_HELPER);
    const r = await evaluate(`window.__rectFor(${JSON.stringify(txt)}, false)`);
    if (r && r.y > 60 && r.y < 820) return r;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 207, y: 520, deltaX: 0, deltaY: 300 * dir,
    });
    await sleep(320);
  }
  return null;
}

const ctaBefore = await ctaText();

// 卡片定位用 tagline（"会撒娇，会吃醋…"），它在 CTA 上不会出现
const cardPick = await clickText('会撒娇，会吃醋', false);
await sleep(1000);
const ctaAfterXiaorou = await ctaText();

// 再把列表往下滚，点另一个人，确认"选谁"真的在改 CTA —— 证明卡片点了有用
const noaRect = await scrollUntilVisible('Noa', 1);
const otherPick = noaRect ? await clickText('Noa', false) : { ok: false, skipped: true };
await sleep(1000);
const ctaAfterNoa = await ctaText();

// 换回小柔：后面的断言（存档 personaId、聊天记录）都按她来
await scrollUntilVisible('会撒娇，会吃醋', -1);
const backPick = await clickText('会撒娇，会吃醋', false);
await sleep(1000);
const ctaFinal = await ctaText();

const saved = await evaluate(`(() => {
  const raw = localStorage.getItem('aiva.companion.v1');
  if (!raw) return { found: false };
  const s = JSON.parse(raw);
  return { found: true, bgId: s.config?.bgId, spokenLang: s.config?.spokenLang, personaId: s.personaId };
})()`);
console.log('   选舞台:', JSON.stringify(bgPick));
console.log('   选人(卡片):', JSON.stringify(cardPick), '| CTA:', ctaBefore, '→', ctaAfterXiaorou,
  '→ 点 Noa:', ctaAfterNoa, '→ 换回:', ctaFinal, '| 换回点击:', JSON.stringify(backPick));
console.log('   存档:', JSON.stringify(saved));

// ---- 3. CTA 进主页 --------------------------------------------------------
// 这一次人还在选择页，CTA 应该真的点得着。
// 文案两种都试：点过卡片之后就是换人模式的「换成 X」了。
const cta = await clickText('换成 ', false);
const cta2 = cta?.ok ? null : await clickText('开始相处 ·', false);
await sleep(600);
const ctaWorked = await evaluate(`(() => {
  const inp = Array.from(document.querySelectorAll('input'))
    .some((e) => (e.placeholder || '').includes('跟她说'));
  const t = window.__text();
  const raw = localStorage.getItem('aiva.companion.v1');
  return {
    // 选择页的两个标题都不在了才算真的回到主页（Home 从头到尾都挂在底下，
    // 所以"有输入框"不能当作判据）
    enteredHome: inp && !t.includes('今天想陪在谁身边') && !t.includes('换成谁？'),
    personaId: raw ? JSON.parse(raw).personaId : null,
  };
})()`);

// 渐进式加载的第一现场：**刚进主页的这一刻**，输入条要已经在，
// 而队列还没跑完（重活都排在后面）。这正好是"先能打字、再补模型"的判据。
await sleep(700);
await evaluate(CLICK_HELPER);
const firstPaint = await evaluate(`(() => {
  const inp = Array.from(document.querySelectorAll('input'))
    .find((e) => (e.placeholder || '').includes('跟她说'));
  return {
    inputReady: !!inp && !inp.disabled,
    preload: window.__aivaPreload ? window.__aivaPreload.state() : null,
  };
})()`);
console.log('   首屏现场:', JSON.stringify(firstPaint));

await sleep(12000);
await evaluate(CLICK_HELPER);
const home = await evaluate(`(() => {
  const t = window.__text();
  const cv = document.querySelector('canvas');
  const cr = cv ? cv.getBoundingClientRect() : null;
  return {
    hasMenu: t.includes('☰'),
    hasMic: t.includes('🎙️'),
    hasFile: t.includes('📎'),
    hasSend: t.includes('➤'),
    inputs: document.querySelectorAll('input').length,
    oldButtons: ['送礼物','每日签到','她的记忆'].filter((k) => t.includes(k)),
    // 舞台要占满屏：canvas 高度占视口的比例
    stageRatio: cr ? Math.round((cr.height / window.innerHeight) * 100) : -1,
    text: t.slice(0, 110),
  };
})()`);
console.log('=== 3. 主页 ===');
console.log(' ', JSON.stringify(home));
console.log('   CTA 点击:', JSON.stringify(cta), '| 异常数:', exceptions.length);
exceptions.slice(0, 5).forEach((e) => console.log('   [EXCEPTION]', e.slice(0, 200)));

// ---- 4. 菜单页 ------------------------------------------------------------
const menuBtn = await clickText('☰', true);
await sleep(1500);
const menu = await evaluate(`(() => {
  const t = window.__text();
  const want = ['换角色','聊天记录','语音设置','送礼物','她的记忆','每日签到','回正视角','设置'];
  return { missing: want.filter((k) => !t.includes(k)), found: want.filter((k) => t.includes(k)) };
})()`);
console.log('=== 4. 菜单页 ===');
console.log('  ☰ 点击:', JSON.stringify(menuBtn));
console.log('  命中:', JSON.stringify(menu.found));
console.log('  缺失:', JSON.stringify(menu.missing));
if ((menu?.missing || []).length) {
  console.log('  [现场] 屏幕文字:', JSON.stringify(await evaluate(`window.__text().slice(0, 400)`)));
}

// 送礼是页内视图，不是再叠一层弹层
const gift = await clickText('送礼物', false);
await sleep(1200);
const giftView = await evaluate(`(() => {
  const t = window.__text();
  return { ok: t.includes('亲密') && t.includes('🪙'), hasBack: t.includes('返回') };
})()`);
console.log('   送礼页内视图:', JSON.stringify(gift), JSON.stringify(giftView));

// ---- 5. 渐进式加载跑到头了吗 ----------------------------------------------
// 队列里应该有：1 个主角模型 + N 个其他角色预热。等它跑完（最多 40s）。
const preState = await evaluate(`window.__aivaPreload ? window.__aivaPreload.drain(40000) : null`);
console.log('=== 5. 渐进式加载 ===');
console.log(' ', JSON.stringify(preState));

// ---- 6. 角落那个小圆环进度器 ----------------------------------------------
// 本机跑得太快，等队列自然出现会 flaky。这里塞一个 2.5s 的假任务把它逼出来，
// 顺便验两件事：它真的显示百分比，而且**完全不挡点击**。
await evaluate(`window.__aivaPreload.schedule({
  id: '__badgeProbe', label: '自检', priority: 0, force: true,
  run: () => new Promise((r) => setTimeout(r, 2500)),
})`);
await sleep(900);
const badge = await evaluate(`(() => {
  const el = document.getElementById('aiva-preload-badge');
  if (!el) return { shown: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    shown: true,
    w: Math.round(r.width), h: Math.round(r.height),
    pointerEvents: cs.pointerEvents,
    hasRing: !!el.querySelector('svg'),
    text: (el.innerText || '').replace(/\\s+/g, ''),
    // 命中测试：圆心里那一点上最顶层的元素如果还是它自己（或它的子节点），
    // 就说明它吃掉了点击 —— 这正是需求里"不挡任何东西"的反面
    blocks: !!(top && (el === top || el.contains(top))),
  };
})()`);
await sleep(3200);
const badgeGone = await evaluate(`!document.getElementById('aiva-preload-badge')`);
console.log('=== 6. 角落小圆环进度器 ===');
console.log(' ', JSON.stringify(badge), '| 跑完后消失:', badgeGone);

// ---- 7. 输入条上方那几行聊天记录 ------------------------------------------
// ⚠️ 第 4 步点开菜单后，Home 还在底下活着但被浮层盖住了 ——
//    不先关掉菜单，后面"点输入框 / 点 ➤"全是点在浮层上，等于没点。
//    菜单是两级：送礼视图里 ⟨返回 → 主菜单，主菜单 ⟨关闭 → 回主页。
await clickText('返回', false);
await sleep(900);
await clickText('关闭', false);
await sleep(1200);
await evaluate(CLICK_HELPER);

const readTranscript = () => evaluate(`(() => {
  const box = document.getElementById('aiva-transcript');
  const inp = Array.from(document.querySelectorAll('input'))
    .find((e) => (e.placeholder || '').includes('跟她说'));
  const inputTop = inp ? Math.round(inp.getBoundingClientRect().top) : -1;
  if (!box) return { shown: false, inputTop };
  const r = box.getBoundingClientRect();
  const ops = [];
  for (let i = 0; i < 8; i++) {
    const el = document.getElementById('aiva-tline-' + i);
    if (!el) break;
    ops.push(Number(getComputedStyle(el).opacity));
  }
  // 命中测试：这几行压在 3D 舞台上方，pointerEvents 必须是 none，
  // 否则单指拖拽转视角 / 双指缩放在这一带会被吃掉。
  const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    shown: true,
    lines: ops.length,
    ops,
    h: Math.round(r.height),
    bottom: Math.round(r.bottom),
    inputTop,
    pointerEvents: getComputedStyle(box).pointerEvents,
    blocks: !!(mid && (box === mid || box.contains(mid))),
    text: (box.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
  };
})()`);

// 存档里那 6 条历史：进主页就该已经在，不用等大模型回包
const chat = await readTranscript();
console.log('=== 7. 输入条上方的最近对话 ===');
console.log('  存档历史:', JSON.stringify(chat));

// 再真发一条，看看新的一轮会顶掉最旧的一行（行数仍被压住、依旧越往上越淡）。
// 没有 Key 时 chatWithTools 会抛错 → catch 只改气泡、不写历史，
// 所以这一发只验"不会把已有的那几行搞崩"，不苛求它一定变长。
const focused = await evaluate(`(() => {
  const i = Array.from(document.querySelectorAll('input'))
    .find((e) => (e.placeholder || '').includes('跟她说'));
  if (!i) return null;
  i.focus();
  const r = i.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: Math.round(r.top) };
})()`);
if (focused) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: focused.x, y: focused.y, button: 'left', clickCount: 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }
  await send('Input.insertText', { text: '今天过得怎么样' });
  await sleep(400);
}
const sendBtn = await clickText('➤', true);
await sleep(6000);
const chat2 = await readTranscript();
console.log('  发送后:', JSON.stringify(chat2), '| ➤ 点击:', JSON.stringify(sendBtn));

// ---- 判定 ----------------------------------------------------------------
console.log('\n=== 判定 ===');
const titleOk = !!title?.brand && !!title?.loading;
const selectOk = !!sel?.isSelect && !!sel?.hasCharTab && !!sel?.hasBgTab && !!sel?.hasCta;
const bgOk = !!saved?.found && saved.bgId === 'night';
const homeOk = !!home?.hasMenu && !!home?.hasMic && !!home?.hasFile && !!home?.hasSend
  && (home.inputs || 0) >= 1 && (home.oldButtons || []).length === 0;
const stageOk = (home?.stageRatio ?? 0) >= 55;
const menuOk = (menu?.missing || []).length === 0;
const noCrash = exceptions.length === 0;
console.log((titleOk ? 'PASS' : 'FAIL') + '  ① 启动先进标题页（品牌 + 载入进度）');
console.log((selectOk ? 'PASS' : 'FAIL') + '  ② 角色选择页同时能选人和选舞台');
console.log((bgOk ? 'PASS' : 'FAIL') + '  ③ 选的舞台真的写进存档 (bgId=' + saved?.bgId + ')');
console.log((homeOk ? 'PASS' : 'FAIL') + '  ④ 主页前台 = 顶栏两入口 + 一条输入条，无遗留按钮');
console.log((stageOk ? 'PASS' : 'FAIL') + '  ⑤ 3D 舞台占满屏 (占视口高 ' + home?.stageRatio + '%)');
console.log((menuOk ? 'PASS' : 'FAIL') + '  ⑥ 菜单页收下全部功能（缺失: ' + JSON.stringify(menu?.missing) + '）');
console.log((giftView?.ok ? 'PASS' : 'FAIL') + '  ⑦ 送礼是菜单页内的视图');
console.log((noCrash ? 'PASS' : 'FAIL') + '  ⑧ 全程无异常 (' + exceptions.length + ')');

// ⑨ 第二批扩列的 4 个原创角色进了选择页
const newFacesOk = (sel?.newFaces || []).length === 4;
console.log((newFacesOk ? 'PASS' : 'FAIL') + '  ⑨ 新增 4 个角色模型进了列表 (' + JSON.stringify(sel?.newFaces) + ')');

// ⑩ 首屏先亮：进主页时输入条已可用，且**第一个重活确实排在首屏就绪之后**。
//    不能拿 "done < total" 当判据：本机 700ms 就把 18 个任务全跑完了，
//    那个断言只反映机器快慢，不反映顺序。这里比的是两个时间戳。
const p10 = firstPaint?.preload;
const bootOk = !!firstPaint?.inputReady && !!p10
  && p10.interactiveAt > 0
  && (p10.firstTaskAt === 0 || p10.firstTaskAt >= p10.interactiveAt);
console.log((bootOk ? 'PASS' : 'FAIL') + '  ⑩ 首屏先亮：进主页即能打字，重活排在首屏之后 (' +
  `interactiveAt=${Math.round(p10?.interactiveAt || 0)}ms, firstTaskAt=${Math.round(p10?.firstTaskAt || 0)}ms, ` +
  `done=${p10?.done}/${p10?.total})`);

// ⑪ 后台预热真的跑完了，而且缓存里确实有字节
const warmOk = !!preState && preState.phase === 'done' && preState.total >= 10 && preState.done === preState.total;
console.log((warmOk ? 'PASS' : 'FAIL') + '  ⑪ 后台预热跑完 ' + (preState ? `${preState.done}/${preState.total}` : 'n/a'));

// ⑫ 角落小圆环：够小、有百分比、有进度条、跑完自己消失、且不挡任何点击
const badgeOk = !!badge?.shown
  && badge.pointerEvents === 'none'
  && badge.blocks === false
  && !!badge.hasRing
  && /\d/.test(badge.text || '')
  && badge.w <= 60 && badge.h <= 70
  && badgeGone === true;
console.log((badgeOk ? 'PASS' : 'FAIL') + '  ⑫ 角落小圆环：显示百分比且不挡点击 (' +
  `${badge?.w}×${badge?.h}px, pointer-events=${badge?.pointerEvents}, 挡点击=${badge?.blocks}, ` +
  `文字="${badge?.text}", 跑完消失=${badgeGone})`);

// ⑬ 输入条上方只留几行对话：越往上越淡、不越过输入框、不挡手势。
//    两份样本都要成立：存档里带进来的历史，以及发完一条之后的样子。
const chatRanks = (c) => !!c?.shown
  && c.lines >= 2 && c.lines <= 4
  && c.ops[0] < c.ops[c.lines - 1]
  && c.pointerEvents === 'none'
  && c.blocks === false
  && c.bottom <= c.inputTop + 2
  && c.h <= 100;
const chatOk = chatRanks(chat) && chatRanks(chat2);
console.log((chatOk ? 'PASS' : 'FAIL') + '  ⑬ 输入条上方的最近对话：几行 + 顶部淡出 (' +
  `${chat?.lines} 行, 透明度 ${JSON.stringify(chat?.ops)}, 高 ${chat?.h}px, ` +
  `底边 ${chat?.bottom} ≤ 输入框顶 ${chat?.inputTop}, 挡手势=${chat?.blocks}` +
  `｜发完一条: ${chat2?.lines} 行, 高 ${chat2?.h}px)`);

// ⑭ 选人真的点到的是**卡片**：点完仍在选择页，CTA 上的人名跟着变
const pickOk = !!cardPick?.ok && ctaBefore === '小柔' && ctaAfterXiaorou === '小柔'
  && ctaFinal === '小柔';
console.log((pickOk ? 'PASS' : 'FAIL') + '  ⑭ 点卡片选人（点到的是卡片，不是 CTA 自己） (' +
  `点中=${cardPick?.ok}, CTA=${ctaBefore}→${ctaAfterXiaorou}, 换回后=${ctaFinal})`);

// ⑮ 换人：点另一张卡，CTA 要变成那个人 —— 证明卡片点击真的在改选择
const switchOk = ctaAfterNoa === 'Noa' && ctaFinal === '小柔';
console.log((switchOk ? 'PASS' : 'FAIL') + '  ⑮ 换一个人，底部 CTA 跟着换成她 (' +
  `Noa 滚到=${!!noaRect}, 点中=${otherPick?.ok}, CTA=${ctaAfterNoa} → 换回 ${ctaFinal})`);

// ⑯ CTA 本身：这次人还在选择页，点下去要真的进主页并落档
const ctaHit = (cta?.ok ? cta : cta2) || {};
const ctaOk = !!ctaHit.ok && !!ctaWorked?.enteredHome && ctaWorked?.personaId === 'girlfriend';
console.log((ctaOk ? 'PASS' : 'FAIL') + '  ⑯ 底部 CTA 真的点得着、真的进主页 (' +
  `点中=${ctaHit.ok}, 进主页=${ctaWorked?.enteredHome}, personaId=${ctaWorked?.personaId})`);

// ⑰ 前台默认模型 = aiva-shino（VRoid CC0 现成模型）。
//
// ⚠️ 这条断言 2026-09 改过。原来验的是「底座+头发+衣服三件套」
//    （aiva-body + aiva-hair-kizuna + aiva-outfit-kizuna）——
//    那份拆件已经**整体删除**，理由见 src/lib/companionModel.js 里的注释：
//    Kizuna 的 VRM 授权是 allowRedistribution:false，而打包产物会推到公开
//    分享链接上，等于公开分发（4 个文件共 20.6MB）。
//    现在默认角色换成 VRoid 官方 sample「Sendagaya Shino」，授权 CC0 1.0，
//    可以随便分发商用。
//
//    所以要验两件事：
//      a) 真的拉到了 shino 的 glb
//      b) **没有**再拉任何 Kizuna 派生物（授权合规，这条是硬红线）
//    单看页面渲染正常证明不了这两点，必须落到网络层。
const modelLog = modelReqs.join(' | ');
const shinoLoaded = modelReqs.some((n) => /aiva-shino/i.test(n));
// 任何 Kizuna 派生物都不该再被请求
const bannedLoaded = modelReqs.filter((n) => /kizuna/i.test(n));
const modelOk = shinoLoaded && bannedLoaded.length === 0;
if (!modelOk) {
  // 失败时把现场日志打出来：模型没挂上的原因几乎都在这些 warn/info 里
  const rel = allLogs.filter((l) => /model|部件|part|glb|attach|Avatar|rig|骨架|morph/i.test(l));
  console.log('      ↓ 现场日志（' + rel.length + ' 条）');
  rel.slice(-15).forEach((l) => console.log('        ' + l));
}
console.log((modelOk ? 'PASS' : 'FAIL') +
  `  ⑰ 默认模型 = aiva-shino，且无 Kizuna 派生物 (shino=${shinoLoaded}, 违规请求=${bannedLoaded.length})`);
console.log(`      请求: ${modelLog || '无'}`);

// ⑱ 表情通道真的挂上了。
//
// ⚠️ 这条也改过。原来问的是 __aivaDebug.partCount（换装部件网格数）——
//    三件套删掉之后这个概念不存在了，探针只会回 'no-debug'，
//    看起来像"部件没挂上"，其实是断言本身失效了（工具在骗人，不是应用坏了）。
//
//    现在验的是**表情链路**，这才是本项目的核心诉求：
//    应用自己会打一句
//      "[morph] 表情已接管（内置 blendshape）：N 个形状 / M 个网格（口型驱动就绪…）"
//    Shino 是 10 个材质分量共享 41 个 target、转换后保留 16 条 ARKit 通道，
//    所以期望「16 个形状 / 10 个网格」。
//    ⚠️ M 必须是 10 而不是 1：只驱动 primitives[0] 的话，
//       眨眼会只动脸皮、睫毛和眼线留在原地 —— 这正是 createBuiltinMorphHandle
//       改成"同名 morph 全网格都写"要解决的问题。
const morphLog = allLogs.map((l) => /表情已接管（内置 blendshape）：(\d+) 个形状 \/ (\d+) 个网格/.exec(l)).find(Boolean);
const morphShapes = morphLog ? Number(morphLog[1]) : 0;
const morphMeshes = morphLog ? Number(morphLog[2]) : 0;
const rigLog = allLogs.map((l) => /\[rig\] 骨架已接管：(\d+)\/(\d+) 核心骨/.exec(l)).find(Boolean);
const rigHave = rigLog ? Number(rigLog[1]) : 0;
const rigNeed = rigLog ? Number(rigLog[2]) : 0;
// 判据：16 条通道都在、且网格数 >= 2（证明不是只驱动了 primitives[0]）
const partOk = morphShapes >= 16 && morphMeshes >= 2 && rigNeed > 0 && rigHave === rigNeed;
console.log((partOk ? 'PASS' : 'FAIL') +
  `  ⑱ 表情与骨架已接管 (形状 ${morphShapes}/16, 网格 ${morphMeshes}（>1 才算多分量都驱动）, 核心骨 ${rigHave}/${rigNeed})`);
if (!partOk) {
  const rel = allLogs.filter((l) => /morph|rig|骨架|表情|blendshape/i.test(l));
  console.log('      ↓ morph/rig 相关日志：' + (rel.length ? '' : '(无)'));
  rel.slice(-10).forEach((l) => console.log('        ' + l));
}

const allOk = titleOk && selectOk && bgOk && homeOk && stageOk && menuOk
  && giftView?.ok && noCrash && newFacesOk && bootOk && warmOk && badgeOk && chatOk
  && pickOk && switchOk && ctaOk && modelOk && partOk;
cleanup();
process.exit(allOk ? 0 : 1);
