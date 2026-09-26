// 常驻牙齿：证明 check-persona-coverage（本地第 1 步）**看见缺口会红**。
// ---------------------------------------------------------------------------
// 为什么要有（第 22 / 23 步同一套路子）：
//   这个脚本靠**纯文本解析** theme.js 来判断 18 个角色齐不齐，而文本解析
//   本身就是最容易悄悄失效的东西（文件头的注释里记过：第一版用 split 切块，
//   角色之间的注释把块和 id 错位，一半角色被误报）。它已经有自检（`realistic-noa
//   应当全绿`）+ 交叉核对（PERSONAS 里的 id 不许漏），但**规则本身**
//   —— 少个 tagline、背景 id 写错、姿势不是 idle、签名姿势撞车 ——
//   没有常驻的场景盯着。规则被改松时「所有测试照旧全绿」是最容易出现的假象。
//
// 做法：在**沙盒副本**里改 theme.js（不动真的 src/），每一种缺口要求脚本红；
//       再配一个「原样」的对照组要求它绿 —— 少了对照组，无脑报错的检查也能混过去
//       （SKILL 第 77 条）。
//
// 用法：node tools/test-persona-coverage-teeth.mjs .
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_personasb');
const NODE = process.execPath;
const SRC = ['src/theme.js', 'src/llm.js', 'src/anim/idlePoses.js', 'src/backgrounds.js'];

let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

fs.rmSync(SB, { recursive: true, force: true });   // 第 61 条：先删干净，旧证据会冒充新证据

/** 造一份沙盒仓库，把 theme.js 按 mutator 改过再落盘；返回沙盒根目录 */
function sandbox(mutator) {
  const dir = path.join(SB, 'sb' + (sandbox.n = (sandbox.n || 0) + 1));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'anim'), { recursive: true });
  for (const f of SRC) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'tools/check-persona-coverage.mjs'), path.join(dir, 'tools/check-persona-coverage.mjs'));
  if (mutator) {
    const p = path.join(dir, 'src/theme.js');
    fs.writeFileSync(p, mutator(fs.readFileSync(p, 'utf8')));
  }
  return dir;
}

/** 取出某个角色的那一段原文，改完再塞回去 —— 用 Mei 函数的形式保证改动只落在这一个角色上 */
function onPersona(theme, id, fn) {
  const pStart = theme.indexOf('export const PERSONAS = [');
  const pEnd = theme.indexOf('export const getPersona');
  const block = theme.slice(pStart, pEnd);
  const at = block.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`沙盒里找不到角色 ${id} —— 这个场景没造起来`);
  const start = block.lastIndexOf('\n  {\n', at);
  let next = block.indexOf('\n  {\n', at);
  if (next < 0) next = block.length;
  const chunk = block.slice(start < 0 ? 0 : start, next);
  const out = fn(chunk);
  return theme.slice(0, pStart) + block.slice(0, start < 0 ? 0 : start) + out + block.slice(next) + theme.slice(pEnd);
}

const run = (dir) => {
  const r = spawnSync(NODE, [path.join(dir, 'tools/check-persona-coverage.mjs')], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 24 });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
};
/** count '✗' rows in the report */
const missingCount = (out) => (out.match(/← 有缺口/g) || []).length;

// ---------- 对照组：原样必须绿 ----------
console.log('⓪ 对照组：没动过的角色表必须是绿的');
{
  const base = run(sandbox(null));
  check(base.code === 0, `退出码 ${base.code}（要 0）`);
  check(missingCount(base.out) === 0, `报表里有缺口的角色数 ${missingCount(base.out)}（要 0）`);
  check(/自检（realistic-noa 应当全绿）：✓/.test(base.out), '自检这行要打印 ✓');
}

// ---------- ① 少了 tagline ----------
console.log('\n① 某个角色少了 tagline');
{
  const r = run(sandbox((t) => onPersona(t, 'girlfriend', (c) => c.replace(/\n    tagline:[^\n]*/, ''))));
  check(r.code !== 0, `退出码 ${r.code}（要非 0）`);
  check(missingCount(r.out) >= 1, `报表里要点名这个角色（有缺口数 ${missingCount(r.out)}）`);
}

