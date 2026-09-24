// 把 autorig 产出的 xxx.morph.json 灌进 three.js 的 morphAttributes
// ---------------------------------------------------------------------------
// 数据形态（version 2，见 tools/autorig.mjs 的导出段）：
//   { version:2, meshCount:1,
//     shapes:     ['jawOpen', 'mouthSmileLeft', ...],   // 24 个 ARKit 名
//     indices:    [[meshIdx, vertexIdx], ...],          // 全部会动的脸部顶点（共用池）
//     shapeSlots: { jawOpen:[0,1,2,...], mouthSmileLeft:[...] },
//     deltas:     { jawOpen:[dx,dy,dz, ...], ... }      // 展平，长度 = 3 × shapeSlots[s].length
//   }
//
// 三个关键点，写错了会**静默失效**（不报错，只是"没反应"或"嘴歪"）：
//
//   1) deltas 不是"每个 shape 都用满整张 indices"。
//      左右分开的形状（mouthSmileLeft / eyeBlinkRight …）只在自己那侧的顶点上
//      产生位移，生成时对不属于自己的顶点是 `continue` 跳过的。
//      所以它的三元组数 < indices 数（实测 299 vs 195 / 104）。
//      **必须靠 shapeSlots[s][k] 才知道第 k 个三元组属于哪个顶点。**
//      v1 数据没有这张表，只能退化假设 1:1（会导致左右表情错位）。
//
//   2) glTF / three.js 只认**整网格等长**的 morph 属性：morphAttributes.position
//      是个 BufferAttribute，长度必须等于 geometry 顶点总数。稀疏数据得先
//      摊平成"全 0 + 少数非 0"的完整缓冲。
//
//   3) morphTargetsRelative = true —— 存的是位移量，和 base 顶点相加。
//
// 另一条容易踩的：一个 BufferAttribute **不能跨 mesh 共享**，这里每个 mesh 单独 new。
//
// v3（写实角色用）：多一个 `quant` 字段，deltas 存的是**定点整数**而不是浮点。
//   写实角色的位移量本身很小（毫米级），存成 `1.2345e-3` 这种文本极占地方；
//   除以 1e-5 变成整数后 JSON 体积能小一半以上。
//   读取时 `delta = raw * quant`。没有 quant 字段 = v1/v2 的裸浮点，行为不变。

import * as THREE from 'three';

/**
 * 判断这份 morph 数据能不能用
 * @param {any} data 解析后的 morph.json
 */
export function isUsableMorph(data) {
  return !!(
    data &&
    Array.isArray(data.shapes) &&
    data.shapes.length &&
    Array.isArray(data.indices) &&
    data.indices.length &&
    data.deltas &&
    typeof data.deltas === 'object'
  );
}

/** v3 的定点缩放；没有就是 1（等于不缩放，兼容 v1/v2） */
function quantOf(data) {
  const q = data?.quant;
  return typeof q === 'number' && q > 0 ? q : 1;
}

/**
 * 取某个 shape 的三元组 -> 稀疏下标映射。
 * v2 用 shapeSlots；v1 没有，退化成"也就是 indices 本身"。
 */
function slotsFor(data, shape) {
  const slots = data.shapeSlots?.[shape];
  if (Array.isArray(slots) && slots.length) return slots;
  // v1 兼容路径：假设这个 shape 用满了整张 indices
  return data.indices.map((_, i) => i);
}

/**
 * 统计这份数据覆盖了哪些 shape、密度如何 —— 调试和测试用
 */
export function morphStats(data) {
  if (!isUsableMorph(data)) return { version: 0, shapes: 0, sparse: 0, coverage: {} };
  const coverage = {};
  for (const s of data.shapes) {
    const d = data.deltas[s];
    let nonzero = 0;
    if (Array.isArray(d)) {
      for (let i = 0; i < d.length; i += 3) {
        if (d[i] || d[i + 1] || d[i + 2]) nonzero++;
      }
    }
    coverage[s] = { verts: Array.isArray(d) ? d.length / 3 : 0, nonzero };
  }
  return { version: data.version || 1, shapes: data.shapes.length, sparse: data.indices.length, coverage };
}

/**
 * 把一份 morph.json 应用到目标网格上。
 *
 * @param {THREE.Object3D} root     模型根（会 traverse 找 Mesh / SkinnedMesh）
 * @param {any}             data    解析后的 morph.json
 * @param {object}          [opts]
 * @param {boolean}         [opts.replace=true] 是否替换已有的同名 morph target
 * @returns {null | object} 驱动句柄：setInfluence(name, v) 就是驱动表情
 */
