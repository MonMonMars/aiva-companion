#!/usr/bin/env node
/**
 * 写实档「能不能真的动起来」的集成测试。
 *
 * 几何体检（inspect-character.mjs）只证明**形状对**；
 * 这个文件证明**管线通** —— 用真实的 three.js GLTFLoader + 项目自己的
 * rigStandard / morphData 去加载 assets/models2/*.glb，然后断言：
 *
 *   1. GLTFLoader 能解析（蒙皮 / 顶点色 / 骨架都不炸）
 *   2. 有 SkinnedMesh，且 skeleton.bones 数 = 23
 *   3. mapSkeleton() 能把 CORE_BONES 全部认出来（认不出就没法驱动动作）
 *   4. applyMorphData() 能把 24 个 blendshape 挂上，且：
 *        - morphTargetsRelative = true（存位移而不是绝对坐标）
 *   5. setInfluence('jawOpen', 1) 之后嘴巴附近的顶点**真的位移了**
 *      —— 这才叫"会动"，前面那些都只是"装上了"
 *
 * 用 Node 跑，不需要浏览器：three 的 GLTFLoader 在 Node 里能直接解析 ArrayBuffer。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 动态 import 在 Windows 上必须给 file:// URL，直接塞 C:\... 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME */
const importPath = (p) => import(pathToFileURL(p).href);

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { mapSkeleton, rigCoverage, CORE_BONES } = await importPath(
  path.join(ROOT, 'src/anim/rigStandard.js')
);
const { applyMorphData } = await importPath(path.join(ROOT, 'src/anim/morphData.js'));

const MODELS = path.join(ROOT, 'assets', 'models2');
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// ★ assets/models2 不在 → 别让 readdirSync 甩一段 ENOENT 堆栈了事。
//   「脚本炸了」和「管线不通」不是一回事，后者才是这条检查要说的话。
if (!fs.existsSync(MODELS)) {
  console.log(`✗ 找不到 ${MODELS} —— 一个模型都验不到，别把这一轮当成通过。`);
  process.exit(1);
}
const list = names.length
  ? names.map((n) => (n.startsWith('realistic-') ? n : `realistic-${n}`))
  : fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));

/** GLTFLoader.parse 要正牌 ArrayBuffer */
function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const parse = (ab) => new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));

/**
 * GLB 里有没有内嵌贴图。
 *
 * 有的话**不能在 Node 里用 GLTFLoader 解析**：贴图解码走 ImageBitmapLoader，
 * 而它要 `self`，Node 没有 —— 报错 "self is not defined"。
 * 程序化生成的那批模型没有内嵌贴图（上色靠顶点色），所以一直跑得好好的；
 * 官方 VRM 转来的 kizuna-kamatte.glb 带了 8 张，一进来就把这个测试打红了。
 * 这类模型改由 tools/web-check-glb.mjs 在真浏览器里验（那里才验得到贴图解码）。
 *
 * ⚠️ 这里的判据是「能不能被 GLTFLoader 解析」，跟 tools/inspect-character.mjs
 *    的判据（是不是 Mixamo 单 mesh + 外挂 morph.json）**不是一回事** ——
 *    那边卡的是骨骼/网格格式，这边卡的是贴图解码。同一个模型可能被这边跳过、
 *    被那边跳过，但理由不同；别把两个门禁合并成一个。
 */
function glbHasImages(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return false;
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      try {
        const j = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
        return (j.images || []).length > 0;
      } catch { return false; }
    }
    off += 8 + len;
  }
  return false;
}

let totalFails = 0;
const rows = [];

