// 常驻牙齿：证明那三条 lint **看见真违规会红**，而不是「不管什么都绿」。
// ---------------------------------------------------------------------------
// 为什么要有（SKILL 第 76 条那条判据的另一半）：
//   上一轮（tools/test-lint-zero-scan-teeth.mjs）只证明了「收集环节坏掉时会响」，
//   没证明它们的**规则本身**还拦得住东西。规则被改松（为了消误报放宽正则、
//   白名单数字往上调）时，最可能出现的假象就是「所有测试照旧全绿」。
//   所以这里按第 19/20/21/22 步那套路子：沙盒副本里造一处**真违规**，
//   要求它必须红；同时配一个**正确写法**的对照组要求它绿 ——
//   少了对照组，"它红了"说明不了任何事（无脑报错也能通过）。
//
// 用法：node tools/test-lint-rules-teeth.mjs .
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_rulesb');
const NODE = process.execPath;

let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

fs.rmSync(SB, { recursive: true, force: true });   // 先删干净（第 61 条：旧证据会冒充新证据）

/** 造一个沙盒目录并往里写文件，返回它的绝对路径 */
function sandbox(files) {
  const dir = path.join(SB, 'sb' + (sandbox.n = (sandbox.n || 0) + 1));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const run = (script, args) => {
  const r = spawnSync(NODE, [path.join(ROOT, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 24 });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
};

// ---------- ① lint-net-calls：裸 fetch ----------
console.log('① lint-net-calls：src 里出现没走 netFetch 的裸请求');
{
  const bad = sandbox({ 'src/api.js': "export const load = () => fetch('https://api.example.com/x');\n" });
  const good = sandbox({ 'src/api.js': "export const n = 1;\n" });
  const b = run('tools/lint-net-calls.mjs', [path.join(bad, 'src')]);
  check(b.code !== 0, `有裸 fetch 时退出码 ${b.code}（要非 0）`);
  check(/裸 fetch/.test(b.out), '报错里点明「裸 fetch」');
  const g = run('tools/lint-net-calls.mjs', [path.join(good, 'src')]);
  check(g.code === 0, `对照组（没有 fetch）退出码 ${g.code}（要 0）—— 它不是无脑变红`);
}

// ---------- ② lint-net-calls：白名单里的数字是钉死的 ----------
console.log('\n② lint-net-calls：白名单允许 6 处，出现第 7 处就要红');
{
  const mk = (n) => sandbox({
    'src/voice/stt.js': Array.from({ length: n }, (_, i) => `const b${i} = await fetch(file${i});`).join('\n') + '\n',
  });
  const six = run('tools/lint-net-calls.mjs', [path.join(mk(6), 'src')]);
  const seven = run('tools/lint-net-calls.mjs', [path.join(mk(7), 'src')]);
  check(six.code === 0, `6 处（白名单上限）退出码 ${six.code}（要 0）`);
  check(seven.code !== 0, `7 处退出码 ${seven.code}（要非 0）`);
  check(/白名单允许 6 处/.test(seven.out), '报错里点明「白名单允许 6 处」');
}

// ---------- ③ lint-imports：导入了目标模块没导出的名字 ----------
console.log('\n③ lint-imports：A 项——导入了目标模块根本没导出的名字');
{
  const bad = sandbox({
    'src/index.js': "import { Nope } from './mod';\nconsole.log(Nope);\n",
    'src/mod.js': 'export const Yes = 1;\n',
  });
  const good = sandbox({
    'src/index.js': "import { Yes } from './mod';\nconsole.log(Yes);\n",
    'src/mod.js': 'export const Yes = 1;\n',
  });
  const b = run('tools/lint-imports.mjs', [bad]);
  check(b.code !== 0, `退出码 ${b.code}（要非 0）`);
  check(/并没有导出它/.test(b.out), '报错里点明「并没有导出它」');
  check(run('tools/lint-imports.mjs', [good]).code === 0, '对照组（导入真实存在的导出）要绿');
}

// ---------- ④ lint-imports：相对路径在磁盘上找不到 ----------
console.log('\n④ lint-imports：C 项——相对引用指向不存在的文件');
{
  const bad = sandbox({ 'src/index.js': "import x from './nope';\nconsole.log(x);\n" });
  const good = sandbox({ 'src/index.js': "import './mod';\n", 'src/mod.js': 'export const a = 1;\n' });
  const b = run('tools/lint-imports.mjs', [bad]);
  check(b.code !== 0, `退出码 ${b.code}（要非 0）`);
  check(/在磁盘上找不到/.test(b.out), '报错里点明「在磁盘上找不到」');
  check(run('tools/lint-imports.mjs', [good]).code === 0, '对照组（路径真实存在）要绿');
}

// ---------- ⑤ lint-styles：引用了 StyleSheet 里没定义的键 ----------
console.log('\n⑤ lint-styles：引用了 StyleSheet 里没定义的键');
{
  const sheet = (usage) => [
    "import { StyleSheet } from 'react-native';",
    'const styles = StyleSheet.create({',
    '  a: { flex: 1 },',
    '});',
    `export const v = ${usage};`,
  ].join('\n') + '\n';
  const bad = sandbox({ 'src/s.js': sheet('styles.b') });
  const good = sandbox({ 'src/s.js': sheet('styles.a') });
  const b = run('tools/lint-styles.mjs', [bad]);
  check(b.code !== 0, `退出码 ${b.code}（要非 0）`);
  check(/引用了但未定义/.test(b.out), '报错里点明「引用了但未定义」');
  check(run('tools/lint-styles.mjs', [good]).code === 0, '对照组（引用已定义的键）要绿');
}

fs.rmSync(SB, { recursive: true, force: true });
console.log(fails ? `\n[lint-rules-teeth] FAIL — ${fails} 项没达到预期` : '\n[lint-rules-teeth] PASS — 三条 lint 看见真违规会红、看见正确写法会绿');
process.exit(fails ? 1 : 0);
