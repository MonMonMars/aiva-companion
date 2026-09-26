// 常驻牙齿：证明那几条「扫描式检查」在**收集环节失效时会响**，而不是静默全绿。
// ---------------------------------------------------------------------------
// 为什么要有（SKILL 第 71 条的同款洞，第 74 条的同一族）：
//   lint-net-calls / lint-styles / lint-imports / check-persona-coverage 都是
//   「扫到什么就对什么」—— 一旦收集文件/角色的那一步失效（源码目录搬走、
//   扩展名改成 .mjs、角色 id 多了个新前缀），`bad` 计数就是 0，于是它们
//   会**一声不吭地报通过**。这不是"没问题"，是"这条检查这回根本没验东西"，
//   而且比没有这条检查更糟：它让人以为这件事有人守着。
//
// 所以这里给每条检查造一个「收集环节坏掉」的场景，要求它**必须是红的**。
//
// ⚠️ 本脚本只断言**当前**这几条检查的行为，**不依赖 git HEAD 是哪个版本** ——
//    早先那种「从 HEAD 取旧版做对比」的取证一次性有效，提交之后就跑不出来了
//    （那次对比做过：旧版在空目录上退 0，见 memory ㉛）。
//
// 用法：node tools/test-lint-zero-scan-teeth.mjs .
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTreeBounded } from './step-runner.mjs';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_teethsb');           // 沙盒：造坏掉的仓库副本
const NODE = process.execPath;

let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const run = (script, args, cwd) => {
  const r = spawnSync(NODE, [path.isAbsolute(script) ? script : path.join(ROOT, script), ...args],
    { encoding: 'utf8', cwd: cwd || ROOT, maxBuffer: 1 << 24 });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
};

// ---------- 0. 沙盒准备：先删干净（SKILL 第 61 条：旧证据会冒充新证据） ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB, 'src', 'anim'), { recursive: true });
fs.mkdirSync(path.join(SB, 'tools'), { recursive: true });
fs.mkdirSync(path.join(SB, '只放非源码文件'), { recursive: true });
fs.writeFileSync(path.join(SB, '只放非源码文件', 'readme.md'), '这里故意不放任何 js');

console.log('① 空目录 / 无源码文件 —— 三条文件扫描类检查必须红');
{
  const src = path.join(SB, 'src');
  const cases = [
    ['lint-net-calls', 'tools/lint-net-calls.mjs', [src]],
    ['lint-styles', 'tools/lint-styles.mjs', [path.join(SB, '只放非源码文件')]],
    ['lint-imports', 'tools/lint-imports.mjs', [SB]],
  ];
  for (const [name, script, args] of cases) {
    const r = run(script, args);
    check(r.code !== 0, `${name}：扫到 0 个文件时退出码 ${r.code}（要非 0）`);
    check(/一个文件都没扫到/.test(r.out), `${name}：报错里点明「一个文件都没扫到」`);
  }
}

