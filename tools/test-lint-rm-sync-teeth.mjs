// 第 39 步：给第 38 步（lint-rm-sync）配牙齿。
// ---------------------------------------------------------------------------
// 老规矩：一个检查值得存在，当且仅当**能造出「旧检查通过、新检查失败」的场景**。
// 第 38 步的判据只有一条（CI 脚本里不许直连 fs.rmSync(..., {recursive:true})），
// 但会响错的地方不止一处，逐条造：
//
//   ① 直连 fs.rmSync(dir, {recursive:true})   → 必须红
//   ② 同一个位置改成 rmTreeSyncBounded         → 必须绿（不许误伤正确写法）
//   ③ 扫描器退化：认不出 fs.rmSync 了          → 必须红（金丝雀失联）
//   ④ 注释里提到 fs.rmSync(recursive)          → 必须绿（抹注释得生效）
//   ⑤ 只删单个文件（不带 recursive）           → 必须绿（作用域就到 recursive 为止）
//
// ⚠️ ②⑤ 两个对照组为什么必须有：判据是「带 recursive 的目录删除」，
//    而 rmTreeSyncBounded / 删单个文件 都是**正确写法**。少了它们，
//    一个「见到 fs.rmSync 就红」的无脑检查也能全绿通过 —— 那会把正确写法逼成绕过。
//
// ⚠️ 沙盒里为什么要 copy runtests.mjs 并按登记表造一堆占位脚本：
//    被检查的那一步是**问 runtests --list-steps 拿清单**的（不自己列，防飘）。
//    沙盒里没有 runtests、也没有登记表点名的那些脚本的话，
//    它连清单都拿不到 —— 所有场景都会挂在「拿不到清单」上，
//    看不出真正被测的那条判据。
//
// 用法：node tools/test-lint-rm-sync-teeth.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runStep, rmTreeBounded, rmTreeSyncBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
const SB = path.join(ROOT, '_teeth_sb_38');
const GATE = 'tools/lint-rm-sync.mjs';
// 被检查的那一步要 spawn runtests 问清单，这三件在沙盒里必须有
const DEPS = ['tools/runtests.mjs', 'tools/step-runner.mjs', 'tools/step-registry.mjs'];
// 往哪个 CI 脚本里注入（它在登记表里，会被真的扫到）
const TARGET = 'tools/test-with-timeout.mjs';

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// ---- 问真仓库的登记表（只问一次，用来在沙盒里造占位脚本）-------------------
async function askRegistry(root) {
  const r = await runStep(['tools/runtests.mjs', root, '--list-steps'], {
    cwd: root,
    timeoutMs: 120000,
  });
  if (r.status !== 0) throw new Error(`问登记表失败（exit=${r.status}）\n${r.stdout}${r.stderr}`);
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue;
    const [name, self, teeth] = line.split('\t');
    if (!name || !/^[\w()+-]+$/.test(name)) continue;
    rows.push({ name, self: self || '', teeth: teeth || '' });
  }
  if (!rows.length) throw new Error('登记表一行都没解析出来');
  return rows;
}

const ROWS = await askRegistry(ROOT);
const TARGETS = [...new Set(ROWS.flatMap((r) => [r.self, r.teeth]).filter(Boolean))].sort();

function buildSandbox() {
  rmTreeSyncBounded(SB);
  fs.mkdirSync(path.join(SB, 'tools'), { recursive: true });
  for (const f of [GATE, ...DEPS]) fs.copyFileSync(path.join(ROOT, f), path.join(SB, f));
  // 登记表点名的脚本都得在：不然沙盒里的 runtests 登记核对就红了，
  // 被检查的那一步连清单都拿不到（那就不是在测判据，是在测环境）
  for (const t of TARGETS) {
    const abs = path.join(SB, t);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, `export const stub = 1;\n`);
  }
}

