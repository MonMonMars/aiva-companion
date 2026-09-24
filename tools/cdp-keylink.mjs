// 验「一键装 Key」这条链路在真 App 里跑得通
// ---------------------------------------------------------------------------
// 为什么单独写这个：store 的读写在别处早就验过了，但"URL 片段 → 存档"这一段
// 是新的，而且**调用时机**是它唯一的致命点 —— 装在 loadStore 之前会被硬盘旧值
// 整体冲掉，界面上一点痕迹都没有。这种 bug 靠读代码看不出来，只能真跑。
//
// 断言：
//   ① 带 #sk=... 打开 → 存档里真的写进去了
//   ② 地址栏的片段被抹掉（Key 不残留）
//   ③ STT 供应商被拨到 siliconflow（否则装了 Key 还停在 openai 上，照样报错）
//   ④ 刷新后（不带片段）Key 还在 —— 证明真的落盘了，不是留在内存里
//   ⑤ 屏幕上出现「已装好」提示
//   ⑥ 全程没有未捕获异常
//
// 用法: node tools/cdp-keylink.mjs [url] [dist目录] [片段参数名]
//   片段参数名默认 sk（硅基流动）。换成别的就能验别家那把 Key：
//     node tools/cdp-keylink.mjs "" dist-motion ek   # 验 ElevenLabs
//     node tools/cdp-keylink.mjs "" dist-motion ak   # 验 Azure（还要同时给 ar）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const distDir = process.argv[3] || 'dist-motion';

// 片段参数 → { 存档字段, 应该被拨到的 STT 供应商, 送入片段的值 }
const CASES = {
  gm: { field: 'geminiKey',  stt: 'gemini',      val: 'AIzaTESTKEY0123456789abcdef' },
  sk: { field: 'siliconKey',  stt: 'siliconflow', val: 'sk-TESTKEY0123456789abcdef' },
  ek: { field: 'elevenKey',   stt: 'elevenlabs',  val: 'el-TESTKEY0123456789abcdef' },
  gk: { field: 'groqKey',     stt: 'groq',        val: 'gsk_TESTKEY0123456789abcdef' },
  ok: { field: 'openaiKey',   stt: null,          val: 'sk-TESTKEY0123456789abcdef' },
  ak: { field: 'azureKey',    stt: 'azure',       val: 'AZURE-TESTKEY-0123' },
};
const PARAM = process.argv[4] || 'sk';
const CASE = CASES[PARAM];
if (!CASE) { console.log('未知片段参数：' + PARAM + '  可选：' + Object.keys(CASES).join(' / ')); process.exit(1); }
const PORT_SRV = 8911;
const NODE = process.execPath;
const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/';

