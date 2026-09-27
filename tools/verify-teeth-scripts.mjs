// 第 34 步：每个「自称牙齿」的脚本，都必须真的验到了东西。
// ---------------------------------------------------------------------------
// 起因：欠账单上那 14 个自认「未验证」的步骤，唯一凭据是「当初做过变异测试」。
//    这正是反复说过的那个形状 —— **「下次记得」不算防线**。
//    当时的证据会过期：脚本后来被人改过、依赖的产物没了、sanity 分支悄悄放行，
//    而登记表只会照旧打出「20 步有常驻牙齿」，一行都不带红的。
//
// 本步不去看每个牙齿脚本**内部**怎么写的（13 个写法各异，靠读代码判不了），
// 而是**挨个真跑一遍**，只看三条对谁都成立的外在事实：
//   ① 它在干净的仓库上跑完是绿的（退出码 0）
//   ② 它**真的验到了东西** —— 输出里必须有场景结论
//   ③ 它跑完工作区**没有变化**（变异改坏了没还原、沙盒没删，都会被抓住）
//   ④ 它跑完**产物目录还在**（dist / dist-localcheck-*。这些目录 match .gitignore，
//      git status 看不见，所以③ 抓不到「某一步把下一步要用的产物删了」——
//      CI #66/#67 连红三轮就是这么白的，详见下面 distDirs() 处的注释）
//
// ② 为什么用「有没有场景结论」这么松的判据（实测数据）：
//    第一次跑的时候 13 个脚本挨个跑过一遍，12 个的输出里都有 PASS / ✅ 之类结论标记；
//    唯一没有的那个，正是**真的什么都没验**的那个 ——
//      test-smoke-runtime-teeth.mjs 在 dist-localcheck-web 不存在时打印
//      「⚠️ 跳过：没有 dist-localcheck-web …」然后 exit(0)。
//    也就是说：「什么都不验还报绿」这件事**真实发生过一次**，
//    而且没有任何一道闸会响 —— 它自己是第 23 步，全套照绿。
//
// ⚠️ 判据里**没有**「不许出现『跳过』二字」这一条。因为「跳过」出现在 4 个脚本
//    里（assertion / inspect-character / lint-ci-refs / smoke-runtime），
//    其中 3 个只是把「跳过」当场景描述写、仍然照常做实验并打印结论。
//    一刀切禁字会误伤这 3 个 —— 那样红的就不是该红的那个。
//
// ⚠️ 不重新实现登记表：牙齿脚本清单**真的 spawn 一次
//    `runtests.mjs --list-steps` 去问**（那个开关就是为本步加的）。
//    这个仓库里「两份逻辑飘开」出现过四次，多一份副本就多一份飘的机会。
//    解析不出来 / 一条都问不到 → 按失败处理，拿不到数就不许判绿。
//
// 用法：node tools/verify-teeth-scripts.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStep } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根目录：命令行给了就用给的（第 35 步的牙齿测试要在沙盒副本上跑它）。
//   ⚠️ 默认不能取 '.' —— 后台任务里 cd 不可用，'.' 解析出来的是工作区根。
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(HERE, '..'));

let bad = 0;
// 失败项留一份，结尾再重述一遍。
//   ⚠️ 为什么必须重述：CI 只保留这一步输出的**末 40 行**（runtests 的 TAIL），
//     而这里一跑就是十几个脚本、几十行 —— 那个唯一的 ✗ 往往在中间，
//     被截掉之后 CI 上只剩「FAIL — 1 项没达标」，**看不出是哪一项**。
//     #66 就是这么白的：日志里能看见「1 项没达标」，看不见那一项。
const failed = [];
const check = (cond, msg) => {
  needBool(cond, 'check()');
  needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) {
    bad++;
    failed.push(msg);
  }
};

// ---- 场景结论标记 ---------------------------------------------------------
// 实测：12/13 个牙齿脚本跑完都会打出 PASS / ✅ 之类；唯一不打的那个正是
// 什么都没验的那个。所以「一个结论标记都没有」=「它没做实验」。
const VERDICT = /PASS|FAIL|✅|❌|✓|✗/;

// ---- 问权威：登记表里哪些步骤自称牙齿 -------------------------------------
async function askRegistry(root) {
  const r = await runStep(['tools/runtests.mjs', root, '--list-steps'], {
    cwd: root,
    timeoutMs: 120000,
  });
  if (r.status !== 0) {
    throw new Error(`问登记表失败（exit=${r.status}）—— 拿不到清单就不许判绿\n${r.stdout}${r.stderr}`);
  }
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue;
    const [name, self, teeth] = line.split('\t');
    if (!name || !/^[\w()+-]+$/.test(name)) continue; // 混进来的登记核对输出之类
    rows.push({ name, self: self || '', teeth: teeth || '' });
  }
  if (rows.length === 0) throw new Error('登记表一行都没解析出来 —— 多半是 --list-steps 的输出格式变了');
  return rows;
}

