// 第 36 步：跨平台脚本里，**平台专属的系统命令必须有 process.platform 守卫**。
// ---------------------------------------------------------------------------
// 起因（2026-09-27，CI #65 那次真事故）：
//   第 35 步删沙盒写的是 `spawnSync('cmd', ['/c', 'rmdir', ...])`。
//   本机是 Windows，跑得好好的；CI 是 ubuntu runner，**没有 cmd** ——
//   于是沙盒没删掉，收工核验判红。而这一步在本机怎么跑都是绿的，
//   除了推上去让 CI 跑一遍，没有任何办法发现。
//
//   事故之后我在注释里写了「禁 Windows 专属写法」，也写进了记忆和 SKILL。
//   但**那只是下次记得** —— 这一轮又是同一个形状（这次是产物目录被抹），
//   我才发现那条规矩从来没变成过机器能执行的东西。这一步就是把它补上。
//
// ★ 判据不是「不许用平台专属命令」，而是「用了就必须有平台守卫」。
//   这条区别是实测逼出来的：扫第一遍就撞上 `tools/step-runner.mjs` 里的
//   `taskkill` —— 它是 **Windows 专属**，但它被包在
//   `if (process.platform === 'win32') { … }` 里、下面另有 `process.kill(-pid)`
//   给其它平台兜底。**那正是唯一正确的写法**，禁掉它就等于逼人用手写跨平台。
//
// 怎么判「有守卫」：往上（含本行）8 行内出现 `process.platform` 就算。
//   ⚠️ 这是**松**判据：8 行内有个不相关的平台判断也会放行。
//     之所以敢松，是因为误伤的代价更大 —— 一刀切禁词会把上面那种正确写法
//     逼成绕过检查（这个仓库里「绕过」发生过不止一次）。松一点，漏网靠人看。
//
// ⚠️ 抹掉注释再扫：我自己解释这个坑的那行注释里就有 `'cmd'` 字面量 ——
//    不抹的话它会把自己点着（第 30 步那条检查当年就是这么中招的）。
//
// 用法：node tools/lint-platform-cmds.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(HERE, '..'));

// ---- 范围：只扫 tools/ ---------------------------------------------------
// src/ 是前端代码，不 spawn 子进程；archive/ 是一次性历史脚本，不进 CI。
// `_` 打头的是开发过程产物（第 30 步的 walk 也是这个口径）。
const SCAN_DIR = 'tools';
// ⚠️ 'fixtures' 为什么必须跳过（2026-09-27 实测，不是设想）：
//   牙齿脚本要往沙盒里注入**坏代码**，那些坏代码原本是写在脚本里的字符串。
//   而一个扫源码文本的检查**分不清「代码」和「被写出去的数据」** ——
//   第 36 步第一次上全套就红了 3 处，全是我自己那个牙齿脚本里写进夹具的
//   `spawnSync('cmd', ...)` / `'C:\\Users\\x'` / `'run.bat'`。
//   所以夹具单独放到 tools/fixtures/ 下，由这里**点名跳过**。
//   ★ 刻意**不开**行内豁免注释那种口子：开了，真违规也能贴个注释混过去。
const SKIP_DIR_NAMES = new Set(['archive', 'node_modules', '.git', 'tmp', 'fixtures']);

function walk(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name) || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      walk(abs, acc);
    } else if (e.isFile()) {
      if (!/\.(mjs|js)$/.test(e.name)) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.tmp-')) continue;
      acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  }
  return acc;
}

// 抹平注释，**保持长度不变**，行号才准
function maskComments(src) {
  return src.split('\n').map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? ' '.repeat(l.length) : l)).join('\n');
}

// ---- 平台专属命令名单 -----------------------------------------------------
// 只列「另一边根本不会有」的。两边都有的（git / node / bash）不列 ——
//   列进去只会逼人改写法，抓不到真问题。
const WIN_ONLY = new Set([
  'cmd', 'cmd.exe', 'taskkill', 'tasklist', 'rmdir', 'powershell', 'powershell.exe',
  'wmic', 'mklink', 'xcopy', 'sc', 'reg',
]);
const UNIX_ONLY = new Set(['pkill', 'killall']);
// 绝对路径形式的 Unix 工具 —— Windows 上 Git Bash 有、cmd 里没有，属于半专属，
//   execSync 走的是 cmd，所以照样会炸。
const UNIX_ABS = /^\/(?:bin|usr\/bin|sbin)\//;
// execSync 里整条命令写成字符串时的 Unix 味儿（rm -rf / cp / mv）
const UNIX_SHELL_CMD = /^\s*(?:rm\s+-|cp\s|mv\s|ln\s+-)/;

