// 程序化人形角色生成器
// ---------------------------------------------------------------------------
// 为什么不用下载的模型：
//   1. 版权 —— 网上抓来的模型授权说不清，上架就是雷
//   2. 可控 —— 自己生成的角色，五官位置是"已知"的，
//      blendshape 才能做得准。反过来给陌生 mesh 反推五官误差很大。
//
// 产出：标准成人比例（约 7.5 头身）、四边形拓扑、Mixamo 兼容骨架、
//      ARKit 命名的一套 blendshape。顶点着色，不依赖任何贴图
//      —— 顺带解决了原生端 three.js 贴图加载器不可用的老问题。
//
// 用法：node tools/build-character.mjs girlfriend

import fs from 'fs';

globalThis.FileReader = class {
  readAsArrayBuffer(b) { b.arrayBuffer().then((x) => { this.result = x; this.onloadend && this.onloadend(); }); }
};

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

// ===========================================================================
// 预设
// ===========================================================================

const PRESETS = {
  girlfriend: {
    height: 1.62,
    shoulder: 0.36, hip: 0.34,
    skin: [0.98, 0.86, 0.80],
    hair: [0.42, 0.26, 0.30],
    top: [1.00, 0.72, 0.80], bottom: [0.36, 0.30, 0.48], shoes: [0.92, 0.90, 0.92],
    eye: [0.36, 0.52, 0.72],
    style: 'twin-tail',
  },
  boyfriend: {
    height: 1.78,
    shoulder: 0.44, hip: 0.36,
    skin: [0.95, 0.82, 0.74],
    hair: [0.22, 0.20, 0.26],
    top: [0.36, 0.44, 0.62], bottom: [0.24, 0.26, 0.34], shoes: [0.30, 0.30, 0.34],
    eye: [0.32, 0.42, 0.52],
    style: 'short',
  },
  secretary: {
    height: 1.70,
    shoulder: 0.39, hip: 0.36,
    skin: [0.98, 0.88, 0.82],
    hair: [0.18, 0.14, 0.14],
    top: [0.28, 0.32, 0.44], bottom: [0.20, 0.22, 0.32], shoes: [0.14, 0.14, 0.18],
    eye: [0.40, 0.34, 0.30],
    style: 'bob',
  },
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smoothstep = (t) => t * t * (3 - 2 * t);
const falloff = (d, r) => (r <= 0 ? 0 : smoothstep(Math.max(0, 1 - d / r)));

// ===========================================================================
// 几何生成器
// ===========================================================================

/** 空白 Tendon：这一份才是真的累加器 */
function newAcc() { return { pos: [], uv: [], idx: [], color: [], bone: [], face: [], eye: 0 }; }

/**
 * 沿一条直线生成锥形管 —— 躯干、四肢、脖子共用。
 * @param {object} o
 * @param {THREE.Vector3} o.a 近端圆心
 * @param {THREE.Vector3} o.b 远端圆心
 * @param {number} o.segs 沿长度分段
 * @param {number} o.ring 环向分段
 * @param {Function} [o.shape] (t, angle) -> [rx比例, rz比例]，把圆压成椭圆
 */
function tube({ a, b, ra, rb, segs, ring, shape, capA = false, capB = false }) {
  const dir = new THREE.Vector3().subVectors(b, a);
  dir.normalize();
  const up = Math.abs(dir.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const fwd = new THREE.Vector3().crossVectors(dir, right).normalize();

  const verts = [];
  const uvs = [];
  const idx = [];

  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const center = new THREE.Vector3().lerpVectors(a, b, t);
    const r0 = ra + (rb - ra) * t;
    for (let c = 0; c <= ring; c++) {
      const ang = (c / ring) * Math.PI * 2;
      const mod = shape ? shape(t, ang) : [1, 1];
      const rx = r0 * mod[0] * Math.cos(ang);
      const rz = r0 * mod[1] * Math.sin(ang);
      verts.push(
        center.x + right.x * rx + fwd.x * rz,
        center.y + right.y * rx + fwd.y * rz,
        center.z + right.z * rx + fwd.z * rz
      );
      uvs.push(c / ring, t);
    }
  }

  const stride = ring + 1;
  for (let s = 0; s < segs; s++) {
    for (let c = 0; c < ring; c++) {
      const i0 = s * stride + c;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }

  // 端面：加一个中心点，做三角扇形封口
  for (const [which, isB] of [[capA, false], [capB, true]]) {
    if (!which) continue;
    const cv = isB ? b : a;
    const ci = verts.length / 3;
    verts.push(cv.x, cv.y, cv.z);
    uvs.push(0.5, isB ? 1 : 0);
    const baseRow = isB ? segs * stride : 0;
    for (let c = 0; c < ring; c++) {
      const v0 = baseRow + c;
      const v1 = baseRow + c + 1;
      idx.push(ci, v0, v1);
    }
  }

  return { verts, uvs, idx };
}

/** 椭球 —— 头、眼球、手、脚共用 */
function ellipsoid({ c, r, segs = 20, ring = 20, deform = null }) {
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const phi = (i / segs) * Math.PI;
    for (let j = 0; j <= ring; j++) {
      const theta = (j / ring) * Math.PI * 2;
      let x = Math.sin(phi) * Math.cos(theta);
      let y = Math.cos(phi);
      let z = Math.sin(phi) * Math.sin(theta);
      if (deform) {
        const d = deform(x, y, z, phi, theta);
        x = d[0]; y = d[1]; z = d[2];
      }
      verts.push(c.x + x * r.x, c.y + y * r.y, c.z + z * r.z);
      uvs.push(j / ring, i / segs);
    }
  }
  const stride = ring + 1;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < ring; j++) {
      const i0 = i * stride + j;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return { verts, uvs, idx };
}

/** 把一批 part 追加进累加器 */
function appendParts(acc, parts) {
  for (const p of parts) {
    const base = acc.pos.length / 3;
    acc.pos.push(...p.verts);
    acc.uv.push(...p.uvs);
    for (const i of p.idx) acc.idx.push(base + i);
    const n = p.verts.length / 3;
    for (let i = 0; i < n; i++) {
      acc.color.push(...(p.color || [1, 1, 1]));
      acc.bone.push(p.bone || 'Hips');
      acc.face.push(p.isFace ? 1 : 0);
      // eye 标记：0=不是眼 1=左眼 2=右眼，用于眨眼时做"压扁"而不是位移
      acc.eye.push(p.eyeSide || 0);
    }
  }
}

// ===========================================================================
// 骨架：Mixamo 兼容
// ===========================================================================

/**
 * 必须和 Mixamo 一致的原因：Mixamo 是全球最大的免费动作库。
 * 命名一致 = 它那儿的动画能零重定向直接套上来，等于白捡一大资源。
 * T-pose 也是故意的 —— Mixamo 导出的就是 T-pose，保持一致不做任何换姿势。
 */
function buildSkeleton(preset) {
  const H = preset.height;
  const hw = preset.shoulder / 2;
  const hh = preset.hip / 2;

  const j = {
    Hips:          V(0, 0.94 * H, 0),
    Spine:         V(0, 0.99 * H, 0),
    Spine1:        V(0, 1.06 * H, 0),
    Spine2:        V(0, 1.14 * H, 0),
    Neck:          V(0, 1.20 * H, 0),
    Head:          V(0, 1.235 * H, 0),
    HeadTop_End:   V(0, 1.345 * H, 0),

    LeftShoulder:  V(hw * 0.55, 1.155 * H, 0),
    LeftArm:       V(hw, 1.145 * H, 0),
    LeftForeArm:   V(hw + 0.135 * H, 1.145 * H, 0),
    LeftHand:      V(hw + 0.265 * H, 1.145 * H, 0),

    RightShoulder: V(-hw * 0.55, 1.155 * H, 0),
    RightArm:      V(-hw, 1.145 * H, 0),
    RightForeArm:  V(-(hw + 0.135 * H), 1.145 * H, 0),
    RightHand:     V(-(hw + 0.265 * H), 1.145 * H, 0),

    LeftUpLeg:     V(hh * 0.55, 0.90 * H, 0),
    LeftLeg:       V(hh * 0.55, 0.52 * H, 0),
    LeftFoot:      V(hh * 0.55, 0.08 * H, 0),
    LeftToeBase:   V(hh * 0.55, 0.02 * H, 0),

    RightUpLeg:    V(-hh * 0.55, 0.90 * H, 0),
    RightLeg:      V(-hh * 0.55, 0.52 * H, 0),
    RightFoot:     V(-hh * 0.55, 0.08 * H, 0),
    RightToeBase:  V(-hh * 0.55, 0.02 * H, 0),
  };

  const parent = {
    Hips: null,
    Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
    Neck: 'Spine2', Head: 'Neck', HeadTop_End: 'Head',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
  };

  const order = Object.keys(parent);
  const seg = {};
  for (const name of order) {
    const child = order.find((k) => parent[k] === name);
    seg[name] = [name, child || name];
  }
  return { j, parent, order, seg };
}

// ===========================================================================
// 身体
// ===========================================================================

function buildBody(preset, skel) {
  const H = preset.height;
  const parts = [];
  const skin = preset.skin;

  // 骨盆
  parts.push({
    ...ellipsoid({ c: skel.j.Hips, r: V(preset.hip * 0.5, 0.075 * H, 0.075 * H), segs: 12, ring: 18 }),
    color: preset.bottom,
    bone: 'Hips',
  });

  // 躯干：腰 -> 胸，截面从"腰圆"渐变到"胸扁"
  parts.push({
    ...tube({
      a: skel.j.Spine, b: skel.j.Neck,
      ra: preset.hip * 0.42, rb: preset.shoulder * 0.40,
      segs: 14, ring: 18,
      shape: (t) => [1, 0.68 + (0.55 - 0.68) * t],
      capA: false, capB: false,
    }),
    color: preset.top,
    bone: 'Spine',
  });

  // 脖子
  parts.push({
    ...tube({ a: skel.j.Neck, b: skel.j.Head, ra: 0.042 * H, rb: 0.046 * H, segs: 5, ring: 12 }),
    color: skin,
    bone: 'Neck',
  });

  const limb = (prox, dist, r1, r2, col, boneName) => ({
    ...tube({ a: prox, b: dist, ra: r1, rb: r2, segs: 9, ring: 12, capB: true }),
    color: col,
    bone: boneName,
  });

  for (const s of [1, -1]) {
    const S = s > 0 ? 'Left' : 'Right';
    parts.push(limb(skel.j[`${S}Arm`], skel.j[`${S}ForeArm`], 0.047 * H, 0.038 * H, skin, `${S}Arm`));
    parts.push(limb(skel.j[`${S}ForeArm`], skel.j[`${S}Hand`], 0.038 * H, 0.030 * H, skin, `${S}ForeArm`));
    parts.push({
      ...ellipsoid({
        c: skel.j[`${S}Hand`].clone().add(V(s * 0.028 * H, 0, 0)),
        r: V(0.045 * H, 0.032 * H, 0.018 * H), segs: 8, ring: 12,
      }),
      color: skin,
      bone: `${S}Hand`,
    });
    parts.push(limb(skel.j[`${S}UpLeg`], skel.j[`${S}Leg`], 0.075 * H, 0.055 * H, skin, `${S}UpLeg`));
    parts.push(limb(skel.j[`${S}Leg`], skel.j[`${S}Foot`], 0.055 * H, 0.038 * H, skin, `${S}Leg`));
    parts.push({
      ...ellipsoid({
        c: skel.j[`${S}Foot`].clone().add(V(0, -0.012 * H, 0.028 * H)),
        r: V(0.042 * H, 0.022 * H, 0.072 * H), segs: 8, ring: 12,
      }),
      color: preset.shoes,
      bone: `${S}Foot`,
    });
  }

  return parts;
}

// ===========================================================================
// 头部 + 五官
// ===========================================================================

function buildHead(preset, skel) {
  const H = preset.height;
  const c = skel.j.Head;
  const parts = [];

  const headR = V(0.098 * H, 0.115 * H, 0.105 * H);

  // 眼 / 眉 / 嘴的位置：因为头是我们自己生成的，这些坐标是精确已知的
  const L = {
    center: c,
    headR,
    eyeY: c.y + 0.018 * H,
    eyeX: 0.042 * H,
    eyeR: 0.020 * H,
    browY: c.y + 0.050 * H,
    mouthY: c.y - 0.042 * H,
    mouthW: 0.026 * H,
    mouthR: 0.024 * H,
    H,
  };
  L.eyeZ = c.z + headR.z * 0.86;

  // 头：椭球 + 简单雕刻（下颌收窄、眼窝内陷）
  parts.push({
    ...ellipsoid({
      c,
      r: headR,
      segs: 26,
      ring: 26,
      deform: (x, y, z) => {
        if (y < -0.35) {
          const k = Math.min(1, (-y - 0.35) / 0.65);
          x *= 1 - 0.38 * k;
          z *= 1 - 0.22 * k;
        }
        return [x, y, z];
      },
    }),
    color: preset.skin,
    bone: 'Head',
    isFace: true,
  });

  // 眼球：略突出于脸表面，做成"能看到"的眼睛。
  // 眨眼用压扁实现（等价于把眼睛眯成一条线），这是卡通角色里最稳的做法。
  for (const [sideTag, s] of [[1, 1], [2, -1]]) {
    const ec = V(c.x + s * L.eyeX, L.eyeY, L.eyeZ);
    parts.push({
      ...ellipsoid({ c: ec, r: V(L.eyeR, L.eyeR * 1.05, L.eyeR * 0.55), segs: 10, ring: 14 }),
      color: [1, 1, 1],
      bone: 'Head',
      isFace: true,
      eyeSide: sideTag,
    });
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(0, 0, L.eyeR * 0.34)),
        r: V(L.eyeR * 0.55, L.eyeR * 0.62, L.eyeR * 0.35), segs: 8, ring: 12,
      }),
      color: preset.eye,
      bone: 'Head',
      isFace: true,
      eyeSide: sideTag,
    });
  }

  return { parts, L };
}

