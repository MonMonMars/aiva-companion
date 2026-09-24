// mhrig-audit.mjs —— 不看图，直接用数学给蒙皮打分
// =========================================================================
// 撕裂（tearing）本质是「相邻顶点位移不一致」，可以量化：
//   1. rest 位姿下蒙皮结果必须 == 原始顶点（差 0），否则 bind 矩阵错了
//   2. 摆一个姿势后，每条边的长度变化率 / 每个三角形的面积变化率
//      正常蒙皮是平滑的（相邻顶点位移接近），撕裂处会飙到几十倍
// 用法: node tools/mhrig-audit.mjs [glb路径]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');
globalThis.self = globalThis;

const FILE = process.argv[2] ||
  'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-base-mh.glb';

const buf = fs.readFileSync(FILE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// ---------------------------------------------------------------- 蒙皮计算
// 纯 JS 版 Linear Blend Skinning，和 three.js 的 shader 一致
function skinOnce(posArray, skinIndex, skinWeight, boneMat, N) {
  const out = new Float32Array(N * 3);
  const v = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    t.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k];
      if (w === 0) continue;
      const ji = skinIndex[i * 4 + k];
      t.x += w * (boneMat[ji].elements[0] * v.x + boneMat[ji].elements[4] * v.y + boneMat[ji].elements[8] * v.z + boneMat[ji].elements[12]);
      t.y += w * (boneMat[ji].elements[1] * v.x + boneMat[ji].elements[5] * v.y + boneMat[ji].elements[9] * v.z + boneMat[ji].elements[13]);
      t.z += w * (boneMat[ji].elements[2] * v.x + boneMat[ji].elements[6] * v.y + boneMat[ji].elements[10] * v.z + boneMat[ji].elements[14]);
    }
    out[i * 3] = t.x; out[i * 3 + 1] = t.y; out[i * 3 + 2] = t.z;
  }
  return out;
}

// 收集当前骨骼的世界矩阵 × bindMatrixInverse
function boneMatrices(mesh) {
  const sk = mesh.skeleton;
  sk.update();
  return sk.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, sk.boneInverses[i]));
}

// 建边表，用于量化「相邻顶点是否分家」
function buildEdges(geo) {
  const idx = geo.index.array;
  const set = new Set();
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    set.add(a < b ? a + ',' + b : b + ',' + a);
    set.add(b < c ? b + ',' + c : c + ',' + b);
    set.add(a < c ? a + ',' + c : c + ',' + a);
  }
  const out = new Uint32Array(set.size * 2);
  let n = 0;
  for (const s of set) { const p = s.split(','); out[n * 2] = +p[0]; out[n * 2 + 1] = +p[1]; n++; }
  return out;
}

// ⚠️ glTF 里 SkinnedMesh 和 Armature 是**兄弟节点**，只 updateMatrixWorld(mesh)
//    是更新不到骨骼的，必须更新整个 scene —— 漏了这步所有姿势都测出 0 位移。
function poseByName(scene, mesh, spec) {
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]));
  const done = [];
  for (const [name, [rx, ry, rz]] of Object.entries(spec)) {
    const b = map.get(name);
    if (!b) { done.push('❌ 找不到骨骼 ' + name); continue; }
    b.rotation.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz));
  }
  scene.updateMatrixWorld(true);
  return done;
}
function resetPose(scene, mesh) {
  for (const b of mesh.skeleton.bones) b.rotation.set(0, 0, 0);
  scene.updateMatrixWorld(true);
}

