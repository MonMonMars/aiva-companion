// 把一份 GLB 按「(mesh, primitive) 白名单」拆成若干份部件文件。
// 专为 VRoid / VRM 那种「多个 primitive 共用同一份顶点缓冲、靠 index 区分材质」的结构设计。
//
// 为什么不像 glbsplit 那样按 node 删：
//   Shino 的 Body.baked 里 9 个 primitive **共用同一个 POSITION accessor**，
//   真正区分皮肤 / 衣服 / 后发的是各自的 indices。按 node 级切会把整块 Body 一起带走，
//   剥不掉衣服。只能在 primitive 层面过滤。
//
// 两条必须守住的底线（都是在 Kizuna 上付过学费的）：
//   1. **整棵 node 树一个不删**。skin.joints 引用的是 node 索引，删一个节点后面全线错位，
//      而且 three.js 只会抛出跟差距毫无关系的 `Cannot read properties of undefined`。
//   2. **bufferView 从不假设连续/不重叠**。重建 BIN 时按 (offset,length) 原样搬字节、
//      去重相同的段，每段再补齐 4 字节对齐（glTF 要求 accessor 偏移是分量大小的倍数）。
//
// morph target 必须连同 sparse 一起带走 —— Face.baked 的 16 个表情是 lip-sync 的命脉，
// 漏了口型就全没了。
import fs from 'node:fs';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/';
const SRC = ROOT + 'assets/models4/aiva-shino-front.glb';
const DST = ROOT + 'assets/models5/';

const raw = fs.readFileSync(SRC);
const total = raw.length;