function classify(bin, fnName) {
  const b = bin.trim();
  if (WIN_ONLY.has(b.toLowerCase())) return 'windows';
  if (UNIX_ONLY.has(b)) return 'unix';
  if (UNIX_ABS.test(b)) return 'unix';
  // execSync 默认走 shell，整条命令可能写成 'rm -rf xxx'
  if (fnName === 'execSync' && UNIX_SHELL_CMD.test(b)) return 'unix';
  return null;
}

const CALL_RE = /\b(spawn|spawnSync|execSync|execFile)\s*\(\s*(['"`])([^'"`]*)\2/g;

function scanFile(rel) {
  const src = maskComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const lines = src.split('\n');
  const hits = [];

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const [, fn, , bin] = m;
    const line = src.slice(0, m.index).split('\n').length;
    const kind = classify(bin, fn);
    if (!kind) continue;
    // 往上（含本行）8 行内找平台判断
    let guarded = false;
    for (let i = line - 1; i >= Math.max(0, line - 1 - 8); i--) {
      if (/process\.platform/.test(lines[i])) { guarded = true; break; }
    }
    hits.push({ rel, line, fn, bin, kind, guarded });
  }

  // 硬编码的 Windows 盘符路径 —— 这个没有「正确用法」，出现即红
  lines.forEach((l, i) => {
    if (/['"`][A-Za-z]:\\/.test(l)) hits.push({ rel, line: i + 1, fn: '(路径字面量)', bin: l.trim().slice(0, 60), kind: 'winpath', guarded: false });
  });
  // .bat / .cmd / .ps1 作为子进程目标
  lines.forEach((l, i) => {
    if (/\.(?:bat|cmd|ps1)['"`]\s*[,)]/.test(l)) hits.push({ rel, line: i + 1, fn: '(脚本后缀)', bin: l.trim().slice(0, 60), kind: 'winext', guarded: false });
  });

  return hits;
}

// ---- 开跑 ----------------------------------------------------------------
const files = walk(path.join(ROOT, SCAN_DIR)).sort();
const all = [];
for (const f of files) all.push(...scanFile(f));

const bad = all.filter((h) => !h.guarded);
const guarded = all.filter((h) => h.guarded);

process.stdout.write(`\n[platform-cmds] 扫了 ${files.length} 个脚本，`
  + `${all.length} 处平台专属调用（${guarded.length} 处有 process.platform 守卫）\n`);

if (bad.length) {
  process.stdout.write(`\n  ✗ ${bad.length} 处用了只在某一平台存在的命令，却没有平台守卫：\n\n`);
  for (const h of bad) {
    process.stdout.write(`    ${h.rel}:${h.line}  ${h.fn}(${JSON.stringify(h.bin)})  【${h.kind}】\n`);
  }
  process.stdout.write('\n  本机是 Windows、CI 是 ubuntu runner：命令在另一边不存在时，\n');
  process.stdout.write('  它不会报错，只会**静默地什么事都没做**，然后被后面的判据当成「失败了」。\n');
  process.stdout.write('  ⚠️ 这类 bug 在本机永远看不出来 —— 推上去之前没有任何办法发现。\n');
  process.stdout.write('  正确写法（tools/step-runner.mjs 里的 taskkill 就是范本）：\n');
  process.stdout.write("    if (process.platform === 'win32') { …win 写法… } else { …其它平台… }\n\n");
  process.exit(1);
}

// ---- 金丝雀：扫描器自己退化时要响 -----------------------------------------
// 「一个都没扫到」会让这一步静默全绿 —— 这个仓库已经四次栽在这个形状上。
if (files.length < 30) {
  process.stdout.write(`\n  ✗ 只扫到 ${files.length} 个脚本 —— 扫描范围多半坏了（正常 200+）\n\n`);
  process.exit(1);
}
const CANARY = { rel: 'tools/step-runner.mjs', bin: 'taskkill' };
const canaryOk = fs.existsSync(path.join(ROOT, CANARY.rel))
  && scanFile(CANARY.rel).some((h) => h.bin === CANARY.bin && h.guarded);
if (!canaryOk) {
  process.stdout.write(`\n  ✗ 金丝雀失联：${CANARY.rel} 里的 taskkill 应该被认成「有守卫」却没认出来\n`);
  process.stdout.write('    要么是那段代码改坏了（那它现在就是个跨平台事故），\n');
  process.stdout.write('    要么是上面的识别规则坏了 —— 两种都得有人来看。\n\n');
  process.exit(1);
}

// ⚠️ 这里**没有**断言助手函数（判据只有一条，直接 exit 就是了），所以不需要
//    needBool/needLabel 那套守卫 —— 第 30 步（lint-assert-guards）认的是
//    「函数里把参数当真假用」，本文件没有这种函数，它不会来扫。
//    别为了「显得符合规矩」硬塞一个：凑出来的守卫比没有更假。
process.stdout.write(
  `[platform-cmds] PASS — 平台专属命令都在 process.platform 分支里（金丝雀：${CANARY.rel} 的 taskkill）\n`
);
