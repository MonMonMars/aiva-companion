// 第 33 步：给第 32 步 `tools/lint-readme-steps.mjs` 配牙齿。
// ---------------------------------------------------------------------------
// 为什么非配不可（和第 31 步同一条理由，换个对象）：
//   第 32 步自己也只是「我记得有」。哪天有人把某个正则删了、把日志行的抹除
//   改坏了、或者把「扫不到就红」那道金丝雀删掉，它就会退化成**永远绿** ——
//   而这个仓库里「扫到 0 条就静默全绿」的事故已经出现过四次。谁拦？这个文件。
//
// 做法：在**沙盒副本**上做变异，真的 spawn 一次第 32 步，看它红不红。
//   每个红场景都配对照组（原样必须绿）——少了对照组，"它红了"说明不了任何事：
//   一个无脑 raise 的检查也能过只验红的那半边。
//
// ⚠️ 沙盒里要能真跑 `runtests.mjs --check-registry`：
//    第 32 步的权威数字是**问它要**的，不是自己算的（见第 32 步文件头）。
//    而 `--check-registry` 会核对「teeth 指向的脚本在不在」，所以沙盒里得把
//    那些路径**建成空桩** —— 桩不会被执行，只是让登记核对照常通过，
//    这样红出来的原因才确实是「README 和代码对不上」，不是「沙盒没搭好」。
//
// ⚠️ 期望值不硬编码：开跑前先问一次**真实**的登记，拿 total / covered / teeth
//    三个数，再据此拼出「输出里必须出现」的串。否则将来加到第 34 步时，
//    这里会拿旧数字去验新代码 —— 那不是牙齿，那是过期证据。
//
// 场景表（🟢=要求绿 / 🔴=要求红）：
//   ⓖ  对照组：原样                                    🟢（并逐条证明四类正则都还活着）
//   ⓗ  对照组：README 换了说法但数字仍对                🟢（不许误伤）
//   ①  README 的「N 步全套」写错                        🔴
//   ②  README 的「N 步里 M 步有常驻牙齿」总数写错       🔴
//   ③  README 的「N 组牙齿测试」写错                    🔴
//   ④  runtests 里凭空多出一步（README 里没有）          🔴 ← 将来真正会发生的那种
//   ⑤  runtests 里某个步骤改了名                        🔴
//   ⑥  README 里一处步数声明都没有                      🔴 ← 金丝雀：扫不到必须红
//   ⑦  README 里删掉某个步骤的名字                      🔴
//   ⑧  检查器退化：把所有行都抹掉                       🔴 ← 同上，另一条路子
//   ⑨  检查器退化：不再抹日志行（历史日志被当成当前声明）🔴
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runStep, rmTreeBounded, rmTreeSyncBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

// ⚠️ 用 fileURLToPath，不用 new URL(...).pathname：后者在 Windows 上给出
//    `/C:/Users/...`，根目录会算错 —— 沙盒建到别处去，而测试照样"通过"。
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_teeth_sb_readme');
const SB_TOOLS = path.join(SB, 'tools');

const LINT = 'lint-readme-steps.mjs';
const RUNTESTS = 'runtests.mjs';
// 第 32 步的依赖链（它 import 这两个；runtests 再 import 这两个）
const DEPS = ['step-runner.mjs', 'step-registry.mjs', 'assert-args.mjs'];

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()'); needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12);

// ---- 先问真实的登记要权威数字 ---------------------------------------------
async function askRegistry(cwd) {
  const r = await runStep(['tools/runtests.mjs', '.', '--check-registry'], { cwd, timeoutMs: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/共\s*(\d+)\s*步：(\d+)\s*步有常驻牙齿，(\d+)\s*步只靠理由/);
  if (!m) throw new Error(`问不出权威数字（退出码 ${r.status}，超时 ${!!r.timedOut}）—— 拿不到数就不许判绿`
    + `\n${out.split('\n').slice(-20).map((l) => `        ${l}`).join('\n')}`);
  return { total: +m[1], covered: +m[2] };
}

// ---- 沙盒 -----------------------------------------------------------------
function buildSandbox() {
  rmTreeSyncBounded(SB);
  fs.mkdirSync(SB_TOOLS, { recursive: true });
  for (const n of [LINT, RUNTESTS, ...DEPS]) {
    fs.copyFileSync(path.join(ROOT, 'tools', n), path.join(SB_TOOLS, n));
  }
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(SB, 'README.md'));
  // 登记核对会检查 teeth 指向的脚本在不在 —— 建空桩，桩不会被执行
  const src = fs.readFileSync(path.join(ROOT, 'tools', RUNTESTS), 'utf8');
  for (const m of src.matchAll(/teeth:\s*'([^']+)'/g)) {
    const abs = path.join(SB, m[1]);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// 沙盒空桩：登记只查这个文件在不在，不会执行它\n');
  }
}