for (const name of list) {
  const glb = path.join(MODELS, `${name}.glb`);
  const mp = path.join(MODELS, `${name}.morph.json`);
  if (!fs.existsSync(glb)) { console.log(`✗ ${name}: 缺 GLB`); totalFails++; continue; }

  // 带内嵌贴图的模型在 Node 里解析不了（见 glbHasImages 的注释），
  // 这不是模型的问题，不算失败 —— 但要在输出里说清楚，别让它悄悄消失。
  if (glbHasImages(glb)) {
    console.log(`· ${name}: 有内嵌贴图 → Node 解析不了（要 DOM），跳过`);
    console.log(`    浏览器验证请跑：node tools/web-check-glb.mjs assets/models2/${name}.glb`);
    continue;
  }

  const problems = [];
  const ok = (c, m) => { if (!c) problems.push(m); };

  let gltf;
  try {
    gltf = await parse(toAB(fs.readFileSync(glb)));
  } catch (e) {
    console.log(`✗ ${name}: GLTFLoader 解析失败 — ${e.message}`);
    totalFails++;
    continue;
  }

  const root = gltf.scene;

  // ---- 1) SkinnedMesh ----
  const skinned = [];
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
    if (o.isSkinnedMesh) skinned.push(o);
  });
  ok(skinned.length > 0, `没有 SkinnedMesh（模型未绑骨，rigDriver 没法驱动）`);

  let boneCount = 0;
  if (skinned.length) {
    boneCount = skinned[0].skeleton.bones.length;
    ok(boneCount === 23, `骨骼 ${boneCount} 根（应为 23）`);
    // 绑定矩阵是否有效
    const inv = skinned[0].skeleton.boneInverses;
    ok(inv && inv.length === boneCount, `boneInverses 数量异常`);
  }

  // ---- 2) 骨架映射 ----
  const boneList = [];
  root.traverse((o) => { if (o.isBone) boneList.push({ name: o.name, obj: o }); });
  const { mapping, unknown, missing } = mapSkeleton(boneList);
  const cov = rigCoverage(mapping);
  ok(cov.ratio >= 1.0, `CORE_BONES 覆盖率 ${(cov.ratio * 100).toFixed(0)}%，缺 ${cov.missing.join(',')}`);

  // ---- 3) 顶点色 ----
  const colored = meshes.filter((m) => m.geometry?.attributes?.color).length;
  ok(colored > 0, `没有顶点色（写实档靠 COLOR_0 上色，没有就是灰模）`);

  // ---- 4) 表情 ----
  let morphShapes = 0;
  let jawMoved = 0;
  if (!fs.existsSync(mp)) {
    ok(false, `缺 morph.json`);
  } else {
    const data = JSON.parse(fs.readFileSync(mp, 'utf8'));
    let handle = null;
    try {
      handle = applyMorphData(root, data);
    } catch (e) {
      ok(false, `applyMorphData 抛异常：${e.message}`);
    }
    ok(!!handle, `applyMorphData 返回 null（网格对不上或格式不符）`);

    if (handle && skinned.length) {
      const m = skinned[0];
      morphShapes = (m.geometry.morphAttributes.position || []).length;
      ok(morphShapes === 24, `挂上的 blendshape ${morphShapes} 个（应为 24）`);
      ok(m.geometry.morphTargetsRelative === true, `morphTargetsRelative 不是 true（位移会被当绝对坐标，脸会炸）`);

      // ---- 5) 真的动一下 ----
      // morph 是渲染期加的：顶点数组本身不变，three 在 shader 里按 weight 叠加。
      // 所以这里验的是"那份位移数据确实指向一批真实顶点、且幅度可见"。
      try {
        handle.setInfluence('jawOpen', 1);
      } catch (e) {
        ok(false, `setInfluence 抛异常：${e.message}`);
      }
      const attrs = m.geometry.morphAttributes.position || [];
      const pos = m.geometry.attributes.position;
      const dict = m.morphTargetDictionary || {};
      const jawIdx = typeof dict.jawOpen === 'number' ? dict.jawOpen : -1;
      const attr = jawIdx >= 0 ? attrs[jawIdx] : null;
      if (!attr) {
        ok(false, `morphTargetDictionary 里找不到 jawOpen`);
      } else {
        let maxD = 0;
        let moved = 0;
        for (let i = 0; i < pos.count; i++) {
          const dx = attr.array[i * 3], dy = attr.array[i * 3 + 1], dz = attr.array[i * 3 + 2];
          const d = Math.hypot(dx, dy, dz);
          if (d > 1e-6) moved++;
          if (d > maxD) maxD = d;
        }
        jawMoved = moved;
        ok(moved > 0, `jawOpen 没有影响任何顶点（表情是死的）`);
        ok(maxD > 0.002, `jawOpen 最大位移只有 ${(maxD * 1000).toFixed(2)}mm，小到看不出来`);
      }
    }
  }

  rows.push({
    name: name.replace('realistic-', ''),
    meshes: meshes.length,
    skinned: skinned.length,
    bones: boneCount,
    cov: cov.ratio,
    unknown: unknown.length,
    colored,
    morphShapes,
    jawMoved,
    problems,
  });
  totalFails += problems.length;
}

/* ------------------------------ 输出 ------------------------------ */
const pad = (s, n) => String(s).padEnd(n);
const lp = (s, n) => String(s).padStart(n);

console.log('');
console.log('  写实档管线集成测试（真实 three.js GLTFLoader + rigStandard + morphData）');
console.log('  ' + '─'.repeat(82));
console.log(
  '  ' + pad('角色', 12) + lp('网格', 5) + lp('蒙皮', 5) + lp('骨骼', 5) +
  lp('核心骨', 7) + lp('未知骨', 7) + lp('顶点色', 7) + lp('表情', 5) + lp('嘴动顶点', 9)
);
console.log('  ' + '─'.repeat(82));
for (const r of rows) {
  console.log(
    '  ' + pad(r.name, 12) + lp(r.meshes, 5) + lp(r.skinned, 5) + lp(r.bones, 5) +
    lp((r.cov * 100).toFixed(0) + '%', 7) + lp(r.unknown, 7) + lp(r.colored, 7) +
    lp(r.morphShapes, 5) + lp(r.jawMoved, 9)
  );
}
console.log('');

for (const r of rows) {
  if (r.problems.length === 0) {
    console.log(`  ✓ ${pad(r.name, 10)} 管线全通：${r.bones} 骨 · 核心骨 100% · ${r.morphShapes} 表情 · jawOpen 动 ${r.jawMoved} 顶点`);
  } else {
    console.log(`  ✗ ${r.name}`);
    for (const p of r.problems) console.log(`      ${p}`);
  }
}
console.log('');
// ★ rows 为空也要红 —— 这是 tools/inspect-character.mjs 上一任版本留下的同款洞：
//   它算完 totalFails 就打印一句结论，于是「一个 GLB 都没验到」和「15 个全通过」
//   输出同样体面。0 条闸门（SKILL 第 75 条）：扫到 0 条时报通过的检查，
//   比没有这条检查更糟 —— 它会让人以为模型是被验过的。
if (rows.length === 0) {
  console.log(`✗ 一个模型都没验到（目录：${MODELS}）—— 这条检查等于没跑，`);
  // 文案里刻意不写「全部通过」四个字：它自己的牙齿脚本会在 stdout 里找那句结论，
  // 这段提醒带着它就会被误判（lint-ci-refs 早踩过：注释里的名字被当成真步骤）。
  console.log('    一件东西都没判过，就谈不上通过。别把它当成模型的结论。');
  process.exit(1);
}
console.log(totalFails === 0 ? '  全部通过。' : `  ${totalFails} 项未通过。`);
console.log('');
process.exitCode = totalFails ? 1 : 0;