const write = (rel, content) => fs.writeFileSync(path.join(SB, rel), content);
const read = (rel) => fs.readFileSync(path.join(SB, rel), 'utf8');
function rep(rel, from, to) {
  const s = read(rel);
  if (!s.includes(from)) throw new Error(`${rel} 里找不到「${from}」—— 变异没落上，等于没测`);
  fs.writeFileSync(path.join(SB, rel), s.replace(from, to));
}

async function runGate() {
  return runStep([GATE, SB], { cwd: SB, timeoutMs: 120000 });
}

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()');
  needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ---- 场景表 --------------------------------------------------------------
const scenarios = [
  {
    id: 'ⓐ 原样（对照）',
    mutate: () => {},
    expect: 0,
    expectText: '[rm-sync] PASS',
    why: '基线：沙盒里的登记表副本干干净净，闸必须是绿的',
  },
  {
    id: '① 直连 fs.rmSync(dir, {recursive:true})',
    mutate: () =>
      write(
        TARGET,
        "import fs from 'node:fs';\nfs.rmSync(dir, { recursive: true, force: true });\n"
      ),
    expect: 1,
    expectText: '直接 fs.rmSync',
    why: '判据本体：它偶尔不返回，而且是同步的 —— 卡住时整套没有结论',
  },
  {
    id: '② 同一个位置改成 rmTreeSyncBounded（对照）',
    mutate: () =>
      write(
        TARGET,
        "import { rmTreeSyncBounded } from './step-runner.mjs';\nrmTreeSyncBounded(dir);\n"
      ),
    expect: 0,
    expectText: '[rm-sync] PASS',
    why: '反向对照：判的是「带 recursive 的目录删除」，不是「见 fs.rmSync 就红」',
  },
  {
    id: '③ 扫描器退化：认不出 fs.rmSync 了',
    mutate: () => rep(GATE, '/fs\\.rm(?:dir)?Sync\\s*\\(/g', '/(?!)/g'),
    expect: 1,
    expectText: '金丝雀失联',
    why: '金丝雀：认不出来会让这条检查静默全绿 —— 迁移完之后仓库里一处违规都不剩，没有内置金丝雀就再也验不出它坏了',
  },
  {
    id: '④ 注释里提到 fs.rmSync(recursive)（对照）',
    mutate: () =>
      write(TARGET, "// 这里提到 fs.rmSync(dir, { recursive: true }) 只是注释\nexport const n = 1;\n"),
    expect: 0,
    expectText: '[rm-sync] PASS',
    why: '抹注释必须生效 —— 仓库里有 7 处这种注释，不抹的话它们会把闸点着',
  },
  {
    id: '⑤ 只删单个文件，不带 recursive（对照）',
    mutate: () => write(TARGET, "import fs from 'node:fs';\nfs.rmSync(file, { force: true });\n"),
    expect: 0,
    expectText: '[rm-sync] PASS',
    why: '作用域就到「带 recursive 的目录删除」为止 —— 删单个文件没在这台机器上卡过，一刀切会逼出绕过',
  },
];

// ---- 开跑 ---------------------------------------------------------------
console.log('【第 39 步】第 38 步「不许直连 fs.rmSync(recursive) 删目录」这道闸有没有牙齿');

const before = [GATE, ...DEPS].map((f) => [f, sha(path.join(ROOT, f))]);
const rootStatusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;

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
  console.log(`    期望 exit=${s.expect} 且报出「${s.expectText}」；实际 exit=${r.status}`);
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

const rm = await rmTreeBounded(SB, { timeoutMs: 20000 });
console.log(`    ${rm.gone ? '✓' : '✗'} 沙盒已删除${rm.gone ? '' : `（${rm.timedOut ? '清理超时，进程已杀' : '未知原因'}）`}`);
if (!rm.gone) bad++;

console.log(bad ? `\n❌ ${bad} 处不合预期` : `\n✅ ${scenarios.length} 个场景全部合预期`);
process.exit(bad ? 1 : 0);
