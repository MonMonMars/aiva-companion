// 把一只 GLB 按 mesh / primitive 拆成若干份（身体 / 头发 / 衣服分开存）
// ---------------------------------------------------------------------------
// 为什么能这么拆：这个模型的每个 mesh 都自带 skin，而 skin.joints 引用的是
// **node 索引**。所以只要保留整棵 node 树不动，被留下的 mesh 的绑骨关系就
// 原样成立 —— 不需要重新绑骨，也不需要骨骼名字匹配。
// 被剔除的 mesh，只把对应 node 的 `mesh` 属性摘掉，node 本身留着当骨头用。
//
// BIN 的处理原则（踩过坑，别改）：
//   按 bufferView 逐个「原样切片拷贝」，允许重叠的 bufferView 各拷一份。
//   **绝对不要**试图按地址排序去重 —— 原文件里 bufferView 是互相重叠的
//   （kizuna 有 570 个 bufferView 的 byteLength 加起来 8.64MB，但 BIN 只有 7.23MB），
//   一旦假设"段之间不重叠"，偏移就会算错，出来的模型全是乱的。
//
// 用法：
//   node tools/glbsplit.mjs in.glb out.glb body_geo#1,face_geo
//   mesh 名不加 #n 表示保留全部 primitive；加 #n 只保留第 n 个 primitive。
//   名字支持 * 通配。
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './png-min.mjs';

// ---------------- GLB 读写 ----------------
function loadGLB(file) {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

function writeGLB(json, bin, out) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;
  const out2 = Buffer.alloc(total);
  let o = 0;
  out2.writeUInt32LE(0x46546c67, o); o += 4;
  out2.writeUInt32LE(2, o); o += 4;
  out2.writeUInt32LE(total, o); o += 4;
  out2.writeUInt32LE(jsonBuf.length + jsonPad, o); o += 4;
  out2.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonBuf.copy(out2, o); o += jsonBuf.length;
  for (let i = 0; i < jsonPad; i++) out2[o++] = 0x20;
  out2.writeUInt32LE(bin.length + binPad, o); o += 4;
  out2.writeUInt32LE(0x004e4942, o); o += 4;
  bin.copy(out2, o); o += bin.length;
  fs.writeFileSync(out, out2);
  return total;
}

// ---------------- 解析 keep 规格 ----------------
function parseSpec(spec, meshes) {
  const out = new Map(); // meshIdx -> Set(primIdx) | 'all'
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [namePart, primPart] = raw.split('#');
    const re = new RegExp('^' + namePart.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    let hit = 0;
    meshes.forEach((m, mi) => {
      if (!re.test(m.name || '')) return;
      hit++;
      if (primPart === undefined) out.set(mi, 'all');
      else {
        const s = out.get(mi);
        const set = s instanceof Set ? s : new Set();
        set.add(Number(primPart));
        out.set(mi, set);
      }
    });
    if (!hit) throw new Error(`keep 规格 "${raw}" 没匹配到任何 mesh。现有: ${meshes.map((m) => m.name).join(', ')}`);
  }
  return out;
}

