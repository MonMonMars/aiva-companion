// 自动绑定工具（离线构建步骤）
// ---------------------------------------------------------------------------
// 为什么要有这个：
//   现成的 VTuber 模型很多是"静态网格" —— 没有骨骼、没有 blendshape，本质是座雕像。
//   要做嘴型同步和身体动作，必须先给它装骨架、算蒙皮权重、生成表情。
//
// 这个脚本一次性把 .glb 变成可在运行时驱动的资源：
//   xxx.rigged.glb      —— 每个 mesh 变成 SkinnedMesh，共用一副标准骨架；
//                          材质 / UV / 贴图**原样保留**，所以外观不会有损失
//   xxx.morph.json      —— 稀疏存的 blendshape 数据（只存脸部顶点）
//
// 为什么不把 blendshape 直接塞进 GLB：
//   glTF 的 morph target 必须和基础网格顶点数完全一致，且只能用 float32。
//   13k 顶点 × 52 个表情 = 8MB/角色，手机上完全不可接受。
//   改成"只记录脸部顶点 + 只记录真正用得上的表情"之后，单角色约 300KB。
//
// 用法：node tools/autorig.mjs assets/models/girlfriend.glb

import fs from 'fs';
import path from 'path';

// GLTFExporter 内部用 FileReader 读 Blob，Node 里缺这个对象
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend && this.onloadend(); });
  }
};

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const TARGET_HEIGHT = 1.68; // 米，标准成人身高，作为统一缩放基准

// ---------------------------------------------------------------------------
// 1. 读入并把所有 mesh 拉到统一世界坐标
// ---------------------------------------------------------------------------

async function loadScene(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

/**
 * 收集所有 mesh，把它们的世界变换烘进几何体本身，然后把变换清零。
 * 烘完之后全部在同一个坐标系里，才能共用一副骨架（bind matrix = 单位阵）。
 * 注意：材质、UV、贴图全都留在原 mesh 上，不做任何合并。
 */
function collectMeshes(scene) {
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.isSkinnedMesh) return; // 已经是蒙皮的就别碰
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    out.push({ name: o.name || 'mesh', geo, material: o.material, orig: o });
  });
  return out;
}

/** 把所有几何体按顶点数归一化缩放：统一身高、水平居中、脚踩地面 */
function normalizeScale(meshes) {
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      box.expandByPoint(tmp.fromBufferAttribute(pos, i));
    }
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (!isFinite(size.y) || size.y <= 0) throw new Error('模型没有有效高度');

  const s = TARGET_HEIGHT / size.y;
  const p = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      // x/z 居中，y 让最低点落在 0
      pos.setXYZ(i, (p.x - center.x) * s, (p.y - box.min.y) * s, (p.z - center.z) * s);
    }
    pos.needsUpdate = true;
    m.geo.computeBoundingBox();
  }
  return { scale: s, size };
}

// ---------------------------------------------------------------------------
// 2. 用剪影反向测量身体各部位的真实高度
// ---------------------------------------------------------------------------
// 不用教科书比例硬套：模型有大长腿、有 Q 版、有鞋跟，套标准比例必歪。
// 这里直接从几何统计里量出几个锚点，其余再按比例插值。

