// 第 34 步：每个「自称牙齿」的脚本，都必须真的验到了东西。
// ---------------------------------------------------------------------------
// 起因：欠账单上那 13 个自认「未验证」的步骤，唯一凭据是「当初做过变异测试」。
//    这正是反复说过的那个形状 —— **「下次记得」不算防线**。
//    当时的证据会过期：脚本后来被人改过、依赖的产物没了、sanity 分支悄悄放行，
//    而登记表只会照旧打出「20 步有常驻牙齿」，一行都不带红的。
//
// 本步不去看每个牙齿脚本**内部**怎么写的（13 个写法各异，靠读代码判不了），
// 而是**挨个真跑一遍**，只看三条对谁都成立的外在事实：
//   ① 它在干净的仓库上跑完是绿的（退出码 0）
//   ② 它**真的验到了东西** —— 输出里必须有场景结论
//   ③ 它跑完工作区**没有变化**（变异改坏了没还原、沙盒没删，都会被抓住）
//
// ② 为什么用「有没有场景结论」这么松的判据（实测数据）：
//    13 个脚本挨个跑过一遍，12 个的输出里都有 PASS / ✅ 之类结论标记；
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
const check = (cond, msg) => {
  needBool(cond, 'check()');
  needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
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

// 文件名像牙齿脚本、却没登记进套装的 —— 它不会被任何人跑，等于没有。
// 已知的例外要**点名**写在这里（写在下面就每跑必打印，跑不掉）：
//   改了名 / 删了文件，这条会立刻红（下面会反过来查「名单里的文件还在不在」）。
const KNOWN_UNREGISTERED = [
  {
    file: 'tools/test-verify-app-ui-teeth.mjs',
    why: '它要本机 Chrome + 重新打一次包 + 临时改一次 src；没登记是**有意**的，等定夺后才进 CI',
  },
];

function gitStatus(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git status 跑不动（${r.error ? r.error.message : `exit=${r.status}`}）—— 没法判断有没有残留`);
  }
  return r.stdout;
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
  console.log(bad ? `\n[teeth-scripts] FAIL — ${bad} 项没达标` : '');
  process.exit(1);
}
const teeth = teethScripts(rows);

check(teeth.length > 0, `从登记表问到了 ${teeth.length} 个牙齿脚本（一条都没有就是解析失败，按失败算）`);

for (const k of KNOWN_UNREGISTERED) {
  check(
    fs.existsSync(path.join(ROOT, k.file)),
    `未登记例外「${k.file}」还在原位（不在了说明这条例外已经过期，删掉它）`
  );
}
if (KNOWN_UNREGISTERED.length) {
  console.log(`  ⚠️ ${KNOWN_UNREGISTERED.length} 个牙齿脚本**故意**没登记（不会被任何人跑）：`);
  for (const k of KNOWN_UNREGISTERED) console.log(`      ${k.file} —— ${k.why}`);
}

const known = new Set(KNOWN_UNREGISTERED.map((k) => k.file));
const onDisk = fs
  .readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => /^test-.*teeth.*\.mjs$/.test(f))
  .map((f) => `tools/${f}`);
for (const f of onDisk) {
  if (teeth.some((t) => t.script === f)) continue;
  if (known.has(f)) continue;
  check(false, `tools/ 下有牙齿脚本「${f}」没登记进套装 —— 它不会被任何人跑，等于没有`);
}

let totalMs = 0;
for (const t of teeth) {
  const abs = path.join(ROOT, t.script);
  console.log(`\n  ▸ ${t.script}（${t.why}）`);
  if (!fs.existsSync(abs)) {
    check(false, `脚本存在（登记表指向 ${t.script}，但文件不在）`);
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

  check(r.status === 0, `跑完是绿的（exit=${r.status}${r.timedOut ? '，且被掐掉了 —— 超时算失败' : ''}，${Math.round(r.ms / 1000)}s）`);
  check(
    VERDICT.test(out),
    `输出里有场景结论（一个 PASS/✅ 都没有 = 它多半跳过了、什么都没验 —— 跳过的牙齿等于没牙齿）`
  );
  check(before === after, `跑完工作区没变化（变异没还原 / 沙盒没删都会在这里响）`);
  if (before !== after) {
    const add = after.split('\n').filter((l) => l && !before.includes(l));
    console.log(`      多出来的：${add.slice(0, 5).join(' ; ')}`);
  }
}

console.log(`\n  牙齿脚本合计跑了 ${Math.round(totalMs / 1000)}s（这一步是**真的**把它们挨个跑了一遍，不是读代码猜的）`);
console.log(bad ? `\n[teeth-scripts] FAIL — ${bad} 项没达标` : '\n[teeth-scripts] PASS — 每个自称牙齿的脚本都真的验到了东西，且跑完没留下痕迹');
process.exit(bad ? 1 : 0);
