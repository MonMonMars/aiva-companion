#!/usr/bin/env node
// 拆件后的「抽真空」：把每个部件里**没有被引用的顶点**整段删掉，索引重映射。
//
// 为什么会有死顶点：Shino 的 Body.baked 是一整块 7798 顶点的缓冲，9 个 primitive
// 共用它、靠各自的 indices 区分皮肤 / 衣服 / 后发。我们按 primitive 拆成 3 个文件后，
// 每个文件都把整块 7798 顶点**连同用不到的那部分**一起搬走了：
//   outfit 只用 2925 / 7798，hair 里的后发只用 225 / 7798 —— 剩下全是白搬的。
// 结果就是三块加起来 5.77MB，比拆之前的单文件 4.69MB 还大。
//
// 本脚本按 **POSITION accessor 分组**（共用同一份顶点缓冲的 primitive 算一组），
// 算出组内所有 indices 的并集，只保留被引用的顶点，其余连同它们的
// NORMAL / TEXCOORD / JOINTS / WEIGHTS / morph target 一起丢掉。
//
// 安全底线（踩过学费的）：
//   1. **node 树 / skin / 动画一个字节都不动** —— 顶点重排不会碰它们。
//   2. 遇到 sparse accessor、byteStride（交错缓冲）、多个 accessor 共用 bufferView
//      这三种情况**直接拒绝并退出**，宁可不动也别悄悄压坏。
//   3. morph target 跟着 POSITION 一起精简，口型才不会错位。
//
// 用法: node tools/glbcompact.mjs <输入.glb> <输出.glb>
import fs from 'node:fs';

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const CSZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const elemSize = (a) => COMP[a.type] * CSZ[a.componentType];

function readGLB(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4), s = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(b.slice(s, s + len).toString('utf8'));
    else if (type === 0x004e4942) bin = b.slice(s, s + len);
    off = s + len;
  }
  if (!json) throw new Error('缺 JSON chunk: ' + file);
  return { json, bin: bin || Buffer.alloc(0) };
}

function writeGLB(file, json, bin) {
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const jp = (4 - (js.length % 4)) % 4;
  if (jp) js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);        // JSON chunk 补空格
  const bp = (4 - (bin.length % 4)) % 4;
  const bb = bp ? Buffer.concat([bin, Buffer.alloc(bp)]) : bin;     // BIN chunk 补 0
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bb.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bb.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, c1, js, c2, bb]));
}