function measureBody(meshes) {
  const BINS = 240;
  const minW = new Array(BINS).fill(Infinity);
  const maxW = new Array(BINS).fill(-Infinity);
  const maxAbsZ = new Array(BINS).fill(0);
  let topY = -Infinity, botY = Infinity;

  const p = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      if (p.y > topY) topY = p.y;
      if (p.y < botY) botY = p.y;
      let b = Math.floor(((p.y - botY) / (topY - botY || 1)) * (BINS - 1));
      b = Math.max(0, Math.min(BINS - 1, b));
      if (p.x < minW[b]) minW[b] = p.x;
      if (p.x > maxW[b]) maxW[b] = p.x;
      if (Math.abs(p.z) > maxAbsZ[b]) maxAbsZ[b] = Math.abs(p.z);
    }
  }

  const H = topY - botY;
  const widthAt = (b) => (maxW[b] > minW[b] ? maxW[b] - minW[b] : 0);
  const yOf = (b) => botY + (b / (BINS - 1)) * H;

  // 裆部：从下往上找第一个"中线附近完全没有顶点"的高度（两腿分开的地方）。
  // 预先把顶点按 bins 分桶，避免对每一层都全量扫一遍原始顶点。
  const nearCount = new Array(BINS).fill(0);
  const eps = 0.02 * H;
  const bandH = H / BINS;
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (Math.abs(x) >= eps) continue;
      const b = Math.max(0, Math.min(BINS - 1, Math.floor(((pos.getY(i) - botY) / (H || 1)) * (BINS - 1))));
      nearCount[b]++;
    }
  }
  let crotchY = null;
  for (let b = 1; b < BINS; b++) {
    if (nearCount[b] === 0) { crotchY = yOf(b); break; }
  }

  // 肩：身体上半段（裆以上、头以下）最宽处
  const upperLo = Math.floor(BINS * 0.55);
  const upperHi = Math.floor(BINS * 0.88);
  let shoulderB = upperLo;
  let best = 0;
  for (let b = upperLo; b <= upperHi; b++) {
    if (widthAt(b) > best) { best = widthAt(b); shoulderB = b; }
  }

  return {
    H, topY, botY, width: widthAt, yOf, V: (b) => yOf(b),
    crotchY: crotchY ?? botY + 0.48 * H,
    shoulderY: yOf(shoulderB),
    shoulderWidth: widthAt(shoulderB),
    topAbs: maxAbsZ,
  };
}

// ---------------------------------------------------------------------------
// 3. 建立标准骨架
// ---------------------------------------------------------------------------
// 命门：必须和 Mixamo 一致。Mixamo 是全球最大免费动作库，
// 命名一致 = 它那儿的动画能零重定向直接套上来。