// MakeHuman 默认骨架：骨骼只有 translation，无旋转 → 关节局部轴 = 世界轴
const POSES = {
  '大臂侧抬45°': { upperarm01L: [0, 0, -45], upperarm01R: [0, 0, 45] },
  '大臂前抬80°': { upperarm01L: [0, -80, 0], upperarm01R: [0, 80, 0] },
  '肘弯曲90°': { upperarm01L: [0, 0, -45], lowerarm01L: [0, -90, 0], upperarm01R: [0, 0, 45], lowerarm01R: [0, 90, 0] },
  '手腕弯60°': { wristL: [0, 0, 60], wristR: [0, 0, -60] },
  '抬腿60°': { upperleg01L: [60, 0, 0], upperleg01R: [-30, 0, 0] },
  '膝弯曲90°': { upperleg01L: [45, 0, 0], lowerleg01L: [-90, 0, 0] },
  '脚掌下压30°': { footL: [-30, 0, 0], footR: [-30, 0, 0] },
  '扭腰30°': { spine03: [0, 30, 0] },
  '弯腰40°': { spine04: [40, 0, 0], spine03: [40, 0, 0] },
  '歪头20°': { neck01: [0, 0, 20], head: [0, 0, 20] },
  '叉开腿45°': { upperleg01L: [0, 0, -25], upperleg01R: [0, 0, 25] },
  '张嘴25°': { jaw: [25, 0, 0] },
  '十指握拳': { finger1_1L: [0, 0, 60], finger2_1L: [0, 0, 60] },
};

