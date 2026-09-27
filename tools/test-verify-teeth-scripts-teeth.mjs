// 第 35 步：给第 34 步（verify-teeth-scripts）配牙齿。
// ---------------------------------------------------------------------------
// 要验的还是那句老规矩：一个检查值得存在，当且仅当**能造出「旧检查通过、
// 新检查失败」的场景**。第 34 步有四条判据，逐条造：
//
//   ① 跑完是绿的           → 让夹具崩掉（exit 1）
//   ② 输出里有场景结论      → 让夹具空转 / 让它「跳过」（就是真出过事的那种）
//   ③ 跑完工作区没变化      → 让夹具留一个文件不收
//   ③b 产物目录还在         → 让夹具删掉 dist-localcheck-web（git status 看不见的那种）
//   ④ 问得到登记表          → 让 --list-steps 吐不出东西
//   ⑤ 牙齿脚本本身被人删了  → 登记表指向一个不存在的文件（整套拒绝开跑）
//   ⑥ 未登记的牙齿脚本要响  → 往 tools/ 里丢一个新的 test-*teeth*.mjs
//
// （原先的「未登记例外还在原位」那条在 2026-09-27 连同那份豁免名单一起删了：
//   它放过的那个脚本已经登记成第 41 步，留着就是一条没有东西会响的烂豁免。）
//
// 加两个**反向**场景，证明判据是「承重」的、不是摆设：
//   ⑧ 换个写法但仍然打印结论、无副作用 → 必须仍然绿（不是见谁都红）
//   ⑨ 把判据 ② 的正则放宽到「什么都算结论」，再喂一个空转脚本
//      → 闸会**假绿**。这一条期望绿，是故意的：它演示「没有这条判据会怎样」。
//
// ⚠️ 为什么用夹具而不是真跑那 14 个：第 34 步真跑一遍要 153s，
//    11 个场景就是 25 分钟。所以沙盒里把登记表**裁到只剩两个夹具步骤**，
//    一次闸门运行压到 1~2 秒。裁的方式是按锚点切开 runtests.mjs 换掉中间那段，
//    不是自己另写一份登记表 —— 头部/尾部（含 --list-steps 那个出口）仍是真的。
//
// 用法：node tools/test-verify-teeth-scripts-teeth.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runStep, rmTreeBounded, rmTreeSyncBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
const SB = path.join(ROOT, '_teeth_sb_34');
const GATE = 'tools/verify-teeth-scripts.mjs';

// 沙盒里要带上的真文件（少了任何一个，第 34 步在沙盒里都跑不起来）
const COPIES = [
  'tools/runtests.mjs',
  'tools/step-runner.mjs',
  'tools/step-registry.mjs',
  'tools/assert-args.mjs',
  GATE,
  // ⚠️ `tools/test-verify-app-ui-teeth.mjs` 原先在这份清单里 —— 因为那时的
  //    第 34 步有一份「未登记例外名单」点名了它。那份名单连同那条豁免在
  //    2026-09-27 一起删掉了（它已经登记成第 41 步），这里也就不需要它了。
];

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// ---- 裁剪登记表：只留夹具步骤 ---------------------------------------------
// 按锚点切开真的 runtests.mjs，中间那段（几十条 REG.push）换成两条夹具。
// 头尾都是真文件里的原文，所以 --list-steps 那个出口、以及它输出的三列格式，
// 沙盒里和线上是同一份代码。
function trimRegistry(src) {
  const A = 'const REG = makeRegistry();';
  const B = 'const REG_CHECK = REG.verify(ROOT);';
  const i = src.indexOf(A);
  const j = src.indexOf(B);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(`runtests.mjs 里找不到锚点（${A} / ${B}）—— 换写法了，本脚本要跟着改`);
  }
  // 三条夹具，正好覆盖第 34 步认牙齿的两条路径：