// ===========================================================================
// 头发
// ===========================================================================

function buildHair(preset, skel) {
  const H = preset.height;
  const c = skel.j.Head;
  const parts = [];
  const main = preset.hair;

  parts.push({
    ...ellipsoid({
      c: c.clone().add(V(0, 0.006 * H, -0.004 * H)),
      r: V(0.104 * H, 0.118 * H, 0.112 * H),
      segs: 20, ring: 20,
      deform: (x, y, z) => {
        if (y < -0.15) {
          const k = Math.min(1, (-y - 0.15) / 0.85);
          x *= 1 - 0.5 * k;
          z *= 1 - 0.3 * k;
        }
        return [x, y, z];
      },
    }),
    color: main,
    bone: 'Head',
  });

  if (preset.style === 'twin-tail') {
    for (const s of [1, -1]) {
      parts.push({
        ...tube({
          a: c.clone().add(V(s * 0.085 * H, 0.02 * H, -0.03 * H)),
          b: c.clone().add(V(s * 0.13 * H, -0.16 * H, -0.05 * H)),
          ra: 0.035 * H, rb: 0.022 * H, segs: 7, ring: 10, capB: true,
        }),
        color: main,
        bone: 'Head',
      });
    }
  } else if (preset.style === 'bob') {
    parts.push({
      ...ellipsoid({
        c: c.clone().add(V(0, -0.055 * H, -0.012 * H)),
        r: V(0.098 * H, 0.085 * H, 0.095 * H),
        segs: 16, ring: 18,
        deform: (x, y, z) => (z > 0.2 ? [x, y, z * 0.55] : [x, y, z]),
      }),
      color: main,
      bone: 'Head',
    });
  } else {
    const spots = [[0, 0.09, -0.02], [-0.05, 0.085, 0.03], [0.05, 0.085, 0.03], [0, 0.08, -0.07]];
    for (const [dx, dy, dz] of spots) {
      parts.push({
        ...ellipsoid({
          c: c.clone().add(V(dx * H, dy * H, dz * H)),
          r: V(0.03 * H, 0.035 * H, 0.03 * H), segs: 7, ring: 9,
        }),
        color: main,
        bone: 'Head',
      });
    }
  }
  return parts;
}