// ---------------- 主流程 ----------------
export function splitGLB(inFile, outFile, specStr) {
  const { json, bin } = loadGLB(inFile);
  const { meshes = [], nodes = [], skins = [], accessors = [], materials = [], images = [], animations = [] } = json;

  const keep = parseSpec(specStr, meshes);

  // --- 1) 新的 meshes 列表（顺便记下 primitive 的旧→新映射，用于后面 node 重映射）
  const newMeshes = [];
  const meshRemap = new Map(); // 旧 meshIdx -> 新 meshIdx
  const primKeptCount = { n: 0 };
  meshes.forEach((m, mi) => {
    const sel = keep.get(mi);
    if (sel === undefined) return;
    const prims = sel === 'all' ? m.primitives : m.primitives.filter((_, pi) => sel.has(pi));
    if (!prims.length) return;
    meshRemap.set(mi, newMeshes.length);
    newMeshes.push({ ...m, primitives: prims });
    primKeptCount.n += prims.length;
  });

  // --- 2) nodes：全保留（骨骼索引不能动），但把被剔除 mesh 的引用摘掉
  const newNodes = nodes.map((n) => {
    if (n.mesh === undefined) return n;
    const nm = meshRemap.get(n.mesh);
    if (nm === undefined) { const c = { ...n }; delete c.mesh; return c; }
    return { ...n, mesh: nm };
  });

  // --- 3) 可达性分析：从保留的 primitive 出发收集 accessor / bufferView
  const needAcc = new Set();
  const addAcc = (i) => { if (i != null) needAcc.add(i); };
  for (const m of newMeshes) {
    for (const p of m.primitives) {
      Object.values(p.attributes || {}).forEach(addAcc);
      addAcc(p.indices);
      (p.targets || []).forEach((t) => Object.values(t).forEach(addAcc));
    }
  }
  for (const s of skins) addAcc(s.inverseBindMatrices);           // 骨架全留，所以全部要
  for (const a of animations) {                                    // 动画全留
    for (const ch of a.channels || []) addAcc(ch.target?.node != null ? undefined : undefined);
    for (const sa of a.samplers || []) addAcc(sa.input), addAcc(sa.output);
  }

  // --- 4) 材质 / 贴图：只留保留 primitive 用到的
  const needMat = new Set();
  for (const m of newMeshes) for (const p of m.primitives) if (p.material != null) needMat.add(p.material);
  const needTex = new Set();
  const needImg = new Set();
  const matRemap = new Map();
  const newMaterials = [];
  materials.forEach((m, mi) => {
    if (!needMat.has(mi)) return;
    matRemap.set(mi, newMaterials.length);
    const t = m.pbrMetallicRoughness?.baseColorTexture;
    if (t != null) {
      needTex.add(t.index);
      const img = json.textures?.[t.index]?.source;
      if (img != null) needImg.add(img);
    }
    newMaterials.push(m);
  });

  // --- 5) bufferView：accessor 用到的 + 图片用到的
  // ⚠️ 别忘了 sparse：表情（52 个 blendshape）的 morph target 用的是稀疏 accessor，
  //    它们主体没有 bufferView，数据藏在 a.sparse.indices / a.sparse.values 里。
  //    漏掉这两个，新文件里 sparse 仍指向旧下标 → 下标越界 →
  //    GLTFLoader 报 "Cannot read properties of undefined (reading 'extensions')"，
  //    而且这个报错完全看不出是 sparse 坏了（踩过一次）。
  const needBv = new Set();
  for (const ai of needAcc) {
    const a = accessors[ai];
    if (!a) continue;
    if (a.bufferView != null) needBv.add(a.bufferView);
    if (a.sparse) {
      if (a.sparse.indices?.bufferView != null) needBv.add(a.sparse.indices.bufferView);
      if (a.sparse.values?.bufferView != null) needBv.add(a.sparse.values.bufferView);
    }
  }
  for (const ii of needImg) { const im = images[ii]; if (im && im.bufferView != null) needBv.add(im.bufferView); }

  // --- 6) 重建 BIN：逐个 bufferView 原样切片拷贝（允许重复，安全优先）
  const bvRemap = new Map();
  const chunks = [];
  let cursor = 0;
  const order = [...needBv].sort((a, b) => a - b);
  for (const bvi of order) {
    const bv = json.bufferViews[bvi];
    const start = bv.byteOffset || 0;
    const slice = Buffer.from(bin.slice(start, start + bv.byteLength));
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    bvRemap.set(bvi, { offset: cursor, length: bv.byteLength });
    chunks.push(slice);
    cursor += slice.length;
  }
  const newBin = Buffer.concat(chunks);

  // --- 7) 重映射并组装新 JSON
  const accRemap = new Map();
  const newAccessors = [];
  accessors.forEach((a, ai) => {
    if (!needAcc.has(ai)) return;
    accRemap.set(ai, newAccessors.length);
    const c = { ...a };
    if (a.bufferView != null) {
      const r = bvRemap.get(a.bufferView);
      if (!r) throw new Error(`accessor ${ai} 的 bufferView ${a.bufferView} 没有被保留`);
      c.bufferView = undefined; // 下面统一放
      c._bv = a.bufferView;
    }
    // 稀疏 accessor（表情 morph target）：indices / values 各有一份 bufferView，
    // 同样要换成新下标，否则指向的是旧的、已经不存在的位置
    if (a.sparse) {
      c.sparse = {
        ...a.sparse,
        indices: { ...a.sparse.indices, _bv: a.sparse.indices.bufferView, bufferView: undefined },
        values: { ...a.sparse.values, _bv: a.sparse.values.bufferView, bufferView: undefined },
      };
    }
    newAccessors.push(c);
  });
  // bufferView 索引重建
  const newBvList = [];
  const bvIndex = new Map();
  order.forEach((bvi) => { bvIndex.set(bvi, newBvList.length); newBvList.push({ ...json.bufferViews[bvi], buffer: 0, byteOffset: bvRemap.get(bvi).offset }); });
  newAccessors.forEach((a) => {
    if (a._bv != null) { a.bufferView = bvIndex.get(a._bv); delete a._bv; }
    if (a.sparse) {
      a.sparse.indices.bufferView = bvIndex.get(a.sparse.indices._bv);
      delete a.sparse.indices._bv;
      a.sparse.values.bufferView = bvIndex.get(a.sparse.values._bv);
      delete a.sparse.values._bv;
    }
  });

  const imgRemap = new Map();
  const newImages = [];
  images.forEach((im, ii) => {
    if (!needImg.has(ii)) return;
    imgRemap.set(ii, newImages.length);
    const c = { ...im, bufferView: bvIndex.get(im.bufferView) };
    newImages.push(c);
  });
  const texRemap = new Map();
  const newTextures = [];
  (json.textures || []).forEach((t, ti) => {
    if (!needTex.has(ti)) return;
    texRemap.set(ti, newTextures.length);
    newTextures.push({ ...t, source: imgRemap.get(t.source) });
  });
  newMaterials.forEach((m) => {
    const t = m.pbrMetallicRoughness?.baseColorTexture;
    if (t != null) m.pbrMetallicRoughness.baseColorTexture = { ...t, index: texRemap.get(t.index) };
  });

  const newMeshes2 = newMeshes.map((m) => ({
    ...m,
    primitives: m.primitives.map((p) => {
      const np = { ...p };
      if (p.material != null) np.material = matRemap.get(p.material);
      if (p.indices != null) np.indices = accRemap.get(p.indices);
      const at = {};
      for (const [k, v] of Object.entries(p.attributes || {})) at[k] = accRemap.get(v);
      np.attributes = at;
      if (p.targets) np.targets = p.targets.map((t) => { const o = {}; for (const [k, v] of Object.entries(t)) o[k] = accRemap.get(v); return o; });
      return np;
    }),
  }));

  const newSkins = skins.map((s) => ({ ...s, inverseBindMatrices: s.inverseBindMatrices != null ? accRemap.get(s.inverseBindMatrices) : undefined }));
  const newAnimations = (animations || []).map((a) => ({
    ...a,
    samplers: (a.samplers || []).map((sa) => ({ ...sa, input: accRemap.get(sa.input), output: accRemap.get(sa.output) })),
  }));

  const newJson = {
    ...json,
    buffers: [{ byteLength: newBin.length }],
    bufferViews: newBvList,
    accessors: newAccessors,
    meshes: newMeshes2,
    nodes: newNodes,
    skins: newSkins,
    materials: newMaterials,
    textures: newTextures,
    images: newImages,
    animations: newAnimations,
    samplers: json.samplers || [],
  };

  const bytes = writeGLB(newJson, newBin, outFile);

  // --- 8) 自校验：重新打开，按新偏移把每张贴图解码一遍
  const chk = loadGLB(outFile);
  let verified = 0;
  (chk.json.images || []).forEach((im, ii) => {
    const bv = chk.json.bufferViews[im.bufferView];
    const slice = chk.bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const head = slice.slice(0, 8).toString('hex');
    if (head !== '89504e470d0a1a0a') throw new Error(`自校验失败：image[${ii}] ${im.name} 不是 PNG（头 ${head}）`);
    decodePNG(slice);
    verified++;
  });
  // accessors 越界检查
  chk.json.accessors.forEach((a, ai) => {
    if (a.bufferView == null) return;
    const bv = chk.json.bufferViews[a.bufferView];
    const end = (bv.byteOffset || 0) + (a.byteOffset || 0) + a.count * (a.componentType === 5126 ? 4 : a.componentType === 5123 ? 2 : 1) * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type] || 1);
    if (end > chk.bin.length) throw new Error(`自校验失败：accessor[${ai}] 越界 ${end} > ${chk.bin.length}`);
  });

  // ⚠️ 关键自校验：不允许出现「bufferView 下标指向不存在的位置」。
  //    稀疏 accessor（表情 morph target）的主体可以没有 bufferView，
  //    但 sparse.indices / sparse.values 必须有，而且下标必须有效。
  //    漏掉这条，出来的文件 three.js 只在运行时抛一句
  //    "Cannot read properties of undefined (reading 'extensions')"，极难定位。
  const nbv = chk.json.bufferViews.length;
  chk.json.accessors.forEach((a, ai) => {
    if (a.bufferView != null && (a.bufferView < 0 || a.bufferView >= nbv)) {
      throw new Error(`自校验失败：accessor[${ai}].bufferView=${a.bufferView} 越界（共 ${nbv} 个 bufferView）`);
    }
    if (a.sparse) {
      for (const part of ['indices', 'values']) {
        const b = a.sparse[part]?.bufferView;
        if (b == null || b < 0 || b >= nbv) {
          throw new Error(`自校验失败：accessor[${ai}].sparse.${part}.bufferView=${b} 越界（共 ${nbv} 个 bufferView）`);
        }
      }
    }
  });

  return {
    bytes,
    meshes: newMeshes2.length,
    prims: primKeptCount.n,
    verts: newMeshes2.reduce((s, m) => s + m.primitives.reduce((t, p) => t + (chk.json.accessors[p.attributes.POSITION]?.count || 0), 0), 0),
    morph: Math.max(0, ...newMeshes2.map((m) => Math.max(0, ...m.primitives.map((p) => (p.targets || []).length)))),
    materials: newMaterials.length,
    images: verified,
    nodes: newNodes.length,
    skins: newSkins.length,
    animations: newAnimations.length,
  };
}

const isMain = (() => {
  try { return import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href; } catch { return false; }
})();
if (isMain) {
  const [inp, outp, spec] = process.argv.slice(2);
  if (!inp || !outp || !spec) {
    console.error('用法: node tools/glbsplit.mjs <输入.glb> <输出.glb> <mesh名[#prim],...>');
    process.exit(1);
  }
  const before = fs.statSync(inp).size;
  const r = splitGLB(inp, outp, spec);
  console.log(`拆分完成 → ${path.basename(outp)}`);
  console.log(`  ${(before / 1048576).toFixed(2)} MB → ${(r.bytes / 1048576).toFixed(2)} MB`);
  console.log(`  mesh ${r.meshes} / primitive ${r.prims} / 顶点 ${r.verts} / 表情 ${r.morph}`);
  console.log(`  材质 ${r.materials} / 贴图 ${r.images}（已逐个解码验证）/ node ${r.nodes} / skin ${r.skins} / 动画 ${r.animations}`);
}
