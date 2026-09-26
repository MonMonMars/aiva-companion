// 第 28 步：给「每一步都要登记牙齿在哪」这道闸配牙齿。
// ---------------------------------------------------------------------------
// 它要回答的那句话，是我上一轮结尾自己提出来的：
//   「将来再加第 28、29 步时，谁来提醒它『你还没配牙齿』？」
// 之前 19~27 步每一条牙齿，都是**我补完一条闸之后自己想起来**才去配的。
// 那是「下次记得」，而「下次记得」不算防线。tools/step-registry.mjs 把提醒
// 变成机器的事：漏登记 → 整套测试拒绝开跑。本文件盯的是**这件事真的发生**。
//
// 两半，缺一半都不算数：
//   【甲】纯函数层：拿合成清单喂 verifyRegistry，逐个场景确认它会红。
//         只做这一半不够 —— 验的是函数，没验到「整套拒绝开跑」这个行为。
//   【乙】真跑层：把 tools/ 里那三个文件复制到沙盒，改坏登记，
//         真的 spawn 一次 `node runtests.mjs --check-registry`，要求 exit ≠ 0。
//         这才是对「加第 29 步的人会当场撞上」的直接验证。
//
// 每个场景都配对照组（原样必须绿）—— 少了对照组，"它红了"说明不了任何事：
// 一个无脑拒绝开跑的检查也能过只验红的那半边。
//
// 场景表（🟢=要求绿 / 🔴=要求红）：
//   ⓟ⓪ 合成清单·对照组：登记齐全                🟢
//   ⓪  漏登记                                    🔴
//   ①  teeth 指向不存在的脚本                     🔴
//   ②  填了 teeth 但清单里没有 <name>-teeth        🔴
//   ③  why 是占位（"不需要"）                     🔴
//   ④  why 太短                                   🔴
//   ⑤  teeth 和 why 同时填                        🔴
//   ⑥  孤儿登记（登记了但不在清单里）              🔴
//   ⑦  guardedBy 指向不在清单里的步骤              🔴
//   ⑧  老实写 why 且带「未验证」→ 不红，但要被列出 🟢
//   ⑨  空清单（一步都没有）                        🔴
//   ⑩  重名                                       🔴
//   Ⓐ  真跑·对照组：原样 → exit 0                 🟢
//   Ⓑ  用旧写法 STEPS.push 加一步                 🔴
//   Ⓒ  REG.push 但不填第三参                      🔴
//   Ⓓ  新加一步 why 写「不需要」                  🔴
//   Ⓔ  新加一步 teeth 指向不存在                  🔴
//   Ⓕ  新加一步 guardedBy 指向不存在              🔴
//   Ⓖ  把已有一步（inspect-character）的登记删掉   🔴

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRegistry } from './step-registry.mjs';
import { runStep, rmTreeBounded } from './step-runner.mjs';

// ⚠️ 用 fileURLToPath，不用 new URL(...).pathname：后者在 Windows 上给出
//    `/C:/Users/...`，path.resolve 之后根目录是错的 —— 沙盒会建到别处去，
//    而测试照样"通过"（它验的是沙盒里的行为，沙盒建错地方它也看不出来）。
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_teeth_sb_registry');
const SB_TOOLS = path.join(SB, 'tools');

let bad = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ---- 小工具 ---------------------------------------------------------------
const REAL_TEETH = 'tools/test-inspect-character-teeth.mjs'; // 一个**真的存在**的牙齿脚本，用来做对照组

function synth(steps, declObj) {
  return verifyRegistry(steps, new Map(Object.entries(declObj)), ROOT);
}
const has = (probs, re) => probs.some((p) => re.test(p));
const show = (probs) => probs.map((p) => `\n        ${p}`).join('');