//   zz-teeth          —— 步骤名以 -teeth 结尾，它自己就是牙齿脚本
//   zz-guarded-teeth  —— 走「被别的一步用 teeth: 声明」那条路径
//   zz-guarded        —— 被盯着的那个步骤本体（第 34 步不会跑它）
// ⚠️ 两条登记表规则在这里咬过人（第一次跑 9 个场景全挂在「问登记表失败」）：
//   ① why 不能太短（「夹具」两个字会被判「说清理由」）
//   ② 声明了 teeth: 的步骤，必须另有一个叫 <名字>-teeth 的步骤真去跑那个脚本，
//      否则「牙齿不跑等于没有」—— 所以不能只写 zz-guarded。
const mid = `${A}
const STEPS = REG.steps;
const DECL = REG.decl;
// ↓↓ 第 35 步的夹具（真的那几十条被裁掉了，见本脚本顶部说明）
REG.push('zz-teeth', ['tools/zz-teeth.mjs'], { why: '第 35 步的夹具：一个合格的牙齿脚本该有的样子 —— 打印结论、无副作用、退出码 0' });
REG.push('zz-guarded-teeth', ['tools/zz-other-teeth.mjs'], { why: '第 35 步的夹具：走「被别的一步用 teeth 声明」那条路径' });
REG.push('zz-guarded', ['tools/zz-guarded.mjs'], { teeth: 'tools/zz-other-teeth.mjs' });

`;
  return src.slice(0, i) + mid + src.slice(j);
}

// ---- 夹具 ---------------------------------------------------------------
// 基线：打印结论、无副作用、exit 0 —— 这正是第 34 步期望一个牙齿脚本的样子。
const FIXTURE_OK = `console.log('  ✓ 夹具：做了一次实验，结论是通过');
console.log('[zz-teeth] PASS');
`;
const FIXTURE_OTHER_OK = `console.log('[zz-other-teeth] PASS — 被 zz-guarded 声明为它的牙齿');
`;
const FIXTURE_GUARDED = `console.log('被盯着的那个步骤本体（第 34 步不会跑它）');
`;

function buildSandbox() {
  rmTreeSyncBounded(SB);
  fs.mkdirSync(path.join(SB, 'tools', 'lib'), { recursive: true });
  for (const f of COPIES) {
    fs.copyFileSync(path.join(ROOT, f), path.join(SB, f));
  }
  // 登记表裁到只剩夹具
  const rt = path.join(SB, 'tools/runtests.mjs');
  fs.writeFileSync(rt, trimRegistry(fs.readFileSync(rt, 'utf8')));
  fs.writeFileSync(path.join(SB, 'tools/zz-teeth.mjs'), FIXTURE_OK);
  fs.writeFileSync(path.join(SB, 'tools/zz-other-teeth.mjs'), FIXTURE_OTHER_OK);
  fs.writeFileSync(path.join(SB, 'tools/zz-guarded.mjs'), FIXTURE_GUARDED);
  // ⚠️ 沙盒也要有一份和真仓库同款的 .gitignore（至少 dist-*/ 那一条）：
  //    真仓库里产物目录是 gitignore 的，所以「某一步把产物删了」这件事
  //    git status 一句都不会说 —— 判据③ 抓不到，才需要判据③b。
  //    沙盒里不照抄这条，③b 的场景就会被 ③ 顺手抓走，看不出 ③b 自己有没有牙齿。
  fs.writeFileSync(path.join(SB, '.gitignore'), 'dist-*/\nnode_modules/\n');
  // 第 34 步用 git status 判断「有没有残留」，沙盒得是个 git 仓库，
  //   否则 git 会顺着目录往上找到**真仓库**，拿真仓库的状态来比对 —— 那就全乱了。
  const g = spawnSync('git', ['init'], { cwd: SB, encoding: 'utf8' });
  if (g.status !== 0) throw new Error(`沙盒 git init 失败：${g.stderr || g.error}`);
}

function write(file, content) {
  const abs = path.join(SB, file);
  if (!fs.existsSync(abs)) throw new Error(`沙盒里没有 ${file} —— 夹具路径改过了？`);
  fs.writeFileSync(abs, content);
}
// 往沙盒里**新增**一个文件（⑦ 要造一个「没登记的牙齿脚本」，文件本来不存在）
function writeNew(file, content) {
  const abs = path.join(SB, file);
  if (fs.existsSync(abs)) throw new Error(`沙盒里已经有 ${file} —— 这个场景是「新增」，别写成覆盖`);
  fs.writeFileSync(abs, content);
}
const read = (file) => fs.readFileSync(path.join(SB, file), 'utf8');
function rep(file, from, to) {
  const s = read(file);
  if (!s.includes(from)) throw new Error(`${file} 里找不到「${from}」—— 变异没落上，等于没测`);
  fs.writeFileSync(path.join(SB, file), s.replace(from, to));
}

