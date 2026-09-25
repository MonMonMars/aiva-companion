// 运行时冒烟：把打包好的 Web 版在 headless Chrome 里真的跑起来
// ---------------------------------------------------------------------------
// 它补齐的是 verify-bundle.mjs 之上那一层：
//   「打包过了」只保证模块能解析；「能跑起来」是另一回事 —— 白屏、初始化抛异常、
//   ErrorBoundary 把上千行的错吞成一句提示，这些打包全都发现不了。
//
// 所以这里核的是**数得出来的东西**，不是截图：
//   1) React 有没有真的挂载（#root 的子节点数）
//   2) 有没有未捕获异常（Runtime.exceptionThrown 的条数）
//   3) 有没有 console error（ErrorBoundary 会把异常吞掉，只看页面看不出来）
//   4) 能不能从标题页走到 Home（3D 场景句柄 __aivaDebug 是否出现）
//   5) 模型真的挂上了没有（hasRig）—— 第 4 条只证明组件挂载，证明不了 GLB 加载成功
//
// ⚠️ 诚实的边界：
//   - 早先写着「只在本地跑、CI 上没加」，后来**实测推翻了**：ubuntu runner 自带
//     Chrome（/usr/bin/google-chrome → Google Chrome 153），swiftshader 软渲染也能跑
//     （CI #33/#34/#35 三轮观察，都绿，partCount 53 / hasRig true 与本地一致）。
//     观察位原本挂着 continue-on-error，确认不飘之后已经并进 test job ——
//     收进去之后它才被 lint-ci-refs 的 A/B/C 三项覆盖，两边清单才算真对上。
//   - 它证明「boot 成功、能进主界面、模型在」，证明不了交互全对
//     （那是 cdp-* 那批专项探针的事）。
//
// 用法：node tools/smoke-runtime.mjs [项目根] [--dir dist-localcheck-web]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(process.argv[2] || '.');
const argv = process.argv.slice(3);
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null;

// 优先用刚打出来的那份；没有就退回 npm run export:web 的 dist
const CANDIDATES = [dirArg, 'dist-localcheck-web', 'dist'].filter(Boolean);
const DIST = CANDIDATES.map((d) => path.resolve(ROOT, d)).find((d) => {
  try {
    return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'index.html'));
  } catch {
    return false;
  }
});

if (!DIST) {
  console.log('✗ 找不到可跑的产物，试过：\n  ' + CANDIDATES.join('\n  ') + '\n  先跑 npm run export:web');
  process.exit(1);
}

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('✗ 找不到 Chrome。设置 CHROME_PATH 指向本机 chrome.exe 后再跑。');
  process.exit(1);
}

const PORT = 4899;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.gz': 'application/gzip', '.br': 'application/brotli',
};

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end('404');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(f)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(process.env.TEMP || '/tmp', `smoke-${Date.now()}`);