// 变异：`from` 必须真的出现过。⚠️ 找不到就当失败 —— 静默变成「什么都没改」的
//   话，下面测出来的"还是绿的"会被误读成"这条检查没牙齿"，比不做还糟。
function rep(file, from, to) {
  const abs = file === 'README.md' ? path.join(SB, 'README.md') : path.join(SB_TOOLS, file);
  const s = fs.readFileSync(abs, 'utf8');
  if (!s.includes(from)) {
    throw new Error(`[${file}] 找不到待改的原串：${JSON.stringify(from.slice(0, 70))}`
      + ` —— 多半是那个文件的写法变了，这张场景表要跟着改`);
  }
  fs.writeFileSync(abs, s.replace(from, to));
}

// 同上，但**全部**替换。改名场景必须用这个：
//   ⚠️ 只改 `REG.push('assertion-teeth'...)` 那一处的话，另外 8 个步骤的
//      guardedBy 还指着旧名字 —— 登记核对**先**炸在「guardedBy 指向的步骤不在清单里」，
//      第 32 步连数字都问不到，红出来的原因就不是「README 里没这个名字」了。
//      （登记能拦住改名是好事，但本场景要证的是第 32 步那道闸，得先把登记摆平。）
function repAll(file, from, to) {
  const abs = file === 'README.md' ? path.join(SB, 'README.md') : path.join(SB_TOOLS, file);
  const s = fs.readFileSync(abs, 'utf8');
  const n = s.split(from).length - 1;
  if (n === 0) {
    throw new Error(`[${file}] 找不到待改的原串：${JSON.stringify(from.slice(0, 70))}`
      + ` —— 多半是那个文件的写法变了，这张场景表要跟着改`);
  }
  fs.writeFileSync(abs, s.split(from).join(to));
}

