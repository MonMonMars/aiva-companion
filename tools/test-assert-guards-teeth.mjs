// 第 31 步：给第 30 步 `tools/lint-assert-guards.mjs` 配牙齿。
// ---------------------------------------------------------------------------
// 为什么非配不可：
//   上一次的经验是，补完一条闸之后如果没有第二道东西盯着它，它就只是「我记得有」
//   —— 「下次记得」不算防线（SKILL 第 78 条）。update 这句话同样适用于本步自己：
//   有一天有人（很可能就是我）为了图省事把第 30 步的识别规则改松一点，
//   或者把断言助手里的守卫删掉，谁会拦？就是这个文件。
//
// 做法：在**沙盒副本**上做变异，真的 spawn 一次第 30 步，看它红不红。
//   每个红场景都配对照组（原样必须绿）——少了对照组，"它红了"说明不了任何事：
//   一个无脑 raise 的检查也能过只验红的那半边。
//
// ⚠️ 沙盒里只有文本：第 30 步是**读源码做静态识别**的，从不 require 被测文件，
//    所以复制过去的 verify-kizuna.mjs 之类的根本不需要能跑起来
//    （它们 import three / CHROME 之类，真 require 反而跑不动）。
//    这一点让它比其它牙齿脚本便宜得多：沙盒 5 个文件，跑一次不到 1 秒。
//
// 场景表（🟢=要求绿 / 🔴=要求红）：
//   ⓖ  对照组：原样                                  🟢
//   ⓗ  对照组：新加一个**装了守卫**的全新脚本          🟢（不许误伤）
//   ①  A 型（✓/✗+计数）删掉 needBool                  🔴
//   ②  needBool 守到别的参数上                        🔴
//   ③  B 型（只 push 不打标记）删掉守卫                🔴
//   ④  C 型（❌/✅）删掉守卫                           🔴
//   ⑤  全新脚本**没装**守卫                            🔴 ← 最重要：这才是将来真正会发生的
//   ⑥  只留 needBool，删掉 needLabel                   🔴
//   ⑦  删掉 import（守卫还在）                         🔴 ← 否则运行时 ReferenceError 而本检查还说"都守住了"
//   ⑧  扫描器自己退化（isBareCondition 恒 false）      🔴 ← 必须靠金丝雀兜住，否则静默全绿
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runStep, rmTreeBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

// ⚠️ 用 fileURLToPath，不用 new URL(...).pathname：后者在 Windows 上给出
//    `/C:/Users/...`，根目录会算错 —— 沙盒建到别处去，而测试照样"通过"
//    （它验的是沙盒里的行为，沙盒建错地方它自己也看不出来）。
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_teeth_sb_guards');
const SB_TOOLS = path.join(SB, 'tools');

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()'); needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ---- 小工具 ---------------------------------------------------------------
// 参与模拟的四个「被测」源文件：A/B/C 三种形状 + 本件第 30 步自己
const SUBJECTS = [
  'test-with-timeout.mjs',   // A 型
  'verify-compare-page.mjs', // B 型
  'verify-kizuna.mjs',       // C 型
];
const LINT = 'lint-assert-guards.mjs';
const GUARD = 'assert-args.mjs';

const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12);
const realSubjects = () => [LINT, GUARD, ...SUBJECTS].map((n) => path.join(ROOT, 'tools', n));

function buildSandbox(extra = []) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(SB_TOOLS, { recursive: true });
  for (const n of [LINT, GUARD, ...SUBJECTS]) {
    fs.copyFileSync(path.join(ROOT, 'tools', n), path.join(SB_TOOLS, n));
  }
  for (const [name, body] of extra) fs.writeFileSync(path.join(SB_TOOLS, name), body);
}

// 变异：`from` 必须真的出现过。⚠️ 找不到就当失败 —— 静默变成「什么都没改」的
//   话，下面测出来的"还是绿的"会被误读成"这条检查没牙齿"，比不做还糟。
function rep(file, from, to) {
  const abs = path.join(SB_TOOLS, file);
  const s = fs.readFileSync(abs, 'utf8');
  if (!s.includes(from)) {
    throw new Error(`[${file}] 找不到待改的原串：${JSON.stringify(from.slice(0, 70))}`
      + ` —— 多半是那个文件的写法变了，这张场景表要跟着改`);
  }
  fs.writeFileSync(abs, s.replace(from, to));
}

