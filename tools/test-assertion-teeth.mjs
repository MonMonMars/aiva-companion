// 第 29 步：给四个「只靠 why」的断言型步骤配牙齿。
// ---------------------------------------------------------------------------
// 起因：第 28 步把「每步的牙齿在哪」变成显式登记之后，屏幕上多了一份欠账单
//   —— 28 步里 19 步只靠 `why`，其中 9 步是真的没有常驻牙齿。
//   而我在那些 `why` 里写的是「它断言的是真实行为，断言写坏会红」，旁边老实
//   标了「未验证」。**未验证的断言不算数**（这条纪律在这里已经应验过很多次），
//   所以本步就是去把它们证掉 —— 方法还是变异：改坏它测的东西，看它红不红。
//
// 审计结果（三个判断里两个被证伪，一个坐实了洞）：
//   tts         清空 EMOTIONS      → 13 项 ✗   ✅ 我的判断是对的，它真的有牙齿
//   nativeSpeech 清空 NATIVE_EMOTION → 5 项 ✗  ✅ 同上
//   songs       清空 SONG_LIST      → 「曲库 0 首」，WAV 那批实质判据**整批被跳过**，
//                                     靠 matchSong 抛 TypeError 才退出非 0 ❌ 洞
//   espeak      粤语码改回 yue      → 应红（这是它存在的理由：防 yue→zhy 回归）
//
// 洞已补（tools/songs.test.mjs 加了 0 条闸门，并把崩溃改成一条 ✗）。
// 本步把「补完之后仍然红」钉住，免得有人为了让测试变绿又把那条闸门删掉。
//
// ── 第二批（同日下午）：欠账单上剩下的五个「非牙齿」步骤 ──────────────────
//   ⚠️ 2026-09-26 当晚订正过一次数字。这里原先写「12 个变异、11 杀 1 存活」，
//      那是把**排查阶段的临时探针**一起算进去的（探针没登记成常驻场景，
//      事后既对不上代码、也没法复现）。如实描述应该是：
//
//        登记在 CASES 里的：第一批 4 条 + 第二批 9 条 = **13 条**，
//        实测 **13 条全部被杀死**（每条都是 exit 1 且报错点名），**0 条存活**。
//
//   排查阶段（未登记的探针）里存活过的四条，其中三条各自挖出一个洞。
//   洞已补，本步把「补完之后仍然红」钉住：
//
//   withTimeout  上限乘 3（450ms）      → 原本**全绿** ❌ 洞
//                  原断言的耗时窗口是 [140,900)，6 倍宽。补了一条不看墙钟的断言：
//                  直接盯排进计时器的毫秒数。
//   rig-semantics 拿掉 out 对 fwd 的正交化 → 原本**全绿** ❌ 盲区
//                  两棵合成骨架的 z 全是 0 ⇒ out·fwd 恒为 0，正交化是空操作。
//                  补了一棵手臂往身前伸的骨架。
//   rig-semantics 允许连着播同一个姿势  → 原本**全绿** ❌ 碰运气的断言
//                  18 个姿势随机抽七八次，撞上同一个的概率本来就不高。
//                  已把那一段的 Math.random 钉成常数，变成确定性问题。
//   net-timeout  退化成只发 signal     → ✅ 红（正是「装聋平台」那组存在的理由）
//   bundle       引用不存在的模块      → ✅ 红（web 5.2s / ios 3.0s 就失败）
//
//   唯一仍然存活的一条 —— ⚠️ 它是**排查时的临时探针，没有登记成常驻场景**
//   （所以不在下面的 CASES 里，也拿不到证据复现），如实记在这里，不用补：
//   withTimeout  拿掉 `guard.catch(() => {})` → 绿，而且**绿是对的**：
//                  race 一建立，guard 就有人接了；那条 catch 只在「race 建立之前
//                  就同步抛错」时才用得上，而 `Promise.resolve(source)` 不会抛。
//                  它是纵深防御，不是当前路径上的判据 —— 硬要它红反而是造假。
//
// ⚠️ 本步会**临时改真实源文件**再还原。这是第 21 步（lipsync-teeth）用过的做法，
//    三重保险：① 内存里留原文 ② 每个场景 try/finally 还原 ③ 收工前比对 sha256，
//    不一致就还原并大声报错。**清理不干净比测试失败更糟** —— 它会把仓库弄脏，
//    而脏的源文件会让后面每一步的结论都不可信。
//
// 场景表（🟢 要求绿 / 🔴 要求红）：
//   ⓐ 对照组：每个被测步骤原样都要 exit 0 且无 ✗（同一条命令只跑一次） 🟢
//   ⓑ songs 清空曲库        → 红，要点名「曲库非空」、不许 TypeError  🔴
//   ⓒ tts 清空情绪表        → 红，且有 ✗                             🔴
//   ⓓ nativeSpeech 清空映射 → 红，且有 ✗                             🔴
//   ⓔ espeak 粤语码改回 yue → 红，且要点名 zh-hk                     🔴
//   ● 第二批九条（withTimeout ×2 / auth-timeout ×2 / net-timeout ×2 /
//     rig-semantics ×2 / bundle ×1）→ 各自要求红 + 点名              🔴
//   ● 第三批三条（auth-timeout-ms / dbCall-ms / net-timeout-ms）——
//     按第二批那两个洞的**形状**回头全仓库扫出来的同类病，详见 CASES 上方。🔴
//   ⓕ 变异必须真的改到了东西（否则"绿"没被验过）                     🟢
//   ⓖ 收工前九个源文件必须与原文**逐字节一致**                        🟢
//
// ⚠️ 不在注释里写「一共几条」—— 那个数字脱离代码之后没有任何检查会响
//    （2026-09-26 刚栽过一次：注释写 12/11/1，实际 13/13/0）。
//    想知道有多少条，看本脚本**收尾打印的那一行**（它是从 CASES 数出来的）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runStep, rmTreeBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const R = (rel) => path.join(ROOT, rel);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()'); needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ★ 判「有没有失败」只认**行首两空格 + ✗**。
//   第一版写的是裸 `/✗/.test(out)`，结果命中了说明文字里我自己写的那个 ✗
//   （「曲库为空时这里也必须是一条 ✗，不是崩溃」被打印在一条 **✓** 行上）——
//   于是「原样没有 ✗」这条断言凭空变红。这跟第 25 步踩过的「/全部通过/ 命中了
//   正在解释为什么不算通过的报错文案本身」是同一类：**判据宽到能命中说明文字**。
const FAILED_LINE = /^ {2}✗/m;
const hasFail = (out) => FAILED_LINE.test(out);

