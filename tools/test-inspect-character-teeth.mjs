// 第 25 步：给「写实角色几何体检」补常驻牙齿。
// ---------------------------------------------------------------------------
// 为什么要这一步：
//   tools/inspect-character.mjs 算了 `fails`，打印「N 项未通过。」—— 然后**没有
//   process.exit**。于是本地第 11 步无论体检成什么样都是 PASS。实测三个假的绿：
//     ① MODELS 是空目录      → 「全部通过。」退出 0（一个模型都没体检到）
//     ② 指定不存在的角色名   → 先打 ✗ 再说「全部通过。」退出 0
//     ③ 体检出 N 项不合格    → 退出 0（同一个洞）
//   前两种是「0 条闸门」（SKILL 第 75 条）的教科书形态：扫到 0 条时报通过，
//   比没这条检查更糟；第三种是「打印了 ≠ 拦住了」（第 69 条）的原样重现。
//
//   修完之后，这四条必须成立；本脚本就是守住这四条的常驻证据。
//
// 怎么造"不合格的模型"：
//   不采用「把检查的合格门槛改严」那种做法 —— 那验的是"界限没画错"，
//   验不出"模型真的塌了能不能发现"。这里改的是**模型本身**：把 GLB 里 POSITION
//   accessor 的每个顶点 Y 乘 0.4，人就被压到 0.66m。GLB 的 POSITION 是
//   float32 VEC3、byteStride 12（实测 realistic-noa.glb：count 12919、
//   byteLength 155028 = 12919×12），所以直接在 BIN chunk 里改字节即可，
//   顺带把 accessor 的 min/max 也改掉 —— 双保险，无论脚本读顶点还是读 min/max 都生效。
//
// 每个场景都配对照组（SKILL 第 77 条）：少了"本来就该绿"那一半，
// "它红了"什么都说明不了 —— 一个无脑报错的检查也能通过只验红的那边。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmTreeBounded } from './step-runner.mjs';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPT = 'tools/inspect-character.mjs';
const MODEL = 'realistic-noa';
const SB = path.join(ROOT, '_teeth_sb_ic');

let fails = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
};

