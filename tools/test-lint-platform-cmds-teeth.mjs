// 第 37 步：给第 36 步（lint-platform-cmds）配牙齿。
// ---------------------------------------------------------------------------
// 老规矩：一个检查值得存在，当且仅当**能造出「旧检查通过、新检查失败」的场景**。
// 第 36 步的判据只有一条（平台专属命令必须有 process.platform 守卫），
// 但要盯的不止一处，逐条造：
//
//   ① 裸写 Windows 命令（cmd）            → 必须红
//   ② 同一个 cmd 但包在平台分支里          → 必须绿（不许误伤，这是关键对照组）
//   ③ 扫描器退化：认不出 Windows 命令了    → 必须红（金丝雀失联）
//   ④ 注释里提到 cmd                      → 必须绿（证明抹注释生效）
//   ⑤ 硬编码 Windows 盘符路径              → 必须红
//   ⑥ .bat 作为子进程目标                  → 必须红
//   ⑦ Unix 专属命令 pkill 无守卫           → 必须红（反方向也要管）
//
// ⚠️ 为什么要②这个对照组：判据是「用了平台专属命令就该有守卫」，
//    而 `taskkill` 那种**正确写法**用的也是平台专属命令。少了②，
//    一个「见命令就红」的检查也能混过去 —— 那会把唯一正确的写法逼成绕过。
//
// ⚠️ 沙盒里为什么要造一批占位脚本：被检查的那一步自带一条金丝雀
//    「扫不到 30 个脚本就说明扫描范围坏了」。沙盒里只有几个文件的话，
//    所有场景都会挂在金丝雀上，看不出真正被测的那条判据。
//
// ⚠️ 夹具为什么单独放 tools/fixtures/（见下面 useFixture 的注释）：
//    坏代码写在本文件里会被第 36 步当成真违规扫出来 —— 第一次上全套就红了 3 处。
//
// ⚠️ 沙盒为什么用 rmTreeSyncBounded 删而不是 fs.rmSync：
//    fs.rmSync(dir, {recursive:true}) 在这台机器上**偶尔不返回**（实测 12 轮 1 轮），
//    而且它是同步的、堵着事件循环 —— 连外面 10 分钟的超时都救不回来。
//    这一步第一次进全套时就是这么挂掉的（第 34 步 600s 掐断、自己那步再挂一次）。
//
// 用法：node tools/test-lint-platform-cmds-teeth.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runStep, rmTreeBounded, rmTreeSyncBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
const SB = path.join(ROOT, '_teeth_sb_36');
const GATE = 'tools/lint-platform-cmds.mjs';
// 金丝雀点名了它，沙盒里必须有，而且不能改
const CANARY_SRC = 'tools/step-runner.mjs';

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

const FIXTURE = 'tools/zz-plat.mjs';

function buildSandbox() {
  rmTreeSyncBounded(SB);
  fs.mkdirSync(path.join(SB, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, GATE), path.join(SB, GATE));
  fs.copyFileSync(path.join(ROOT, CANARY_SRC), path.join(SB, CANARY_SRC));
  // 占位脚本：让「扫到多少个文件」那条金丝雀不至于自己响（正常是 200 个）
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(SB, 'tools', `zz-filler-${i}.mjs`), `export const n = ${i};\n`);
  }
  fs.writeFileSync(path.join(SB, FIXTURE), `export const nothing = 1;\n`);
}

const read = (rel) => fs.readFileSync(path.join(SB, rel), 'utf8');