// ===========================================================================
// Blendshape
// ===========================================================================

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

/**
 * 生成 blendshape 位移（相对量 —— morphTargetsRelative = true）。
 * 脸部以外的顶点全部保持 0，这样即使 mesh 里只有部分是脸，
 * 也不会出现"眨个嘴，屁股跟着动"这种鬼畜。
 */
function buildBlendshapes(L, pos, acc) {
  const N = pos.length / 3;
  const out = {};
  for (const s of SHAPES) out[s] = new Float32Array(N * 3);
  const c = L.center;
  const H = L.H;

  for (let vi = 0; vi < N; vi++) {
    const eyeTag = acc.eye[vi];

    // ---- 眼球：眨眼用"压扁"，比位移自然得多 ----
    if (eyeTag) {
      const sideName = eyeTag === 1 ? 'Left' : 'Right';
      const y = pos[vi * 3 + 1];
      const rel = y - L.eyeY;
      const tgt = out[`eyeBlink${sideName}`];
      tgt[vi * 3 + 1] -= rel * 0.97;
      const wide = out[`eyeWide${sideName}`];
      wide[vi * 3 + 1] += rel * 0.22;
      const sq = out[`eyeSquint${sideName}`];
      sq[vi * 3 + 1] -= rel * 0.55;
      continue;
    }

    if (!acc.face[vi]) continue;

    const x = pos[vi * 3];
    const y = pos[vi * 3 + 1];
    const z = pos[vi * 3 + 2];
    if (z < c.z) continue;   // 只处理脸朝向的那一面

    const set = (name, dx, dy, dz) => {
      out[name][vi * 3] += dx;
      out[name][vi * 3 + 1] += dy;
      out[name][vi * 3 + 2] += dz;
    };

    const dEyeL = Math.hypot(x - (c.x + L.eyeX), y - L.eyeY);
    const dEyeR = Math.hypot(x - (c.x - L.eyeX), y - L.eyeY);
    const dMouth = Math.hypot(x - c.x, y - L.mouthY);
    const dBrowL = Math.hypot(x - (c.x + L.eyeX * 0.9), y - L.browY);
    const dBrowR = Math.hypot(x - (c.x - L.eyeX * 0.9), y - L.browY);

    // 下颌张开：绕颌关节旋转下落
    {
      const m = falloff(dMouth, L.mouthR * 2.0) * falloff(Math.max(0, L.mouthY - y), 0.055 * H);
      if (m > 0.001) {
        const pivotY = L.mouthY + 0.012 * H;
        const ry = y - pivotY;
        const rz = z - c.z;
        const a = 0.26 * m;
        set('jawOpen', 0, -ry * (1 - Math.cos(a)) - rz * Math.sin(a) * 0.3, -ry * Math.sin(a) * 0.3 + rz * (1 - Math.cos(a)) * 0.2);
      }
    }

    // 抿 / 噘 / 圆
    {
      const m = falloff(dMouth, L.mouthR * 1.8);
      if (m > 0.001) {
        set('mouthClose', 0, -0.010 * H * m * (y > L.mouthY ? 1 : -0.7), -0.003 * H * m);
        set('mouthPucker', -(x - c.x) * 0.30 * m, -(y - L.mouthY) * 0.30 * m, 0.018 * H * m);
        set('mouthFunnel', (x - c.x) * 0.20 * m, (y - L.mouthY) * 0.26 * m, 0.010 * H * m);
      }
    }

    // 嘴角
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const cx = c.x + sign * L.mouthW;
      const m = falloff(Math.hypot(x - cx, y - L.mouthY), L.mouthR * 1.5);
      if (m > 0.001) {
        set(`mouthSmile${side}`, sign * 0.008 * H * m, 0.014 * H * m, 0.002 * H * m);
        set(`mouthFrown${side}`, -sign * 0.003 * H * m, -0.013 * H * m, 0);
        set(`mouth${side}`, sign * 0.014 * H * m, 0, 0);
      }
    }

    // 眼周的皮肤跟着一起动
    for (const [side, sign, dv] of [['Left', 1, dEyeL], ['Right', -1, dEyeR]]) {
      if (dv > L.eyeR * 2.2) continue;
      const m = falloff(dv, L.eyeR * 1.5);
      set(`eyeBlink${side}`, 0, -0.018 * H * m * (y > L.eyeY ? 1 : 0.3), -0.002 * H * m);
      set(`eyeWide${side}`, 0, (y > L.eyeY ? 1 : -1) * 0.009 * H * m, 0.001 * H * m);
      set(`eyeSquint${side}`, 0, 0.006 * H * m * (y < L.eyeY ? 1 : 0.25), 0);
    }

    // 眉
    for (const [side, , dv] of [['Left', 1, dBrowL], ['Right', -1, dBrowR]]) {
      const m = falloff(dv, L.eyeR * 1.6);
      if (m > 0.001) {
        const sign = side === 'Left' ? 1 : -1;
        set(`browOuterUp${side}`, sign * 0.003 * H * m, 0.012 * H * m, 0);
        set(`browDown${side}`, sign * 0.005 * H * m, -0.012 * H * m, 0.002 * H * m);
      }
    }
    {
      const m = falloff(Math.hypot(Math.abs(x - c.x) - L.eyeX * 0.35, y - L.browY), L.eyeR * 1.4);
      if (m > 0.001) set('browInnerUp', 0, 0.013 * H * m, 0.002 * H * m);
    }

    // 颊
    {
      const cheekX = L.eyeX * 1.35;
      const cheekY = (L.eyeY + L.mouthY) / 2;
      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        const m = falloff(Math.hypot(Math.abs(x - c.x) - cheekX, y - cheekY), L.eyeR * 1.8);
        if (m > 0.001) set(`cheekSquint${side}`, sign * 0.003 * H * m, 0.007 * H * m, 0.002 * H * m);
      }
      const m = falloff(Math.hypot(Math.abs(x - c.x) - cheekX * 0.85, y - cheekY - 0.008 * H), L.eyeR * 2.0);
      if (m > 0.001) set('cheekPuff', (x >= c.x ? 1 : -1) * 0.016 * H * m, 0, 0.012 * H * m);
    }
  }

  return out;
}

