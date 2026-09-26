// 第 38 步：CI 里会跑的脚本，**不许在主进程里直接 fs.rmSync(..., {recursive:true}) 删目录**。
// ---------------------------------------------------------------------------
// 起因（2026-09-27，这次不是听说的，是量出来的）：
//   新加的第 37 步一进全套就连挂两次（第 34 步 600s 把它掐断、它自己那步再挂一次），
//   卡在第 ② 个场景之前，一个字都不再打印。查下来是 buildSandbox() 里那句
//   `fs.rmSync(SB, { recursive: true, force: true })`。
//
//   它怎么个卡法（tools/_probe-rmsync.mjs 实测）：12 轮「建 41 个文件 → 删」里
//   **1 轮卡住** —— 目录**已经删掉了**，但调用不返回。1/12 的概率，正好解释了
//   为什么这类脚本平时全绿、隔一阵才挂一次。
//
//   ★ 真正要命的不是「慢」，是**没有任何东西能救它**：
//     fs.rmSync 是同步的，它堵着事件循环，外面那层 runStep 的 10 分钟定时器
//     根本没机会触发 —— 整套跑到那一步就**永远没有结论**。
//     这正是 step-runner.mjs 存在的理由（2026-09-26 挂过 4 小时 17 分），
//     但那条规矩只写在了注释里：**清理**用了 rmTreeBounded，
//     十几个脚本的 buildSandbox() 却照旧直接 fs.rmSync。这一闸补的就是它。
//
// 判据（一条）：登记进 runtests 的脚本里，出现 `fs.rmSync(...)` / `fs.rmdirSync(...)`
//   且带 `recursive` → 红。改用 rmTreeBounded（async）或 rmTreeSyncBounded（同步）。
//
// 为什么范围是「登记过的脚本」而不是整个 tools/：
//   cdp-*.mjs / diag-*.mjs 那批一次性探针里还有十几处同样的写法，但它们**不进 CI** ——
//   它们挂了最多浪费我自己的时间，不会让 CI 没有结论。
//   把它们一起纳入只会逼出一片「为了过闸而改」的改动，反而看不清该盯的那批。
//
// 为什么判据是「带 recursive」而不是「见到 fs.rmSync 就红」：
//   删**单个文件**的 fs.rmSync(file, {force:true}) 没在这台机器上卡过
//   （test-verify-teeth-scripts-teeth.mjs 里就有一处，是变异场景的一部分）。
//   一刀切会把正确用法逼成绕过 —— 这个仓库里「绕过」发生过不止一次。
//
// 用法：node tools/lint-rm-sync.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStep } from './step-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(HERE, '..'));

// ---- 问权威：CI 里到底会跑哪些脚本 ---------------------------------------
// 不自己列清单（这个仓库里「两份逻辑飘开」出现过四次）：真的 spawn 一次
//   `runtests.mjs --list-steps`，跟第 34 步同一个口径。
async function askRegistry(root) {
  const r = await runStep(['tools/runtests.mjs', root, '--list-steps'], {
    cwd: root,
    timeoutMs: 120000,
  });
  if (r.status !== 0) {
    throw new Error(`问登记表失败（exit=${r.status}）\n${r.stdout}${r.stderr}`);
  }
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue;
    const [name, self, teeth] = line.split('\t');
    if (!name || !/^[\w()+-]+$/.test(name)) continue;
    rows.push({ name, self: self || '', teeth: teeth || '' });
  }
  return rows;
}

// ---- 抹掉注释和**字符串字面量的内容**（保持长度与换行，行号才准）-----------
// ★ 为什么必须抹字符串：本文件自己就带着 3 段内置金丝雀样例，输出文案里也写着
//   被禁的写法 —— 它们全是字符串。第一次跑就红了 9 处，其中 4 处在本文件、
//   5 处在它自己的牙齿脚本里，**没有一处是真违规**。
//
// ⚠️ 这条只对「**函数名在代码里**」的检查成立。第 36 步（platform-cmds）判的是
//    `spawnSync('cmd')` 里的**命令名** —— 那本身就在字符串里，抹了就把判据抹没了。
//    同一个「代码 vs 数据」的冲突，两个检查的解法相反，原因就在这。
function maskLiterals(src) {
  let out = '';
  let mode = 'code'; // code | line | block | single | double | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i++; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i++; continue; }
      if (c === "'") { mode = 'single'; out += ' '; continue; }
      if (c === '"') { mode = 'double'; out += ' '; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; continue; }
      out += c;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; } else { out += ' '; }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i++; } else { out += c === '\n' ? '\n' : ' '; }
      continue;
    }
    // 三种引号内部：转义字符吃掉下一个，模板里的 ${ 也一并抹掉（里面就算有代码，
    // 也是「要打印出来的内容」，不是本文件要跑的命令）
    if (c === '\\') { out += '  '; i++; continue; }
    if (mode === 'tpl' && c === '$' && n === '{') { out += '  '; i++; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'; out += ' '; continue;
    }
    out += c === '\n' ? '\n' : ' ';
  }
  return out;
}