// 自称牙齿 = ① 步骤名以 -teeth 结尾（它自己就是牙齿脚本）
//          ② 或者某一步声明了 teeth: 指向它
function teethScripts(rows) {
  const set = new Map(); // 路径 -> 为什么算它
  for (const r of rows) {
    if (r.name.endsWith('-teeth') && r.self) set.set(r.self, `步骤「${r.name}」本身就是牙齿脚本`);
    if (r.teeth) set.set(r.teeth, `步骤「${r.name}」声明 teeth 指向它`);
  }
  return [...set.entries()].map(([script, why]) => ({ script, why }));
}

// ⚠️ 2026-09-27：**「未登记例外名单」整块删掉了**。原先这里点名豁免着
//    `tools/test-verify-app-ui-teeth.mjs`（理由：「要本机 Chrome，没登记是有意的」）。
//    那条理由这一轮被验掉了一半 —— Chrome 在 CI 上是有的（smoke-runtime 早就在
//    CI #33 起跑得好好的），于是它被收进套装当第 41 步。
//    留一条**已经登记了**的文件在这份豁免名单上的后果是：**没有任何东西会响** ——
//    原来那条判据只查「文件还在不在」，登记不登记它不管；而判据⑥ 会因为它被名单
//    豁免而不去管它。名单就这样烂在文件里，没人会发现。
//
//    更干净的做法是把这个口子整块删掉：既然它已经登记，`tools/` 下也再没有别的
//    未登记牙齿脚本，下面判据⑦（文件名像牙齿却没登记 → 红）就完整覆盖了这件事，
//    而且**没有逃生通道** —— 这正是第 36 步那次学到的：开了豁免的口子，
//    真违规也能挂个注释混过去。什么时候 tools/ 里再出现一个确实不该登记的牙齿
//    脚本，到时候只能指着它给出理由，而不是现在先留个空口子等着。