export function applyMorphData(root, data, opts = {}) {
  if (!root || !isUsableMorph(data)) return null;

  const { replace = true } = opts;

  // 1) 收集目标网格，顺序必须和 meshIdx 对得上。
  //    autorig 按"遍历到的第几个 mesh"编号，这里同样口径。
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o);
  });
  if (!meshes.length) return null;

  /** 名字 -> {mesh, index} 的最终索引表 */
  const lookup = {};
  let applied = 0;
  let warned = false;

  // 顶点号 -> 它在 indices 里的位置（用于把 indices 展开成"按顶点查 slot"）
  // 一个顶点可能被多个 shape 引用，所以装的是数组
  const slotByVertex = new Map();
  data.indices.forEach((pair, slot) => {
    if (!Array.isArray(pair) || pair.length < 2) return;
    const key = `${pair[0]}:${pair[1]}`;
    if (!slotByVertex.has(key)) slotByVertex.set(key, []);
    slotByVertex.get(key).push(slot);
  });

  for (const mesh of meshes) {
    const meshIdx = meshes.indexOf(mesh);
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const vertCount = pos.count;

    const existingPos = geo.morphAttributes.position || [];
    const existingDict = mesh.morphTargetDictionary || {};
    const existingNames = Object.keys(existingDict);

    const addNames = [];
    const addAttrs = [];

    for (const shape of data.shapes) {
      if (!replace && existingNames.includes(shape)) continue;

      const d = data.deltas[shape];
      const slots = slotsFor(data, shape);
      // 长度必须正好是 3 × 该 shape 的三元组数
      if (!Array.isArray(d) || d.length !== slots.length * 3) {
        if (!warned) {
          console.warn(`[morph] ${shape} 的 delta 长度 ${d?.length} 与槽位表 ${slots.length} 不匹配，跳过`);
        }
        continue;
      }

      // 摊平成整网格长度：先全 0，再把稀疏点填进去
      const arr = new Float32Array(vertCount * 3);
      const Q = quantOf(data);     // v3 定点缩放，v1/v2 为 1
      let filled = 0;
      for (let k = 0; k < slots.length; k++) {
        const pair = data.indices[slots[k]];
        if (!pair) continue;
        const [mi, vi] = pair;
        // 只填属于这个网格的顶点；顶点号越界也要保护
        if (mi !== meshIdx) continue;
        if (vi < 0 || vi >= vertCount) continue;
        const src = k * 3;
        const dst = vi * 3;
        arr[dst] = d[src] * Q;
        arr[dst + 1] = d[src + 1] * Q;
        arr[dst + 2] = d[src + 2] * Q;
        filled++;
      }
      // 这个网格在这个 shape 上一个顶点都没摊到 —— 是正常情况（比如该 shape 只动另一个网格）
      if (!filled) continue;

      const attr = new THREE.BufferAttribute(arr, 3);
      attr.name = shape;              // 带上名字，three.js 的 morph 按 name 索引
      addNames.push(shape);
      addAttrs.push(attr);
    }

    if (!addNames.length) continue;

    const mergedAttrs = [...existingPos];
    const mergedNames = [...existingNames];
    const mergedInf = [...(mesh.morphTargetInfluences || [])];

    for (let i = 0; i < addNames.length; i++) {
      const name = addNames[i];
      const dup = mergedNames.indexOf(name);
      if (dup >= 0) {
        mergedAttrs[dup] = addAttrs[i];
        mergedInf[dup] = 0;
      } else {
        mergedAttrs.push(addAttrs[i]);
        mergedNames.push(name);
        mergedInf.push(0);
      }
    }

    geo.morphAttributes.position = mergedAttrs;
    // 相对位移：base 顶点保留，morph 值相加。生成器导出的就是位移量。
    geo.morphTargetsRelative = true;
    geo.computeBoundingSphere();

    mesh.morphTargetInfluences = mergedInf;
    mesh.morphTargetDictionary = {};
    mergedNames.forEach((n, i) => (mesh.morphTargetDictionary[n] = i));

    mergedNames.forEach((n, i) => {
      if (lookup[n]) return;   // 同名 shape 只认第一个网格上的
      lookup[n] = { mesh, index: i };
    });

    applied += addNames.length;
    // 有表情之后包围盒会变，关掉视锥剔除免得头一动就被剔掉
    mesh.frustumCulled = false;
  }

  if (!applied) return null;

  /**
   * 改某个表情的权重。
   * @param {string} name ARKit 名
   * @param {number} v    0~1（clamp；负权重在某些驱动上会把面翻出去）
   */
  const setInfluence = (name, v) => {
    const hit = lookup[name];
    if (!hit) return false;
    const inf = hit.mesh.morphTargetInfluences;
    if (!inf) return false;
    inf[hit.index] = Math.max(0, Math.min(1, v));
    return true;
  };

  /** 批量设置：{ jawOpen: 0.4, eyeBlinkLeft: 1 }；clear=true 时先全部归零 */
  const setAll = (dict, { clear = false } = {}) => {
    if (clear) for (const k of Object.keys(lookup)) setInfluence(k, 0);
    for (const [k, v] of Object.entries(dict || {})) setInfluence(k, v);
  };

  return {
    /** 一共接上了多少个 shape（各网格累加） */
    count: applied,
    /** 接上的 shape 名 */
    names: Object.keys(lookup),
    /** 实际参与驱动的网格数 */
    meshes: meshes.length,
    lookup,
    setInfluence,
    setAll,
    has: (n) => !!lookup[n],
  };
}

