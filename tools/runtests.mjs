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

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { runStep, DEFAULT_TIMEOUT_MS } from './step-runner.mjs';
import { makeRegistry } from './step-registry.mjs';

const ARGV = process.argv.slice(2);
// --check-registry：只做「每步有没有登记牙齿」的核对就退出，不真跑那 28 步。
//   存在的理由完全是第 28 步的牙齿测试：它要在沙盒副本上把登记改坏，
//   再确认这里**真的拒绝开跑**。没有这个开关，牙齿测试要么得跑完整套（几分钟），
//   要么只能验纯函数、验不到「整套拒绝开跑」这个行为本身。
const CHECK_ONLY = ARGV.includes('--check-registry');
const FAST = ARGV.includes('--fast');

// ★ 默认根目录由**脚本自己的位置**推出，别用 '.' —— '.' 解析的是 CWD，
//   而后台任务里 `cd` 不可用（shim 直接 127），CWD 是工作区根，
//   于是 22 步会在错误的目录里找脚本、全部 ERR_MODULE_NOT_FOUND（SKILL 第 74 条）。
//   本脚本在 tools/ 下，所以仓库根是它的上一级。
//   （根目录取**第一个不是开关**的参数：加了 --check-registry 之后不能再写死 argv[2]，
//    否则 `node runtests.mjs --check-registry` 会把 --check-registry 当成根目录。）
const rootArg = ARGV.find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const R = (s) => path.join(ROOT, s);

// [显示名, 参数数组] —— 与 CI 逐步对应
//
// ★★ 每一步都必须**登记**（第三个参数，见 tools/step-registry.mjs）：
//    teeth / guardedBy / why 三选一。漏一个，整套测试**拒绝开跑**。
//    这就是「将来再加第 30 步时，谁来提醒它『你还没配牙齿』」的答案 ——
//    不是靠我记得，是靠它跑不起来。
//    这里不厌其烦地把理由写出来，是因为**理由本身也是信息**：
//    下面那份「只靠理由、没有常驻牙齿」的清单，就是这个仓库现在的真实欠账。
const REG = makeRegistry();
const STEPS = REG.steps;
const DECL = REG.decl;