// ---------- ② check-persona-coverage：角色 id 正则漏掉新前缀 ----------
// 它不吃目录参数（按 __dirname 找 src/），所以这里造一份**沙盒仓库**，
// 往 PERSONAS 里塞一个 id 前缀不在正则里的角色：
//   旧行为：这条角色**从来不会被核对**，而报表看着一切正常（静默的假绿）。
//   现在的交叉核对应当抓住它。
console.log('\n② check-persona-coverage：PERSONAS 里出现正则收不到的角色 id');
{
  for (const f of ['src/theme.js', 'src/llm.js', 'src/anim/idlePoses.js', 'src/backgrounds.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(SB, f));
  }
  fs.copyFileSync(path.join(ROOT, 'tools/check-persona-coverage.mjs'), path.join(SB, 'tools/check-persona-coverage.mjs'));
  fs.mkdirSync(path.join(SB, 'src/anim'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src/anim/idlePoses.js'), path.join(SB, 'src/anim/idlePoses.js'));

  const themePath = path.join(SB, 'src/theme.js');
  let theme = fs.readFileSync(themePath, 'utf8');
  const pStart = theme.indexOf('export const PERSONAS = [');
  const pEnd = theme.indexOf('export const getPersona');
  if (pStart < 0 || pEnd < 0) { console.log('  ✗ 沙盒里定位不到 PERSONAS 块 —— 这个场景没造起来'); fails++; }
  const block = theme.slice(pStart, pEnd);
  const at = block.indexOf("id: 'realistic-noa'");
  if (at < 0) { console.log('  ✗ 沙盒里找不到 realistic-noa —— 这个场景没造起来'); fails++; }
  const start = block.lastIndexOf('\n  {\n', at);
  let next = block.indexOf('\n  {\n', at);
  if (next < 0) next = block.length;
  let clone = block.slice(start < 0 ? 0 : start, next);
  // 换掉 id（新前缀 zz- 不在正则里），并换一个**别的** idle 姿势，
  // 免得撞上「签名姿势重复」那条 —— 那样新旧版都会红，就验不出是不是交叉核对抓的
  const idleIds = [...fs.readFileSync(path.join(SB, 'src/anim/idlePoses.js'), 'utf8')
    .matchAll(/id: '([a-z0-9-]+)',\s*\n\s*name: '[^']*',\s*\n\s*tag: 'idle'/g)].map((m) => m[1]);
  const noaPose = /idlePose: '([a-z0-9-]+)'/.exec(clone)?.[1];
  const other = idleIds.find((i) => i !== noaPose);
  clone = clone.replace("id: 'realistic-noa'", "id: 'zz-demo'");
  if (other) clone = clone.replace(`idlePose: '${noaPose}'`, `idlePose: '${other}'`);
  theme = theme.slice(0, pEnd) + clone + theme.slice(pEnd);
  fs.writeFileSync(themePath, theme);
  // ★ 造完先确认 fixture 真的造出来了（SKILL 第 72 条：fixture 造错会长得跟真结果一样）
  check(/id: 'zz-demo'/.test(theme), '沙盒 theme.js 里确实有 id: \'zz-demo\'');
  check(!!other, `换到了另一个 idle 姿势：${noaPose} → ${other}`);

  const r = run(path.join(SB, 'tools/check-persona-coverage.mjs'), [], SB);
  check(r.code !== 0, `交叉核对拦住它：退出码 ${r.code}（要非 0）`);
  check(/没被核对到/.test(r.out), '报错里点明「根本没被核对到」');
}

// ---------- ③ check-persona-coverage：PERSONAS 块定位不到 ----------
console.log('\n③ check-persona-coverage：PERSONAS 块定位不到时也要响');
{
  const themePath = path.join(SB, 'src/theme.js');
  const theme = fs.readFileSync(themePath, 'utf8').replace('export const PERSONAS = [', 'export const PERSONAS_LIST = [');
  fs.writeFileSync(themePath, theme);
  const r = run(path.join(SB, 'tools/check-persona-coverage.mjs'), [], SB);
  check(r.code !== 0, `退出码 ${r.code}（要非 0）`);
  check(/定位不到 PERSONAS 块/.test(r.out), '报错里点明「定位不到 PERSONAS 块」');
}

// ---------- ④ 反向：正常仓库必须全绿（否则说明上面的闸门写得过严） ----------
console.log('\n④ 正常仓库：这几条检查必须还是绿的');
for (const [script, args] of [
  ['tools/lint-net-calls.mjs', []],
  ['tools/lint-styles.mjs', ['.']],
  ['tools/lint-imports.mjs', ['.']],
  ['tools/check-persona-coverage.mjs', []],
]) {
  const r = run(script, args);
  check(r.code === 0, `${path.basename(script)} 退出码 ${r.code}（要 0）`);
}

// 清理不许卡住：fs.rmSync(recursive) 在这台机器上会**卡住不返回** ——
//   八道题全过了却因为清理挂住而整条变红，那是假失败，比挂住更难查。
//   所以丢给子进程做并给它硬上限；真删不掉就如实说，不挡结论。
const rm = await rmTreeBounded(SB);
if (!rm.gone) console.log(`  ⚠️ 沙盒没删干净（${rm.timedOut ? '删除卡住了，进程已杀' : '未知原因'}）—— 留着，不挡结论`);
console.log(fails ? `\n[zero-scan-teeth] FAIL — ${fails} 项没达到预期` : '\n[zero-scan-teeth] PASS — 扫描式检查在收集环节坏掉时会响');
process.exit(fails ? 1 : 0);