// ---------- ② bgId 指向不存在的背景 ----------
console.log('\n② bgId 写了背景表里没有的值');
{
  const r = run(sandbox((t) => onPersona(t, 'girlfriend', (c) => c.replace(/bgId: '[a-z]+'/, "bgId: 'nosuchbg'"))));
  check(r.code !== 0, `退出码 ${r.code}（要非 0）`);
  check(/nosuchbg/.test(r.out), '报表里要打出那个不存在的 bgId');
}

// ---------- ③ 签名姿势不是 idle（她站着的时候根本看不到）----------
console.log('\n③ idlePose 指向的姿势不是 tag:\'idle\'');
{
  // 找一个**非 idle** 的姿势 id
  const poses = fs.readFileSync(path.join(ROOT, 'src/anim/idlePoses.js'), 'utf8');
  const all = [...poses.matchAll(/id: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  const idle = new Set([...poses.matchAll(/id: '([a-z0-9-]+)',\s*\n\s*name: '[^']*',\s*\n\s*tag: 'idle'/g)].map((m) => m[1]));
  const notIdle = all.find((p) => !idle.has(p));
  if (!notIdle) { check(false, '姿势表里找不到非 idle 的姿势 —— 这个场景没造起来'); }
  else {
    const r = run(sandbox((t) => onPersona(t, 'girlfriend', (c) => c.replace(/idlePose: '[a-z0-9-]+'/, `idlePose: '${notIdle}'`))));
    check(r.code !== 0, `退出码 ${r.code}（要非 0，用的是非 idle 姿势 ${notIdle}）`);
    check(new RegExp(notIdle).test(r.out), '报表里要打出那个姿势 id');
  }
}

// ---------- ④ 两个角色撞了同一个签名姿势 ----------
console.log('\n④ 两个角色用同一个签名姿势');
{
  const poses = fs.readFileSync(path.join(ROOT, 'src/anim/idlePoses.js'), 'utf8');
  const idle = [...poses.matchAll(/id: '([a-z0-9-]+)',\s*\n\s*name: '[^']*',\s*\n\s*tag: 'idle'/g)].map((m) => m[1]);
  const theme0 = fs.readFileSync(path.join(ROOT, 'src/theme.js'), 'utf8');
  const noaPose = (() => {
    const b = theme0.slice(theme0.indexOf('export const PERSONAS = ['), theme0.indexOf('export const getPersona'));
    const at = b.indexOf("id: 'realistic-noa'");
    return /idlePose: '([a-z0-9-]+)'/.exec(b.slice(at))?.[1];
  })();
  if (!noaPose || !idle.includes(noaPose)) { check(false, '拿不到 realistic-noa 的签名姿势 —— 这个场景没造起来'); }
  else {
    // 把 girlfriend 的姿势改成和 noa 一样：字段本身合法（别的检查抓不到），只有「重复」这条看得见
    const r = run(sandbox((t) => onPersona(t, 'girlfriend', (c) => c.replace(/idlePose: '[a-z0-9-]+'/, `idlePose: '${noaPose}'`))));
    check(r.code !== 0, `退出码 ${r.code}（要非 0）`);
    check(/签名姿势重复/.test(r.out), '要报「签名姿势重复」');
  }
}

// ---------- ⑤ 整塊角色被删掉：自检必须把退出码拉红 ----------
console.log('\n⑤ 删掉 realistic-noa 整块（自检失败必须影响退出码）');
{
  const r = run(sandbox((t) => onPersona(t, 'realistic-noa', () => '')));
  check(r.code !== 0, `退出码 ${r.code}（要非 0）`);
  check(/✗ 脚本有问题/.test(r.out), '要打印「✗ 脚本有问题，别信上面的结果」');
}

fs.rmSync(SB, { recursive: true, force: true });
console.log(fails ? `\n[persona-teeth] FAIL — ${fails} 项没达到预期` : '\n[persona-teeth] PASS — 角色核对看见缺口会红、没缺口会绿');
process.exit(fails ? 1 : 0);