async function runGate() {
  return runStep([GATE, SB], { cwd: SB, timeoutMs: 120000 });
}

// ---- 场景表 --------------------------------------------------------------
const scenarios = [
  {
    id: 'ⓐ 原样（对照）',
    mutate: () => {},
    expect: 0,
    expectText: '[teeth-scripts] PASS',
    why: '基线：两个夹具都打印结论、无副作用，闸必须是绿的',
  },
  {
    id: '① 夹具崩掉',
    mutate: () => write('tools/zz-teeth.mjs', `console.log('[zz-teeth] PASS');\nprocess.exit(1);\n`),
    expect: 1,
    expectText: '跑完是绿的',
    why: '判据①：退出码不是 0 就要响',
  },
  {
    id: '② 夹具空转（什么都不验还报绿）',
    mutate: () => write('tools/zz-teeth.mjs', `process.exit(0);\n`),
    expect: 1,
    expectText: '输出里有场景结论',
    why: '判据②：一个结论标记都打不出来 = 它多半什么都没验',
  },
  {
    id: '③ 夹具「跳过」（真出过事的那种）',
    mutate: () =>
      write('tools/zz-teeth.mjs', `console.log('⚠️ 跳过：没有产物，这一步需要产物才能做实验。');\nprocess.exit(0);\n`),
    expect: 1,
    expectText: '输出里有场景结论',
    why: '判据②：2026-09-27 真的在 test-smoke-runtime-teeth 上撞过一次',
  },
  {
    id: '④ 夹具跑完留下文件',
    mutate: () =>
      write(
        'tools/zz-teeth.mjs',
        `console.log('[zz-teeth] PASS');\nrequire('node:fs').writeFileSync('_zz-residue.txt', 'x');\n`
      ),
    expect: 1,
    expectText: '跑完工作区没变化',
    why: '判据③：变异没还原 / 沙盒没删，都在这里响',
  },
  {
    id: '③b 夹具删掉产物目录（git status 看不见的那种）',
    mutate: () => {
      // 造一份假产物 —— 第 34 步认的是「目录名 + index.html」，不需要真打包
      fs.mkdirSync(path.join(SB, 'dist-localcheck-web'), { recursive: true });
      fs.writeFileSync(path.join(SB, 'dist-localcheck-web', 'index.html'), '<html></html>\n');
      // 先打印结论再删：① ② 都照绿，只有 ③b 该红 —— 单一变量，红得干净
      write(
        'tools/zz-teeth.mjs',
        [
          "console.log('  ✓ 夹具：做了一次实验，结论是通过');",
          "console.log('[zz-teeth] PASS');",
          "require('node:fs').rmSync('dist-localcheck-web', { recursive: true, force: true });",
        ].join('\n')
      );
    },
    expect: 1,
    expectText: '跑完产物目录还在',
    why: '判据③b：产物目录 match .gitignore，git status 一句都不会说 —— 少了这条，CI #66/#67 那种「上一步把下一步要用的产物删了」永远没人响',
  },
  {
    id: '⑤ 登记表吐不出东西',
    mutate: () =>
      rep(
        'tools/runtests.mjs',
        "    process.stdout.write(`${name}\\t${self}\\t${d.teeth || ''}\\n`);",
        "    process.stdout.write(`# ${name}（这一行故意不带制表符）\\n`);"
      ),
    expect: 1,
    expectText: '问得到登记表',
    why: '判据④：拿不到数就不许判绿（扫到 0 条静默全绿是这个仓库的老事故）',
  },
  {
    id: '⑥ 牙齿脚本本身被人删了',
    mutate: () => fs.rmSync(path.join(SB, 'tools/zz-other-teeth.mjs')),
    expect: 1,
    expectText: '问得到登记表',
    why: '换掉了原先那条「未登记例外还在原位」（那份豁免名单在 2026-09-27 连同它一起删了）：牙齿脚本改名 / 被删之后登记表会直接拒绝开跑，第 34 步连清单都问不到 —— 必须有人来看',
  },
  {
    id: '⑦ tools/ 下冒出未登记的牙齿脚本',
    mutate: () => writeNew('tools/test-zz-new-teeth.mjs', `console.log('我是新的牙齿脚本');\n`),
    expect: 1,
    expectText: '没登记进套装',
    why: '判据⑥：文件名像牙齿却没登记 = 它不会被任何人跑',
  },
  {
    id: '⑧ 换个写法但仍然合格（对照）',
    mutate: () => write('tools/zz-teeth.mjs', `console.log('✅ 8 个场景全部合预期');\n`),
    expect: 0,
    expectText: '[teeth-scripts] PASS',
    why: '反向对照：判据认的是「有没有结论」，不是某一种固定写法',
  },
  {
    id: '⑨ 拿掉判据② 会怎样（反向，故意期望绿）',
    mutate: () => {
      write('tools/zz-teeth.mjs', `process.exit(0);\n`); // 空转：什么都不验
      rep('tools/verify-teeth-scripts.mjs', 'const VERDICT = /PASS|FAIL|✅|❌|✓|✗/;', 'const VERDICT = /[\\s\\S]*/;');
    },
    expect: 0,
    expectText: '[teeth-scripts] PASS',
    why: '把判据放宽到「什么都算结论」之后，空转脚本照样被判绿 —— 说明判据②是承重的',
  },
];