try {
  // =========================================================================
  console.log('【甲】纯函数层 —— verifyRegistry 看见这些坏登记会不会红');
  console.log('\nⓟ⓪ 对照组：登记齐全的合成清单');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']], ['alpha-teeth', ['tools/b.mjs']]],
      {
        alpha: { teeth: REAL_TEETH },
        'alpha-teeth': { why: '它自己是牙齿脚本，牙齿的牙齿到此为止；未验证' },
      },
    );
    check(r.problems.length === 0, `0 个问题（实际 ${r.problems.length}）${show(r.problems)}`);
    check(r.covered.includes('alpha'), 'alpha 算「有常驻牙齿」');
    check(r.total === 2, `总数 2（实际 ${r.total}）`);
  }

  console.log('\n⓪ 漏登记（清单里有、登记里没有）');
  {
    const r = synth([['alpha', ['tools/a.mjs']]], {});
    check(r.problems.length > 0, '要有问题');
    check(has(r.problems, /没有登记/), `报错要点名「没有登记」${show(r.problems)}`);
  }

  console.log('\n① teeth 指向不存在的脚本');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']], ['alpha-teeth', ['tools/b.mjs']]],
      { alpha: { teeth: 'tools/no-such-teeth.mjs' }, 'alpha-teeth': { why: '它自己是牙齿脚本；未验证' } },
    );
    check(has(r.problems, /不存在/), `报错要说明「不存在」${show(r.problems)}`);
    check(has(r.problems, /no-such-teeth/), '报错要把那个不存在的路径打出来');
  }

  console.log('\n② 填了 teeth，但清单里没有 <alpha-teeth> 这一步');
  {
    const r = synth([['alpha', ['tools/a.mjs']]], { alpha: { teeth: REAL_TEETH } });
    check(has(r.problems, /alpha-teeth/), `报错要指出缺的是 alpha-teeth${show(r.problems)}`);
    check(has(r.problems, /不跑等于没有/), '要说清为什么这算问题（牙齿不跑等于没有）');
  }

  console.log('\n③ why 是敷衍占位（"不需要"）');
  {
    const r = synth([['alpha', ['tools/a.mjs']]], { alpha: { why: '不需要' } });
    check(has(r.problems, /敷衍|占位/), `占位理由要被拒${show(r.problems)}`);
  }

  console.log('\n④ why 太短');
  {
    const r = synth([['alpha', ['tools/a.mjs']]], { alpha: { why: '太短' } });
    check(has(r.problems, /只有 2 个字/), `要报出字数${show(r.problems)}`);
  }

  console.log('\n⑤ teeth 和 why 同时填（只能选一个）');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']], ['alpha-teeth', ['tools/b.mjs']]],
      { alpha: { teeth: REAL_TEETH, why: '这条理由写得足够长但是不该出现' } },
    );
    check(has(r.problems, /只能填一个/), `要报「只能填一个」${show(r.problems)}`);
  }

  console.log('\n⑥ 孤儿登记（登记里有、清单里没有）');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']]],
      { alpha: { why: '这条理由写得足够长，只用来凑对照组' }, ghost: { why: '这条理由也写得足够长，只用来凑对照组' } },
    );
    check(has(r.problems, /ghost/), `要点名那个孤儿${show(r.problems)}`);
    check(has(r.problems, /不在清单里/), '要说明它是孤儿');
  }

  console.log('\n⑦ guardedBy 指向不在清单里的步骤');
  {
    const r = synth([['alpha', ['tools/a.mjs']]], { alpha: { guardedBy: ['no-such-step'] } });
    check(has(r.problems, /no-such-step/), `要点名那个不存在的步骤${show(r.problems)}`);
  }

  console.log('\n⑧ 老实写 why 且带「未验证」：不红，但必须被列出来');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']], ['beta', ['tools/c.mjs']]],
      {
        alpha: { why: '这条只是我的判断，没有证据；未验证' },
        beta: { why: '这条有证据：做过变异测试，四个场景全杀' },
      },
    );
    check(r.problems.length === 0, `不该红${show(r.problems)}`);
    check(r.unverified.includes('alpha'), '自认未验证的 alpha 要进 unverified 清单');
    check(!r.unverified.includes('beta'), '有证据的 beta 不该进 unverified');
  }

  console.log('\n⑨ 空清单（一步都没有）');
  {
    const r = synth([], {});
    check(has(r.problems, /一步都没有|0 步/), `空清单不许判成「齐全」${show(r.problems)}`);
  }

  console.log('\n⑩ 重名');
  {
    const r = synth(
      [['alpha', ['tools/a.mjs']], ['alpha', ['tools/a.mjs']]],
      { alpha: { why: '这条理由写得足够长，只用来凑对照组' } },
    );
    check(has(r.problems, /出现了 2 次/), `要报重名次数${show(r.problems)}`);
  }

  // =========================================================================
  console.log('\n\n【乙】真跑层 —— 真的 spawn 一次 runtests.mjs --check-registry');
  console.log('    （甲只验了函数；这一半验的是「整套测试拒绝开跑」这个行为本身）');

  // 沙盒要放：三个执行相关的文件 + 登记里 teeth 指向的每个脚本。
  // ⚠️ 后者是踩出来的：第一版只复制了三个文件，于是核对把「teeth 指向的脚本不存在」
  //   报成问题，**对照组自己就红了** —— 而它红的原因跟「登记」毫无关系，
  //   是沙盒不完整。这种假红最害人：它会让人以为闸在工作。
  fs.mkdirSync(SB_TOOLS, { recursive: true });
  const NEEDED = ['runtests.mjs', 'step-registry.mjs', 'step-runner.mjs'];
  for (const f of NEEDED) {
    fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(SB_TOOLS, f));
  }
  const SB_RUNTESTS = path.join(SB_TOOLS, 'runtests.mjs');
  const PRISTINE = fs.readFileSync(SB_RUNTESTS, 'utf8');
  {
    const teeth = new Set();
    let m;
    const re = /teeth:\s*'([^']+)'/g;
    while ((m = re.exec(PRISTINE)) !== null) teeth.add(m[1]);
    for (const rel of teeth) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) throw new Error(`登记里的 teeth 脚本在真仓库里就不存在：${rel}`);
      fs.copyFileSync(src, path.join(SB, rel));
    }
    console.log(`    （沙盒备齐 ${teeth.size} 个牙齿脚本的副本，免得核对把「文件不在沙盒」当成登记问题）`);
  }

  async function runCheck(label) {
    const r = await runStep([SB_RUNTESTS, SB, '--check-registry'], {
      cwd: SB,
      timeoutMs: 60000,
    });
    return r;
  }
  function mutate(from, to) {
    const s = PRISTINE.replace(from, to);
    if (s === PRISTINE) throw new Error(`变异没生效（没找到：${from}）`);
    fs.writeFileSync(SB_RUNTESTS, s);
  }
  // 每个「要求红」的场景：exit 必须非 0，**并且**报错里要点名那一步 ——
  // 只验 exit≠0 不够（脚本崩了也是非 0），得确认是**这条闸**在拦，不是别的。
  async function expectRed(label, mutateFn, mustName, mustSay) {
    mutateFn();
    const r = await runCheck(label);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status !== 0, `${label}：拒绝开跑（exit ${r.status}${r.timedOut ? '，且超时了' : ''}）`);
    check(out.includes(mustName), `${label}：报错要点名「${mustName}」`);
    if (mustSay) check(out.includes(mustSay), `${label}：报错要说明「${mustSay}」`);
    if (r.status === 0) console.log(`        实际输出：${out.slice(0, 400)}`);
  }

  console.log('\nⒶ 对照组：原样的 runtests.mjs');
  {
    fs.writeFileSync(SB_RUNTESTS, PRISTINE);
    const r = await runCheck('control');
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status === 0, `原样必须放行（exit ${r.status}）`);
    check(/登记齐全/.test(out), '要打印「登记齐全」');
    check(!/✗/.test(out), '原样不该有任何 ✗');
    const m = out.match(/共 (\d+) 步/);
    check(m && Number(m[1]) >= 28, `要报告总步数（实际 ${m ? m[1] : '没报告'}）`);
    if (r.status !== 0) console.log(`        实际输出：${out.slice(0, 600)}`);
  }

  console.log('\nⒷ 用**旧写法**加一步（STEPS.push，不带登记）');
  await expectRed(
    '旧写法',
    () => mutate(
      // ★ 锚点必须在 verify() **之前**：插在 `if (CHECK_ONLY) process.exit(0)` 前面
      //   等于插在核对之后，那一步根本不参与核对 —— 第一版就是这么错的，
      //   结果 exit≠0 通过（被别的问题带红的）、点名失败，五个场景全瞎。
      "const REG_CHECK = REG.verify(ROOT);",
      "STEPS.push(['brand-new-step', ['tools/brand-new.mjs']]);\nconst REG_CHECK = REG.verify(ROOT);",
    ),
    'brand-new-step',
    '没有登记',
  );

  console.log('\nⒸ 用新写法加一步，但不填第三参');
  await expectRed(
    '空登记',
    () => mutate(
      // ★ 锚点必须在 verify() **之前**：插在 `if (CHECK_ONLY) process.exit(0)` 前面
      //   等于插在核对之后，那一步根本不参与核对 —— 第一版就是这么错的，
      //   结果 exit≠0 通过（被别的问题带红的）、点名失败，五个场景全瞎。
      "const REG_CHECK = REG.verify(ROOT);",
      "REG.push('brand-new-step', ['tools/brand-new.mjs']);\nconst REG_CHECK = REG.verify(ROOT);",
    ),
    'brand-new-step',
    '一个都没填',
  );

  console.log('\nⒹ 新加一步，why 写「不需要」');
  await expectRed(
    '敷衍理由',
    () => mutate(
      // ★ 锚点必须在 verify() **之前**：插在 `if (CHECK_ONLY) process.exit(0)` 前面
      //   等于插在核对之后，那一步根本不参与核对 —— 第一版就是这么错的，
      //   结果 exit≠0 通过（被别的问题带红的）、点名失败，五个场景全瞎。
      "const REG_CHECK = REG.verify(ROOT);",
      "REG.push('brand-new-step', ['tools/brand-new.mjs'], { why: '不需要' });\nconst REG_CHECK = REG.verify(ROOT);",
    ),
    'brand-new-step',
    '敷衍',
  );

  console.log('\nⒺ 新加一步，teeth 指向不存在的脚本');
  await expectRed(
    '假牙齿',
    () => mutate(
      // ★ 锚点必须在 verify() **之前**：插在 `if (CHECK_ONLY) process.exit(0)` 前面
      //   等于插在核对之后，那一步根本不参与核对 —— 第一版就是这么错的，
      //   结果 exit≠0 通过（被别的问题带红的）、点名失败，五个场景全瞎。
      "const REG_CHECK = REG.verify(ROOT);",
      "REG.push('brand-new-step', ['tools/brand-new.mjs'], { teeth: 'tools/no-such-teeth.mjs' });\nconst REG_CHECK = REG.verify(ROOT);",
    ),
    'brand-new-step',
    '不存在',
  );

  console.log('\nⒻ 新加一步，guardedBy 指向不存在的步骤');
  await expectRed(
    '假守卫',
    () => mutate(
      // ★ 锚点必须在 verify() **之前**：插在 `if (CHECK_ONLY) process.exit(0)` 前面
      //   等于插在核对之后，那一步根本不参与核对 —— 第一版就是这么错的，
      //   结果 exit≠0 通过（被别的问题带红的）、点名失败，五个场景全瞎。
      "const REG_CHECK = REG.verify(ROOT);",
      "REG.push('brand-new-step', ['tools/brand-new.mjs'], { guardedBy: ['no-such-step'] });\nconst REG_CHECK = REG.verify(ROOT);",
    ),
    'brand-new-step',
    '不在清单里',
  );

  console.log('\nⒼ 把**已有一步**的登记整块删掉（inspect-character）');
  await expectRed(
    '删掉已有登记',
    () => mutate(
      "REG.push('inspect-character', ['tools/inspect-character.mjs'], {\n  teeth: 'tools/test-inspect-character-teeth.mjs',\n});",
      "REG.push('inspect-character', ['tools/inspect-character.mjs']);",
    ),
    'inspect-character',
    '一个都没填',
  );
} finally {
  // 用子进程删 + 硬上限：rmSync(recursive) 在这台机器上会卡住不返回
  // （第 27 步那次挂 4 小时 17 分就是它），不能让「清理」变成新一轮的挂住。
  const rm = await rmTreeBounded(SB);
  if (!rm.gone) console.log(`  ⚠️ 沙盒没删干净（${rm.timedOut ? '删除卡住了，进程已杀' : '未知原因'}）—— 留着，不挡结论`);
}

console.log(bad ? `\n[registry-teeth] FAIL — ${bad} 项没达标` : '\n[registry-teeth] PASS — 漏登记 / 乱登记 / 敷衍理由都会让整套拒绝开跑，原样照旧放行');
process.exit(bad ? 1 : 0);