function buildSkeletonLayout(mea) {
  const H = mea.H;
  const hipY = mea.crotchY;                       // 骨盆底
  const chestY = mea.shoulderY - 0.04 * H;        // 胸下端
  const shoulderHW = mea.shoulderWidth / 2 * 0.86; // 肩关节比外轮廓靠内

  const L = (x, y, z) => new THREE.Vector3(x, y, z);
  // 【约定】角色面朝 +Z，则它的左手在 +X（forward×up = Z×Y = -X 是右手）
  const pos = {
    Hips: L(0, hipY + 0.045 * H, 0),
    Spine: L(0, hipY + 0.12 * H, 0),
    Spine1: L(0, hipY + 0.20 * H, 0),
    Spine2: L(0, chestY, 0),
    Neck: L(0, chestY + 0.075 * H, 0),
    Head: L(0, chestY + 0.10 * H, 0),
    HeadTop_End: L(0, mea.topY, 0),

    LeftShoulder: L(+shoulderHW * 0.55, chestY + 0.03 * H, 0),
    LeftArm: L(+shoulderHW, chestY + 0.02 * H, 0),
    LeftForeArm: L(+shoulderHW + 0.02 * H, chestY - 0.20 * H, 0),
    LeftHand: L(+shoulderHW + 0.035 * H, chestY - 0.38 * H, 0),

    RightShoulder: L(-shoulderHW * 0.55, chestY + 0.03 * H, 0),
    RightArm: L(-shoulderHW, chestY + 0.02 * H, 0),
    RightForeArm: L(-shoulderHW - 0.02 * H, chestY - 0.20 * H, 0),
    RightHand: L(-shoulderHW - 0.035 * H, chestY - 0.38 * H, 0),

    LeftUpLeg: L(+0.055 * H, hipY + 0.02 * H, 0),
    LeftLeg: L(+0.055 * H, hipY - 0.24 * H, 0),
    LeftFoot: L(+0.055 * H, hipY - 0.47 * H, 0),
    LeftToeBase: L(+0.055 * H, mea.botY + 0.015 * H, 0),
    LeftToe_End: L(+0.055 * H, mea.botY + 0.015 * H, 0.09 * H),

    RightUpLeg: L(-0.055 * H, hipY + 0.02 * H, 0),
    RightLeg: L(-0.055 * H, hipY - 0.24 * H, 0),
    RightFoot: L(-0.055 * H, hipY - 0.47 * H, 0),
    RightToeBase: L(-0.055 * H, mea.botY + 0.015 * H, 0),
    RightToe_End: L(-0.055 * H, mea.botY + 0.015 * H, 0.09 * H),
  };

  // hierarchy: name -> parent
  const parent = {
    Hips: null,
    Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
    Neck: 'Spine2', Head: 'Neck', HeadTop_End: 'Head',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot', LeftToe_End: 'LeftToeBase',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot', RightToe_End: 'RightToeBase',
  };

  // 每根骨头的"骨段"（近端到远端），用于算蒙皮权重时的距离
  const seg = {
    Hips: ['Hips', 'Spine'],
    Spine: ['Spine', 'Spine1'],
    Spine1: ['Spine1', 'Spine2'],
    Spine2: ['Spine2', 'Neck'],
    Neck: ['Neck', 'Head'],
    Head: ['Head', 'HeadTop_End'],
    LeftShoulder: ['LeftShoulder', 'LeftArm'],
    LeftArm: ['LeftArm', 'LeftForeArm'],
    LeftForeArm: ['LeftForeArm', 'LeftHand'],
    LeftHand: ['LeftHand', null],
    RightShoulder: ['RightShoulder', 'RightArm'],
    RightArm: ['RightArm', 'RightForeArm'],
    RightForeArm: ['RightForeArm', 'RightHand'],
    RightHand: ['RightHand', null],
    LeftUpLeg: ['LeftUpLeg', 'LeftLeg'],
    LeftLeg: ['LeftLeg', 'LeftFoot'],
    LeftFoot: ['LeftFoot', 'LeftToeBase'],
    LeftToeBase: ['LeftToeBase', 'LeftToe_End'],
    LeftToe_End: ['LeftToeBase', 'LeftToe_End'],
    RightUpLeg: ['RightUpLeg', 'RightLeg'],
    RightLeg: ['RightLeg', 'RightFoot'],
    RightFoot: ['RightFoot', 'RightToeBase'],
    RightToeBase: ['RightToeBase', 'RightToe_End'],
    RightToe_End: ['RightToeBase', 'RightToe_End'],
  };

  return { pos, parent, seg, order: Object.keys(parent) };
}

// ---------------------------------------------------------------------------
// 4. 蒙皮权重
// ---------------------------------------------------------------------------
// 纯按距离反比算会出事：两腿互相渗透、抬手时整块身体跟着动。
// 所以先按身体分区限制候选骨头，再在候选里按距离衰减。

function buildAuthorities(mea) {
  return {
    hipY: mea.crotchY,
    chestY: mea.shoulderY - 0.04 * mea.H,
    neckY: mea.shoulderY + 0.055 * mea.H,
    H: mea.H,
  };
}

function candidateBones(p, A) {
  const side = p.x >= 0 ? 'Left' : 'Right';
  if (p.y < A.hipY - 0.01) {
    // 腿脚
    return [`${side}UpLeg`, `${side}Leg`, `${side}Foot`, `${side}ToeBase`, 'Hips'];
  }
  if (p.y < A.chestY + 0.02) {
    // 躯干：所有脊柱
    return ['Hips', 'Spine', 'Spine1', 'Spine2', `${side}UpLeg`];
  }
  if (p.y < A.neckY) {
    // 肩胸区域：手臂 + 上胸并存（这样抬肩时锁骨会跟着动，是对的）
    return [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, 'Spine2', 'Spine1'];
  }
  if (p.y < A.neckY + 0.055 * A.H) {
    return ['Neck', 'Head', 'Spine2'];
  }
  return ['Head', 'Neck'];
}

function distToSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? new THREE.Vector3().subVectors(p, a).dot(ab) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return p.distanceTo(proj);
}