function gitStatus(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git status 跑不动（${r.error ? r.error.message : `exit=${r.status}`}）—— 没法判断有没有残留`);
  }
  return r.stdout;
}

// 产物目录清单（dist / dist-localcheck-*）。
//   ★ 为什么 git status 之外还要单独看它：这些目录 **match .gitignore**，
//     被删掉时 `git status --porcelain` 一行都不会变 —— 判据③ 完全瞎。
//     2026-09-27 CI #66/#67 连红三轮就是这个形状：assertion-teeth 里那条
//     bundle 变异用例先删掉 dist-localcheck-web 再打包失败，真产物没了，
//     紧跟其后的 smoke-runtime-teeth 报「找不到可跑的产物」，
//     而每一步的「跑完工作区没变化」全是绿的（git 看不见 dist-*）。
function distDirs(root) {
  try {
    return fs
      .readdirSync(root)
      .filter((d) => d === 'dist' || d.startsWith('dist-localcheck'))
      .filter((d) => {
        try {
          return fs.statSync(path.join(root, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// ---- 开跑 ----------------------------------------------------------------
console.log('【第 34 步】每个自称牙齿的脚本，是不是真的验到了东西');

// 拿不到清单就必须是**一条红的 ✗**，不能是崩掉的异常 ——
//   异常只会让这一步「失败」，看不出是哪一条判据没达标（第 35 步要逐条对得上）。
let rows = null;
try {
  rows = await askRegistry(ROOT);
} catch (e) {
  check(false, `问得到登记表（${e.message.split('\n')[0]}）`);
  console.log(`\n  ===== 没达标的 ${bad} 项（重述，免得被日志截断吃掉）=====`);
  for (const m of failed) console.log(`  ✗ ${m}`);
  console.log(`\n[teeth-scripts] FAIL — ${bad} 项没达标`);
  process.exit(1);
}
const teeth = teethScripts(rows);

check(teeth.length > 0, `从登记表问到了 ${teeth.length} 个牙齿脚本（一条都没有就是解析失败，按失败算）`);

// 文件名像牙齿脚本、却没登记进套装的 —— 它不会被任何人跑，等于没有。
//   ⚠️ 2026-09-27 起**没有豁免名单**：原先放过 test-verify-app-ui-teeth.mjs 的那个口子
//     连同它一起删掉了，理由见上面那段注释 —— 现在 tools/ 下再冒出任何一个未登记的
//     牙齿脚本，这里都会红，没有逃生通道。
const onDisk = fs
  .readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => /^test-.*teeth.*\.mjs$/.test(f))
  .map((f) => `tools/${f}`);
for (const f of onDisk) {
  if (teeth.some((t) => t.script === f)) continue;
  check(false, `tools/ 下有牙齿脚本「${f}」没登记进套装 —— 它不会被任何人跑，等于没有`);
}

// ⚠️ 判据③ 比的是「这个脚本跑之前 vs 之后」。要是**别的进程**（或者你自己）
//    正好在这段时间里改了工作区，那句「多出来的」就会把别人的改动算到被测脚本
//    头上 —— 2026-09-27 实测：我在它跑的中间改了 README 和第 35 步脚本，
//    于是 smoke-runtime-teeth 和 assertion-teeth 各背了一条假阳性，
//    白查半天。基线不干净就先说一句，别让下一个照着假线索走。
const BASE_DIRTY = gitStatus(ROOT).trim();
if (BASE_DIRTY) {
  console.log(`\n  ⚠️ 开跑时工作区**不干净**（${BASE_DIRTY.split('\n').length} 项）——`);
  console.log(`     判据③ 会把这段时间里别人的改动算到被测脚本头上；出现红项先看是不是它。`);
}

// 开跑时先记一份产物目录清单 —— 判据④ 要比的是「有没有消失」。
//   开跑时一个都没有（比如第 35 步的沙盒副本）就整条跳过：那条判据在这种情况下
//   没有可比的基线，硬判只会让沙盒里的场景全部假红。
const DIST_BEFORE = distDirs(ROOT);
if (DIST_BEFORE.length) {
  console.log(`\n  开跑时的产物目录：${DIST_BEFORE.join(' / ')}`);
  console.log(`  （dist-* match .gitignore，git status 看不见它被删 —— 所以下面单独盯一遍）`);
}

let totalMs = 0;
for (const t of teeth) {
  const abs = path.join(ROOT, t.script);
  console.log(`\n  ▸ ${t.script}（${t.why}）`);
  // 每条判据的消息都**带上脚本名**：结尾那份「没达标的 N 项」重述里只有消息本身，
  //   不带名字的话 CI 上只知道「1 项没达标」，不知道是谁 —— #67 就是这么白的。
  const ck = (cond, msg) => check(cond, `${t.script}：${msg}`);
  if (!fs.existsSync(abs)) {
    ck(false, `脚本存在（登记表指向 ${t.script}，但文件不在）`);
    continue;
  }

  const before = gitStatus(ROOT);
  // 超时给到 10 分钟：本机最快的脚本 2s、最慢的 assertion-teeth 48s，
  //   但 CI 的机器明显更慢，给 3 分钟的话「慢」会被误判成「坏」。
  //   整个第 34 步外面还有一层 DEFAULT_TIMEOUT_MS（也是 10 分钟）兜着。
  const r = await runStep([t.script, ROOT], { cwd: ROOT, timeoutMs: 600000 });
  totalMs += r.ms;
  const after = gitStatus(ROOT);
  const out = `${r.stdout}\n${r.stderr}`;

  ck(r.status === 0, `跑完是绿的（exit=${r.status}${r.timedOut ? '，且被掐掉了 —— 超时算失败' : ''}，${Math.round(r.ms / 1000)}s）`);
  ck(
    VERDICT.test(out),
    `输出里有场景结论（一个 PASS/✅ 都没有 = 它多半跳过了、什么都没验 —— 跳过的牙齿等于没牙齿）`
  );
  ck(before === after, `跑完工作区没变化（变异没还原 / 沙盒没删都会在这里响）`);
  if (before !== after) {
    const add = after.split('\n').filter((l) => l && !before.includes(l));
    console.log(`      多出来的：${add.slice(0, 5).join(' ; ')}`);
  }

  if (DIST_BEFORE.length) {
    const now = distDirs(ROOT);
    const gone = DIST_BEFORE.filter((d) => !now.includes(d));
    ck(
      gone.length === 0,
      `跑完产物目录还在（少了：${gone.join('、') || '（没少）'}）`
    );
  }

  // 红了就把**它自己说的话**贴出来：只看「exit=1」没法动手 ——
  //   是脚本崩了、是产物没了、还是断言真的被放宽了，全在它自己的输出里。
  //   #66/#67 两轮都是靠「猜 + 按耗时反推」才定位的，因为日志里没有这一段。
  if (r.status !== 0 || !VERDICT.test(out)) {
    const lines = out.trim().split('\n');
    console.log(`      —— 它自己说（末 ${Math.min(30, lines.length)} 行）——`);
    console.log(lines.slice(-30).map((l) => `      ${l}`).join('\n'));
  }
}

console.log(`\n  牙齿脚本合计跑了 ${Math.round(totalMs / 1000)}s（这一步是**真的**把它们挨个跑了一遍，不是读代码猜的）`);
if (bad) {
  // ↑ 见 failed 那条的注释：CI 只看得到末 40 行，所以红项必须在结尾再打一次。
  console.log(`\n  ===== 没达标的 ${bad} 项（重述一遍，免得被日志截断吃掉）=====`);
  for (const m of failed) console.log(`  ✗ ${m}`);
}
console.log(bad ? `\n[teeth-scripts] FAIL — ${bad} 项没达标` : '\n[teeth-scripts] PASS — 每个自称牙齿的脚本都真的验到了东西，且跑完没留下痕迹');
process.exit(bad ? 1 : 0);
