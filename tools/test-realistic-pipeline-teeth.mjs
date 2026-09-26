// 第 26 步：给「写实档管线集成测试」补常驻牙齿。
// ---------------------------------------------------------------------------
// 为什么要有：
//   tools/test-realistic-pipeline.mjs 和 tools/inspect-character.mjs 是同一族：
//   遍历 assets/models2 收集 → 逐项打分 → 打印「全部通过。」。
//   inspect-character 那边查出「算完 fails 不用」之后，这里也补了同一对闸门
//   （MODELS 不在要说人话 / rows 为空不许说通过）。本文件盯的就是这两条，
//   外加它原本就做对的那一条（缺 GLB 要计入 totalFails）。
//
// 为什么沙盒要连 src/ 一起搬：
//   这个脚本直接 import 项目的 src/anim/rigStandard 等源码（不是只靠 node_modules），
//   只复制 tools/ 下那一个文件会 ERR_MODULE_NOT_FOUND 崩在洞口，
//   看上去像是"体检没通过"，其实是环境没搭起来 —— 两者必须分得开。
//
// 每个场景同样配对照组（SKILL 第 77 条）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmTreeBounded } from './step-runner.mjs';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPT = 'tools/test-realistic-pipeline.mjs';
const MODEL = 'realistic-noa';
const SB = path.join(ROOT, '_teeth_sb_rp');

let fails = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// 沙盒：tools（被检脚本）+ src（它要 import 的项目源码）+ assets/models2（按需填）。
// 只建**一次**：src/ 有 71 个文件，每建一次都要删一遍再复制一遍 —— 早先每个场景
// 都重建，一轮跑到第 23 分钟还没结束（同一批场景手工跑只要 0.3 秒），
// 卡的是文件系统不是被测脚本。现在改成建一次 + 按需换 models2 的内容。
let sbReady = false;
function makeSandbox(models) {
  if (!sbReady) {
    fs.rmSync(SB, { recursive: true, force: true });
    fs.mkdirSync(path.join(SB, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(SB, 'assets', 'models2'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, SCRIPT), path.join(SB, SCRIPT));
    copyDir(path.join(ROOT, 'src'), path.join(SB, 'src'));
    sbReady = true;
  }
  // models2 归零再按需填 —— 不碰 src/tools
  const dir = path.join(SB, 'assets', 'models2');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const m of models) {
    fs.copyFileSync(path.join(ROOT, 'assets', 'models2', m), path.join(dir, m));
  }
}

// ⚠️ 限时是这个文件的**组成部分**，不是可选配置：
//   早先用的是 spawnSync + timeout 选项，实测在这里根本杀不掉子进程 ——
//   一轮跑到第 23 分钟还卡着（而同一批场景手工 spawn 只要 0.3 秒）。
//   所以改成 spawn + 自己的 setTimeout + kill()，超时按**失败**处理：
//   挂住不等于通过，也不能算"没跑完就算了"。
function runChild(cwd, args) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(cwd, SCRIPT), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      ch.kill('SIGKILL');
      out += '\n（跑了 30 秒还没结束 —— 按失败处理）';
    }, 30000);
    ch.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: '' });
    });
  });
}

(async () => {
try {
  /* ⓪ 对照组：noa（GLB + morph.json 都齐）→ 必须绿 */
  console.log('⓪ 对照组：管线真的通的模型必须是绿的');
  {
    makeSandbox([`${MODEL}.glb`, `${MODEL}.morph.json`]);
    const r = await runChild(SB, []);
    const out = String(r.stdout || '');
    check(r.status === 0, `退出码 0（实际 ${r.status}）`);
    check(/^ {2}全部通过。$/m.test(out), '要给出结论行「全部通过。」');
    check(/jawOpen 动 \d+ 顶点/.test(out), '要有 jawOpen 真的位移了顶点的明细');
  }

  /* ① GLB 被截断 → 解析必须失败且计入 fails */
  console.log('\n① GLB 被截断（GLTFLoader 应当解析不出东西）');
  {
    const glb = path.join(SB, 'assets', 'models2', `${MODEL}.glb`);
    const buf = fs.readFileSync(glb);
    fs.writeFileSync(glb, buf.subarray(0, Math.floor(buf.length * 0.6)));
    const r = await runChild(SB, []);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/解析失败|未通过/.test(out), '要说出是解析失败（或直接报未通过）');
  }

  /* ② models2 是空目录 → 一个都没验到，不许说通过 */
  console.log('\n② assets/models2 里一个 GLB 都没有');
  {
    makeSandbox([]);
    const r = await runChild(SB, []);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/一个模型都没验到/.test(out), '要说明是一个都没验到');
    check(!/^ {2}全部通过。$/m.test(out), '不许给出「全部通过。」的结论行');
  }

  /* ③ models2 目录不在 → 说人话，别甩 ENOENT 堆栈 */
  console.log('\n③ assets/models2 目录不存在');
  {
    makeSandbox([]);
    fs.rmSync(path.join(SB, 'assets', 'models2'), { recursive: true, force: true });
    const r = await runChild(SB, []);
    const out = String(r.stdout || '') + String(r.stderr || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/找不到.*models2/.test(out), '要提示找不到 assets/models2');
    check(!/ENOENT.*scandir/.test(out), '不许退化成一串 scandir 堆栈');
  }

  /* ④ 混合名单：一个真 + 一个不存在（把"缺 GLB 要计数"这条单独剥离出来） */
  console.log('\n④ 混合名单：noa（在）+ nosuchhero（缺 GLB）');
  {
    makeSandbox([`${MODEL}.glb`, `${MODEL}.morph.json`]);
    // 名字按**脚本自己的约定**传：它会自动补 `realistic-` 前缀，
    // 所以这里给 'noa'（写成 'realistic-noa' 会变成 realistic-realistic-noa）。
    const r = await runChild(SB, ['noa', 'nosuchhero']);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/缺 GLB/.test(out), '要点名缺 GLB 的那个');
    check(/未通过/.test(out), '要计入 totalFails，而不是被 rows 非空掩盖');
  }
} finally {
  // 清理不许卡住：fs.rmSync(recursive) 在这台机器上会**卡住不返回** ——
  //   八道题全过了却因为清理挂住而整条变红，那是假失败，比挂住更难查。
  //   所以丢给子进程做并给它硬上限；真删不掉就如实说，不挡结论。
  const rm = await rmTreeBounded(SB);
  if (!rm.gone) console.log(`  ⚠️ 沙盒没删干净（${rm.timedOut ? '删除卡住了，进程已杀' : '未知原因'}）—— 留着，不挡结论`);
}

console.log(fails ? `\n[pipeline-teeth] FAIL — ${fails} 项没达标` : '\n[pipeline-teeth] PASS — 管线测试看见断的模型会红、一个都没验到会红、正常的仍绿');
process.exit(fails ? 1 : 0);
})();
