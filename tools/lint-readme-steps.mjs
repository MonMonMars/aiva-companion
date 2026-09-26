// 第 32 步：README 里写的「第几步 / 一共几步 / 几个变异」必须跟代码对得上。
// ---------------------------------------------------------------------------
// 起因（本轮连续踩到两次）：
//   ① README 写「29 步全套」，加完第 30/31 步之后它变成 31 —— 没人响。
//      我是因为正好要改那段才发现，不是被谁拦下来的。
//   ② 更早一次：`test-assertion-teeth.mjs` 注释与提交信息写「12 个变异、
//      11 杀 1 存活」，实际登记 13 条、13 全杀、0 存活（那个所谓存活者是
//      排查时的临时探针）。数字一旦写进文档，就没有任何东西会盯着它。
//
// 两条合起来的共同点：**文档里的数字是手写的，代码里的数字是活着的**，
// 而它们之间没有任何机器连接。本步就是那根线。
//
// ⚠️ 不重新实现登记规则 —— 那样两份逻辑迟早会飘开（这个仓库里「扫到 0 条就
//    静默全绿」的事故出现过四次，多一份副本就多一份飘的机会）。步数/有牙齿的
//    步数一律**真的 spawn 一次 `runtests.mjs --check-registry` 去问**，
//    解析它打出来的那一行。解析不出来就按失败处理 —— 拿不到数就不许判绿。
//
// ⚠️ 第一版是「代码围栏整块都不查」，结果**正好漏掉最该查的那一行**：
//       npm test              # 29 步全套（含 lint 三条 + …）
//    它躺在一个 ```bash 围栏里 —— 而「README 写着 29、代码已经是 31」正是本步
//    的起因。围栏 ≠ 历史证据：命令示例说的是**现在**该怎么用，贴的 CI 日志
//    才是**当时**的事实。所以改成按行抹（见 maskNonClaims），围栏内的正文照查。
//
// 查什么：
//   ① 「N 步全套」「（N 步）」这类**总数声明**必须等于实际步数
//   ② 「N 步里 M 步有常驻牙齿」必须等于实际的 N / M
//   ③ 【登记核对】示例行的「共 N 步：M 步有常驻牙齿，K 步只靠理由」三个数都要对
//   ④ 「N 组牙齿测试」必须等于登记的 `-teeth` 步数
//   ⑤ README 里最后一个「第 N 步」章节的 N 必须等于实际步数
//   ⑥ 套装里**每一步的名字**都必须在 README 里出现过（改名 / 新加都会被抓）
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStep } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根目录：命令行给了就用给的（第 33 步的牙齿测试要在沙盒副本上跑它）。
//   ⚠️ 默认不能取 '.' —— 后台任务里 cd 不可用，'.' 解析出来的是工作区根。
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(HERE, '..'));

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()'); needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ---- 抹掉不该参与比对的行（按行，保行号）---------------------------------
// 只抹两类：
//   ① 围栏标记行 —— ``` 本身不该被当成正文
//   ② 长得像 CI 日志的行 —— 带头时间戳的那一行记的是当时的事实，不是现在的声明
//      14:51:58.2496782Z 【登记核对】共 29 步：…   ← 历史证据，改它就是改证据
const LOG_LINE = /^\s*(?:##\[|\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s/;
function maskNonClaims(src) {
  return src.split('\n').map((l) => {
    if (/^\s*```/.test(l)) return ' '.repeat(l.length);
    if (LOG_LINE.test(l)) return ' '.repeat(l.length);
    return l;
  }).join('\n');
}

// ---- 中文数字（「十一组牙齿测试」这类写法也要能比对）----------------------
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s === '十') return 10;
  let m = s.match(/^十([一二三四五六七八九])$/);
  if (m) return 10 + CN[m[1]];
  m = s.match(/^([二])十([一二三四五六七八九])?$/);
  if (m) return 20 + (m[2] ? CN[m[2]] : 0);
  m = s.match(/^([一二三四五六七八九])$/);
  if (m) return CN[m[1]];
  return NaN; // 认不出来就返回 NaN —— 它跟任何数都不相等，会红出来叫人来看
}

// ---- 问权威数字 -----------------------------------------------------------
async function askRegistry() {
  const r = await runStep(['tools/runtests.mjs', '.', '--check-registry'], { cwd: ROOT, timeoutMs: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.timedOut) return { err: 'runtests.mjs --check-registry 超过 60 秒没结束' };
  if (r.status !== 0) return { err: `runtests.mjs --check-registry 退出码 ${r.status}（登记有问题，先修那个）` };
  const m = out.match(/共\s*(\d+)\s*步：(\d+)\s*步有常驻牙齿，(\d+)\s*步只靠理由/);
  if (!m) return { err: '输出里找不到「共 N 步：M 步有常驻牙齿，K 步只靠理由」这一行 —— 解析不出来就不许判绿' };
  return { total: +m[1], covered: +m[2], byWhy: +m[3], out };
}

// 步骤名从源码里抠（--check-registry 不打印名单）
const stepNames = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/runtests.mjs'), 'utf8');
  return [...src.matchAll(/REG\.push\('([^']+)'/g)].map((m) => m[1]);
})();

// ---- 开跑 -----------------------------------------------------------------
const reg = await askRegistry();
if (reg.err) {
  console.log(`\n[readme-steps] FAIL — ${reg.err}\n`);
  process.exit(1);
}
const { total, covered } = reg;
const teeth = stepNames.filter((n) => n.endsWith('-teeth')).length;

const readmePath = path.join(ROOT, 'README.md');
if (!fs.existsSync(readmePath)) {
  console.log(`\n[readme-steps] FAIL — 找不到 README.md（${readmePath}）\n`);
  process.exit(1);
}
const raw = fs.readFileSync(readmePath, 'utf8');
const body = maskNonClaims(raw);

console.log(`\n[readme-steps] 实际 ${total} 步（${covered} 步有常驻牙齿，其中牙齿脚本 ${teeth} 个）；README 正文 ${body.length} 字，步骤名 ${stepNames.length} 个\n`);

// 金丝雀之一：抠不出步骤名 = 本步等于没检查，不许静默绿
check(stepNames.length > 0, `runtests.mjs 里抠出了 ${stepNames.length} 个步骤名（一个都抠不出来，多半是写法变了）`);

// ①~④ 数字类
const numClaims = [];
for (const m of body.matchAll(/(\d+)\s*步全套/g)) numClaims.push({ at: m.index, n: +m[1], what: `「${m[0]}」里的 ${m[1]}` });
for (const m of body.matchAll(/[（(](\d+)\s*步[)）]/g)) numClaims.push({ at: m.index, n: +m[1], what: `「${m[0]}」里的 ${m[1]}` });
for (const m of body.matchAll(/(\d+)\s*步里\s*(\d+)\s*步有常驻牙齿/g)) {
  numClaims.push({ at: m.index, n: +m[1], what: `「${m[0]}」里的总数 ${m[1]}` });
  numClaims.push({ at: m.index, n: +m[2], what: `「${m[0]}」里有常驻牙齿的 ${m[2]}`, want: covered });
}
for (const m of body.matchAll(/共\s*(\d+)\s*步：(\d+)\s*步有常驻牙齿，(\d+)\s*步只靠理由/g)) {
  numClaims.push({ at: m.index, n: +m[1], what: `登记核对示例行的总数 ${m[1]}` });
  numClaims.push({ at: m.index, n: +m[2], what: `登记核对示例行里有常驻牙齿的 ${m[2]}`, want: covered });
  numClaims.push({ at: m.index, n: +m[3], what: `登记核对示例行里只靠理由的 ${m[3]}`, want: total - covered });
}
for (const m of body.matchAll(/([0-9]+|[一二三四五六七八九十]+)\s*组牙齿测试/g)) {
  numClaims.push({ at: m.index, n: cnNum(m[1]), what: `「${m[0]}」里的 ${m[1]}`, want: teeth });
}

// ⚠️ 「扫到 0 条就静默全绿」在这个仓库出现过四次 —— 这里同样躲不掉：
//    正则一个都没匹配上（比如 README 换了说法），下面循环一次不进，判绿。
check(numClaims.length > 0,
  `README 里至少得有一处步数声明（一处都没有，多半是正则失配 —— 那等于没检查）`);

const lineOf = (idx) => body.slice(0, idx).split('\n').length;
for (const c of numClaims) {
  const want = c.want ?? total;
  check(c.n === want, `第 ${lineOf(c.at)} 行 ${c.what} —— 实际是 ${want}`);
}

// ⑤ 最后一个「第 N 步」章节的序号 = 总步数
//    加一步却不写章节 → 这里红；删一步却留着章节 → 这里也红。
const headings = [...raw.matchAll(/^#{2,4}\s*第\s*(\d+)\s*步/gm)].map((m) => +m[1]);
const maxHeading = headings.length ? Math.max(...headings) : 0;
check(maxHeading === total, `README 里最后一个「第 N 步」章节是第 ${maxHeading} 步 —— 实际一共 ${total} 步（新加的步骤得在 README 里有自己的章节）`);

// ⑥ 每一步的名字都要在 README 里出现过
//    ⚠️ 查**整篇**（含围栏内）：贴的 CI 日志里有步骤名，那也算「出现过」，
//       查的是「别人能不能在 README 里找到这步」，不是「正文里有没有讲」。
for (const name of stepNames) {
  check(raw.includes(name),
    `步骤名「${name}」在 README 里出现过（新加 / 改名的步骤得在 README 里留下它的名字）`);
}

console.log(bad
  ? `\n[readme-steps] FAIL — ${bad} 处对不上（文档里的数字是手写的，代码里的才是真的）\n`
  : `\n[readme-steps] PASS — README 的步数声明与 ${stepNames.length} 个步骤名都对得上代码\n`);
process.exit(bad ? 1 : 0);