/** 把 `export const NAME = [` / `{` 起到同缩进的 `];` / `};` 止，整体换成 `[]` / `{}` */
function emptyBlock(src, declLine, open, close) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.includes(declLine));
  if (i < 0) throw new Error('找不到声明行：' + declLine);
  const start = lines[i];
  const indent = /^(\s*)/.exec(start)[1];
  const name = /const (\w+)/.exec(start)[1];
  if (start.trim().endsWith(open + ';')) {
    return start.replace(open + ';', open + close + ';');
  }
  let j;
  for (j = i + 1; j < lines.length; j++) if (lines[j] === indent + close + ';') break;
  if (j >= lines.length) throw new Error('找不到闭合行：' + declLine);
  lines.splice(i, j - i + 1, `${indent}export const ${name} = ${open}${close};`);
  return lines.join('\n');
}

/** 改一次；改不到就抛错 —— 「本该改到的地方没改到」必须响，否则等于没验 */
function repOnce(s, from, to) {
  if (!s.includes(from)) throw new Error('找不到锚点：' + from.slice(0, 60));
  return s.replace(from, to);
}

// 被测步骤 + 各自的变异。变异**必须是真实可能发生的事故**，不是随便改坏：
//   前四条  = 第一批（2026-09-26 上午）：songs / tts / nativeSpeech / espeak
//   后九条  = 第二批（同日下午）：withTimeout / auth-timeout / net-timeout /
//            rig-semantics / bundle —— 欠账单上剩下的五个「非牙齿」步骤
const CASES = [
  {
    id: 'songs',
    label: 'songs（清空曲库）',
    step: ['tools/songs.test.mjs'],
    file: 'src/services/songs.js',
    mutate: (s) => s.replace('export const SONG_LIST = Object.keys(SONGS);', 'export const SONG_LIST = [];'),
    mustSay: ['曲库非空'],
    mustNotSay: ['TypeError'], // 必须是断言在拦，不是崩溃在拦
    note: '靠崩溃才红是 fragile 的：哪天给 matchSong 加个空表兜底，静默全绿就回来了',
  },
  {
    id: 'tts',
    label: 'tts（清空情绪表）',
    step: ['tools/tts.test.mjs'],
    file: 'src/voice/tts.js',
    mutate: (s) => emptyBlock(s, 'export const EMOTIONS = [', '[', ']'),
    mustFail: true,
  },
  {
    id: 'nativeSpeech',
    label: 'nativeSpeech（清空情绪映射）',
    step: ['tools/nativeSpeech.test.mjs'],
    file: 'src/voice/nativeEmotion.js',
    mutate: (s) => emptyBlock(s, 'export const NATIVE_EMOTION = {', '{', '}'),
    mustFail: true,
  },
  {
    id: 'espeak',
    label: 'espeak（粤语嗓音码改回 yue）',
    step: ['tools/espeak.test.mjs'],
    file: 'src/voice/espeak.js',
    mutate: (s) => s.replace("'zh-hk': 'zhy',", "'zh-hk': 'yue',"),
    mustSay: ['zh-hk'],
    note: '这就是它存在的理由：eSpeak-ng 里粤语嗓音是 zhy 不是 yue，写错会静默回落英文',
  },

  // ───────────────────────────────────────────────────────────────────────
  // 第二批：欠账单上剩下的五个「非牙齿」步骤
  // ───────────────────────────────────────────────────────────────────────
  {
    id: 'withTimeout',
    label: 'withTimeout（超时上限被悄悄放大 3 倍）',
    step: ['tools/test-with-timeout.mjs'],
    file: 'src/lib/withTimeout.js',
    mutate: (s) => repOnce(s, '}, ms);', '}, ms * 3);'),
    mustSay: ['150ms'],
    note: '★ 这一条抓到过一个洞：原断言的耗时窗口是 [140,900)，对 150ms 来说是 6 倍宽，'
      + '上限乘 3（450ms）整套照旧全绿。补的断言不看墙钟，直接盯排进计时器的毫秒数',
  },
  {
    id: 'withTimeout-2',
    label: 'withTimeout（不再包 Promise.resolve，thenable 会同步抛）',
    step: ['tools/test-with-timeout.mjs'],
    file: 'src/lib/withTimeout.js',
    mutate: (s) => repOnce(s, 'const p = Promise.resolve(source);', 'const p = source;'),
    mustSay: ['同步抛错'],
  },
  {
    id: 'auth-timeout',
    label: 'auth-timeout（归一出来的 kind 写成 network）',
    // ⚠️ 别漏了 loader：cloudClient.js 里 `import ... from './withTimeout'` 没带扩展名，
    //    Node 的 ESM 不做扩展名推断。漏了它，这一步红的是 ERR_MODULE_NOT_FOUND
    //    —— 那不是真事故，是**我在造一个假的红**（第一版就写漏了，当场四条断言变红）。
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs'],
    file: 'src/lib/cloudClient.js',
    mutate: (s) => repOnce(s, "return { data: null, error: { kind: 'timeout', message: String(e?.message || e) } };", "return { data: null, error: { kind: 'network', message: String(e?.message || e) } };"),
    mustFail: true,
  },
  {
    id: 'auth-timeout-2',
    label: 'auth-timeout（dbCall 超时后不 abort，后台继续占着连接）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs'],
    file: 'src/lib/cloudClient.js',
    mutate: (s) => repOnce(s, "'db-timeout', () => ac.abort());", "'db-timeout');"),
    mustSay: ['abort'],
  },
  {
    id: 'net-timeout',
    label: 'net-timeout（退化成「只发 signal、不做 race」）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-net-timeout.mjs'],
    file: 'src/lib/netFetch.js',
    mutate: (s) => repOnce(s, `return await withTimeout(
      fetch(url, { ...init, signal: ac.signal }),
      ms,
      NET_TIMEOUT_CODE,
      () => ac.abort() // 我们已经不等了，别让它继续占着连接（弱网正是要防的场景）
    );`, `setTimeout(() => ac.abort(), ms);
    return await fetch(url, { ...init, signal: ac.signal });`),
    mustSay: ['出口'],
    note: 'netFetch.js 顶部点名过的退化：只发 signal 时 node/浏览器的 fetch 都认，'
      + '上面每一组照样绿，只有「平台装聋」那一组会挂 —— 那组就是为它而写的',
  },
  {
    id: 'net-timeout-2',
    label: 'net-timeout（一律按秒取整，80ms 会说成「等了 0 秒」）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-net-timeout.mjs'],
    file: 'src/lib/netFetch.js',
    mutate: (s) => repOnce(s, 'const wait = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`;', 'const wait = `${Math.round(ms / 1000)} 秒`;'),
    mustSay: ['毫秒'],
  },
  {
    id: 'rig-semantics',
    label: 'rig-semantics（拿掉 out 对 fwd 的正交化 —— 102° 残差那次事故）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-rig-semantics.mjs'],
    file: 'src/anim/semAxes.js',
    mutate: (s) => repOnce(s, 'out.addScaledVector(fwd, -out.dot(fwd));', ''),
    mustFail: true,
    note: '★ 这一条抓到一个盲区：原测试两棵合成骨架的 z 全是 0，于是 out·fwd 恒等于 0，'
      + '正交化是空操作，删掉整行照样全绿。补了一棵手臂往身前伸的骨架',
  },
  {
    id: 'rig-semantics-2',
    label: 'rig-semantics（允许连着播同一个姿势）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-rig-semantics.mjs'],
    file: 'src/anim/poseScheduler.js',
    mutate: (s) => repOnce(s, 'const fresh = all.filter((p) => p.id !== lastId);', 'const fresh = all;'),
    mustSay: ['同一个姿势'],
    note: '★ 这一条抓到一条**碰运气**的断言：18 个姿势随机抽七八次，连着抽中同一个的'
      + '概率本来就不高 —— 去重拿掉它也照样绿。已把 Math.random 钉成常数',
  },
  // ───────────────────────────────────────────────────────────────────────
  // 第三批（同日晚些）：按上面那两个洞的**形状**回头全仓库扫一遍，
  // 结果发现 auth-timeout / net-timeout 有同一道病。
  //
  //   那三句的耗时窗口是 [75,2000) / [110,2000)，而传进去的上限是
  //   80 / 120ms —— **16~25 倍宽**。变异实测（6 个：authCall / dbCall / netFetch
  //   各 ×2 ×5）：
  //     ×2   → 三处**全部整套全绿**（exit 0、0 条 ✗）
  //     ×5   → authCall / netFetch 虽然红了，但红的是别处那两条自捡
  //            （等 200ms / cap 3000ms）—— 核心那句「确实等到了上限才放弃」
  //            **一次都没吭声**；dbCall 最彻底，×5 也全绿。
  //   所以「(exit非0) 会红吗」的答案是会，但**红错了地方** —— 这跟
  //   「判据宽到能命中说明文字」是同一类：判据没对准真正要看的那件事。
  // 修法跟 withTimeout 那次一样：补一条不看墙钟的判据（用记录器盯
  // 排进计时器的毫秒数）。下面三条就是把「补完之后仍然红」钉住。
  // ───────────────────────────────────────────────────────────────────────
  {
    id: 'auth-timeout-ms',
    label: 'auth-timeout（authCall 的上限被改写：80ms → 160ms）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs'],
    file: 'src/lib/cloudClient.js',
    mutate: (s) => repOnce(s, "return await withTimeout(fn(), ms, 'auth-timeout');", "return await withTimeout(fn(), ms * 2, 'auth-timeout');"),
    mustSay: ['authCall 排进计时器'],
    note: '★ 原断言的耗时窗口是 [75,2000)，对 80ms 是 25 倍宽 —— 这一条原本整套全绿',
  },
  {
    id: 'dbCall-ms',
    label: 'auth-timeout（dbCall 的上限被改写：120ms → 240ms）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs'],
    file: 'src/lib/cloudClient.js',
    mutate: (s) => repOnce(s, "return await withTimeout(fn(ac.signal), ms, 'db-timeout', () => ac.abort());", "return await withTimeout(fn(ac.signal), ms * 2, 'db-timeout', () => ac.abort());"),
    mustSay: ['dbCall 排进计时器'],
    note: '★ 三处里最松的一处：连 ×5 都曾经整套全绿（exit 0、0 条 ✗）',
  },
  {
    id: 'net-timeout-ms',
    label: 'net-timeout（netFetch 的上限被改写：80ms → 160ms）',
    step: ['--import', './tools/src-resolve.mjs', 'tools/test-net-timeout.mjs'],
    file: 'src/lib/netFetch.js',
    mutate: (s) => repOnce(s, `    return await withTimeout(
      fetch(url, { ...init, signal: ac.signal }),
      ms,`, `    return await withTimeout(
      fetch(url, { ...init, signal: ac.signal }),
      ms * 2,`),
    mustSay: ['netFetch 排进计时器'],
    note: '★ 同 authCall：原窗口 [75,2000) 对 80ms 有 25 倍宽，×2 原本整套全绿',
  },
  {
    id: 'bundle',
    label: 'bundle（引用一个不存在的模块 —— CI #25 那次事故的形状）',
    // ⚠️ 只验 web 那一半：ios 要 21 秒，而这里是**常驻**检查，不值得每次都付。
    //    两边共用同一条 Metro 解析链，web 会红的那一族 ios 也会红。
    //
    // ⚠️⚠️ `--out` **不能省**（2026-09-27 CI #66/#67 连红三轮查出来的）：
    //    verify-bundle 打包前会**无条件先删输出目录**，而本用例的变异注定打包失败 ——
    //    于是目录被删掉、又建不回来。用默认目录就等于把第 17 步 --keep 留给
    //    第 18 步冒烟的真产物抹掉，紧跟其后的第 34 步（它要挨个真跑所有牙齿脚本）
    //    就会在 smoke-runtime-teeth 上「找不到可跑的产物」而红。
    //    只在 CI 上暴露：本地另有一份 dist/ 能兜底，CI 上只有 dist-localcheck-web。
    //    指到独立前缀之后，这里怎么删都碰不到真产物。
    //
    //    `--keep` 也不能省：不带它时 verify-bundle 收尾会 `fs.rmSync(...)`，
    //    而在这台机器上删那种目录会**挂住不返回**（第 27 步补的有上限清理器写在
    //    runtests 那一层，脚本自己这行没人兜）。实测：不带 --keep 时对照组跑到
    //    180 秒硬上限被杀 —— 打包其实 3.1 秒就成功了，卡的是清理。
    step: ['tools/verify-bundle.mjs', '.', '--platform', 'web', '--keep', '--out', 'dist-localcheck-assertteeth'],
    file: 'src/lib/netFetch.js',
    mutate: (s) => s + "\nimport './__mutation_missing.js';\n",
    mustSay: ['打包失败'],
    // ⚠️ 不写 mustFail：verify-bundle 的失败行是 `✗ [web] 打包失败`，
    //    ✗ 在**行首**（没有那两个缩进空格），本文件的 `hasFail` 认的是 `/^ {2}✗/m`，
    //    认不到它。判据要跟被判对象的实际输出对齐，别想当然。
    note: '它跑的是真的 expo export（不是"扫到几个文件"）；坏掉的导出 5 秒内就会红',
  },
];