/**
 * 直接复用模型**自带**的 blendshape，不经过 morph.json。
 *
 * 什么时候用这个而不是 applyMorphData：
 *   外部模型（VRM / 现成 GLB）通常自带一整套表情，名字写在 mesh 的
 *   extras.targetNames 上，three.js 会读成 morphTargetDictionary。
 *   这种模型再灌一份我们生成的 morph.json 是接不上的 —— 顶点数、顶点序
 *   都和我们的生成器对不上。不如直接用它自带的，而且质量通常更好
 *   （Kizuna AI 官方模型就带完整的 ARKit 52 个）。
 *
 * 返回的句柄形状与 applyMorphData **完全一致**，下游 createLipSync 不用改。
 *
 * @param {THREE.Object3D} root 挂载后的模型根节点
 * @returns {null | object}
 */
export function createBuiltinMorphHandle(root) {
  if (!root) return null;

  /**
   * 名字 -> [{mesh, index}, ...]
   *
   * ⚠️ 为什么是**数组**而不是单个槽位（改过，务必别改回去）：
   *   VRoid / VRM 的脸是「一个 mesh 里塞 10 个 primitive」——皮肤、嘴、眼线、
   *   睫毛、虹膜各一份材质，各自持有**同一套** morph target。
   *   原来按「同名只认第一个网格」处理，结果是眨眼时只有皮肤动，
   *   睫毛和眼线原地不动 —— 比不做表情还难看。
   *   所以同名必须全部驱动；几份全都写同一个权重，视觉才是齐的。
   */
  const lookup = {};
  const meshes = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.morphTargetDictionary) return;
    const dict = o.morphTargetDictionary;
    const keys = Object.keys(dict);
    if (!keys.length) return;
    meshes.push(o);
    // 表情会把顶点推出原始包围盒，不关剔除的话一张嘴整个人就可能被剔掉
    o.frustumCulled = false;
    for (const k of keys) (lookup[k] ||= []).push({ mesh: o, index: dict[k] });
  });

  if (!Object.keys(lookup).length) return null;

  const setInfluence = (name, v) => {
    const hits = lookup[name];
    if (!hits) return false;
    // 权重 [-1,1] 是合法的（负值表示反向 morph），但驱动端目前只用 0~1，
    // 这里按 setAll 的原口径裁剪
    const w = Math.max(0, Math.min(1, v));
    let written = false;
    for (const hit of hits) {
      const inf = hit.mesh.morphTargetInfluences;
      if (!inf) continue;
      inf[hit.index] = w;
      written = true;
    }
    return written;
  };

  const setAll = (dict, { clear = false } = {}) => {
    if (clear) for (const k of Object.keys(lookup)) setInfluence(k, 0);
    for (const [k, v] of Object.entries(dict || {})) setInfluence(k, v);
  };

  return {
    /** 唯一 shape 名数量（不按网格累加，和 applyMorphData 的口径略有差异） */
    count: Object.keys(lookup).length,
    names: Object.keys(lookup),
    meshes: meshes.length,
    lookup,
    setInfluence,
    setAll,
    has: (n) => !!lookup[n],
  };
}
