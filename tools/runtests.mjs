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
  ['auth-timeout', ['--import', './tools/ext-resolve.mjs', 'tools/test-auth-timeout.mjs']],
  ['net-timeout', ['--import', './tools/ext-resolve.mjs', 'tools/test-net-timeout.mjs']],
  ['nativeSpeech', ['tools/nativeSpeech.test.mjs']],
  ['espeak', ['tools/espeak.test.mjs']],
  ['tts', ['tools/tts.test.mjs']],
  ['songs', ['tools/songs.test.mjs']],
  ['pipeline', ['tools/pipeline.test.mjs']],
  ['rig-semantics', ['--import', './tools/ext-resolve.mjs', 'tools/test-rig-semantics.mjs']],
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
if (!FAST) STEPS.push(['bundle(web+ios)', ['tools/verify-bundle.mjs', '.']]);

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

process.stdout.write(`\n${STEPS.length} 步，失败 ${fails} 项\n`);
if (fails) {
  process.stdout.write(rows.filter((x) => !x.ok).map((x) => `  ✗ ${x.name}`).join('\n') + '\n');
}
process.exit(fails ? 1 : 0);