// 命中判据（就这一行；第 39 步的「扫描器退化」场景会改它来验证金丝雀）
const HITS_RE = /fs\.rm(?:dir)?Sync\s*\(/g;

// 同一行往后看两行：`fs.rmSync(dir, {\n  recursive: true,\n})` 这种也要抓到
const RECURSIVE_WINDOW = 2;

function scanSrc(src, rel, tag) {
  const masked = maskLiterals(src);
  const lines = masked.split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    HITS_RE.lastIndex = 0;
    if (!HITS_RE.test(l)) return;
    const win = lines.slice(i, i + 1 + RECURSIVE_WINDOW).join('\n');
    if (!/recursive/.test(win)) return;
    hits.push({ rel: rel || tag, line: i + 1, code: l.trim().slice(0, 70) });
  });
  return hits;
}

// ---- 金丝雀：扫描器自己退化时要响 -----------------------------------------
// 迁移完之后仓库里**一处违规都不剩**了 —— 一个正例都没有的检查，
// 退化成「什么都扫不到」时照样全绿。所以金丝雀不能靠仓库里的真违规，
// 只能**内置三段源码**自己扫自己：
//   B1 真违规（带 recursive）      → 必须报 1
//   B2 正确写法 rmTreeSyncBounded   → 必须报 0
//   B3 注释里提到 fs.rmSync(recursive) → 必须报 0（抹注释得生效）
const CANARY_SRC = [
  "import fs from 'node:fs';\nfs.rmSync(dir, { recursive: true, force: true });\n",
  "import { rmTreeSyncBounded } from './step-runner.mjs';\nrmTreeSyncBounded(dir);\n",
  "// 清理不许卡住：fs.rmSync(recursive) 在这台机器上会卡住不返回\nrmTreeBounded(dir);\n",
];
const CANARY_EXPECT = [1, 0, 0];

let rows;
try {
  rows = await askRegistry(ROOT);
} catch (e) {
  process.stdout.write(`\n[rm-sync] FAIL — ${e.message.split('\n')[0]}\n`);
  process.stdout.write('  拿不到「CI 会跑哪些脚本」这份清单，就不许判绿。\n\n');
  process.exit(1);
}

const targets = [...new Set(rows.flatMap((r) => [r.self, r.teeth]).filter(Boolean))].sort();

// 金丝雀 A：清单本身要够大
if (targets.length < 20) {
  process.stdout.write(`\n[rm-sync] FAIL — 登记表只给出 ${targets.length} 个脚本（正常 37 步 + 牙齿，应该 30+）\n`);
  process.stdout.write('  「一个都没扫到」会让这一步静默全绿 —— 这个仓库已经四次栽在这个形状上。\n\n');
  process.exit(1);
}

// 金丝雀 B：内置三段源码自测
for (let i = 0; i < CANARY_SRC.length; i++) {
  const got = scanSrc(CANARY_SRC[i], null, `金丝雀B${i + 1}`).length;
  if (got !== CANARY_EXPECT[i]) {
    process.stdout.write(`\n[rm-sync] FAIL — 金丝雀失联：内置样例 B${i + 1} 期望报 ${CANARY_EXPECT[i]} 处，实际 ${got} 处\n`);
    process.stdout.write(`    样例：${CANARY_SRC[i].split('\n').filter(Boolean).join(' ⏎ ')}\n`);
    process.stdout.write('    识别规则坏了的话，这一步会静默全绿 —— 那比报错更坏。\n\n');
    process.exit(1);
  }
}

// ---- 开扫 ----------------------------------------------------------------
const bad = [];
let scanned = 0;
for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue; // 不存在由登记核对那条闸去管
  scanned++;
  bad.push(...scanSrc(fs.readFileSync(abs, 'utf8'), rel, rel));
}

process.stdout.write(`\n[rm-sync] 问到 ${targets.length} 个 CI 脚本，实扫 ${scanned} 个\n`);

if (bad.length) {
  process.stdout.write(`\n  ✗ ${bad.length} 处在主进程里直接 fs.rmSync(..., {recursive:true}) 删目录：\n\n`);
  for (const h of bad) process.stdout.write(`    ${h.rel}:${h.line}  ${h.code}\n`);
  process.stdout.write('\n  它**偶尔不返回**（实测 12 轮 1 轮），而且是同步的 ——\n');
  process.stdout.write('  卡住时事件循环被堵死，外面 10 分钟的超时也救不回来，整套就没有结论了。\n');
  process.stdout.write('  改成：rmTreeBounded(dir)（async）或 rmTreeSyncBounded(dir)（同步、有硬上限）。\n\n');
  process.exit(1);
}

process.stdout.write(
  `[rm-sync] PASS — CI 会跑的脚本里没有一处直连 fs.rmSync(recursive)`
  + `（金丝雀：内置 3 段样例 + 登记表 ${targets.length} 个脚本）\n`
);