REG.push('check-persona-coverage', ['tools/check-persona-coverage.mjs'], {
  guardedBy: ['zero-scan-teeth', 'lint-rules-teeth', 'persona-coverage-teeth'],
});
// 下面三条原先只写 `why`（「断言写坏会红，未验证」）。2026-09-26 用变异证掉了：
//   withTimeout  上限乘 3 → **原本全绿**（耗时窗口 [140,900) 有 6 倍宽）❌ 洞，已补
//                不看墙钟的新断言：直接盯排进计时器的毫秒数
//   auth-timeout kind 写错 / 不 abort → 红 ✅
//   net-timeout  退化成只发 signal / 按秒取整 → 红 ✅
REG.push('withTimeout', ['tools/test-with-timeout.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('auth-timeout', ['--import', './tools/src-resolve.mjs', 'tools/test-auth-timeout.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('net-timeout', ['--import', './tools/src-resolve.mjs', 'tools/test-net-timeout.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('nativeSpeech', ['tools/nativeSpeech.test.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('espeak', ['tools/espeak.test.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('tts', ['tools/tts.test.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('songs', ['tools/songs.test.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('pipeline', ['tools/pipeline.test.mjs'], {
  // 只覆盖它里面的**口型**那两条断言 —— 其余部分仍是没有牙齿的
  guardedBy: ['lipsync-teeth'],
});
// 原先只写 `why`。2026-09-26 用变异证掉了，而且**两条都挖出过洞**：
//   拿掉 out 对 fwd 的正交化 → 原本**全绿**（两棵骨架的 z 全是 0，正交化是空操作）
//   允许连着播同一个姿势   → 原本**全绿**（那条断言在 18 个姿势里随机抽，靠碰运气）
// 洞已补（另搭一棵手臂往身前伸的骨架 + 把那一段的 Math.random 钉成常数）。
REG.push('rig-semantics', ['--import', './tools/src-resolve.mjs', 'tools/test-rig-semantics.mjs'], {
  guardedBy: ['assertion-teeth'],
});
REG.push('inspect-character', ['tools/inspect-character.mjs'], {
  teeth: 'tools/test-inspect-character-teeth.mjs',
});
REG.push('realistic-pipeline', ['tools/test-realistic-pipeline.mjs'], {
  teeth: 'tools/test-realistic-pipeline-teeth.mjs',
});
REG.push('lint-imports', ['tools/lint-imports.mjs', '.'], {
  guardedBy: ['zero-scan-teeth', 'lint-rules-teeth'],
});
REG.push('lint-styles', ['tools/lint-styles.mjs', '.'], {
  guardedBy: ['zero-scan-teeth', 'lint-rules-teeth'],
});
// 盯「对外请求有没有走 netFetch」——同一个漏兜底的 bug 已经在
// auth / database / STT / TTS / llm / web / region 六处出现过，
// 光靠"下次记得"守不住，必须在 CI 上跑
REG.push('lint-net-calls', ['tools/lint-net-calls.mjs'], {
  guardedBy: ['zero-scan-teeth', 'lint-rules-teeth'],
});

// CI 里真正对照的是两个 job：test（上面 15 步）和 build（导出 Web 静态包）。
// 早期缺了这第 16 步，于是出现过「本地 15 步全绿 → CI build job 炸」
// （就是 tools/verify-bundle.mjs 顶部记的那次）。**测试全绿不等于能打包**，
// 所以默认带上；确实赶时间可以加 --fast 跳过，但别让跳过变成常态。
//
// 第 16 步现在打**两个平台**（web + ios）：CI 只导 web，而同一入口在原生是
// 830 个模块、web 只有 546 —— 差的那批只有打原生才会走到，缺了成员实现
// （如 Avatar3D.native.js）时 web 照样全绿。
// 原先那条 `why` 里写着「从没造过『导出其实坏了它却放行』的场景」。
// 2026-09-26 造出来了：往 src/lib/netFetch.js 里插一行
// `import './__mutation_missing.js';`（正是脚本顶部记的那次 CI #25 的形状），
// web 5.2 秒 / ios 3.0 秒双双失败、退出码 1 且报错点名 —— 它确实有牙齿。
// 第 29 步把这一条变成常驻（只验 web 那一半，ios 要 21 秒，不值得每次都付）。
if (!FAST) REG.push('bundle(web+ios)', ['tools/verify-bundle.mjs', '.', '--keep'], {
  guardedBy: ['assertion-teeth'],
});
// 第 17 步接管第 16 步之上的那一层：「能打包」不等于「能跑起来」。
// 白屏、boot 抛异常、ErrorBoundary 把错吞掉 —— 这些打包全都发现不了，
// 只有真在浏览器里 boot 一遍才看得见。实测证明它有牙齿的是这一条：
// 塞一句 throw 进去，页面照样挂载成功、照样进得了 Home，但异常计数是 1 ——
// 只看「走到 Home」会放行，加了「无未捕获异常」才拦得住。
// ⚠️ 早先这里写着「只挂本地、没进 CI：Chrome 路径和 swiftshader 依赖本机」——
//    后来**实测推翻**：ubuntu runner 自带 Chrome 153（/usr/bin/google-chrome），
//    软渲染也能跑。先开 continue-on-error 的观察位连绿三轮（#33/#34/#35），
//    确认不飘之后已并进 CI 的 test job。
if (!FAST) REG.push('smoke-runtime', ['tools/smoke-runtime.mjs', '.'], {
  teeth: 'tools/test-smoke-runtime-teeth.mjs',
});
// 第 18 步盯的是**验收本身的健康度**：`.github/workflows/*.yml` 里引用的每个文件
// 是否还存在、CI 跑的每一步是否本地套装里也有。
// 存在的理由是一次真事故（CI #29）：合并两套 loader 删掉 ext-resolve.mjs 之后，
// 本地 17 步全绿、build/deploy 也绿，只有 CI test job 红 —— 那三行
// `node --import ./tools/ext-resolve.mjs` 还躺在 workflow 里没改。
// 没人发现的原因：grep 默认跳过隐藏目录，`.github/` 从来没被扫过；
// 而 CI 跑的和本地跑的是两份互不相干的清单。**这一步把两份清单对起来。**
REG.push('lint-ci-refs', ['tools/lint-ci-refs.mjs', '.'], {
  teeth: 'tools/test-lint-ci-refs-teeth.mjs',
});
// 第 19 步验的是第 18 步**自己有没有牙齿**：在沙盒副本上改一行配置，
// 回头确认 A / B / C 三项真的会变红。
// 它要常驻的理由：第 18 步的规则一旦被放宽（比如为了消误报改了某条正则），
// 最可能发生的事是「拦截能力被顺手改掉，而所有测试照旧全绿」。
// 写在文件注释里的「改完记得重跑牙齿测试」不会主动提醒任何人，
// 那就把它变成自动跑的一步 —— 改坏了这里立刻红。
REG.push('lint-ci-refs-teeth', ['tools/test-lint-ci-refs-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。这一层**连变异测试都没做过**：生效时只验了「改坏 workflow 它会红」，没验过「把它自己改坏它还红不红」。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 20 步验的是第 17 步**自己有没有牙齿**：把产物里的 .glb 全藏起来再跑一次冒烟，
// 确认前四条老断言照绿放行、只有第五条「模型挂上」把得住。
// 常驻的理由和第 19 步一样：断言被放宽时，「所有测试照旧全绿」是最容易出现的
// 假象。写在注释里的「改完记得重跑」不会提醒任何人。
// ⚠️ 它要再 boot 一次 Chrome 并耗满 25 秒轮询，所以放在最后 —— 打包产物留到最后
// 才清理，正好够它用。
REG.push('smoke-runtime-teeth', ['tools/test-smoke-runtime-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：第 17 步里塞一句 throw，只有第五条「模型挂上」拦得住 —— 那次实测过。但那是当时的证据，没有常驻检查保证它以后还拦得住。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 21 步验的是第 9 步「口型」那两条断言**自己有没有牙齿**：
// 造两处真出过的事故（clock.t 不更新 → 嘴根本不动；stopSpeaking 不真的停 →
// 打断后嘴继续动），回头确认那两条真的会变红。
// 常驻的理由和第 19 / 20 步一样：断言被放宽时「所有测试照旧全绿」是最容易
// 出现的假象。写在注释里的「改完记得重跑」不会提醒任何人。
// ⚠️ 它会临时改 src/three/companion.js 再还原（有 .bak 兜底 + try/finally），
//    放在最后一步，免得改源码的这段时间里别的步骤也在读它。
REG.push('lipsync-teeth', ['tools/test-lipsync-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：造过 clock.t 不更新 / stopSpeaking 不停两处事故，那两条确实会红。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 22 步验的是那几条**扫描式检查**（lint-net-calls / lint-styles / lint-imports /
// check-persona-coverage）在「收集环节坏掉」时会响，而不是静默全绿。
// 它们都是「扫到什么就对什么」：`bad` 计数为 0 就报通过 —— 于是源码目录搬走、
// 扩展名改成 .mjs（那两条正则并不匹配 .mjs）、或者角色 id 多了个新前缀
// （`zz-foo` 不在那条正则里 → 这个角色**从来不会被核对**），这些情况统统是绿的。
// 实测旧行为：空目录上打印「扫描 0 个文件」然后退出 0；塞进一个 zz-demo 角色后
// 报「合计 18 个角色，有缺口的 0 个」也是退出 0 —— 静默的假绿，比没有这条检查更糟。
// 常驻的理由和第 19/20/21 步一样：闸门被改松时「所有测试照旧全绿」是最容易出现的假象。
REG.push('zero-scan-teeth', ['tools/test-lint-zero-scan-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：扫空目录、改成 .mjs 扩展名、塞 zz- 前缀角色，旧行为确实静默全绿。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 23 步验的是那三条 lint（lint-net-calls / lint-imports / lint-styles）
// **规则本身**还拦不拦得住东西 —— 和第 22 步是一对：
//   第 22 步验「收集环节坏掉会响」（扫不到东西时别静默绿），
//   第 23 步验「看见真违规会红」（沙盒里造一处真违规，并要求它红）。
// 每条都配一个**正确写法**的对照组要求它绿 —— 少了对照组，"它红了"说明不了
// 任何事：一个无脑报错的检查也能通过只验红的那半边。
// 自己的牙齿也验过（变异测试）：把三条规则分别改成不生效，这里立刻红。
REG.push('lint-rules-teeth', ['tools/test-lint-rules-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：三条规则分别被改成不生效，这一步立刻红（变异测试）。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 24 步轮到 check-persona-coverage（本地第 1 步）**规则本身**的牙齿。
// 前面两步的顺序是这样补下来的：
//   第 22 步 —— 收集环节坏掉会响（扫不到东西时别静默绿）；
//   第 23 步 —— 那三条 lint 看见真违规会红、看见正确写法会绿；
//   第 24 步 —— 角色核对那张报表里每一项（tagline / bgId 指向存在的背景 /
//                idlePose 指向 tag:'idle' 的姿势 / 签名姿势不许重复 / 自检不许假通过）
//                **缺一项就得有一个 ✗**。
// 同样每个场景配对照组（原样必须绿），同样跑过变异测试：把这五条分别改成不生效，
// 这一步立刻红。没有它，谁把 `row.tagline` 改成恒 true，报表照样「有缺口 0 个」。
REG.push('persona-coverage-teeth', ['tools/test-persona-coverage-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：五条规则分别被改成不生效，这一步立刻红（变异测试）。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 25 步来自一次**真发现**：tools/inspect-character.mjs（本地第 11 步）算完
// `fails` 打印一句「N 项未通过。」就结束了 —— 没有 process.exit。于是无论体检出
// 什么都不可能变红。实测三个假的绿：模型目录空的说「全部通过」、指定不存在的角色
// 先打 ✗ 再说「全部通过」、体检出 N 项不合格退出 0。第 69 条「打印了 ≠ 拦住了」
// 一点没夸张。现在它有三道闸（0 项 / 目录不在 / fails>0），本步就是盯这三道的。
// 造坏模型的方式是**改模型本身**（把 GLB 顶点 Y 压到 0.4 倍），不是把合格门槛改严。
REG.push('inspect-character-teeth', ['tools/test-inspect-character-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：三道闸分别拿掉，这一步立刻红（变异测试，4 个场景全杀）。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 26 步是同一族的第二个：tools/test-realistic-pipeline.mjs（本地第 12 步）
// 遍历同一批 GLB 打分。它原本就有退出码（process.exitCode），缺的是「一个都没验到」
// 那道 0 条闸门 —— 已补。注意这条牙齿**慢**：它要在 Node 里用真 GLTFLoader 解析 GLB，
// 一个场景几十秒；所以脚本内部每次调用都带了 60 秒 timeout，挂住算失败。
REG.push('realistic-pipeline-teeth', ['tools/test-realistic-pipeline-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：四个场景的变异测试全杀。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 27 步盯的不是某个脚本，而是**这套东西自己**：每一步的硬上限。
// 起因是 2026-09-26 那次 —— 全套跑到第 19 步挂住，一挂 4 小时 17 分，
// 日志停在「PASS lint-ci-refs」之后再无输出。当时每一步都是不带 timeout 的
// spawnSync，所以「挂住」既不像失败也不像成功，就是**永远没有结论**。
// 根因（fs.rmSync 卡在 Windows 的删除上）没能锁定，也不需要锁定：
// 能确定的是「一步挂住 → 整套没有结论」，而这一步把那个洞补上。
// 它同时要求：正常通过的一步仍要 exit 0、正常失败的一步退出码不能被抹平、
// 掐完之后进程**树**要真的死（孙进程留着会继续占文件句柄 —— 最可疑的那次就是句柄）。
REG.push('step-timeout-teeth', ['tools/test-step-timeout-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）：没人能给「牙齿的牙齿的牙齿」再配一层常驻检查。有**当时的**证据：五个场景的变异测试全杀（含「只标记不真杀」这种）。但那是当时的证据。它被改松之后的表现就是「全绿」，而全绿不会有人来看；未验证',
});
// 第 28 步盯的是**这道登记闸自己**：上面每一步的「牙齿在哪」这一栏，
// 漏填 / 乱填 / 敷衍，是不是真的会让整套测试拒绝开跑。
// 起因就是我上一轮结尾自己提出的那个问题：
//   「将来再加第 28、29 步时，谁来提醒它『你还没配牙齿』？」
// 之前每一条牙齿都是**我补完一条闸之后自己想起来**才去配的 —— 那是「下次记得」，
// 而「下次记得」不算防线。这一步把提醒变成机器的事：加第 30 步的人会当场撞上
// 「没有登记 —— 加这一步的人必须写明它的牙齿在哪」，不需要谁记得。
// 它自己的牙齿（变异测试）见 tools/test-step-registry-teeth.mjs 顶部的场景表。
REG.push('step-registry-teeth', ['tools/test-step-registry-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止（再往上就是无限递归）。本轮做过变异测试（8 个场景全杀，见脚本顶部），但那是当时的证据，没有常驻的再上一层；未验证',
});
// 第 29 步盯的是**欠账单上那 9 个「只靠 why」的步骤里的一批**（nativeSpeech /
// espeak / tts / songs）。起因是第 28 步把那份欠账单摆到屏幕上之后，我得承认
// 那 9 条 `why` 里写的「它断言的是真实行为，断言写坏会红」是**我自己没验过的判断**。
// 本步用变异把它们证掉 —— 结果三个判断里**两个被证伪**：
//   tts 清空情绪表 → 13 项 ✗；nativeSpeech 清空映射 → 5 项 ✗（这两条我的判断是对的）；
//   songs 清空曲库 → 打一行「曲库 0 首」，WAV 那批实质判据**整批被跳过**，
//     靠 matchSong 抛 TypeError 才退出非 0 —— **洞，已补 0 条闸门**。
// 「靠崩溃才红」是 fragile 的：哪天有人给 matchSong 加个空表兜底（很常见的
// "健壮性"改法），静默全绿立刻就回来了。所以本步额外要求 songs 的失败必须是
// 一条 ✗，输出里**不许出现 TypeError**。
// 它自己的牙齿（变异测试）见 README：7 个变异体，含「把刚补的那条闸门还原掉」。
REG.push('assertion-teeth', ['tools/test-assertion-teeth.mjs', '.'], {
  why: '它自己是牙齿脚本 —— 牙齿的牙齿到此为止。本轮做过变异测试（7 个全杀），但那是当时的证据，没有常驻的再上一层；未验证',
});

// ---------------------------------------------------------------------------
// ★ 开跑前先核对登记。有一步没交代清楚它的牙齿在哪，**整套拒绝开跑**。
//
// 为什么是"拒绝开跑"而不是"打个警告继续"：警告会被淹没在 28 行的 PASS 里，
// 而这条信息恰好是**唯一一条写给未来那个加步骤的人看的**。他加完第 29 步跑一遍，
// 立刻撞上，当场就得补 —— 推迟到"以后再说"，就等于没有。
//
// 打印出来的那份「只靠理由、没有常驻牙齿」的清单，**不是噪音，是欠账单**：
// 它把这个仓库现在的真实状态摆在每次跑测试的屏幕上。想让它变短，
// 唯一的办法是去给那些步骤配牙齿，而不是把这一栏删掉。
// ---------------------------------------------------------------------------
const REG_CHECK = REG.verify(ROOT);
{
  const { problems, unverified, covered, total } = REG_CHECK;
  process.stdout.write(`\n【登记核对】共 ${total} 步：${covered.length} 步有常驻牙齿，${total - covered.length} 步只靠理由\n`);
  if (unverified.length) {
    process.stdout.write(`  ⚠️ 其中 ${unverified.length} 步自认「未验证」（只是我的判断，没有证据）：${unverified.join(' / ')}\n`);
  }
  if (problems.length) {
    process.stdout.write(`\n  ✗ 登记有 ${problems.length} 项问题 —— 整套测试**拒绝开跑**：\n`);
    for (const p of problems) process.stdout.write(`      ✗ ${p}\n`);
    process.stdout.write(`\n  每一步都必须写明 teeth（它的牙齿脚本）/ guardedBy（已有谁的牙齿在盯它）/ why（为什么不需要）。\n`);
    process.stdout.write(`  三选一，写在 tools/runtests.mjs 里那一步的第三个参数上。见 tools/step-registry.mjs。\n\n`);
    process.exit(1);
  }
  process.stdout.write(`  ✓ 登记齐全 —— 开跑\n\n`);
}
if (CHECK_ONLY) process.exit(0);

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
  // ★ 每一步都带硬上限 —— 详见 tools/step-runner.mjs 顶部的注释。
  //   2026-09-26 实测：第 19 步卡在 Node 自己的 fs.rmSync 上，整套挂了 4 小时 17 分，
  //   日志停在「PASS lint-ci-refs」之后再无输出。**挂住既不是成功也不是失败，
  //   是永远没有结论** —— 这里把它变成一种看得见的失败（TIMEOUT）。
  const r = await runStep(args, { cwd: ROOT, timeoutMs: DEFAULT_TIMEOUT_MS });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
  const ok = r.status === 0 && !r.timedOut;
  if (!ok) fails += 1;
  rows.push({ name, ok, out, ms: Date.now() - t0, timedOut: r.timedOut });
  const tag = ok ? 'PASS' : r.timedOut ? 'TIMEOUT' : 'FAIL';
  process.stdout.write(`${tag}  ${name}${ok ? '' : `  (${Date.now() - t0}ms)`}\n`);
  if (r.timedOut) {
    process.stdout.write(`        超过 ${DEFAULT_TIMEOUT_MS}ms 没有结束，已按失败处理（进程树已杀）\n`);
    process.stdout.write(`        ⚠️ 超时 ≠ 通过，也 ≠ 「这次不算」：这一步的结论是「不知道」，必须有人来看\n`);
  }
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
// 顺手把这里也换成同一个执行器：原来用的是 spawnSync + timeout，而那个 timeout
// 只让父进程放弃等待，**子进程还在**（它正卡在删除里）。现在超时会连进程树一起杀。
async function rmTree(rel) {
  const abs = R(rel);
  const script = `require('fs').rmSync(${JSON.stringify(abs)}, { recursive: true, force: true })`;
  const r = await runStep(['-e', script], { cwd: ROOT, timeoutMs: 15000 });
  const gone = !fs.existsSync(abs);
  if (gone) process.stdout.write(`        清理 ${rel}\n`);
  else {
    const why = r.timedOut ? '清理自己挂住了（进程已杀）' : r.error || `exit=${r.status}`;
    process.stdout.write(`  ⚠️ 清理 ${rel} 没成（${why}）—— 留着，不挡收工\n`);
  }
}

for (const d of fs.readdirSync(ROOT)) {
  if (d.startsWith('dist-localcheck')) await rmTree(d);
}

process.stdout.write(`\n${STEPS.length} 步，失败 ${fails} 项\n`);
if (fails) {
  process.stdout.write(rows.filter((x) => !x.ok).map((x) => `  ✗ ${x.name}`).join('\n') + '\n');
}
process.exit(fails ? 1 : 0);