const srv = spawn(NODE, ['tools/dist-server.mjs', String(PORT_SRV), distDir], {
  cwd: ROOT, stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

// 探针自己需要"带片段的 URL"，所以参数只收 http(s) 或当目录名解析
let base = process.argv[2];
if (!base) base = `http://127.0.0.1:${PORT_SRV}/`;
if (!/^https?:\/\//.test(base)) base = `http://127.0.0.1:${PORT_SRV}/`;

// Azure 要 key + region 同时到才算装上（只有区域没 Key 等于没装），单独补料
const TEST_KEY = CASE.val;
const EXPECT = PARAM === 'ak' ? 'AZURE-TESTKEY-0123' : TEST_KEY;
const withKey = PARAM === 'ak'
  ? base + '#ak=AZURE-TESTKEY-0123&ar=eastasia'
  : base + '#' + PARAM + '=' + TEST_KEY;

const CHROME = 'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe';
const PORT = 9355;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keylink-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  // 别加 --disable-gpu（会连 swiftshader 一起禁掉，3D 走降级分支）
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--mute-audio',
  // ★ 不能把带片段的 URL 放在命令行：--headless=new 会另开一个 about:blank 目标，
  //   /json/list 排第一的往往不是真页面，求值全落在空白页上 →
  //   表现为"hash 是空的、localStorage 是空的"，看着像功能坏了，其实是探针的锅。
  //   改成启动后自己 Page.navigate。
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch (_) {} try { srv.kill(); } catch (_) {} };
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
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails || {};
    exceptions.push(d.text + ' ' + (d.exception?.description || d.exception?.value || ''));
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params?.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push('[' + m.params.type + '] ' + txt);
  }
  // store.js 的 persist 失败只走 console.warn，不抛异常，
  // Log 域能兜住 Runtime 域漏掉的那些
  if (m.method === 'Log.entryAdded') {
    logs.push('[' + m.params.entry?.level + '] ' + (m.params.entry?.text || ''));
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
const navigate = async (u) => {
  await send('Page.navigate', { url: u });
  await sleep(500);
};

// ⚠️ 必须 enable 这些域，否则 Runtime.consoleAPICalled / exceptionThrown 一条都收不到
//    —— 不开的话探针是"盲测"，失败时完全没有线索（我就这么白跑过一轮）。
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

let pass = 0, fail = 0;
const gate = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}  ${detail}`); }
};

// 真正导航到带片段的地址，并等导航 commit。
// 没 commit 就求值 = 在 about:blank 上求值，读到的全是空，会误判成功能坏了。
await navigate(withKey);
for (let i = 0; i < 80; i++) {
  const h = await evaluate('location.href');
  if (h && h.indexOf(base.replace(/^https?:\/\//, '')) >= 0) break;
  await sleep(500);
}

// 读存档里的字段。localStorage 的 key 见 store.js 的 KEY = 'aiva.companion.v1'
const READ = `(function(){
  try {
    var raw = localStorage.getItem('aiva.companion.v1');
    if (!raw) return { found:false };
    var s = JSON.parse(raw);
    var v = (s.config && s.config.voice) || {};
    // 整包把 voice 带回来：每加一家供应商就要记得改这里一次，太容易漏了
    return {
      found:true, voice: v,
      stt: v.sttProvider || '', apiKey: s.config?.apiKey || ''
    };
  } catch(e) { return { found:false, err: String(e) }; }
})()`;

// ---- ① 存档写入：轮询等 App 起来（模型大，首次十几秒很正常） --------------
// FIELD 就是存档字段名本身，没必要再手工维护一份「参数名 → 短代号」的影射
let s1 = null;
for (let i = 0; i < 60; i++) {
  s1 = await evaluate(READ);
  if (s1 && s1.found && s1.voice?.[CASE.field]) break;
  await sleep(1000);
}
const got1 = s1?.voice?.[CASE.field] || '';
gate(`① #${PARAM}= 的 Key 写进了存档`, got1 === EXPECT, `读到 "${got1}"`);

// ---- ② 地址栏片段被抹掉 ----------------------------------------------------
const hash = await evaluate('location.hash || ""');
gate('② 地址栏片段已清除', hash === '', `hash="${hash}"`);

// ---- ③ STT 供应商被拨过去（ok 是 TTS 那把，不参与切讲究下去） --------------
if (CASE.stt) {
  gate(`③ STT 供应商 = ${CASE.stt}`, s1 && s1.stt === CASE.stt, `stt="${(s1 && s1.stt) || ''}"`);
} else {
  console.log(`SKIP ③ #${PARAM} 不影响 STT 供应商`);
}

// ---- ⑤ 屏幕上有提示 --------------------------------------------------------
const body = await evaluate('document.body.innerText || ""');
gate('⑤ 屏幕上出现「已装好」提示', /已装好/.test(body), body.slice(0, 80).replace(/\n/g, ' | '));

// ---- ④ 刷新后仍在（不带片段） ---------------------------------------------
await navigate(base);
let s2 = null;
for (let i = 0; i < 60; i++) {
  s2 = await evaluate(READ);
  if (s2 && s2.found) break;
  await sleep(1000);
}
gate('④ 刷新后 Key 仍在（真落盘）', !!(s2 && s2.voice?.[CASE.field] === EXPECT), `读到 "${(s2 && s2.voice?.[CASE.field]) || ''}"`);

// ---- ⑥ 没有异常 ------------------------------------------------------------
gate('⑥ 无未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' / '));

// 失败时把现场摊开：光看 PASS/FAIL 没法定位（空 innerText 可能是没起来，
// 也可能是 AsyncStorage 在 web 上换了键名 —— 两者修法完全不同）
if (fail > 0) {
  const lsKeys = await evaluate('Object.keys(localStorage)');
  const htmlLen = await evaluate('document.body.innerHTML.length');
  const txt = await evaluate('(document.body.innerText||"").slice(0,200)');
  console.log('\n--- 诊断 ---');
  console.log('  location.href: ' + await evaluate('location.href'));
  console.log('  localStorage 键: ' + JSON.stringify(lsKeys));
  console.log('  body.innerHTML 长度: ' + htmlLen);
  console.log('  body.innerText: ' + JSON.stringify(txt));
  console.log('  console 末尾 15 条:');
  for (const l of logs.slice(-15)) console.log('    ' + l.slice(0, 160));
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} （PASS=${pass} FAIL=${fail}）===`);
if (logs.length) {
  console.log('--- console 摘录 ---');
  for (const l of logs.filter((x) => /keyLink|store/i.test(x)).slice(0, 10)) console.log('  ' + l);
}
cleanup();
process.exit(fail === 0 ? 0 : 1);