// ---------- 读 GLB 容器 ----------
const dv0 = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
if (dv0.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB');
let json = null, binOff = 0, binLen = 0;
{
  let off = 12;
  while (off + 8 <= total) {
    const len = dv0.getUint32(off, true), type = dv0.getUint32(off + 4, true), start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(raw.slice(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) { binOff = start; binLen = len; }
    off = start + len;
  }
}
if (!json) throw new Error('缺 JSON chunk');
const BIN = raw.slice(binOff, binOff + binLen);

const matName = (i) => json.materials[i]?.name || '';
const isCloth = (i) => /CLOTH/i.test(matName(i));
const isSkin = (i) => /_SKIN/.test(matName(i));
const isHairMat = (i) => /_HAIR/i.test(matName(i));

const meshByName = {};
json.meshes.forEach((m, i) => { meshByName[m.name] = i; });

// ---------- 定义每个输出部件：哪个 mesh 的第几个 prim 保留 ----------
function buildSpec() {
  const body = meshByName['Body.baked'];
  const face = meshByName['Face.baked'];
  const hair = meshByName['Hair001.baked'];
  if (body === undefined || face === undefined || hair === undefined) {
    throw new Error('找不到 mesh，实际有：' + json.meshes.map((m) => m.name).join(' | '));
  }
  const bp = json.meshes[body].primitives.map((p, i) => ({ i, m: p.material }));
  const keep = (pred) => bp.filter((x) => pred(x.m)).map((x) => x.i);
  // 为什么是 3 块不是 4 块：base / outfit / hairback 都要用到 Body.baked 那份共享
  // 顶点缓冲（9 个 prim 共用同一份 POSITION），拆成 3 个文件就等于把它复制 3 遍
  // （实测合计 5.67MB > 原文件 4.69MB）。把后发并进 hair，只留 2 份持有身体缓冲。
  return {
    base: {
      [face]: 'all',
      [body]: keep((m) => isSkin(m)),       // 只有 4 个 Body_00_SKIN prim = 裸躯干 + 头脸
    },
    outfit: {
      [body]: keep((m) => isCloth(m)),      // Tops / Accessory / Bottoms / Shoes
    },
    hair: {
      [hair]: 'all',                        // 主头发 48 prims
      [body]: keep((m) => isHairMat(m)),    // + Body.baked 里的后发，合成一顶完整头发
    },
  };
}

// ---------- 核心：按白名单重建 ----------
function extract(name, allow) {
  const src = json;
  const out = {
    asset: { ...(src.asset || {}), generator: (src.asset?.generator || '') + ` [part:${name}]` },
    scene: src.scene, scenes: JSON.parse(JSON.stringify(src.scenes || [])),
    nodes: JSON.parse(JSON.stringify(src.nodes || [])),      // ★ node 树一个不动
    skins: JSON.parse(JSON.stringify(src.skins || [])),
    animations: JSON.parse(JSON.stringify(src.animations || [])),
    extensionsUsed: src.extensionsUsed ? [...src.extensionsUsed] : undefined,
    extensionsRequired: src.extensionsRequired ? [...src.extensionsRequired] : undefined,
    extensions: src.extensions ? JSON.parse(JSON.stringify(src.extensions)) : undefined,
  };

  // ---- 1) 挑出保留的 primitive ----
  const newMeshes = src.meshes.map((m, mi) => {
    const mode = allow[mi];
    let prims;
    if (mode === 'all') prims = m.primitives.map((p) => ({ p, srcIdx: m.primitives.indexOf(p) }));
    else if (Array.isArray(mode)) prims = mode.map((i) => ({ p: m.primitives[i], srcIdx: i }));
    else prims = [];
    if (!prims.length) return { name: m.name, primitives: [], extras: m.extras, weights: m.weights };
    const mm = { name: m.name, primitives: prims.map(({ p }) => JSON.parse(JSON.stringify(p))) };
    if (m.extras) mm.extras = JSON.parse(JSON.stringify(m.extras));   // ★ targetNames 在这
    if (m.weights) mm.weights = [...m.weights];
    return mm;
  });

  // ---- 2) 收集可达资源 ----
  const needAcc = new Set(), needMat = new Set(), needTex = new Set(), needImg = new Set(), needSamp = new Set();
  const addAcc = (i) => { if (i !== undefined && i !== null) needAcc.add(i); };
  newMeshes.forEach((m) => (m.primitives || []).forEach((p) => {
    Object.values(p.attributes || {}).forEach(addAcc);
    addAcc(p.indices);
    (p.targets || []).forEach((t) => Object.values(t || {}).forEach(addAcc));
    if (p.material !== undefined) needMat.add(p.material);
  }));
  (src.skins || []).forEach((s) => addAcc(s.inverseBindMatrices));

  // attr Eve如此you.For/自定义扩展里也可能引 accessor，保守起见一并带上已选 mesh 涉及的所有 targetName 项
  // ⚠️ `baseColorTexture` 是嵌在 `pbrMetallicRoughness` 里的，只扫材质顶层 key 会漏掉
  //    漫反射贴图 —— 那样拆出来的部件一张图都没有（实测三个文件 images=0）。
  //    必须递归遍历，任何 key 以 Texture 结尾且带 index 的节点都收。
  const harvestTex = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) { v.forEach(harvestTex); continue; }
      if (v && typeof v === 'object') {
        if (k.endsWith('Texture') && v.index !== undefined) needTex.add(v.index);
        harvestTex(v);
      }
    }
  };
  const needMatArr = [...needMat].sort((a, b) => a - b);
  const remapMat = new Map(); needMatArr.forEach((o, n) => remapMat.set(o, n));
  const newMats = needMatArr.map((oi) => {
    const m = JSON.parse(JSON.stringify(src.materials[oi]));
    harvestTex(m);
    return m;
  });
  const needTexArr = [...needTex].sort((a, b) => a - b);
  const remapTex = new Map(); needTexArr.forEach((o, n) => remapTex.set(o, n));
  const newTex = needTexArr.map((oi) => {
    const t = JSON.parse(JSON.stringify(src.textures[oi]));
    if (t.source !== undefined) needImg.add(t.source);
    if (t.sampler !== undefined) needSamp.add(t.sampler);
    return t;
  });
  const needImgArr = [...needImg].sort((a, b) => a - b);
  const remapImg = new Map(); needImgArr.forEach((o, n) => remapImg.set(o, n));
  const newImg = needImgArr.map((oi) => JSON.parse(JSON.stringify(src.images[oi])));
  const needSampArr = [...needSamp].sort((a, b) => a - b);
  const remapSamp = new Map(); needSampArr.forEach((o, n) => remapSamp.set(o, n));
  const newSamp = needSampArr.map((oi) => JSON.parse(JSON.stringify(src.samplers[oi])));

  // ---- 3) accessor + bufferView 重映射 ----
  needAcc.forEach((i) => {
    const a = src.accessors[i];
    if (!a) return;
    if (a.sparse) { needAcc.add(a.sparse.indices.bufferView); needAcc.add(a.sparse.values.bufferView); }
  });
  // 上面误把 bufferView 当 accessor 加进去了，下面重来一遍干净的集合
  const needAccArr = [];
  const needBv = new Set();
  const collectAcc = (i) => {
    if (i === undefined || i === null) return;
    if (needAccArr.includes(i)) return;
    needAccArr.push(i);
    const a = src.accessors[i]; if (!a) return;
    if (a.bufferView !== undefined) needBv.add(a.bufferView);
    if (a.sparse) { needBv.add(a.sparse.indices.bufferView); needBv.add(a.sparse.values.bufferView); }
  };
  needAcc.forEach(collectAcc);
  needImgArr.forEach((i) => { const b = src.images[i]?.bufferView; if (b !== undefined) needBv.add(b); });

  const needAccSorted = [...needAccArr].sort((a, b) => a - b);
  const remapAcc = new Map(); needAccSorted.forEach((o, n) => remapAcc.set(o, n));
  const newAcc = needAccSorted.map((oi) => JSON.parse(JSON.stringify(src.accessors[oi])));

  // ---- 4) 重建 BIN：原样搬字节 + 去重 + 4 字节对齐 ----
  // 去重键是 (旧偏移, 长度)：Body.baked 那 9 个 prim 共用的顶点缓冲只会被搬一次。
  const needBvArr = [...needBv].sort((a, b) => a - b);
  const chunks = [];
  const newBv = [];
  const remapBv = new Map();
  const seen = new Map();
  let cursor = 0;
  needBvArr.forEach((oi) => {
    const v = src.bufferViews[oi];
    const o = v.byteOffset || 0, l = v.byteLength;
    const key = o + ':' + l;
    if (seen.has(key)) { remapBv.set(oi, seen.get(key)); return; }   // 命中已搬过的同段
    const nv = { buffer: 0, byteOffset: cursor, byteLength: l };
    if (v.byteStride !== undefined) nv.byteStride = v.byteStride;
    if (v.target !== undefined) nv.target = v.target;
    if (v.name !== undefined) nv.name = v.name;
    newBv.push(nv);
    seen.set(key, newBv.length - 1);
    remapBv.set(oi, newBv.length - 1);
    chunks.push(BIN.slice(o, o + l));
    cursor += l;
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }     // 分量对齐，最大 4 字节
  });
  const newBin = Buffer.concat(chunks);

  // ---- 5) 回填索引 ----
  newAcc.forEach((a, n) => {
    if (a.bufferView !== undefined) a.bufferView = remapBv.get(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = remapBv.get(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = remapBv.get(a.sparse.values.bufferView);
    }
  });
  newMeshes.forEach((m) => (m.primitives || []).forEach((p) => {
    if (p.indices !== undefined) p.indices = remapAcc.get(p.indices);
    const at = {}; for (const [k, v] of Object.entries(p.attributes || {})) at[k] = remapAcc.get(v);
    p.attributes = at;
    if (p.targets) p.targets = p.targets.map((t) => { const o = {}; for (const [k, v] of Object.entries(t || {})) o[k] = remapAcc.get(v); return o; });
    if (p.material !== undefined) p.material = remapMat.get(p.material);
  }));
  (out.skins || []).forEach((s) => { if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remapAcc.get(s.inverseBindMatrices); });
  // 回填同样要递归 —— 不然只有顶层能改到，pbrMetallicRoughness 里还指着旧 index
  const repointTex = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) { v.forEach(repointTex); continue; }
      if (v && typeof v === 'object') {
        if (k.endsWith('Texture') && v.index !== undefined) v.index = remapTex.get(v.index);
        repointTex(v);
      }
    }
  };
  newMats.forEach(repointTex);
  newTex.forEach((t) => {
    if (t.source !== undefined) t.source = remapImg.get(t.source);
    if (t.sampler !== undefined) t.sampler = remapSamp.get(t.sampler);
  });
  newImg.forEach((im) => { if (im.bufferView !== undefined) im.bufferView = remapBv.get(im.bufferView); });

  out.meshes = newMeshes;
  out.accessors = newAcc;
  out.bufferViews = newBv;
  out.materials = newMats;
  out.textures = newTex;
  out.images = newImg;
  out.samplers = newSamp;
  out.buffers = [{ byteLength: newBin.length }];

  return { json: out, bin: newBin };
}

