// 本地一次跑完全套验证 — 与 .github/workflows/deploy-pages.yml 的 test job 同序
// ---------------------------------------------------------------------------
// 为什么要有：
//   CI 的逐步结果要打开网页才看得到，而来回一轮 push 要几分钟。
//   改一行就想确认没弄坏东西的时候，需要的是本地一条命令跑完同一套。
//   顺序刻意和 CI 保持 1:1 —— 两边跑出来的第 N 步必须是同一个东西，
//   否则「CI 红 / 本地绿」时没法直接对号入座。
//
// 用法：node tools/runtests.mjs
//      node tools/runtests.mjs --fast   # 跳过最后一步 Metro 打包（省几十秒）
//
// 坑（都是踩过的）：
//   1) `node --import` 在 Windows 上给绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，
//      所以 loader 必须写成相对于cwd 的 `./tools/...` 并配合下面的 cwd 选项。
//   2) 别用 `&&` 串成一长条：某一步挂了就看不到后面还剩几步没跑。
//      这里逐步跑、逐步打印，最后给总数。
//   3) 失败时把输出的末 40 行打出来 —— 和 CI Summary 的策略一样，
//      省得为了看一行报错再去翻日志。

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(process.argv[2] || '.');
const R = (s) => path.join(ROOT, s);

// [显示名, 参数数组] —— 与 CI 逐步对应
const STEPS = [
  ['check-persona-coverage', ['tools/check-persona-coverage.mjs']],
  ['withTimeout', ['tools/test-with-timeout.mjs']],
  ['auth-timeout', ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs']],
  ['net-timeout', ['--import', './tools/src-resolve.mjs', 'tools/test-net-timeout.mjs']],
  ['nativeSpeech', ['tools/nativeSpeech.test.mjs']],
  ['espeak', ['tools/espeak.test.mjs']],
  ['tts', ['tools/tts.test.mjs']],
  ['songs', ['tools/songs.test.mjs']],
  ['pipeline', ['tools/pipeline.test.mjs']],
  ['rig-semantics', ['--import', './tools/src-resolve.mjs', 'tools/test-rig-semantics.mjs']],
  ['inspect-character', ['tools/inspect-character.mjs']],
  ['realistic-pipeline', ['tools/test-realistic-pipeline.mjs']],
  ['lint-imports', ['tools/lint-imports.mjs', '.']],
  ['lint-styles', ['tools/lint-styles.mjs', '.']],
  // 盯「对外请求有没有走 netFetch」——同一个漏兜底的 bug 已经在
  // auth / database / STT / TTS / llm / web / region 六处出现过，
  // 光靠"下次记得"守不住，必须在 CI 上跑
  ['lint-net-calls', ['tools/lint-net-calls.mjs']],
];

// CI 里真正对照的是两个 job：test（上面 15 步）和 build（导出 Web 静态包）。
// 早期缺了这第 16 步，于是出现过「本地 15 步全绿 → CI build job 炸」
// （就是 tools/verify-bundle.mjs 顶部记的那次）。**测试全绿不等于能打包**，
// 所以默认带上；确实赶时间可以加 --fast 跳过，但别让跳过变成常态。
//
// 第 16 步现在打**两个平台**（web + ios）：CI 只导 web，而同一入口在原生是
// 830 个模块、web 只有 546 —— 差的那批只有打原生才会走到，缺了成员实现
// （如 Avatar3D.native.js）时 web 照样全绿。
const FAST = process.argv.includes('--fast');
if (!FAST) STEPS.push(['bundle(web+ios)', ['tools/verify-bundle.mjs', '.', '--keep']]);
// 第 17 步接管第 16 步之上的那一层：「能打包」不等于「能跑起来」。
// 白屏、boot 抛异常、ErrorBoundary 把错吞掉 —— 这些打包全都发现不了，
// 只有真在浏览器里 boot 一遍才看得见。实测证明它有牙齿的是这一条：
// 塞一句 throw 进去，页面照样挂载成功、照样进得了 Home，但异常计数是 1 ——
// 只看「走到 Home」会放行，加了「无未捕获异常」才拦得住。
// ⚠️ 只挂本地、没进 CI：Chrome 路径和 swiftshader 软渲染依赖本机。
if (!FAST) STEPS.push(['smoke-runtime', ['tools/smoke-runtime.mjs', '.']]);
// 第 18 步盯的是**验收本身的健康度**：`.github/workflows/*.yml` 里引用的每个文件
// 是否还存在、CI 跑的每一步是否本地套装里也有。
// 存在的理由是一次真事故（CI #29）：合并两套 loader 删掉 ext-resolve.mjs 之后，
// 本地 17 步全绿、build/deploy 也绿，只有 CI test job 红 —— 那三行
// `node --import ./tools/ext-resolve.mjs` 还躺在 workflow 里没改。
// 没人发现的原因：grep 默认跳过隐藏目录，`.github/` 从来没被扫过；
// 而 CI 跑的和本地跑的是两份互不相干的清单。**这一步把两份清单对起来。**
STEPS.push(['lint-ci-refs', ['tools/lint-ci-refs.mjs', '.']]);

const TAIL = 40;
let fails = 0;
const rows = [];

for (const [name, args] of STEPS) {
  const script = args[0].startsWith('--import') ? null : args[0];
  if (script && !fs.existsSync(R(script))) {
    rows.push({ name, ok: false, out: `找不到脚本：${R(script)}` });
    fails += 1;
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
  const ok = r.status === 0;
  if (!ok) fails += 1;
  rows.push({ name, ok, out, ms: Date.now() - t0 });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${Date.now() - t0}ms)`}\n`);
  if (!ok) {
    const lines = out.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - TAIL)).join('\n');
    process.stdout.write(`${tail.split('\n').map((l) => `        ${l}`).join('\n')}\n\n`);
  }
}

// 打包产物是第 16 步用 --keep 留下的（第 17 步要拿它跑），用完由这里统一清掉，
// 免得每跑一轮就在磁盘上堆几十 MB —— 这些目录都 match .gitignore 里的 dist-*/,
// 不进 git，但会占地方，也可能让人误以为是正品 dist。
// 按前缀扫而不是写死两个名字 —— 早期版本产出过不带平台后缀的 dist-localcheck/，
// 写死的话那种残留永远清不掉（git 又看不见它，最后就只能手工删带 EBUSY 的目录）。
for (const d of fs.readdirSync(ROOT)) {
  if (d.startsWith('dist-localcheck')) fs.rmSync(R(d), { recursive: true, force: true });
}

process.stdout.write(`\n${STEPS.length} 步，失败 ${fails} 项\n`);
if (fails) {
  process.stdout.write(rows.filter((x) => !x.ok).map((x) => `  ✗ ${x.name}`).join('\n') + '\n');
}
process.exit(fails ? 1 : 0);