async function runLint() {
  // ⚠️ runStep 会自己补 process.execPath，args 里**不要再写 'node'**
  const r = await runStep(['tools/lint-assert-guards.mjs', '.'], { cwd: SB, timeoutMs: 30000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut: !!r.timedOut };
}

async function scenario(label, wantRed, { mutate, extra, mustSay = [] } = {}) {
  process.stdout.write(`\n${label}\n`);
  buildSandbox(extra);
  if (mutate) mutate();
  const { code, out, timedOut } = await runLint();

  if (timedOut) {
    check(false, `${label} —— 沙盒里的第 30 步超过 30 秒没结束（既没绿也没红，等于没结论）`);
    return;
  }
  if (wantRed) {
    check(code !== 0, `${label} —— 退出码 ${code}（要求非 0）`);
  } else {
    check(code === 0, `${label} —— 退出码 ${code}（要求 0）`);
  }
  for (const s of mustSay) {
    check(out.includes(s), `${label} —— 输出里要点出「${s}」`
      + (out.includes(s) ? '' : `\n        实际输出：\n${out.split('\n').map((l) => `        ${l}`).join('\n')}`));
  }
}

// ---- 开跑 -----------------------------------------------------------------
// 收工核验用：任何情况下都**不许**碰到真实文件。第 30 步这次改的是 24 个脚本，
// 上一轮的教训是机械改动覆盖面一大，就必须证明改完了哪些没被顺手碰坏。
const BEFORE = realSubjects().map((p) => `${path.basename(p)} ${sha(p)}`);

try {
  console.log('【第 31 步】第 30 步「每个断言函数都装了参数守卫」这道闸有没有牙齿');

  await scenario('ⓖ  对照组：沙盒里五个文件原样', false, { mustSay: ['PASS'] });

  await scenario('ⓗ  对照组：新加一个装了守卫的全新脚本（不许误伤）', false, {
    extra: [['brand-new-clean.mjs', fs.readFileSync(path.join(ROOT, 'tools/verify-kizuna.mjs'), 'utf8')
      .replace(/^\/\/[\s\S]*?^-{10,}\n/m, '')]], // 只留代码主体，注释去掉
    mustSay: ['PASS'],
  });

  await scenario('①  A 型（✓/✗+计数）把 needBool 那行删掉', true, {
    mutate: () => rep('test-with-timeout.mjs', "  needBool(cond, 'ok(label, cond)');\n", ''),
    mustSay: ['test-with-timeout.mjs', 'needBool'],
  });

  await scenario('②  needBool 守到别的参数上（不是用来当条件的那个）', true, {
    mutate: () => rep('test-with-timeout.mjs', "needBool(cond, 'ok(label, cond)')", "needBool(label, 'ok(label, cond)')"),
    mustSay: ['test-with-timeout.mjs', 'needBool'],
  });

  await scenario('③  B 型（只往 problems 里 push，不打标记）删掉守卫', true, {
    mutate: () => {
      rep('verify-compare-page.mjs', "    needBool(c, 'ok(c, m)');\n", '');
      rep('verify-compare-page.mjs', "    needLabel(m, 'ok(c, m)');\n", '');
    },
    mustSay: ['verify-compare-page.mjs'],
  });

  await scenario('④  C 型（❌/✅）删掉守卫', true, {
    mutate: () => {
      rep('verify-kizuna.mjs', "  needBool(cond, 'ok(cond, label)');\n", '');
      rep('verify-kizuna.mjs', "  needLabel(label, 'ok(cond, label)');\n", '');
    },
    mustSay: ['verify-kizuna.mjs'],
  });

  await scenario('⑤  将来新写的验证脚本，忘了装守卫 —— 这条才是真正会发生的那种', true, {
    mutate: () => {
      const src = fs.readFileSync(path.join(SB_TOOLS, 'verify-kizuna.mjs'), 'utf8')
        .replace("  needBool(cond, 'ok(cond, label)');\n", '')
        .replace("  needLabel(label, 'ok(cond, label)');\n", '');
      fs.writeFileSync(path.join(SB_TOOLS, 'brand-new-noguard.mjs'), src);
    },
    mustSay: ['brand-new-noguard.mjs'],
  });

  await scenario('⑥  只留 needBool，删掉 needLabel', true, {
    mutate: () => rep('verify-kizuna.mjs', "  needLabel(label, 'ok(cond, label)');\n", ''),
    mustSay: ['needLabel'],
  });

  await scenario('⑦  守卫还在，但 import 被人清掉了', true, {
    mutate: () => rep('verify-kizuna.mjs', "import { needBool, needLabel } from './assert-args.mjs';\n", ''),
    mustSay: ['verify-kizuna.mjs', '没有 import'],
  });

  await scenario('⑧  扫描器自己退化：认不出「裸条件位」了（isBareCondition 恒 false）', true, {
    mutate: () => rep(LINT, 'const p = word(param);', "const p = 'ZZZ_NEVER_MATCHES';"),
    mustSay: ['金丝雀失联'],
  });
} finally {
  await rmTreeBounded(SB, { timeoutMs: 15000 });
  const gone = !fs.existsSync(SB);
  check(gone, `收工核验：沙盒 ${path.basename(SB)} 已删除` + (gone ? '' : ' —— 留着会脏工作区'));

  const AFTER = realSubjects().map((p) => `${path.basename(p)} ${sha(p)}`);
  const same = BEFORE.length === AFTER.length && BEFORE.every((s, i) => s === AFTER[i]);
  check(same, `收工核验：${BEFORE.length} 个真实源文件逐字节未动`
    + (same ? '' : `\n        之前：${BEFORE.join(' | ')}\n        之后：${AFTER.join(' | ')}`));
}

console.log(bad
  ? `\n[assert-guards-teeth] FAIL — ${bad} 项没达标`
  : `\n[assert-guards-teeth] PASS — 红该红的、绿该绿的；考业绩的流程本身也是绿的`);
process.exit(bad ? 1 : 0);