// ---- 开跑 ---------------------------------------------------------------
console.log('【第 35 步】第 34 步「每个牙齿脚本都真的验到了东西」这道闸有没有牙齿');

// 先记下真文件的指纹，收工时逐字节比对（沙盒只许碰沙盒）
const before = COPIES.map((f) => [f, sha(path.join(ROOT, f))]);
const rootStatusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;

let bad = 0;
for (const s of scenarios) {
  buildSandbox();
  try {
    s.mutate();
  } catch (e) {
    console.log(`❌ ${s.id} —— 变异没落上：${e.message}`);
    bad++;
    continue;
  }
  const r = await runGate();
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = r.status === s.expect && out.includes(s.expectText);
  console.log(`${pass ? '✅' : '❌'} ${s.id}`);
  console.log(`    期望 exit=${s.expect}${s.expectText ? ` 且报出「${s.expectText}」` : ''}`);
  console.log(`    实际 exit=${r.status}`);
  if (!pass) {
    out.trim().split('\n').filter((l) => l.includes('✗') || l.includes('[')).slice(0, 6).forEach((l) => console.log('    ' + l.trim()));
  }
  console.log(`    └ ${s.why}`);
  if (!pass) bad++;
}

// ---- 收工核验 -----------------------------------------------------------
console.log('\n  收工核验：');
for (const [f, h] of before) {
  const now = sha(path.join(ROOT, f));
  const ok = now === h;
  console.log(`    ${ok ? '✓' : '✗'} ${f} ${ok ? '逐字节未动' : `★ 变了！${h} → ${now}`}`);
  if (!ok) bad++;
}
const rootStatusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;
const rootClean = rootStatusAfter === rootStatusBefore;
console.log(`    ${rootClean ? '✓' : '✗'} 真仓库状态没变${rootClean ? '' : `（\n${rootStatusAfter}）`}`);
if (!rootClean) bad++;

// ⚠️ 这里**不能**写 `spawnSync('cmd', ['/c','rmdir',...])` —— 那是 Windows 专属，
//    CI 是 ubuntu runner，`cmd` 根本不存在，沙盒删不掉 → 收工核验判红。
//    本地（Windows）完全看不出来，只有 CI 会红 —— #65 就是这么红的。
//    用 step-runner 里那个跨平台且有硬上限的 rmTreeBounded（fs.rmSync 在这台
//    机器上会卡住不返回，所以必须丢给子进程 + 带上限）。
const rm = await rmTreeBounded(SB, { timeoutMs: 20000 });
console.log(
  `    ${rm.gone ? '✓' : '✗'} 沙盒已删除${rm.gone ? '' : `（${rm.timedOut ? '清理超时，进程已杀' : '未知原因'}）`}`
);
if (!rm.gone) bad++;

console.log(bad ? `\n❌ ${bad} 个场景不合预期` : `\n✅ ${scenarios.length} 个场景全部合预期`);
process.exit(bad ? 1 : 0);