function computeSkinWeights(meshes, rig, A) {
  let warned = 0;
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    const n = pos.count;
    const idx = new Uint16Array(n * 4);
    const w = new Float32Array(n * 4);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i);
      const cands = candidateBones(p, A);
      const scored = [];
      for (const bname of cands) {
        const s = rig.seg[bname];
        if (!s) continue;
        let d = distToSegment(p, rig.pos[s[0]], rig.pos[s[1]]);
        scored.push([bname, d]);
      }
      if (!scored.length) { if (warned++ < 3) console.warn('无候选骨', p); continue; }
      scored.sort((a, b) => a[1] - b[1]);
      const top = scored.slice(0, 4);
      // 距离越小权重越大；加 epsilon 防止完全重合时除零
      let sum = 0;
      const ws = top.map(([, d]) => { const v = 1 / Math.pow(d + 0.02, 4); sum += v; return v; });
      for (let k = 0; k < 4; k++) {
        const bname = top[k]?.[0];
        idx[i * 4 + k] = bname ? rig.order.indexOf(bname) : 0;
        w[i * 4 + k] = top[k] ? ws[k] / sum : 0;
      }
    }
    m.geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    m.geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  }
}

// ---------------------------------------------------------------------------
// 5. 生成 blendshape（嘴型 + 表情）
// ---------------------------------------------------------------------------

// 只生成真正会被用到的：嘴型同步 + 情绪表达。其余 ARKit 通道运行时置 0。
const SHAPES = [
  'jawOpen', 'mouthClose', 'mouthPucker', 'mouthFunnel',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthLeft', 'mouthRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'browInnerUp', 'browDownLeft', 'browDownRight',
  'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
];

/** 面部关键点：从头部几何体反推，而不是死记模型内脏的坐标 */
function measureFace(meshes, rig, mea) {
  const H = mea.H;
  const neckY = rig.pos.Neck.y;
  const headTopY = mea.topY;

  // 头部顶点集合
  const headVerts = [];
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) >= neckY - 0.005) headVerts.push([m, i, pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
  }
  if (!headVerts.length) return null;

  let hx = -Infinity, hX = Infinity;
  for (const [, , x] of headVerts) { hx = Math.max(hx, x); hX = Math.min(hX, x); }
  const headW = Math.max(1e-4, hx - hX);

  // 面朝方向：在脸部候选窗口里找最突出的 z
  // 窗口取"鼻子一带"，|x| 很窄，避免被脑后的头发误导
  let zMax = -Infinity, zMin = Infinity;
  const wy = rig.pos.Head.y;
  for (const [, , x, y, z] of headVerts) {
    if (Math.abs(x) > headW * 0.18) continue;
    if (y < wy - 0.06 * H || y > wy + 0.06 * H) continue;
    if (z > zMax) zMax = z;
    if (z < zMin) zMin = z;
  }
  if (!isFinite(zMax)) { zMax = 0.06 * H; }
  const faceZ = zMax;

  // 五官位置：按人脸比例（标准成人），再按动漫比例微调眼睛偏低偏大
  const chinY = neckY + 0.012 * H;
  const headH = headTopY - chinY;
  return {
    H, headW, headH, faceZ, chinY,
    eyeY: chinY + 0.52 * headH,
    browY: chinY + 0.74 * headH,
    noseY: chinY + 0.62 * headH,
    mouthY: chinY + 0.34 * headH,
    eyeX: headW * 0.19,
    browX: headW * 0.22,
    mouthW: headW * 0.16,
    eyeR: headW * 0.16,
    browR: headW * 0.20,
    mouthR: headW * 0.13,
  };
}

/** 平滑衰减：d 是到中心的距离，r 是影响半径 */
const fall = (d, r) => {
  if (r <= 0) return 0;
  const t = Math.max(0, 1 - d / r);
  return t * t * (3 - 2 * t); // smoothstep
};

