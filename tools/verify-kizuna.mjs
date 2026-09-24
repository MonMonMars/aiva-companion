/**
 * 验证官方 VRM 转出来的 GLB 能被 App 正常消费。
 *
 * 为什么需要这个脚本：我看不到渲染结果（读 PNG 一直是 "[does not support images]"），
 * 所以只能把「能不能用」拆成可数的硬指标。这里做的是**端到端**验证 ——
 * 不是再看一遍 GLB，而是真的把 GLB 里的 morph 名喂给我们自己的
 * createBuiltinMorphHandle + createLipSync，看它们认不认。
 *
 * 检查项：
 *   1. GLB 结构：glTF 版本 / 三角面 / 顶点 / 材质 / 贴图尺寸 / 骨骼
 *   2. 贴图完整性：每张 PNG 的签名和 IHDR 尺寸（偏移漂移会在这里暴露）
 *   3. morph 名：是否已被 vrm-to-glb 裁到 ARKit 52 且命名标准化
 *   4. 句柄：createBuiltinMorphHandle 能不能拿到形状、能不能写 influence
 *   5. 口型：createLipSync 认出多少个标准动作（低于阈值就是口型不动）
 *   6. 朝向：脸是不是朝 +Z（App 相机在 +Z，反了就是后脑勺对着人）
 *
 * 用法：node tools/verify-kizuna.mjs [glb路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuiltinMorphHandle } from '../src/anim/morphData.js';
import { createLipSync } from '../src/anim/lipSync.js';
import { ARKIT, ARKIT_INDEX } from '../src/anim/faceStandard.js';
import { mapSkeleton, rigCoverage, CORE_BONES, matchBone } from '../src/anim/rigStandard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GLB = process.argv[2] || path.join(here, '..', 'assets', 'models2', 'kizuna-kamatte.glb');

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
  return cond;
};

// ---------------------------------------------------------------------------
// 1. 拆 GLB
// ---------------------------------------------------------------------------
const buf = fs.readFileSync(GLB);
console.log(`\n=== ${path.basename(GLB)} (${(buf.length / 1048576).toFixed(2)} MB) ===\n`);

ok(buf.readUInt32LE(0) === 0x46546c67, '魔数是 glTF', '0x46546C67');
ok(buf.readUInt32LE(4) === 2, 'glTF 版本 = 2.0');

let off = 12;
let json = null;
let bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const body = buf.slice(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
  else if (type === 0x004e4942) bin = body;
  off += 8 + len;
}
ok(!!json && !!bin, 'JSON + BIN 两个 chunk 都在');

// ---------------------------------------------------------------------------
// 2. 贴图完整性 —— 偏移漂移是「文件能打开、但每张图都错位」的静默错误
// ---------------------------------------------------------------------------
const PNG_SIG = '89504e470d0a1a0a';
const imgs = (json.images || []).map((im) => {
  const bv = json.bufferViews[im.bufferView];
  const s = bin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength);
  const sig = s.slice(0, 8).toString('hex');
  const dim = sig === PNG_SIG && s.length > 24
    ? `${s.readUInt32BE(16)}x${s.readUInt32BE(20)}`
    : `非PNG(${im.mimeType || '?'})`;
  return { name: im.name || '(无名)', sig, dim, bytes: s.length };
});
const goodPng = imgs.filter((i) => i.sig === PNG_SIG);
ok(imgs.length > 0 && goodPng.length === imgs.length,
  `贴图 PNG 签名 ${goodPng.length}/${imgs.length} 通过`,
  imgs.map((i) => `${i.name} ${i.dim}`).join(' · '));

const dims = new Set(goodPng.map((i) => i.dim));
ok([...dims].every((d) => {
  const [w, h] = d.split('x').map(Number);
  return w <= 1024 && h <= 1024;
}), '贴图不超过 1024²', [...dims].join(' / '));

// ---------------------------------------------------------------------------
// 3. 几何规模
// ---------------------------------------------------------------------------
let tris = 0;
let verts = 0;
for (const m of json.meshes || []) {
  for (const p of m.primitives || []) {
    const a = json.accessors[p.attributes?.POSITION];
    if (a) verts += a.count;
    if (p.indices != null) tris += json.accessors[p.indices].count / 3;
  }
}
console.log(`\n  几何：${tris.toLocaleString()} 三角面 / ${verts.toLocaleString()} 顶点`);
console.log(`  材质：${(json.materials || []).length} · 贴图：${imgs.length} · 骨骼：${(json.skins?.[0]?.joints || []).length}`);
ok(tris > 1000, '三角面数量合理');
ok((json.skins?.[0]?.joints || []).length > 10, '骨架已绑定（rigDriver 需要）');

// ---------------------------------------------------------------------------
// 骨骼名映射 —— 这一项曾经是 0%
//
// 不是"有没有骨架"，而是"我们的别名表认不认得出这副骨架"。
// 认不出 → rigDriver 直接放弃驱动 → 角色能显示，但头不会跟手动、被摸不抬手，
// 界面上完全看不出异常。官方 VRM 用的是 J_C_hip / J_L_uparm 这套日式命名，
// 和 Mixamo 命名一个都对不上，踩过一次。
// ---------------------------------------------------------------------------
const jointNames = (json.skins?.[0]?.joints || []).map((i) => json.nodes[i]?.name || `node${i}`);
// ⚠️ obj 不能传 null：rigCoverage 用真值判断 `mapping[b]`，
//    null 会被当成"没找到"，结果全 0%（第一次跑就栽在这）。
const { mapping, missing: missingBones } = mapSkeleton(jointNames.map((name) => ({ name, obj: {} })));
const cov = rigCoverage(mapping);
console.log(`\n  骨骼名映射：${cov.have.length}/${CORE_BONES.length} 核心骨认出（${Math.round(cov.ratio * 100)}%）`);
if (cov.missing.length) console.log(`    认不出：${cov.missing.join(', ')}`);
ok(cov.ratio >= 1, `核心骨 100% 认出（rigDriver 才会接管）`, `${cov.have.length}/${CORE_BONES.length}`);
ok(missingBones.length === 0 || cov.missing.length === 0, '没有遗漏的核心骨');

// glTF 里带贴图的材质数 —— 用来预判 attachModel 会不会把它们保留下来
const textured = (json.materials || []).filter((m) =>
  m.pbrMetallicRoughness?.baseColorTexture != null).length;
ok(textured > 0, `${textured} 个材质自带 baseColorTexture`,
  'attachModel 的 keepTexturedMaterial 会保住它们，不会被 Toon 覆盖成纯色');

// ---------------------------------------------------------------------------
// 4~5. morph：拿真实名字喂给我们自己的两个模块
// ---------------------------------------------------------------------------
const morphMeshes = (json.meshes || []).filter((m) =>
  (m.primitives || []).some((p) => p.targets?.length));
const allNames = [];
for (const m of morphMeshes) {
  const names = m.extras?.targetNames
    || (m.primitives[0].targets || []).map((_, i) => `shape_${i}`);
  const n = m.primitives[0].targets.length;
  // three.js 严格比对长度：extras.targetNames 少了就静默丢弃全部名字
  if (names.length !== n) {
    console.log(`  ⚠️  ${m.name}: targetNames ${names.length} ≠ targets ${n}`);
  }
  allNames.push({ mesh: m.name, names: names.slice(0, n), n });
}

const totalShapes = allNames.reduce((s, x) => s + x.n, 0);
console.log(`\n  表情：${totalShapes} 个形状，分布在 ${morphMeshes.length} 个网格`);
for (const x of allNames) console.log(`    ${x.mesh}: ${x.n} 个`);

ok(totalShapes > 0, '模型带 blendshape');

// 造一棵假的 Object3D 树：只用 createBuiltinMorphHandle 真正读到的那几个字段。
// 不引 three 的 Mesh —— 不需要，而且真 Mesh 在 Node 里建 geometry 更麻烦。
const stage = {
  children: allNames.map((x) => ({
    isMesh: true,
    name: x.mesh,
    geometry: { attributes: {} },
    morphTargetDictionary: Object.fromEntries(x.names.map((n, i) => [n, i])),
    morphTargetInfluences: new Array(x.n).fill(0),
  })),
  traverse(fn) {
    fn(this);
    for (const c of this.children) fn(c);
  },
};

const handle = createBuiltinMorphHandle(stage);
ok(!!handle, 'createBuiltinMorphHandle 拿到句柄');

if (handle) {
  console.log(`\n  句柄：${handle.count} 个形状 / ${handle.meshes} 个网格`);
  ok(handle.count === totalShapes, '句柄形状数 = GLB 形状数', `${handle.count} vs ${totalShapes}`);

  // 写入测试：influence 真的落进数组了吗
  const probe = handle.names[0];
  ok(handle.setInfluence(probe, 0.7), `能写 influence（${probe}）`);
  const mesh = stage.children.find((c) => c.morphTargetDictionary[probe] != null);
  const idx = mesh.morphTargetDictionary[probe];
  ok(Math.abs(mesh.morphTargetInfluences[idx] - 0.7) < 1e-6,
    'influence 数值正确落到对应槽位', `${mesh.morphTargetInfluences[idx]}`);
  ok(handle.setInfluence(probe, -5) && mesh.morphTargetInfluences[idx] === 0,
    '越界值被夹到 [0,1]');

  // ARKit 覆盖 —— 这才是「口型动不动」的真正判据
  const covered = handle.names.filter((n) => ARKIT_INDEX[n] !== undefined);
  const missing = ARKIT.filter((n) => !handle.names.includes(n));
  console.log(`\n  ARKit 覆盖：${covered.length}/${ARKIT.length}`);
  if (missing.length) {
    console.log(`    缺失：${missing.join(', ')}`);
    // 元音（口型主力）缺一个就等于嘴不动
    const vital = missing.filter((n) => ['jawOpen', 'mouthFunnel', 'mouthPucker',
      'mouthClose', 'mouthSmileLeft', 'mouthSmileRight'].includes(n));
    if (vital.length) console.log(`    ⚠️  关键口型缺失：${vital.join(', ')}`);
  }
  ok(covered.length >= 24, `ARKit 覆盖 ${covered.length}/52（口型需要 ≥24）`);
  ok(!missing.includes('jawOpen'), 'jawOpen 存在（张嘴）');
  ok(covered.filter((n) => n.startsWith('mouth')).length >= 10,
    `嘴部形状 ${covered.filter((n) => n.startsWith('mouth')).length} 个（≥10 才够用）`);

  // 真跑一遍口型驱动
  const lips = createLipSync(handle, { fade: 0.05, emotionRate: 4 });
  ok(!!lips, 'createLipSync 建成功');
  if (lips) {
    console.log(`  口型驱动：支持 ${lips.supported()} 个标准动作`);
    ok(lips.supported() >= 20, `口型支持 ${lips.supported()} 个动作（≥20）`);
    const spoke = lips.speak('你好呀，今天天气不错呢', { at: 0 });
    ok(spoke, 'speak() 返回 true（口型排上队了）');
  }
}

// ---------------------------------------------------------------------------
// 6. 朝向：脸朝 +Z 吗
// ---------------------------------------------------------------------------
const faceMesh = (json.meshes || []).find((m) => /face/i.test(m.name || ''));
const backMesh = (json.meshes || []).find((m) => /backhair|back_hair/i.test(m.name || ''));
if (faceMesh && backMesh) {
  const meanZ = (m) => {
    const a = json.accessors[m.primitives[0].attributes.POSITION];
    // 只采样，够判断朝向了（整网格几万点，全算没意义）
    const comp = json.bufferViews[a.bufferView];
    let sum = 0;
    const step = Math.max(1, Math.floor(a.count / 400));
    for (let i = 0; i < a.count; i += step) {
      const o = (a.byteOffset || 0) + comp.byteOffset + i * 12 + 8;
      sum += bin.readFloatLE(o);
    }
    return sum / Math.ceil(a.count / step);
  };
  const fz = meanZ(faceMesh);
  const bz = meanZ(backMesh);
  console.log(`\n  朝向：face 平均 Z=${fz.toFixed(3)} · backhair 平均 Z=${bz.toFixed(3)}`);
  ok(fz > bz, '脸朝 +Z（App 相机也在 +Z，不需要旋转 180°）');
} else {
  console.log('\n  朝向：找不到 face / backhair 网格，跳过');
}

// ---------------------------------------------------------------------------
// 7. 授权与来源落盘了吗（asset.extras）
// ---------------------------------------------------------------------------
const ex = json.asset?.extras || {};
ok(!!ex.source || !!ex.attribution,
  '来源/授权写进了 asset.extras',
  ex.attribution || ex.source || '(缺失)');

console.log(`\n=== ${fail === 0 ? '全部通过' : `${fail} 项失败`} · ${pass} 项通过 ===\n`);
process.exit(fail === 0 ? 0 : 1);