// ===========================================================================
// 蒙皮权重
// ===========================================================================

function distPointSeg(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? new THREE.Vector3().subVectors(p, a).dot(ab) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return p.distanceTo(new THREE.Vector3().copy(a).addScaledVector(ab, t));
}

/**
 * 每 part 标了主骨，这里再按距离把相邻骨拉进来做平滑过渡。
 * 只绑一根骨的话，弯胳膊时会直接断裂 —— 这是蒙皮最容易踩的坑。
 */
function computeSkin(acc, skel) {
  const N = acc.pos.length / 3;
  const idx = new Uint16Array(N * 4);
  const wt = new Float32Array(N * 4);
  const nameToId = {};
  skel.order.forEach((n, i) => (nameToId[n] = i));

  for (let i = 0; i < N; i++) {
    const boneName = acc.bone[i];
    const p = new THREE.Vector3(acc.pos[i * 3], acc.pos[i * 3 + 1], acc.pos[i * 3 + 2]);

    const can = new Set([boneName]);
    const parentName = skel.parent[boneName];
    if (parentName) can.add(parentName);
    for (const k of skel.order) {
      if (skel.parent[k] === boneName) can.add(k);
      if (parentName && skel.parent[k] === parentName) can.add(k);
    }

    const scored = [];
    for (const bn of can) {
      const [s0, s1] = skel.seg[bn];
      scored.push([bn, distPointSeg(p, skel.j[s0], skel.j[s1])]);
    }
    scored.sort((a, b) => a[1] - b[1]);
    const top = scored.slice(0, 4);
    let sum = 0;
    const ws = top.map(([, d]) => { const v = 1 / Math.pow(d + 0.05, 3); sum += v; return v; });
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = nameToId[top[k][0]];
      wt[i * 4 + k] = ws[k] / sum;
    }
  }
  return { idx, wt };
}