/**
 * 为一个 mesh 生成全部 blendshape 的稀疏 delta。
 * @returns {null | { indices:number[], shapes: Record<string, number[]> }}
 *          indices 是有位移的顶点下标；每个 shape 的长度 = indices.length*3
 */
function buildFaceMorphs(meshes, F) {
  if (!F) return null;
  const indexMap = new Map();          // 全局唯一 key -> 稀疏下标
  const indices = [];
  const deltas = {};
  for (const s of SHAPES) deltas[s] = [];

  // 先把所有会动的顶点挑出来（脸部前侧）
  const hits = []; // [mi, vi, x, y, z]
  for (let mi = 0; mi < meshes.length; mi++) {
    const pos = meshes[mi].geo.attributes.position;
    for (let vi = 0; vi < pos.count; vi++) {
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
      if (y < F.chinY - 0.02 * F.H) continue;
      if (z < F.faceZ - 0.28 * F.headW) continue;   // 背面不要
      hits.push([mi, vi, x, y, z]);
      indexMap.set(mi * 1e7 + vi, hits.length - 1);
    }
  }
  if (!hits.length) return null;

  const push = (s, v) => deltas[s].push(v);

  for (const [mi, vi, x, y, z] of hits) {
    indices.push(mi * 1e7 + vi);

    const absX = Math.abs(x);
    const sx = x >= 0 ? 1 : -1;   // +X 是角色自己的左手

    // ---- 下颌张开：绕颌关节转下去 ----
    {
      // 旋转轴穿过两侧下颌关节，大约在耳朵下方、鼻高稍上
      const pivotY = F.mouthY + 0.035 * F.H;
      const pivotZ = F.faceZ - 0.055 * F.headW;
      const relY = y - pivotY, relZ = z - pivotZ;
      const jawMask = fall(Math.abs(x), F.mouthW * 2.2) *
        fall(Math.max(0, pivotY - y), 0.075 * F.H);
      const a = 0.30 * jawMask;      // 最大约 17 度
      push('jawOpen', 0);
      push('jawOpen', -relY * (1 - Math.cos(a)) - relZ * Math.sin(a) * 0.35);
      push('jawOpen', -relY * Math.sin(a) * 0.35 + relZ * (1 - Math.cos(a)) * 0.4);
    }

    // ---- 抿嘴 / 噘嘴 / 张圆 ----
    const mouthD = Math.hypot(x, y - F.mouthY);
    const mMask = fall(mouthD, F.mouthR * 1.9);
    {
      push('mouthClose', 0);
      push('mouthClose', -0.012 * F.H * mMask * (y > F.mouthY ? 1 : -1) * 0.6);
      push('mouthClose', -0.004 * F.H * mMask);
    }
    {
      // 噘嘴：向中心收 + 向前推
      const pullX = -x * 0.35 * mMask;
      const pullY = -(y - F.mouthY) * 0.35 * mMask;
      push('mouthPucker', pullX);
      push('mouthPucker', pullY);
      push('mouthPucker', 0.022 * F.H * mMask);
    }
    {
      // 圆嘴（funnel）：向外张 + 略向前
      const out = fall(mouthD, F.mouthR * 2.2);
      push('mouthFunnel', x * 0.22 * out);
      push('mouthFunnel', (y - F.mouthY) * 0.30 * out);
      push('mouthFunnel', 0.010 * F.H * out);
    }

    // ---- 嘴角：笑 / 哭 / 咧 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const cx = sign * F.mouthW, cy = F.mouthY;
      const cornerD = Math.hypot(x - cx, y - cy);
      const cMask = fall(cornerD, F.mouthR * 1.6);
      push(`mouthSmile${sideName}`, 0.010 * F.H * cMask * sign * 0.5);
      push(`mouthSmile${sideName}`, 0.016 * F.H * cMask);
      push(`mouthSmile${sideName}`, 0.002 * F.H * cMask);

      push(`mouthFrown${sideName}`, -0.004 * F.H * cMask * sign * 0.5);
      push(`mouthFrown${sideName}`, -0.014 * F.H * cMask);
      push(`mouthFrown${sideName}`, 0);

      // 整嘴左右移动
      const shiftMask = fall(cornerD, F.mouthR * 2.4);
      push(`mouth${sideName}`, sign * 0.016 * F.H * shiftMask);
      push(`mouth${sideName}`, 0);
      push(`mouth${sideName}`, 0);
    }

    // ---- 眼睛：睁 / 闭 / 眯 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const ex = sign * F.eyeX, ey = F.eyeY;
      const eyeD = Math.hypot(x - ex, y - ey);
      if (eyeD > F.eyeR * 2.2) {
        push(`eyeBlink${sideName}`, 0); push(`eyeBlink${sideName}`, 0); push(`eyeBlink${sideName}`, 0);
        push(`eyeWide${sideName}`, 0); push(`eyeWide${sideName}`, 0); push(`eyeWide${sideName}`, 0);
        push(`eyeSquint${sideName}`, 0); push(`eyeSquint${sideName}`, 0); push(`eyeSquint${sideName}`, 0);
        continue;
      }
      const lid = fall(eyeD, F.eyeR * 1.5);
      // 闭眼：上眼睑下压
      const above = y > ey ? 1 : 0.25;
      push(`eyeBlink${sideName}`, 0);
      push(`eyeBlink${sideName}`, -0.026 * F.H * lid * above);
      push(`eyeBlink${sideName}`, -0.004 * F.H * lid);

      // 睁大：上下一起撑开
      const dir = y > ey ? 1 : -1;
      push(`eyeWide${sideName}`, 0);
      push(`eyeWide${sideName}`, dir * 0.014 * F.H * lid);
      push(`eyeWide${sideName}`, 0.002 * F.H * lid);

      // 眯眼：下眼睑抬起
      const below = y < ey ? 1 : 0.3;
      push(`eyeSquint${sideName}`, 0);
      push(`eyeSquint${sideName}`, 0.012 * F.H * lid * below);
      push(`eyeSquint${sideName}`, 0);
    }

    // ---- 眉毛 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const bx = sign * F.browX, by = F.browY;
      const browD = Math.hypot(x - bx, y - by);
      const bMask = fall(browD, F.browR * 1.7);

      push(`browOuterUp${sideName}`, sign * 0.004 * F.H * bMask);
      push(`browOuterUp${sideName}`, 0.013 * F.H * bMask);
      push(`browOuterUp${sideName}`, 0);

      push(`browDown${sideName}`, sign * 0.006 * F.H * bMask);
      push(`browDown${sideName}`, -0.013 * F.H * bMask);
      push(`browDown${sideName}`, 0.002 * F.H * bMask);
    }
    {
      // 眉心抬起（惊讶 / 委屈）：靠近中线，两侧都动
      const innerD = Math.hypot(absX - F.headW * 0.08, y - F.browY);
      const iMask = fall(innerD, F.browR * 1.5);
      push('browInnerUp', 0);
      push('browInnerUp', 0.014 * F.H * iMask);
      push('browInnerUp', 0.002 * F.H * iMask);
    }

    // ---- 脸颊 ----
    {
      const cheekSpokeX = F.headW * 0.30, cheekY = (F.eyeY + F.mouthY) / 2;
      for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
        if (sx !== sign) continue;
        const cd = Math.hypot(absX - cheekSpokeX, y - cheekY);
        const cMask = fall(cd, F.headW * 0.22);
        push(`cheekSquint${sideName}`, sign * 0.004 * F.H * cMask);
        push(`cheekSquint${sideName}`, 0.008 * F.H * cMask);
        push(`cheekSquint${sideName}`, 0.002 * F.H * cMask);
      }
      const puffD = Math.hypot(absX - cheekSpokeX * 0.9, y - cheekY - 0.01 * F.H);
      const pMask = fall(puffD, F.headW * 0.24);
      push('cheekPuff', sx * 0.018 * F.H * pMask);
      push('cheekPuff', 0);
      push('cheekPuff', 0.014 * F.H * pMask);
    }
  }

  return { indices, shapes: deltas };
}