// ⚠️ 千万别图省事写 stdio:'ignore'（CI #41 上真吃到了这个亏）：
//    那样 Chrome 启动失败时它自己打印的原因会被整个丢掉，只剩一句
//    "连不上 Chrome" —— 一句说了等于没说的诊断比没有诊断更费事
//    （排查时只能靠猜：是没装库？是沙箱？是端口被占？）。
//    所以这里把 stdout/stderr 都接住（设个上限，别把内存吃爆）。
const chromeLog = [];
const keep = (b) => { if (chromeLog.length < 400) chromeLog.push(String(b)); };
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`,
  '--window-size=900,900', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stdout.on('data', keep);
chrome.stderr.on('data', keep);
let chromeGone = null;      // Chrome 自己退了？记下 code / signal
chrome.on('exit', (code, signal) => { chromeGone = { code, signal }; });
let chromeSpawnErr = null;  // 连可执行文件都没起来（ENOENT 之类）
chrome.on('error', (e) => { chromeSpawnErr = e; });

let ws;
try {
  let page = null;
  let lastErr = '（一次都没请求过）';
  // ⚠️ 这个上限原来是我随手写的 40×400ms = 16 秒，CI #41 就栽在它上面：
  //    那次 bundle 结束到 smoke-runtime 报错隔了 **16.115 秒**（日志时间戳量的），
  //    差 0.1 秒 = 循环把 16 秒**空等满了**，而 chromeGone 为空（Chrome 没退），
  //    于是只能断成「进程活着、但调试端口 16 秒内没开」—— 启动慢，不是崩了。
  //    同一段代码在 #42 上 13.3 秒就整步跑完。**会随机变红的闸门比没有闸门更糟**：
  //    它教会所有人「红了就重跑一次」。所以上限放宽到 60 秒，并且把实际等了多久
  //    打出来 —— 以后每次运行都留一个数，下次再飘不用靠猜。
  const MAX_TRIES = 150;              // 150 × 400ms = 60 秒
  const t0 = Date.now();
  let tries = 0;
  for (let i = 0; i < MAX_TRIES && !page; i++) {
    await sleep(400);
    tries = i + 1;
    // Chrome 已经自己退了就别把 60 秒空等满 —— 早点进诊断分支，早拿到原因。
    // spawn 失败（可执行文件不存在 / 没权限）同理：连进程都没起来，等也没用。
    if (chromeGone || chromeSpawnErr) break;
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
      page = l.find((t) => t.type === 'page');
    } catch (e) {
      lastErr = `${e?.name || 'Error'}: ${e?.message || e}`;
    }
  }
  const waited = ((Date.now() - t0) / 1000).toFixed(1);
  if (page) {
    // 起得慢本身就是要留的证据：这次慢，下次可能就是那 0.1 秒之差。
    console.log(`[smoke-runtime] Chrome 调试端口 ${waited}s 后打开（轮询 ${tries} 次）`);
    if (Date.now() - t0 > 10000) {
      console.log(`[smoke-runtime] ⚠️ Chrome 起得慢（${waited}s）—— 这类抖动会让这一步随机变红，留意`);
    }
  }
  if (!page) {
    // 把**现场**一并打出来：下次再遇到，光看这一屏就能定位，不用再猜
    throw new Error([
      '连不上 Chrome',
      `  可执行文件  ：${CHROME}`,
      `  调试端口    ：${PORT + 1}（静态服务器在 ${PORT}）`,
      `  用户数据目录：${profile}`,
      `  已经等了    ：${waited}s（上限 ${(MAX_TRIES * 400) / 1000}s，轮询 ${tries} 次）`,
      `  最后一次请求：${lastErr}`,
      `  spawn 错误  ：${chromeSpawnErr ? chromeSpawnErr.message : '无'}`,
      // ⚠️ 别在 spawn 已经失败的情况下还写「仍在运行」—— 那句会让人以为 Chrome
      //    起来了、只是端口没开，往完全相反的方向查（实测打印过一次，差点被骗）。
      `  进程状态    ：${chromeSpawnErr
        ? '没起来（spawn 就失败了，等也没用）'
        : chromeGone
          ? `已退出 code=${chromeGone.code} signal=${chromeGone.signal ?? '无'}`
          : '仍在运行，但调试端口一直没开'}`,
      '  ---- Chrome 的 stdout+stderr（末 40 行）----',
      ...chromeLog.join('').split('\n').slice(-40).map((l) => '  ' + l),
    ].join('\n'));
  }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pend = new Map();
  const exceptions = [];
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    }
  });

  const send = (m, p) => new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  /** 注意 returnByValue —— 少了它拿回来的是 RemoteObject 而不是值 */
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const findBtn = (pred) => ev(`(()=>{
    let best=null;
    document.querySelectorAll('[role="button"],button,[tabindex]').forEach(e=>{
      if(best) return;
      const r=e.getBoundingClientRect();
      if(r.width<40||r.height<24) return;
      if(r.bottom<0||r.top>innerHeight) return;
      const t=(e.textContent||'').trim();
      if(!(${pred})) return;
      best={x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), t:t.slice(0,30)};
    });
    return best;
  })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  // ⚠️ 下面三段轮询的**上限全是手写的**（30×700ms / 12 轮 / 25×1000ms），
  //    而「等 Chrome 那个 16 秒上限」就是因为没量过常态、被 runner 一抖捅穿的
  //    （CI #41）。同一个坑不踩第二次：三段都记下实际耗时，并写进末尾那句总结，
  //    这样以后每次运行白留三个数，哪个余量薄了一眼看得出来。
  // ---- 断言 1：React 有没有真的挂载（挂载失败 = 白屏，#root 一个子节点都没有）----
  const tMount0 = Date.now();
  let nodes = 0;
  for (let i = 0; i < 30; i++) {
    nodes = Number(await ev("(document.getElementById('root')||{children:[]}).children.length")) || 0;
    if (nodes > 0) break;
    await sleep(700);
  }
  const tMount = ((Date.now() - tMount0) / 1000).toFixed(1);

  // ---- 断言 4：标题页 → 角色选择 → Home ----
  // 每一屏的停留都给足时间（软渲染 + 首包解析，实测要十几秒）
  const tHome0 = Date.now();
  let reachedHome = false;
  for (let round = 0; round < 12 && !reachedHome; round++) {
    if (await ev('!!(globalThis.__aivaDebug)')) {
      reachedHome = true;
      break;
    }
    const card = await findBtn(`/小柔/.test(t) && r.width>400 && r.height>100`);
    if (card) {
      await clickAt(card.x, card.y);
      await sleep(700);
      const cta = await findBtn(`/(开始相处|继续这段关系|换成)/.test(t) && r.height<90`);
      if (cta) await clickAt(cta.x, cta.y);
      await sleep(1800);
      continue;
    }
    const enter = await findBtn(`/(开始|进入|开启)/.test(t) && r.height<90`);
    if (enter) {
      await clickAt(enter.x, enter.y);
      await sleep(1800);
      continue;
    }
    await sleep(1200);
  }
  const tHome = ((Date.now() - tHome0) / 1000).toFixed(1);

  // ---- 断言 5：模型真的挂上了 ----------------------------------------------
  // 为什么必须有它：把产物里所有 .glb 改名藏起来重跑一遍，前四条**全部照绿** ——
  //   网络 404 不走 Runtime.consoleAPICalled，所以「console error」也是 0；
  //   __aivaDebug 只代表 Avatar3D.web **组件挂载了**，不代表 GLB 加载成功。
  //   实测对照（同一套断言）：
  //     .glb 都在 → {"partCount":53,"hasRig":true,"hasFace":true}
  //     .glb 藏起 → {"partCount":0,"hasRig":false,"hasFace":false}   前四条依然全绿
  //   所以"能走到 Home"和"Home 里真的有个人"是两件事，这条是唯一能分开它们的。
  //
  // ⚠️ 这几个在 __aivaDebug 上都是**函数**，不调用就拿到函数本身，
  //    returnByValue 会把它序列化成 `{}` —— 打出来看着像"部件数为 0"，
  //    其实什么都没测（真被这行骗过一次：白追了两轮去查 CI 上 GLB 有没有加载）。
  //    要值，就在页面里先调用再返回。
  const MODEL_EXPR = `(() => {
    const d = globalThis.__aivaDebug;
    if (!d) return null;
    const call = (f) => { try { return typeof f === 'function' ? f() : null; } catch (e) { return 'ERR:' + e.message; } };
    return { partCount: call(d.partCount), hasRig: call(d.hasRig), hasFace: call(d.hasFace) };
  })()`;

  // ⚠️ 必须轮询等，不能读一次就下结论：__aivaDebug 挂上来只说明组件挂载完成，
  //    几 MB 的 GLB 还在解析/绑定（软渲染下更慢）。读早了拿到 0 就是假红 ——
  //    一个会随机变红的闸门比没有闸门更糟。给足 25 秒，等不到才算真没挂上。
  const tModel0 = Date.now();
  let model = null;
  for (let i = 0; i < 25; i++) {
    model = await ev(MODEL_EXPR);
    if (model && model.hasRig === true) break;
    await sleep(1000);
  }
  const tModel = ((Date.now() - tModel0) / 1000).toFixed(1);
  // 失败时走的是「末 40 行」整段，所以单独打一行（含上限，好对照余量）；
  // 成功时靠末尾那句总结 —— 那边只留 6 行，塞不进别处。
  const TIMING = `端口 ${waited}s｜挂载 ${tMount}s/21s｜Home ${tHome}s｜模型 ${tModel}s/25s`;

  console.log(`产物目录：${path.relative(ROOT, DIST)}`);
  console.log(`各段耗时：${TIMING}`);
  console.log(`root 子节点数：${nodes}`);
  console.log(`未捕获异常：${exceptions.length}`);
  console.log(`console error：${errors.length}`);
  console.log(`进入 Home：${reachedHome ? '是' : '否'}   模型：${JSON.stringify(model)}`);
  for (const e of exceptions.slice(0, 5)) console.log(`  [EXC] ${String(e).slice(0, 200)}`);
  for (const e of errors.slice(0, 5)) console.log(`  [err] ${e}`);

  const checks = [
    [nodes > 0, 'React 挂载'],
    [exceptions.length === 0, '无未捕获异常'],
    [errors.length === 0, '无 console error'],
    [reachedHome, '能走到 Home'],
    // 只认 hasRig，不认 partCount：部件数随版本变（现在 53），拿它当闸门迟早误报；
    // hasRig 才是"模型真的加载并绑定成功"这件事本身。partCount 只打出来作旁证。
    [model?.hasRig === true, '模型挂上'],
  ];
  const bad = checks.filter(([ok]) => !ok);

  ws.close();
  chrome.kill();
  srv.close();

  if (bad.length) {
    console.log(`\n[smoke-runtime] FAIL — ${bad.map(([, n]) => n).join('、')} 没过`);
    process.exit(1);
  }
  // ⚠️ 等待秒数**必须写进这一行**，不能只打在开头：CI 的 run() 成功时只 tail 末 6 行，
  //    开头那句会被整段切掉 —— #44 上实测被切，白等一轮 CI 才发现。
  //    而这个数恰恰只在**成功**时才值得看（失败时有末 40 行全文）。
  const slow = Number(waited) > 10 || Number(tModel) > 10;
  console.log(`\n[smoke-runtime] PASS — ${checks.map(([, n]) => n).join('、')}（${TIMING}${slow ? ' ⚠️偏慢' : ''}）`);
} catch (err) {
  console.log(`\n[smoke-runtime] FAIL — 探针自身出错：${err?.message || err}`);
  ws?.close();
  chrome.kill();
  srv.close();
  process.exit(1);
}
