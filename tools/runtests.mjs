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
import { fileURLToPath } from 'node:url';

// ★ 默认根目录由**脚本自己的位置**推出，别用 '.' —— '.' 解析的是 CWD，
//   而后台任务里 `cd` 不可用（shim 直接 127），CWD 是工作区根，
//   于是 22 步会在错误的目录里找脚本、全部 ERR_MODULE_NOT_FOUND（SKILL 第 74 条）。
//   本脚本在 tools/ 下，所以仓库根是它的上一级。
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
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
// ⚠️ 早先这里写着「只挂本地、没进 CI：Chrome 路径和 swiftshader 依赖本机」——
//    后来**实测推翻**：ubuntu runner 自带 Chrome 153（/usr/bin/google-chrome），
//    软渲染也能跑。先开 continue-on-error 的观察位连绿三轮（#33/#34/#35），
//    确认不飘之后已并进 CI 的 test job。
if (!FAST) STEPS.push(['smoke-runtime', ['tools/smoke-runtime.mjs', '.']]);
// 第 18 步盯的是**验收本身的健康度**：`.github/workflows/*.yml` 里引用的每个文件
// 是否还存在、CI 跑的每一步是否本地套装里也有。
// 存在的理由是一次真事故（CI #29）：合并两套 loader 删掉 ext-resolve.mjs 之后，
// 本地 17 步全绿、build/deploy 也绿，只有 CI test job 红 —— 那三行
// `node --import ./tools/ext-resolve.mjs` 还躺在 workflow 里没改。
// 没人发现的原因：grep 默认跳过隐藏目录，`.github/` 从来没被扫过；
// 而 CI 跑的和本地跑的是两份互不相干的清单。**这一步把两份清单对起来。**
STEPS.push(['lint-ci-refs', ['tools/lint-ci-refs.mjs', '.']]);
// 第 19 步验的是第 18 步**自己有没有牙齿**：在沙盒副本上改一行配置，
// 回头确认 A / B / C 三项真的会变红。
// 它要常驻的理由：第 18 步的规则一旦被放宽（比如为了消误报改了某条正则），
// 最可能发生的事是「拦截能力被顺手改掉，而所有测试照旧全绿」。
// 写在文件注释里的「改完记得重跑牙齿测试」不会主动提醒任何人，
// 那就把它变成自动跑的一步 —— 改坏了这里立刻红。
STEPS.push(['lint-ci-refs-teeth', ['tools/test-lint-ci-refs-teeth.mjs', '.']]);
// 第 20 步验的是第 17 步**自己有没有牙齿**：把产物里的 .glb 全藏起来再跑一次冒烟，
// 确认前四条老断言照绿放行、只有第五条「模型挂上」把得住。
// 常驻的理由和第 19 步一样：断言被放宽时，「所有测试照旧全绿」是最容易出现的
// 假象。写在注释里的「改完记得重跑」不会提醒任何人。
// ⚠️ 它要再 boot 一次 Chrome 并耗满 25 秒轮询，所以放在最后 —— 打包产物留到最后
// 才清理，正好够它用。
STEPS.push(['smoke-runtime-teeth', ['tools/test-smoke-runtime-teeth.mjs', '.']]);
// 第 21 步验的是第 9 步「口型」那两条断言**自己有没有牙齿**：
// 造两处真出过的事故（clock.t 不更新 → 嘴根本不动；stopSpeaking 不真的停 →
// 打断后嘴继续动），回头确认那两条真的会变红。
// 常驻的理由和第 19 / 20 步一样：断言被放宽时「所有测试照旧全绿」是最容易
// 出现的假象。写在注释里的「改完记得重跑」不会提醒任何人。
// ⚠️ 它会临时改 src/three/companion.js 再还原（有 .bak 兜底 + try/finally），
//    放在最后一步，免得改源码的这段时间里别的步骤也在读它。
STEPS.push(['lipsync-teeth', ['tools/test-lipsync-teeth.mjs', '.']]);
// 第 22 步验的是那几条**扫描式检查**（lint-net-calls / lint-styles / lint-imports /
// check-persona-coverage）在「收集环节坏掉」时会响，而不是静默全绿。
// 它们都是「扫到什么就对什么」：`bad` 计数为 0 就报通过 —— 于是源码目录搬走、
// 扩展名改成 .mjs（那两条正则并不匹配 .mjs）、或者角色 id 多了个新前缀
// （`zz-foo` 不在那条正则里 → 这个角色**从来不会被核对**），这些情况统统是绿的。
// 实测旧行为：空目录上打印「扫描 0 个文件」然后退出 0；塞进一个 zz-demo 角色后
// 报「合计 18 个角色，有缺口的 0 个」也是退出 0 —— 静默的假绿，比没有这条检查更糟。
// 常驻的理由和第 19/20/21 步一样：闸门被改松时「所有测试照旧全绿」是最容易出现的假象。
STEPS.push(['zero-scan-teeth', ['tools/test-lint-zero-scan-teeth.mjs', '.']]);

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
// ⚠️ 删目录这件事会**卡住不返回** —— 实测过：19 步全部 PASS 之后进程就是不动了，
//   既有的锈迹目录（dist-final 那批 EBUSY 空壳）和刚被 Chrome 打开过的产物都可能触发。
//   所以这里不直接 rmSync：把它丢给子进程做，并给一个硬上限（10 秒）。
//   超时也不要阻止收工，记一条警告就行 —— 反正这些目录本来就 match .gitignore。
//   一句话：卡在倒数第一步比失败还可恨 —— 既没有红，也没有结论。
function rmTree(rel) {
  const abs = R(rel);
  const script = `require('fs').rmSync(${JSON.stringify(abs)}, { recursive: true, force: true })`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  const gone = !fs.existsSync(abs);
  if (gone) process.stdout.write(`        清理 ${rel}\n`);
  else process.stdout.write(`  ⚠️ 清理 ${rel} 没成（${r.error ? r.error.code || r.error.message : `exit=${r.status}`}）—— 留着，不挡收工\n`);
}

for (const d of fs.readdirSync(ROOT)) {
  if (d.startsWith('dist-localcheck')) rmTree(d);
}

process.stdout.write(`\n${STEPS.length} 步，失败 ${fails} 项\n`);
if (fails) {
  process.stdout.write(rows.filter((x) => !x.ok).map((x) => `  ✗ ${x.name}`).join('\n') + '\n');
}
process.exit(fails ? 1 : 0);