function compact(srcFile, dstFile) {
  const { json, bin } = readGLB(srcFile);
  const A = json.accessors || [], BV = json.bufferViews || [];

  // ---- 0) 先确认这份文件压得动 -------------------------------------------
  const sparseIdx = A.map((a, i) => (a.sparse ? i : -1)).filter((i) => i >= 0);
  const strided = A.map((a, i) => (a.bufferView != null && BV[a.bufferView]?.byteStride ? i : -1)).filter((i) => i >= 0);
  const bvUse = new Map();
  A.forEach((a, i) => { if (a.bufferView != null) bvUse.set(a.bufferView, (bvUse.get(a.bufferView) || 0) + 1); });
  const sharedBV = [...bvUse.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (sparseIdx.length || strided.length || sharedBV.length) {
    throw new Error(`拒绝压缩：sparse=${sparseIdx} strided=${strided} 共用bufferView=${sharedBV}`
      + ' —— 这几样都要专门处理，先别硬压');
  }

  // ---- 1) 按 POSITION accessor 分组 ---------------------------------------
  const groups = new Map();     // posAcc -> { prims:[{p, mesh}], attrs:Set(accIdx), idxAccs:Set(accIdx) }
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      const pa = (p.attributes || {}).POSITION;
      if (pa == null) continue;
      if (!groups.has(pa)) groups.set(pa, { prims: [], attrs: new Set(), idxAccs: new Set() });
      const g = groups.get(pa);
      g.prims.push(p);
      for (const v of Object.values(p.attributes || {})) g.attrs.add(v);
      for (const t of p.targets || []) for (const v of Object.values(t)) g.attrs.add(v);
      if (p.indices != null) g.idxAccs.add(p.indices);
    }
  }

  // ---- 2) 算出每组活着的顶点 ----------------------------------------------
  const remaps = new Map();     // posAcc -> Int32Array(oldIdx -> newIdx | -1)
  let saved = 0, savedBytes = 0;
  for (const [pa, g] of groups) {
    const n = A[pa].count;
    const live = [];
    for (let i = 0; i < n; i++) live.push(false);
    let canDo = true;
    for (const p of g.prims) {
      if (p.indices == null) { canDo = false; break; }   // 非索引绘制 = 每个顶点都用到了
      const ia = A[p.indices];
      const bv = BV[ia.bufferView];
      const base = (bv.byteOffset || 0) + (ia.byteOffset || 0);
      for (let i = 0; i < ia.count; i++) {
        live[ia.componentType === 5125 ? bin.readUInt32LE(base + i * 4) : bin.readUInt16LE(base + i * 2)] = true;
      }
    }
    if (!canDo) { console.log(`   组 acc#${pa}: 有 primitive 不带 indices，跳过`); continue; }
    const remap = new Int32Array(n).fill(-1);
    let k = 0;
    for (let i = 0; i < n; i++) if (live[i]) remap[i] = k++;
    if (k === n) { console.log(`   组 acc#${pa}: ${n} 顶点全用到，无需压缩`); continue; }
    let bytesPerVert = 0;
    for (const ai of g.attrs) bytesPerVert += elemSize(A[ai]);
    remaps.set(pa, remap);
    saved += n - k; savedBytes += (n - k) * bytesPerVert;
    console.log(`   组 acc#${pa}: ${n} → ${k}（省 ${n - k} 顶点 / ${((n - k) * bytesPerVert / 1024).toFixed(0)} KB）`);
  }

  // ---- 3) 重建 BIN ---------------------------------------------------------
  const chunks = []; let cursor = 0;
  const newBV = [];
  const push = (buf, align, target) => {
    const pad = (align - (cursor % align)) % align;      // ⚠️ 取模必须对着 align，写死 %4 会在 align<4 时错位
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    chunks.push(buf); cursor += buf.length;
    const idx = newBV.length;
    newBV.push({ buffer: 0, byteOffset: cursor - buf.length, byteLength: buf.length, ...(target ? { target } : {}) });
    return idx;
  };
  const rawBytes = (ai) => {
    const a = A[ai], bv = BV[a.bufferView];
    const s = (bv.byteOffset || 0) + (a.byteOffset || 0);
    return bin.subarray(s, s + a.count * elemSize(a));
  };
  const copiedBV = new Map();   // 原 bufferView -> 新 bufferView（原样搬字节的去重）

  const accRole = new Array(A.length).fill(null);   // {group, remap} | 'index' | null
  for (const [pa, g] of groups) {
    const remap = remaps.get(pa);
    if (!remap) continue;
    for (const ai of g.attrs) accRole[ai] = { remap };
    for (const ai of g.idxAccs) accRole[ai] = { remap, isIndex: true };
  }

  const newA = [];
  for (let i = 0; i < A.length; i++) {
    const a = { ...A[i] };
    const role = accRole[i];
    if (role && !role.isIndex) {
      // 顶点属性：只写活着的
      const es = elemSize(a);
      const src = rawBytes(i);                    // 只切一次，别在循环里反复 subarray
      const keep = [];
      for (let v = 0; v < a.count; v++) {
        if (role.remap[v] >= 0) keep.push(src.subarray(v * es, (v + 1) * es));
      }
      const buf = Buffer.concat(keep.length ? keep : [Buffer.alloc(0)]);
      a.count = keep.length;
      a.bufferView = push(buf, Math.min(4, es));
      a.byteOffset = 0;
      delete a.min; delete a.max;
      // POSITION 的 min/max 是规范要求的，顺手重算（NORMAL 等无所谓，但算了也无害）
      if (a.type === 'VEC3' && a.componentType === 5126) {
        const f = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < f.length; k += 3) for (let c = 0; c < 3; c++) {
          mn[c] = Math.min(mn[c], f[k + c]); mx[c] = Math.max(mx[c], f[k + c]);
        }
        a.min = mn; a.max = mx;
      }
    } else if (role && role.isIndex) {
      // 索引：值重映射，数量不变
      const es = elemSize(a);
      const src = rawBytes(i);
      const out = Buffer.alloc(src.length);
      for (let v = 0; v < a.count; v++) {
        const old = a.componentType === 5125 ? src.readUInt32LE(v * 4) : src.readUInt16LE(v * 2);
        const nv = role.remap[old];
        if (nv < 0) throw new Error(`索引越界：accessor#${i} 第 ${v} 个引用了已被删掉的顶点 ${old}`);
        if (a.componentType === 5125) out.writeUInt32LE(nv, v * 4); else out.writeUInt16LE(nv, v * 2);
      }
      a.bufferView = push(out, 4, 34963);
      a.byteOffset = 0;
    } else {
      // 其余（骨骼 IBM、动画等）：原样搬
      if (copiedBV.has(a.bufferView)) { a.bufferView = copiedBV.get(a.bufferView); a.byteOffset = 0; }
      else {
        const nb = push(rawBytes(i), 4, BV[a.bufferView]?.target === 34963 ? 34963 : undefined);
        copiedBV.set(A[i].bufferView, nb);
        a.bufferView = nb; a.byteOffset = 0;
      }
    }
    newA.push(a);
  }

  // 图片：同样原样搬，并跟 accessors 共用时去重合流
  const newImages = (json.images || []).map((im) => {
    if (im.bufferView == null) return im;                 // 外链 URI，不动
    if (copiedBV.has(im.bufferView)) return { ...im, bufferView: copiedBV.get(im.bufferView) };
    const bv = BV[im.bufferView];
    const s = bv.byteOffset || 0;
    const nb = push(bin.subarray(s, s + (bv.byteLength || 0)), 4);
    copiedBV.set(im.bufferView, nb);
    return { ...im, bufferView: nb };
  });

  json.accessors = newA;
  json.bufferViews = newBV;
  json.images = newImages;
  json.buffers = [{ byteLength: cursor }];
  json.asset = { ...(json.asset || {}), generator: (json.asset?.generator || '') + ' [compact]' };

  writeGLB(dstFile, json, Buffer.concat(chunks.length ? chunks : [Buffer.alloc(0)]));
  return { saved, savedBytes, src: fs.statSync(srcFile).size, dst: fs.statSync(dstFile).size };
}

// ---- 主流程 ---------------------------------------------------------------
const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.log('用法: node tools/glbcompact.mjs <输入.glb> <输出.glb>'); process.exit(1); }
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('压缩 ' + src.split(/[\\/]/).pop());
const r = compact(src, dst);
console.log(`  ${kb(r.src)} → ${kb(r.dst)}  （省 ${kb(r.src - r.dst)}，${r.saved} 个死顶点 / ${kb(r.savedBytes)} 顶点数据）`);
