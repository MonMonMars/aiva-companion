// 第 27 步：给「每一步的硬上限」配牙齿。
// ---------------------------------------------------------------------------
// 为什么要有：
//   2026-09-26 实测全套跑到第 19 步**挂住**：日志停在「PASS lint-ci-refs」，
//   一挂 4 小时 17 分；进程 CPU 时间几乎为 0、也没有任何子进程 ——
//   卡在 Node 自己的 fs.rmSync(recursive) 上。当时 runtests 用的是不带 timeout 的
//   spawnSync，所以「挂住」既不像失败，也不像成功，就是**永远没有结论**。
//   tools/step-runner.mjs 补的就是这个上限。本文件盯着它真的会把挂住的步骤掐成失败。
//
// 每个场景配对照组/反向断言（SKILL 第 77 条）：
//   光验「挂住的会被掐」不够 —— 一个把什么都掐掉的 runStep 也能过那一半。
//   所以同时要求「正常通过的要 status 0」「正常失败的要保留退出码」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStep, pidAlive } from './step-runner.mjs';

// ⚠️ 用 fileURLToPath 而不是 new URL(...).pathname：后者在 Windows 上会给出
//    `/C:/Users/...` 这种带前导斜杠的路径，path.resolve 之后根目录是错的 ——
//    沙盒会建到莫名其妙的地方去，测试还会"通过"（因为它验证的是沙盒里的行为）。
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SB = path.join(ROOT, '_teeth_sb_timeout');
const LIMIT = 2000;

let bad = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(rel, code) {
  const p = path.join(SB, rel);
  fs.writeFileSync(p, code);
  return p;
}

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });

const HB = path.join(SB, 'heartbeat.txt');
const okScript = fixture('ok.mjs', "console.log('done');\nprocess.exit(0);\n");
const failScript = fixture('fail.mjs', "console.log('going down');\nprocess.exit(3);\n");
const hangScript = fixture('hang.mjs', "console.log('开始');\nsetInterval(() => {}, 1000);\n");
const kidScript = fixture('kid.mjs', `import fs from 'node:fs';\nsetInterval(() => { try { fs.appendFileSync(${JSON.stringify(HB)}, 'x'); } catch {}\n }, 200);\n`);
const hangWithKid = fixture('hang_with_kid.mjs',
  `import { spawn } from 'node:child_process';\n` +
  `spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(kidScript)}], { stdio: 'ignore' });\n` +
  `setInterval(() => {}, 1000);\n`);

try {
  /* ⓪ 对照组：正常通过的一步，不能被上限干扰 */
  console.log('⓪ 对照组：正常通过的一步仍然是 exit 0');
  {
    const r = await runStep([okScript], { timeoutMs: LIMIT });
    check(r.status === 0, `退出码 0（实际 ${r.status}）`);
    check(!r.timedOut, '没被判成超时');
    check(/done/.test(r.stdout), '输出要收得回来');
  }

  /* ① 正常失败的一步：退出码要保住，不能被超时吞掉 */
  console.log('\n① 正常失败的一步：退出码必须是原来的那个');
  {
    const r = await runStep([failScript], { timeoutMs: LIMIT });
    check(r.status === 3, `退出码 3（实际 ${r.status}）`);
    check(!r.timedOut, '不能因为它没跑完就误判成超时');
  }

  /* ② 挂住的一步：必须变成失败 */
  console.log('\n② 挂住的一步必须被掐成失败');
  {
    const t0 = Date.now();
    const r = await runStep([hangScript], { timeoutMs: LIMIT });
    const el = Date.now() - t0;
    check(r.timedOut === true, `timedOut 为 true（实际 ${r.timedOut}）`);
    check(r.status === null, `status 为 null，不能伪装成 0（实际 ${r.status}）`);
    check(el >= LIMIT * 0.9 && el < LIMIT * 5, `真的等到了上限才动手（耗时 ${el}ms，上限 ${LIMIT}ms）`);
    // 挂住之前打印的东西要能拿到 —— 超时时最需要的就是它挂到哪了
    check(/开始/.test(r.stdout), '挂住之前的输出要保留下来（不然没法诊断）');
  }

  /* ③ 掐完之后，那个进程必须真的没了 */
  console.log('\n③ 掐完之后直接子进程必须真的死了');
  {
    const r = await runStep([hangScript], { timeoutMs: LIMIT });
    check(r.timedOut === true, '确实走了超时的分支');
    await sleep(1000);
    const alive = pidAlive(r.pid);
    check(!alive, `pid ${r.pid} 已经不在了（否则它还在占着文件句柄）`);
  }

  /* ④ 孙进程也要一起收走（光杀直接子进程会留孤儿） */
  console.log('\n④ 孙进程也要一起收走');
  {
    fs.writeFileSync(HB, '');
    const r = await runStep([hangWithKid], { timeoutMs: LIMIT });
    check(r.timedOut === true, '确实走了超时的分支');
    const grew = fs.statSync(HB).size;
    check(grew > 0, `超时前孙进程确实在写心跳（写了 ${grew} 字节）`);
    await sleep(1500);
    const after = fs.statSync(HB).size;
    check(after === grew, `掐完之后心跳停了（${grew} → ${after} 字节）—— 孙进程也被收走了`);
  }
} finally {
  // 用子进程删 + 硬上限：rmSync(recursive) 在这台机器上会卡住不返回（见 step-runner 注释），
  // 不能让「清理」变成新一轮的挂住。
  try {
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(SB)}, { recursive: true, force: true })`], { timeout: 10000 });
  } catch {}
  if (fs.existsSync(SB)) console.log(`  ⚠️  沙盒 _teeth_sb_timeout 没删干净，手工清一下`);
}

console.log(bad ? `\n[timeout-teeth] FAIL — ${bad} 项没达标` : '\n[timeout-teeth] PASS — 挂住的步骤会被掐成失败，正常通过/失败的照旧');
process.exit(bad ? 1 : 0);