new GLTFLoader().parse(ab, '', (gltf) => {
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && o.skeleton && !mesh) mesh = o; });
  if (!mesh) { console.log('❌ 没有 skinned mesh'); process.exit(1); }
  mesh.updateMatrixWorld(true);

  const geo = mesh.geometry;
  const P = geo.attributes.position.array;
  const N = geo.attributes.position.count;
  const SI = geo.attributes.skinIndex.array;
  const SW = geo.attributes.skinWeight.array;

  console.log('=== 骨骼检查 ===');
  const sk = mesh.skeleton;
  console.log(`骨骼 ${sk.bones.length} 根；根骨 ${sk.bones[0].name}`);
  const show = ['root','pelvisL','spine05','spine02','spine01','head','clavicleL','upperarm01L','lowerarm01L','wristL','upperleg01L','lowerleg01L','footL','toe1-1L'];
  const wp = new THREE.Vector3();
  for (const nm of show) {
    const b = sk.bones.find((x) => x.name === nm);
    if (!b) { console.log(`  ${nm.padEnd(16)} —— 不存在`); continue; }
    b.updateMatrixWorld();
    wp.setFromMatrixPosition(b.matrixWorld);
    console.log(`  ${nm.padEnd(16)} y=${wp.y.toFixed(3)}  x=${wp.x.toFixed(3)}  z=${wp.z.toFixed(3)}`);
  }

  // ---------- 1. rest 位姿必须恒等 ----------
  resetPose(gltf.scene, mesh);
  const rest = skinOnce(P, SI, SW, boneMatrices(mesh), N);
  let maxId = 0, idN = 0;
  for (let i = 0; i < N * 3; i++) {
    const d = Math.abs(rest[i] - P[i]);
    if (d > maxId) maxId = d;
    if (d > 1e-3) idN++;
  }
  console.log(`\n=== 1. rest 位姿恒等性 ===`);
  console.log(`  最大偏差 ${maxId.toExponential(2)}m；超过 1mm 的顶点分量 ${idN}`);
  console.log(idN === 0 ? '  ✅ bind 矩阵正确' : '  ❌ bind 矩阵有问题 —— 这就是所有变形都歪的根源');

  const edges = buildEdges(geo);
  const restLen = new Float32Array(edges.length / 2);
  for (let e = 0; e < restLen.length; e++) {
    const a = edges[e * 2] * 3, b = edges[e * 2 + 1] * 3;
    restLen[e] = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
  }

  // ---------- 2. 逐姿势量化撕裂 ----------
  console.log('\n=== 2. 姿势形变平滑度（>2x 即肉眼可见撕裂）===');
  console.log('姿势'.padEnd(16) + '边最大拉伸    >2x边数   >4x边数   顶点最大位移');
  for (const [name, spec] of Object.entries(POSES)) {
    resetPose(gltf.scene, mesh);
    const miss = poseByName(gltf.scene, mesh, spec);
    if (miss.length) { console.log(`  ${name}: ${miss.join(' / ')}`); continue; }
    const now = skinOnce(P, SI, SW, boneMatrices(mesh), N);

    let maxRatio = 0, n2 = 0, n4 = 0, maxMove = 0;
    for (let e = 0; e < restLen.length; e++) {
      if (restLen[e] < 1e-6) continue;
      const a = edges[e * 2] * 3, b = edges[e * 2 + 1] * 3;
      const L = Math.hypot(now[a] - now[b], now[a + 1] - now[b + 1], now[a + 2] - now[b + 2]);
      const r = L / restLen[e];
      if (r > maxRatio) maxRatio = r;
      if (r > 2) n2++;
      if (r > 4) n4++;
    }
    for (let i = 0; i < N * 3; i += 3) {
      const d = Math.hypot(now[i] - P[i], now[i + 1] - P[i + 1], now[i + 2] - P[i + 2]);
      if (d > maxMove) maxMove = d;
    }
    const flag = maxRatio > 2 ? '  ⚠️' : '';
    console.log(`  ${name.padEnd(14)} ${maxRatio.toFixed(2).padStart(7)}x  ${String(n2).padStart(7)}  ${String(n4).padStart(7)}   ${maxMove.toFixed(3)}m${flag}`);
  }

  // ---------- 3. morph 目标是否平滑（滑块「撕模特」检测）----------
  // 平滑形变：相邻顶点的位移应该接近。错位/漏项：某个顶点不动、邻居大幅移动。
  // 判据必须用**相对阈值**（相对该 morph 的最大位移），绝对阈值会把稀疏 target
  // 的正常边界全算成洞 —— 这是踩过的坑，别改成绝对值。
  const ma = geo.morphAttributes.position;
  console.log('\n=== 3. morph 位移场平滑度（相对最大位移；洞 >2% 顶点数需处理）===');
  if (!ma) { console.log('  （无 morph）'); }
  else {
    // 邻接表
    const idxA = geo.index.array;
    const nbr = Array.from({ length: N }, () => []);
    for (let f = 0; f < idxA.length; f += 3) {
      const a = idxA[f], b = idxA[f + 1], c = idxA[f + 2];
      nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
    }
    const dict = mesh.morphTargetDictionary;
    const names = Object.keys(dict).sort((a, b) => dict[a] - dict[b]);
    const rows = [];
    for (const nm of names) {
      const attr = ma[dict[nm]];
      if (attr.itemSize !== 3) continue;
      const D = attr.array;
      let maxMag = 0;
      for (let i = 0; i < N; i++) {
        const m = Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
        if (m > maxMag) maxMag = m;
      }
      if (maxMag < 1e-9) { rows.push({ nm, maxMag, holes: 0, step: 0, ratio: 0 }); continue; }
      // 洞 = 自己几乎不动(<3%最大位移) 但邻居平均动幅较大(>15%最大位移)
      let holes = 0, worstStep = 0;
      for (let i = 0; i < N; i++) {
        const nb = nbr[i];
        if (!nb.length) continue;
        const own = Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
        let ax = 0, ay = 0, az = 0;
        for (const j of nb) { ax += D[j * 3]; ay += D[j * 3 + 1]; az += D[j * 3 + 2]; }
        const avg = Math.hypot(ax / nb.length, ay / nb.length, az / nb.length);
        const step = Math.abs(avg - own);
        if (step > worstStep) worstStep = step;
        if (own < maxMag * 0.03 && avg > maxMag * 0.15) holes++;
      }
      rows.push({ nm, maxMag, holes, step: worstStep, ratio: worstStep / maxMag });
    }
    rows.sort((a, b) => b.holes - a.holes || b.ratio - a.ratio);
    console.log('morph'.padEnd(22) + '最大位移    孤立洞    最大邻差  邻差/位移');
    let total = 0;
    for (const r of rows) {
      total += r.holes;
      const flag = r.holes > N * 0.02 ? '  ⚠️' : (r.ratio > 0.5 ? '  ⚠' : '');
      console.log(`  ${r.nm.padEnd(20)} ${r.maxMag.toFixed(4)}m  ${String(r.holes).padStart(6)}   ${r.step.toFixed(5)}   ${r.ratio.toFixed(2)}${flag}`);
    }
    console.log(`  合计孤立洞 ${total}（共 ${N} 顶点 × ${rows.length} morph）`);
  }

  resetPose(gltf.scene, mesh);
}, (e) => console.log('❌ ' + (e.stack || e)));