// ===========================================================================
// 组装 & 导出
// ===========================================================================

async function buildCharacter(name) {
  const preset = PRESETS[name];
  if (!preset) throw new Error('unknown preset: ' + name);

  const skel = buildSkeleton(preset);
  const acc = newAcc();

  appendParts(acc, buildBody(preset, skel));
  const head = buildHead(preset, skel);
  appendParts(acc, head.parts);
  appendParts(acc, buildHair(preset, skel));

  const geo = new THREE.BufferGeometry();
  const skin = computeSkin(acc, skel);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(acc.color, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skin.idx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skin.wt, 4));
  geo.setIndex(acc.idx);
  geo.computeVertexNormals();

  const pos = new Float32Array(acc.pos);
  const shapes = buildBlendshapes(head.L, pos, acc);
  geo.morphAttributes.position = SHAPES.map((s) => new THREE.BufferAttribute(shapes[s], 3));
  geo.morphTargetsRelative = true;   // 存的是位移量而不是绝对位置

  return { geo, skel, preset, shapes, L: head.L, acc };
}

async function exportScene(char, outFile) {
  const { geo, skel, shapes } = char;
  const scene = new THREE.Scene();

  const boneObjs = {};
  for (const name of skel.order) {
    const b = new THREE.Bone();
    b.name = name;
    boneObjs[name] = b;
  }
  for (const name of skel.order) {
    const p = skel.parent[name];
    if (p) {
      boneObjs[p].add(boneObjs[name]);
      boneObjs[name].position.subVectors(skel.j[name], skel.j[p]);
    } else {
      scene.add(boneObjs[name]);
      boneObjs[name].position.copy(skel.j[name]);
    }
  }
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(skel.order.map((n) => boneObjs[n]));

  const mat = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.FrontSide });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = 'Body';
  mesh.frustumCulled = false;

  mesh.morphTargetInfluences = new Array(shapes.length).fill(0);
  mesh.morphTargetDictionary = {};
  shapes.forEach((s, i) => (mesh.morphTargetDictionary[s] = i));

  scene.add(mesh);
  mesh.add(boneObjs.Hips);
  mesh.bind(skeleton);

  const out = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
  fs.writeFileSync(outFile, Buffer.from(out));
  return out.byteLength;
}

// ===========================================================================
// main
// ===========================================================================

const which = process.argv[2] || 'girlfriend';
const char = await buildCharacter(which);
console.log('角色 ' + which + '：');
console.log('  顶点 ' + char.geo.attributes.position.count +
            '  / 三角面 ' + (char.geo.index.count / 3));
console.log('  骨骼 ' + char.skel.order.length + ' 根 / blendshape ' + char.shapes.length + ' 个');
console.log('  身高 ' + char.preset.height + 'm  肩宽 ' + char.preset.shoulder + 'm');

fs.mkdirSync('assets/models2', { recursive: true });
const outFile = 'assets/models2/' + which + '.glb';
const bytes = await exportScene(char, outFile);
console.log('  ✓ ' + outFile + '  (' + (bytes / 1024).toFixed(0) + 'KB)');