/* ---------------- GLB 读写：只为「把模型压矮」这一个目的 ---------------- */
const GLB_MAGIC = 0x46546c67;
const JSON_TYPE = 0x4e4f534a;
const BIN_TYPE = 0x004e4942;

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: 不是 GLB`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_TYPE) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_TYPE) bin = Buffer.from(data);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error(`${file}: JSON/BIN chunk 没读全`);
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;
  const out = Buffer.alloc(total);
  let off = 0;
  out.writeUInt32LE(GLB_MAGIC, off); off += 4;
  out.writeUInt32LE(2, off); off += 4;
  out.writeUInt32LE(total, off); off += 4;
  out.writeUInt32LE(jsonBuf.length + jsonPad, off); off += 4;
  out.writeUInt32LE(JSON_TYPE, off); off += 4;
  jsonBuf.copy(out, off); off += jsonBuf.length;
  out.fill(0x20, off, off + jsonPad); off += jsonPad;
  out.writeUInt32LE(bin.length + binPad, off); off += 4;
  out.writeUInt32LE(BIN_TYPE, off); off += 4;
  bin.copy(out, off); off += bin.length;
  out.fill(0, off, off + binPad);
  return out;
}

// 把第一个带 POSITION 的 primitive 的顶点整体压扁（scaleY），并同步 min/max。
// 返回改动了多少个顶点 —— 0 就说明没改到，这一步的"坏模型"是假的，必须当场炸出来。
function squashY(srcGlb, dstGlb, scaleY) {
  const { json, bin } = readGlb(srcGlb);
  let touched = 0;
  for (const mesh of json.meshes || []) {
    for (const p of mesh.primitives || []) {
      const idx = p.attributes && p.attributes.POSITION;
      if (idx === undefined) continue;
      const acc = json.accessors[idx];
      if (acc.componentType !== 5126 || acc.type !== 'VEC3') continue;
      const bv = json.bufferViews[acc.bufferView];
      const base = bv.byteOffset || 0;
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * 12 + 4; // +4 跳过 X，落在 Y
        bin.writeFloatLE(bin.readFloatLE(o) * scaleY, o);
      }
      touched += acc.count;
      if (acc.min) acc.min[1] *= scaleY;
      if (acc.max) acc.max[1] *= scaleY;
      fs.writeFileSync(dstGlb, writeGlb(json, bin));
      return touched;
    }
  }
  throw new Error(`${srcGlb}: 找不到 float32 VEC3 的 POSITION（`);
}

/* ---------------- 沙盒：一次搭好，四个场景共用 ---------------- */
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB, 'tools'), { recursive: true });
fs.mkdirSync(path.join(SB, 'assets', 'models2'), { recursive: true });
fs.copyFileSync(path.join(ROOT, SCRIPT), path.join(SB, SCRIPT));
const realGlb = path.join(SB, 'assets', 'models2', `${MODEL}.glb`);
fs.copyFileSync(path.join(ROOT, 'assets', 'models2', `${MODEL}.glb`), realGlb);
const morphReal = path.join(ROOT, 'assets', 'models2', `${MODEL}.morph.json`);
if (fs.existsSync(morphReal)) fs.copyFileSync(morphReal, path.join(SB, 'assets', 'models2', `${MODEL}.morph.json`));

const run = (cwd, args = []) =>
  spawnSync(process.execPath, [path.join(cwd, SCRIPT), ...args], { cwd, encoding: 'utf8' });

try {
  /* ⓪ 对照组：模型没动过 → 必须绿 */
  console.log('⓪ 对照组：真实模型（noa）必须是绿的');
  {
    const r = run(SB, [MODEL.replace('realistic-', '')]);
    const out = String(r.stdout || '');
    check(r.status === 0, `退出码 0（实际 ${r.status}）`);
    check(/^ {2}全部通过。$/m.test(out), '报表要给出结论行「全部通过。」');
    check(/✓/.test(out), '要有 ✓ 的明细行');
  }

  /* ① 模型被压矮到 0.4 倍 → 必须红，且点名是哪一项 */
  console.log('\n① 把模型的 Y 压到 0.4 倍（人矮到 0.66m）');
  {
    const verts = squashY(realGlb, realGlb, 0.4);
    check(verts > 0, `真的改到了顶点（${verts} 个）—— 没改到的话这个场景是假的`);
    const r = run(SB, [MODEL.replace('realistic-', '')]);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/总高|头身比|贴地/.test(out), '要点名是哪一项不合格（总高 / 头身比 / 贴地）');
    check(/未通过/.test(out), '要打印「N 项未通过」');
    fs.copyFileSync(path.join(ROOT, 'assets', 'models2', `${MODEL}.glb`), realGlb); // 还原
  }

  /* ② MODELS 是空目录 → 一个都没体检到，不许说通过 */
  console.log('\n② MODELS 里一个 GLB 都没有（0 个体检项）');
  {
    const empty = path.join(SB, 'empty');
    fs.mkdirSync(path.join(empty, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(empty, 'assets', 'models2'), { recursive: true });
    fs.copyFileSync(path.join(SB, SCRIPT), path.join(empty, SCRIPT));
    const r = run(empty);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/一个模型都没体检到|没有 GLB/.test(out), '要说清楚是一个都没体检到，而不是沉默地通过');
    check(!/^ {2}全部通过。$/m.test(out), '不许再打印结论行「全部通过。」');
  }

  /* ③ MODELS 目录压根不在 → 给句人话，别甩 ENOENT 堆栈 */
  console.log('\n③ MODELS 目录不存在');
  {
    const gone = path.join(SB, 'gone');
    fs.mkdirSync(path.join(gone, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(SB, SCRIPT), path.join(gone, SCRIPT));
    const r = run(gone);
    const out = String(r.stdout || '') + String(r.stderr || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/找不到.*models2/.test(out), '要提示找不到 assets/models2');
    check(!/ENOENT.*scandir/.test(out), '不许退化成一串 scandir 堆栈');
  }

  /* ④ 显式指定一个不存在的角色名 → 一边打 ✗ 一边说全部通过，是最坏的一种 */
  console.log('\n④ 显式指定一个不存在的角色名');
  {
    const r = run(SB, ['nosuchhero']);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）`);
    check(/没有 GLB/.test(out), '要打印「没有 GLB」');
    // ⚠️ 只认**结论行**（行首两个空格 + 句号的那一句），不多认一个字：
    //   2026-09-26 自己踩过 —— 被检脚本在 0 项原因里写了一句「而「全部通过。」
    //   只是因为没有东西可判」，宽泛的 /全部通过/ 就命中了那句说明文字，
    //   于是"一边打 ✗ 一边说通过"这条断言变成了假红。
    check(!/^ {2}全部通过。$/m.test(out), '不许一边打 ✗ 一边给出「全部通过。」的结论');
  }
  /* ⑤ 混合名单：一个真角色 + 一个不存在的名字 */
  //   ⚠️ 这个场景是被**变异测试逼出来**的。原先只有场景④（整个名单都不存在），
  //   而那种情况下 rows 本就是空 —— 「0 个体检项」那道闸会先把它拦下，
  //   于是 `if (want) fails++` 就算被改成 `if (false)` 也照样是红的（变异存活）。
  //   要单独验到那一条，名单里必须有**至少一个真能体检到的**，让 rows > 0。
  console.log('\n⑤ 混合名单：noa（存在）+ nosuchhero（不存在）');
  {
    const r = run(SB, ['noa', 'nosuchhero']);
    const out = String(r.stdout || '');
    check(r.status !== 0, `退出码非 0（实际 ${r.status}）—— 有一个找不到就该红`);
    check(/没有 GLB/.test(out), '要点名找不到的那个');
    check(/未通过/.test(out), '计入 fails 而不是被 rows 非空的掩盖');
  }
} finally {
  // 清理不许卡住：fs.rmSync(recursive) 在这台机器上会**卡住不返回** ——
  //   八道题全过了却因为清理挂住而整条变红，那是假失败，比挂住更难查。
  //   所以丢给子进程做并给它硬上限；真删不掉就如实说，不挡结论。
  const rm = await rmTreeBounded(SB);
  if (!rm.gone) console.log(`  ⚠️ 沙盒没删干净（${rm.timedOut ? '删除卡住了，进程已杀' : '未知原因'}）—— 留着，不挡结论`);
}

console.log(fails ? `\n[inspect-teeth] FAIL — ${fails} 项没达标` : '\n[inspect-teeth] PASS — 角色体检看见不合格会红、没体检到会红、正常模型仍绿');
process.exit(fails ? 1 : 0);
