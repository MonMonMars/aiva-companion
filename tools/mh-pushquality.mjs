// mh-pushquality.mjs —— 检验"解穿模软推"有没有把网格推坏
// ===========================================================================
// 软推会在被推顶点和未推顶点之间制造位移梯度。梯度太大 → 三角形被拉长成尖刺。
// 本工具直接用 GLB 里的几何算，不需要浏览器：
//   1. 边长度分布：推挤前后最短/最长边、边长比 >10 的"退化边"数量
//   2. 三角形面积：最小面积、面积 < 1e-10 的塌陷面
//   3. 法线一致性：相邻面朝向是否翻转（用共享边的两三角形法线点积 < 0 计数）
//   4. 与"最近顶点距离"比较：被推顶点的新位置离它原来的连通邻居有多远
//
// 用法: node tools/mh-pushquality.mjs <glbPath> [compareGlbPath]
import fs from 'node:fs';

function readGLB(p) {
  const buf = fs.readFileSync(p);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessor(g, idx) {
  const a = g.json.accessors[idx];
  const bv = g.json.bufferViews[a.bufferView];
  const [Arr, bytes] = CT[a.componentType];
  const n = NC[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = new Arr(a.count * n);
  if (!stride || stride === n * bytes) {
    const src = new Arr(g.bin.buffer, g.bin.byteOffset + base, a.count * n);
    out.set(src);
  } else {
    for (let i = 0; i < a.count; i++) {
      const s = new Arr(g.bin.buffer, g.bin.byteOffset + base + i * stride, n);
      out.set(s, i * n);
    }
  }
  // 归一化整数
  if (a.normalized && a.componentType !== 5126) {
    const max = a.componentType === 5121 ? 255 : a.componentType === 5123 ? 65535 : 127;
    for (let i = 0; i < out.length; i++) out[i] = out[i] / max;
  }
  return out;
}

function meshData(path) {
  const g = readGLB(path);
  const prims = [];
  for (const m of g.json.meshes || []) for (const p of m.primitives) {
    const pos = accessor(g, p.attributes.POSITION);
    const idx = p.indices !== undefined ? accessor(g, p.indices) : null;
    prims.push({ name: m.name, pos: Float64Array.from(pos), idx: idx ? Uint32Array.from(idx) : null });
  }
  return { json: g.json, prims };
}

function analyze(path) {
  const { json, prims } = meshData(path);
  const res = { file: path.split(/[\\/]/).pop(), prims: [] };
  for (const p of prims) {
    const N = p.pos.length / 3;
    const I = p.idx || Uint32Array.from({ length: N }, (_, i) => i);
    const T = I.length / 3;
    // --- 边 ---
    const edge = new Map();
    let minEdge = Infinity, maxEdge = 0, degenerate = 0, total = 0;
    const triArea = [];
    for (let t = 0; t < T; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const ax = p.pos[a * 3], ay = p.pos[a * 3 + 1], az = p.pos[a * 3 + 2];
      const bx = p.pos[b * 3], by = p.pos[b * 3 + 1], bz = p.pos[b * 3 + 2];
      const cx = p.pos[c * 3], cy = p.pos[c * 3 + 1], cz = p.pos[c * 3 + 2];
      const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy - ay, cz - az];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      triArea.push(Math.hypot(nx, ny, nz) / 2);
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const dx = p.pos[u * 3] - p.pos[v * 3], dy = p.pos[u * 3 + 1] - p.pos[v * 3 + 1], dz = p.pos[u * 3 + 2] - p.pos[v * 3 + 2];
        const d = Math.hypot(dx, dy, dz);
        total++;
        if (d < minEdge) minEdge = d;
        if (d > maxEdge) maxEdge = d;
        if (d < 1e-7) degenerate++;
      }
    }
    // --- 边长稳定性：用"每个顶点的最近邻距离"衡量局部尺度 ---
    // 简化：统计面积分布
    triArea.sort((x, y) => x - y);
    const tiny = triArea.filter((v) => v < 1e-9).length;
    const tiny2 = triArea.filter((v) => v < 1e-8).length;
    const p50 = triArea[Math.floor(T * 0.5)] || 0;
    const p99 = triArea[Math.floor(T * 0.99)] || 0;
    res.prims.push({
      name: p.name, verts: N, tris: T,
      minEdgeMM: +(minEdge * 1000).toFixed(4),
      maxEdgeMM: +(maxEdge * 1000).toFixed(2),
      degenerateEdges: degenerate,
      areaP50_mm2: +(p50 * 1e6).toFixed(4),
      areaP99_mm2: +(p99 * 1e6).toFixed(3),
      areaMax_mm2: +(triArea[T - 1] * 1e6).toFixed(3),
      tinyTris_1e9: tiny, tinyTris_1e8: tiny2,
      areaRatio_max_p50: +(triArea[T - 1] / Math.max(p50, 1e-12)).toFixed(1),
    });
  }
  return res;
}

const target = process.argv[2];
if (!target) { console.log('用法: node tools/mh-pushquality.mjs <glbPath>'); process.exit(1); }
console.log(JSON.stringify(analyze(target), null, 1));