// ★ 夹具源码**不在本文件里**。原因（2026-09-27 实测，第一次上全套就红了）：
//   第 36 步扫的是 tools/ 下的源码文本，而夹具就是「坏代码」本身 ——
//   把它写成字符串放在本文件里，检查分不清「要执行的命令」和「要写出去的数据」，
//   于是把 spawnSync('cmd') / 'C:\\Users\\x' / 'run.bat' 全判成真违规（3 处假阳性）。
//   挪到 tools/fixtures/ 之后，那边由第 36 步点名跳过，本文件则照旧被扫 ——
//   CI #65 那次事故恰恰出在牙齿脚本里，这个文件**不能**整豁免。
const FX = 'tools/fixtures';
function useFixture(name) {
  const src = path.join(ROOT, FX, name);
  if (!fs.existsSync(src)) {
    throw new Error(`夹具 ${FX}/${name} 不在了 —— 这个场景没东西可注入`);
  }
  fs.copyFileSync(src, path.join(SB, FIXTURE));
}
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
    expectText: '[platform-cmds] PASS',
    why: '基线：沙盒里只有 step-runner 那处有守卫的 taskkill，闸必须是绿的',
  },
  {
    id: '① 裸写 Windows 命令（cmd）',
    mutate: () => useFixture('plat-cmd-bare.mjs'),
    expect: 1,
    expectText: '没有平台守卫',
    why: '判据本体：CI #65 那次事故的形状 —— ubuntu 上没有 cmd，命令静默失败',
  },
  {
    id: '② 同一个 cmd 但包在平台分支里（对照）',
    mutate: () => useFixture('plat-cmd-guarded.mjs'),
    expect: 0,
    expectText: '[platform-cmds] PASS',
    why: '反向对照：判的是「有没有守卫」，不是「见命令就红」—— 少了这条，无脑报错的检查也能混过去',
  },
  {
    id: '③ 扫描器退化：认不出 Windows 命令了',
    mutate: () => rep(GATE, "if (WIN_ONLY.has(b.toLowerCase())) return 'windows';", "if (false) return 'windows';"),
    expect: 1,
    expectText: '金丝雀失联',
    why: '金丝雀：认不出来会让这条检查静默全绿，比直接报错更坏',
  },
  {
    id: '④ 注释里提到 cmd（对照）',
    mutate: () => useFixture('plat-comment.mjs'),
    expect: 0,
    expectText: '[platform-cmds] PASS',
    why: '抹注释必须生效 —— 否则我自己解释这个坑的那行注释会把它自己点着',
  },
  {
    id: '⑤ 硬编码 Windows 盘符路径',
    mutate: () => useFixture('plat-winpath.mjs'),
    expect: 1,
    expectText: '没有平台守卫',
    why: '盘符路径没有「正确用法」，出现即红',
  },
  {
    id: '⑥ .bat 作为子进程目标',
    mutate: () => useFixture('plat-bat.mjs'),
    expect: 1,
    expectText: '没有平台守卫',
    why: '.bat/.cmd/.ps1 在 ubuntu 上跑不起来',
  },
  {
    id: '⑦ Unix 专属命令 pkill 无守卫',
    mutate: () => useFixture('plat-pkill.mjs'),
    expect: 1,
    expectText: '没有平台守卫',
    why: '反方向也要管：本仓库本机是 Windows，Unix 命令在那边同样不存在',
  },
];

// ---- 开跑 ---------------------------------------------------------------
console.log('【第 37 步】第 36 步「平台专属命令必须有平台守卫」这道闸有没有牙齿');

const before = [GATE, CANARY_SRC].map((f) => [f, sha(path.join(ROOT, f))]);
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

// ⚠️ 用 rmTreeBounded，不要写平台专属的删除命令（第 36 步盯的就是这个）
const rm = await rmTreeBounded(SB, { timeoutMs: 20000 });
console.log(`    ${rm.gone ? '✓' : '✗'} 沙盒已删除${rm.gone ? '' : `（${rm.timedOut ? '清理超时，进程已杀' : '未知原因'}）`}`);
if (!rm.gone) bad++;

console.log(bad ? `\n❌ ${bad} 处不合预期` : `\n✅ ${scenarios.length} 个场景全部合预期`);
process.exit(bad ? 1 : 0);