// ---------- 写 GLB ----------
function writeGlb(path, j, bin) {
  let js = Buffer.from(JSON.stringify(j), 'utf8');
  const jpad = (4 - (js.length % 4)) % 4; if (jpad) js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
  const bpad = (4 - (bin.length % 4)) % 4;
  const b = bpad ? Buffer.concat([bin, Buffer.alloc(bpad)]) : bin;
  const head = Buffer.alloc(12);
  const totalLen = 12 + 8 + js.length + 8 + b.length;
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(totalLen, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(path, Buffer.concat([head, jh, js, bh, b]));
  return totalLen;
}

// ---------- 跑 ----------
const spec = buildSpec();
fs.mkdirSync(DST, { recursive: true });
const lines = [];
const say = (s) => lines.push(s);
say('源文件 ' + SRC.replace(ROOT, ''));
say('');
for (const [name, allow] of Object.entries(spec)) {
  const { json: j, bin } = extract(name, allow);
  const p = DST + `aiva-shino-${name}.glb`;
  const size = writeGlb(p, j, bin);
  const prims = j.meshes.reduce((s, m) => s + (m.primitives?.length || 0), 0);
  const withT = j.meshes.reduce((s, m) => s + (m.primitives || []).reduce((a, pr) => a + (pr.targets?.length || 0), 0), 0);
  say(`${name.padEnd(9)} ${(size / 1048576).toFixed(2).padStart(6)} MB  prims=${String(prims).padStart(3)}  `
    + `mats=${String(j.meshes.reduce((s, m) => s + new Set((m.primitives || []).map((x) => x.material)).size, 0)).padStart(2)}  `
    + `targets=${String(withT).padStart(4)}  节点=${j.nodes.length}  骨架=${j.skins.length}  贴图=${j.images.length}`);
  say(`           目标-> ${p.replace(ROOT, '')}`);
}
say('');
say('校验：节点数与骨架数必须和源文件一致（' + json.nodes.length + ' / ' + json.skins.length + '），否则 joint 索引错位。');
fs.writeFileSync('C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/tmp/split-log.txt', lines.join('\n'));
console.log(lines.join('\n'));