// ---------------------------------------------------------------------------
// 6. 导出
// ---------------------------------------------------------------------------

function buildSkinnedScene(meshes, rig) {
  const scene = new THREE.Scene();

  // 先建骨架树：local position = 自己的世界坐标 - 父节点的世界坐标
  const boneObjs = {};
  for (const name of rig.order) {
    const b = new THREE.Bone();
    b.name = name;
    boneObjs[name] = b;
  }
  for (const name of rig.order) {
    const parentName = rig.parent[name];
    if (parentName) {
      boneObjs[parentName].add(boneObjs[name]);
      boneObjs[name].position.subVectors(rig.pos[name], rig.pos[parentName]);
    } else {
      scene.add(boneObjs[name]);
      boneObjs[name].position.copy(rig.pos[name]);
    }
  }
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(rig.order.map((n) => boneObjs[n]));

  for (const m of meshes) {
    const sk = new THREE.SkinnedMesh(m.geo, m.material);
    sk.name = m.name;
    // frustumCulled 关掉：有 morph 之后包围盒会变，可能被误剔除
    sk.frustumCulled = false;
    scene.add(sk);
    sk.add(boneObjs.Hips);
    sk.bind(skeleton);
  }
  return { scene, skeleton, boneObjs };
}

async function exportGLB(scene, file) {
  const out = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true, animations: [] })
  );
  fs.writeFileSync(file, Buffer.from(out));
  return out.byteLength;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('用法: node tools/autorig.mjs <model.glb>'); process.exit(1); }
  const base = file.replace(/\.glb$/i, '');
  const rigFile = `${base}.rigged.glb`;
  const morphFile = `${base}.morph.json`;

  console.log(`\n▶ ${path.basename(file)}`);

  const scene = await loadScene(file);
  const meshes = collectMeshes(scene);
  if (!meshes.length) throw new Error('没找到任何 mesh');
  const totalVerts = meshes.reduce((a, m) => a + m.geo.attributes.position.count, 0);
  console.log(`  mesh ${meshes.length} 个 / ${totalVerts} 顶点`);

  normalizeScale(meshes);
  const mea = measureBody(meshes);
  console.log(`  身高 ${mea.H.toFixed(2)}m | 裆部 ${mea.crotchY.toFixed(2)} | 肩 ${mea.shoulderY.toFixed(2)} 宽 ${mea.shoulderWidth.toFixed(2)}`);

  const rig = buildSkeletonLayout(mea);
  const A = buildAuthorities(mea);
  computeSkinWeights(meshes, rig, A);

  const F = measureFace(meshes, rig, mea);
  if (F) {
    console.log(`  脸宽 ${F.headW.toFixed(3)} | 眼 (±${F.eyeX.toFixed(3)}, ${F.eyeY.toFixed(2)}) | 嘴 ${F.mouthY.toFixed(2)} | 面朝 z=${F.faceZ.toFixed(3)}`);
  } else {
    console.log('  ⚠ 没测出头部（模型可能没头或比例异常），跳过表情');
  }

  const built = buildSkinnedScene(meshes, rig);
  const gb = await exportGLB(built.scene, rigFile);

  let mb = 0;
  if (F) {
    const sparse = buildFaceMorphs(meshes, F);
    if (sparse) {
      // 稀疏下标还原成 (meshIndex, vertexIndex)
      const meshCount = meshes.length;
      const packed = {
        version: 1,
        meshCount,
        shapes: SHAPES,
        indices: sparse.indices.map((k) => [Math.floor(k / 1e7), k % 1e7]),
        deltas: sparse.shapes,
      };
      const json = JSON.stringify(packed);
      fs.writeFileSync(morphFile, json);
      mb = json.length;
      const moved = sparse.indices.length;
      console.log(`  表情: ${SHAPES.length} 个 × ${moved} 个脸部顶点`);
    }
  }

  console.log(`  ✓ ${path.basename(rigFile)} (${(gb / 1024).toFixed(0)}KB) + morph (${(mb / 1024).toFixed(0)}KB)`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); });