// 先把四个文件的原文记下来 —— 收工前要逐字节比对
const ORIGINAL = new Map();
for (const c of CASES) {
  if (!fs.existsSync(R(c.file))) { console.log(`✗ 找不到 ${c.file}`); process.exit(1); }
  ORIGINAL.set(c.file, fs.readFileSync(R(c.file), 'utf8'));
}

async function runStepScript(args) {
  return runStep(args, { cwd: ROOT, timeoutMs: 180000 });
}

try {
  /* ⓐ 对照组：原样都必须绿（同一条命令只跑一次 —— 有的步骤挂了两条变异） */
  console.log('ⓐ 对照组：每个被测步骤原样都要 exit 0 且没有 ✗');
  const controlDone = new Set();
  for (const c of CASES) {
    const key = c.step.join(' ');
    if (controlDone.has(key)) continue;
    controlDone.add(key);
    const r = await runStepScript(c.step);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status === 0, `${c.id} 原样通过（exit ${r.status}${r.timedOut ? '，超时' : ''}）`);
    check(!hasFail(out), `${c.id} 原样没有失败行`);
    if (r.status !== 0) console.log(out.split('\n').slice(-8).map((l) => `        ${l}`).join('\n'));
  }

  /* ⓑ~ⓔ 变异：改坏它测的东西，它必须红 */
  for (const c of CASES) {
    console.log(`\n● ${c.id} — ${c.label}`);
    const abs = R(c.file);
    const orig = ORIGINAL.get(c.file);
    let mutated;
    try {
      mutated = c.mutate(orig);
    } catch (e) {
      check(false, `变异构造失败：${e.message}`);
      continue;
    }
    check(mutated !== orig, 'ⓕ 变异真的改到了东西（否则这一轮等于没验）');
    if (mutated === orig) continue;

    fs.writeFileSync(abs, mutated, 'utf8');
    let r;
    try {
      r = await runStepScript(c.step);
    } finally {
      fs.writeFileSync(abs, orig, 'utf8');
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status !== 0, `${c.id} 看见这条事故要红（exit ${r.status}${r.timedOut ? '，超时' : ''}）`);
    if (c.mustFail) check(hasFail(out), '要有失败行 —— 靠崩溃退出不算（那说明闸门本身没在拦）');
    for (const s of c.mustSay || []) check(out.includes(s), `报错要包含「${s}」`);
    for (const s of c.mustNotSay || []) check(!out.includes(s), `不该出现「${s}」—— ${c.note || '那说明是别的原因在拦'}`);
    if (r.status === 0) console.log(out.split('\n').slice(-8).map((l) => `        ${l}`).join('\n'));
    check(sha(fs.readFileSync(abs, 'utf8')) === sha(orig), `${c.id} 跑完立刻还原了源文件`);
  }
} finally {
  /* ⓖ 收工核验：源文件必须与原文逐字节一致（几个文件也是数出来的） */
  console.log(`\nⓖ 收工核验：${ORIGINAL.size} 个源文件必须与原文逐字节一致`);
  for (const [rel, orig] of ORIGINAL) {
    let now = '';
    try { now = fs.readFileSync(R(rel), 'utf8'); } catch { /* 读不到就当不一致 */ }
    const same = sha(now) === sha(orig);
    if (!same) {
      try { fs.writeFileSync(R(rel), orig, 'utf8'); } catch { /* 尽力 */ }
      console.log(`  ⚠️ ${rel} 被改动过，已还原 —— 若还原失败请 \`git checkout -- ${rel}\``);
    }
    check(same, `${rel} 与原文一致（${sha(orig)}）`);
  }
  // songs 那一步会在 tools/ 下留个临时副本，崩了就不会自己删
  const tmp = R('tools/.tmp-songs.mjs');
  if (fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); console.log('  清理遗留的 tools/.tmp-songs.mjs'); } catch { /* 不挡结论 */ }
  }
}

// ★★ 下面的数字全部**从 CASES 数出来**，不写在注释里、也不写死在这行里 ——
//    写死的数字会跟代码脱节，而且没有任何检查会响（2026-09-26 栽过一次）。
const STEP_COUNT = new Set(CASES.map((c) => c.step.join(' '))).size;
console.log(bad
  ? `\n[assertion-teeth] FAIL — ${bad} 项没达标`
  : `\n[assertion-teeth] PASS — ${STEP_COUNT} 个被测步骤的 ${CASES.length} 个变异看见真事故都会红，`
    + `原样照旧绿，${ORIGINAL.size} 个源文件已逐字节还原`);
process.exit(bad ? 1 : 0);