async function runLint() {
  // ⚠️ runStep 会自己补 process.execPath，args 里**不要再写 'node'**
  const r = await runStep(['tools/lint-readme-steps.mjs', '.'], { cwd: SB, timeoutMs: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut: !!r.timedOut };
}

async function scenario(label, wantRed, { mutate, mustSay = [] } = {}) {
  process.stdout.write(`\n${label}\n`);
  buildSandbox();
  if (mutate) mutate();
  const { code, out, timedOut } = await runLint();

  if (timedOut) {
    check(false, `${label} —— 沙盒里的第 32 步超过 60 秒没结束（既没绿也没红，等于没结论）`);
    return;
  }
  check(wantRed ? code !== 0 : code === 0,
    `${label} —— 退出码 ${code}（要求 ${wantRed ? '非 0' : '0'}）`
    + ((wantRed ? code !== 0 : code === 0) ? '' : `\n        实际输出：\n${out.split('\n').map((l) => `        ${l}`).join('\n')}`));
  for (const s of mustSay) {
    check(out.includes(s), `${label} —— 输出里要点出「${s}」`
      + (out.includes(s) ? '' : `\n        实际输出：\n${out.split('\n').map((l) => `        ${l}`).join('\n')}`));
  }
}

// ---- 开跑 -----------------------------------------------------------------
// 收工核验用：任何情况下都**不许**碰到真实文件。
const REAL = [LINT, RUNTESTS, ...DEPS].map((n) => path.join(ROOT, 'tools', n))
  .concat([path.join(ROOT, 'README.md')]);
const BEFORE = REAL.map((p) => `${path.basename(p)} ${sha(p)}`);

try {
  console.log('【第 33 步】第 32 步「README 的步数得跟代码对得上」这道闸有没有牙齿');
  const { total, covered } = await askRegistry(ROOT);
  const names = (() => {
    const src = fs.readFileSync(path.join(ROOT, 'tools', RUNTESTS), 'utf8');
    return [...src.matchAll(/REG\.push\('([^']+)'/g)].map((m) => m[1]);
  })();
  const teeth = names.filter((n) => n.endsWith('-teeth')).length;
  console.log(`  权威数字：共 ${total} 步（${covered} 步有常驻牙齿，牙齿脚本 ${teeth} 个）`);

  await scenario('ⓖ  对照组：沙盒里原样（并逐条证明四类正则都还活着）', false, {
    mustSay: [
      'PASS',
      `「${total} 步全套」里的 ${total}`,          // ① 步全套
      `（${total} 步）`,                          // ② 括号总数
      `${total} 步里 ${covered} 步有常驻牙齿`,     // ③ 步里 M 步有常驻牙齿
      `登记核对示例行的总数 ${total}`,             // ④ 登记核对示例行
      '组牙齿测试',                               // ⑤ 牙齿组数
      `最后一个「第 N 步」章节是第 ${total} 步`,   // ⑥ 章节序号
    ],
  });

  await scenario('ⓗ  对照组：README 换了说法（「N 步全量」）但数字仍对 —— 不许误伤', false, {
    mutate: () => rep('README.md', `${total} 步全套`, `${total} 步全量`),
  });

  await scenario('①  README 的「N 步全套」写错', true, {
    mutate: () => rep('README.md', `# ${total} 步全套`, '# 29 步全套'),
    mustSay: ['29 步全套', `实际是 ${total}`],
  });

  await scenario('②  README 的「N 步里 M 步有常驻牙齿」总数写错', true, {
    mutate: () => rep('README.md', `${total} 步里 ${covered} 步有常驻牙齿`, `30 步里 ${covered} 步有常驻牙齿`),
    mustSay: [`30 步里 ${covered} 步有常驻牙齿`, `实际是 ${total}`],
  });

  await scenario('③  README 的「N 组牙齿测试」写错', true, {
    // ⚠️ 不能只改「组牙齿测试」这几个字 —— 那只会让这条声明消失，
    //    剩下的声明还在，金丝雀不响，结果反而是绿的。必须把**数字**改错。
    mutate: () => {
      const abs = path.join(SB, 'README.md');
      const s = fs.readFileSync(abs, 'utf8');
      const m = s.match(/([0-9]+|[一二三四五六七八九十]+)\s*组牙齿测试/);
      if (!m) throw new Error('README 里找不到「N 组牙齿测试」—— 写法变了，场景表要跟着改');
      fs.writeFileSync(abs, s.replace(m[0], `${teeth + 5}组牙齿测试`));
    },
    mustSay: [`${teeth + 5}组牙齿测试`, `实际是 ${teeth}`],
  });

  await scenario('④  runtests 里凭空多出一步（README 里没有 —— 将来真正会发生的那种）', true, {
    mutate: () => rep(RUNTESTS, "REG.push('assert-guards-teeth'",
      "REG.push('brand-new-step', ['tools/nope.mjs'], { why: '沙盒里凭空造出来的一步' });\nREG.push('assert-guards-teeth'"),
    mustSay: ['brand-new-step'],
  });

  await scenario('⑤  runtests 里某个步骤改了名（连 guardedBy 的引用一起改，登记仍有效）', true, {
    mutate: () => repAll(RUNTESTS, "'assertion-teeth'", "'assertion-teeth-renamed'"),
    mustSay: ['步骤名「assertion-teeth-renamed」'],
  });

  await scenario('⑥  README 里一处步数声明都没有 —— 金丝雀必须响', true, {
    mutate: () => fs.writeFileSync(path.join(SB, 'README.md'), '# 空壳\n'),
    mustSay: ['至少得有一处步数声明'],
  });

  await scenario('⑦  README 里某个步骤的名字一处都不剩', true, {
    // ⚠️ 必须**全部**删，一处不留：第 32 步查的是 `raw.includes(name)`，
    //    而同一个名字在 README 里往往出现不止一处 —— 光删第 29 步那行不够，
    //    第 32 步自己那节里又写了一遍 `assertion-teeth`，同一行后面的
    //    `tools/test-assertion-teeth.mjs` 里也含这个子串。只删一处的话
    //    includes 照样命中，测出来是绿的 —— 那是假绿，比不做还糟。
    mutate: () => repAll('README.md', 'assertion-teeth', 'ZZZ'),
    mustSay: ['步骤名「assertion-teeth」'],
  });

  await scenario('⑧  检查器退化：把所有行都抹掉（等于什么都不查）', true, {
    mutate: () => rep(LINT,
      "    if (LOG_LINE.test(l)) return ' '.repeat(l.length);\n    return l;",
      "    return ' '.repeat(l.length);"),
    mustSay: ['至少得有一处步数声明'],
  });

  await scenario('⑨  检查器退化：日志行不再被抹 —— 历史证据被当成当前声明', true, {
    mutate: () => rep(LINT,
      'const LOG_LINE = /^\\s*(?:##\\[|\\d{4}-\\d{2}-\\d{2}[T ])?\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?\\s/;',
      'const LOG_LINE = /ZZZ_永远不是日志行/;'),
    mustSay: ['示例行的总数 29'], // README 里贴的 CI #62 原始日志写的是当时的 29 步
  });
} finally {
  await rmTreeBounded(SB, { timeoutMs: 15000 });
  const gone = !fs.existsSync(SB);
  check(gone, `收工核验：沙盒 ${path.basename(SB)} 已删除` + (gone ? '' : ' —— 留着会脏工作区'));

  const AFTER = REAL.map((p) => `${path.basename(p)} ${sha(p)}`);
  const same = BEFORE.length === AFTER.length && BEFORE.every((s, i) => s === AFTER[i]);
  check(same, `收工核验：${BEFORE.length} 个真实源文件逐字节未动`
    + (same ? '' : `\n        之前：${BEFORE.join(' | ')}\n        之后：${AFTER.join(' | ')}`));
}

console.log(bad
  ? `\n[readme-steps-teeth] FAIL — ${bad} 项没达标`
  : `\n[readme-steps-teeth] PASS — 红该红的、绿该绿的；收工核验也是绿的`);
process.exit(bad ? 1 : 0);
