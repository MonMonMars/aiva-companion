// test-smoke-runtime-teeth.mjs —— 验第 17 步「运行时冒烟」自己有没有牙齿
// ===========================================================================
// 要验的还是那句老规矩：一个检查值得存在，当且仅当**能造出「旧检查通过、
// 新检查失败」的场景**。冒烟那四条老断言（React 挂载 / 无未捕获异常 /
// 无 console error / 能走到 Home）没有一条看资源加载，那就造一个
// 「资产整个没进产物」的现场：把产物里所有 `.glb` 改名藏起来，再跑一遍冒烟。
//
//   期望：前四条**全部照绿**（这正是「旧检查放行」的证据），
//         第五条「模型挂上」必须把住 → 整体 FAIL。
//
// 实测（第一次手工做这个实验时记下的）：
//   root 子节点数 1 / 未捕获异常 0 / console error 0 / 进入 Home 是
//   → 四条一条都没拦住。console error 也是 0 是因为**网络 404 走
//     Network.loadingFailed，不走 Runtime.consoleAPICalled**，听 console 听不见。
//
// 为什么要常驻（和第 19 步同一个理由）：第 17 步的断言一旦被放宽 —— 比如有人
// 嫌 hasRig 太严、改成只警告不失败 —— 最可能发生的事就是「拦截能力没了，
// 而全套照旧全绿」。写在注释里的「改完记得重跑牙齿测试」不会提醒任何人，
// 那就把它变成自动跑的一步。
//
// ⚠️ 代价与取舍：它要再 boot 一次 Chrome，而且因为注定失败，会耗满那 25 秒
//    的轮询等待。所以这里**只做一次破坏场景**；对照组（`.glb` 都在、应当全绿）
//    由第 17 步自己充当 —— 那一步就在前面刚跑过，没必要重复烧时间。
//
// 用法：node tools/test-smoke-runtime-teeth.mjs [项目根]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findDist, distCandidates } from './lib/find-dist.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
// ⚠️ 产物目录**必须和第 17 步挑同一份**（tools/lib/find-dist.mjs，三选一 + 查 index.html）。
//   以前这里写死 `dist-localcheck-web` 一个、连 index.html 都不查，于是环境里
//   只有 dist/ 的时候：第 17 步照常在 dist/ 上做实验，而它的牙齿打印「跳过」
//   然后 exit 0 —— 什么都不验还报绿。2026-09-27 第 34 步实测抓到的就是这个。
const argv = process.argv.slice(3);
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null;
const DIST = findDist(ROOT, dirArg);

function walk(dir, predicate, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, predicate, out);
    else if (predicate(f)) out.push(f);
  }
  return out;
}
const glbs = () => walk(DIST, (f) => f.endsWith('.glb'));
const offs = () => walk(DIST, (f) => f.endsWith('.glb.off'));

// 找不到产物就**红**，不许跳过。
//   早先这里是「⚠️ 跳过…process.exit(0)」，理由是「--fast 跳过打包时没有产物」。
//   但牙齿脚本跳过的代价是：全套照绿，而这一步其实什么都没验 ——
//   比不跑更糟，因为它给了「验过了」的错觉。第 34 步（verify-teeth-scripts）
//   就是专门来抓「什么都不验还报绿」的，这里必须和它保持一致。
if (!DIST) {
  console.log('✗ 找不到可跑的产物，试过：\n  ' + distCandidates(dirArg).join('\n  '));
  console.log('  先跑 npm run export:web，或者先跑第 16 步（node tools/verify-bundle.mjs . --keep）。');
  console.log('  这里**不能**退回「跳过并 exit 0」—— 跳过的牙齿等于没牙齿。');
  process.exit(1);
}

// 先兜底还原：上次要是中途被杀（比如收尾那 25 秒等超时被人打断），
// 会留下 .glb.off，不先收干净的话这一轮的"藏起数量"就不对了。
const stale = offs();
for (const f of stale) fs.renameSync(f, f.slice(0, -4));
if (stale.length) console.log(`  （先还原上次残留的 ${stale.length} 个 .glb.off）`);

const hidden = glbs();
if (!hidden.length) {
  console.log('✗ 产物里一个 .glb 都没有 —— 冒烟那条断言本来就该红，这个实验没意义');
  process.exit(1);
}
for (const f of hidden) fs.renameSync(f, f + '.off');
console.log(`  藏起 ${hidden.length} 个 .glb，再跑一次冒烟…`);

let out = '';
let code = -1;
try {
  // 硬上限：冒烟卡住的话（Chrome 起不来之类）不能把整套带进无限等待
  const r = spawnSync(process.execPath, ['tools/smoke-runtime.mjs', '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  out = (r.stdout || '') + (r.stderr || '');
  code = r.status ?? -1;
  if (r.error) console.log(`  ⚠️ 子进程异常：${r.error.message}`);
} finally {
  // ★ 无论上面发生什么都要还原 —— 产物被改坏比这一步红更麻烦
  const back = offs();
  for (const f of back) fs.renameSync(f, f.slice(0, -4));
  console.log(`  还原 ${back.length} 个 .glb`);
}

console.log(out.trim().split('\n').map((l) => '    ' + l).join('\n'));

// ⚠️ 这条必须先判：冒烟**自己没跑起来**的时候，下面那两条"证据"一条都不成立。
//    CI #41 就是这么骗人的 —— Chrome 连不上，输出里既没有「进入 Home：是」
//    也没有「模型挂上」，牙齿脚本却报「前四条老断言照绿、第五条没拦住」，
//    看着像是断言被人放宽了，实际是探针根本没开工，什么都没验到。
//    把这种"假结论"单独拎出来，免得下次照着错误的方向查半天。
if (/探针自身出错/.test(out)) {
  console.log('\n[smoke-teeth] FAIL — 冒烟探针自己就没跑起来（见上面它打的原因）。');
  console.log('  这**不是**"断言被放宽"，是这个实验根本没做成：Chrome 没起来，');
  console.log('  产物有没有 .glb 都一样，什么都验不出来。先修探针，再谈牙齿。');
  process.exit(1);
}

const checks = [
  [code !== 0, `冒烟必须失败（实际退出码 ${code}）`],
  // 下面这条才是"旧检查放行"的证据：模型没了，它照样说进得了 Home
  [/进入 Home：是/.test(out), '前四条老断言确实照绿（说明它们拦不住这类事故）'],
  [/模型挂上/.test(out), '第五条「模型挂上」必须站出来拦下'],
];
const bad = checks.filter(([ok]) => !ok);
if (bad.length) {
  console.log(`\n[smoke-teeth] FAIL — ${bad.map(([, n]) => n).join('、')}`);
  process.exit(1);
}
console.log(`\n[smoke-teeth] PASS — ${checks.map(([, n]) => n).join('、')}`);
