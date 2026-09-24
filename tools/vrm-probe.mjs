// vrm-probe.mjs —— 转换前的最后一道摸底
// 只回答四个问题：贴图能不能压 / 材质要不要改 / 骨骼名能不能被 rigStandard 认 / 是不是 T-pose
// 用法: node tools/vrm-probe.mjs <file.vrm>
import fs from 'node:fs';
import path from 'node:path';

function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB/VRM');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
  }
  return { json, bin };
}

const file = process.argv[2];
if (!file) { console.error('用法: node tools/vrm-probe.mjs <file.vrm>'); process.exit(1); }
const { json, bin } = parseGlb(file);
console.log('文件  ' + path.basename(file) + '   ' + (fs.statSync(file).size / 1048576).toFixed(2) + ' MB');

// ---- 1) 贴图：格式与尺寸决定能不能离线压缩 ----
console.log('\n== 贴图 ==');
const totals = {};
for (const img of json.images || []) {
  const bv = json.bufferViews[img.bufferView];
  const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  let w = 0, h = 0, kind = '?';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    kind = 'PNG'; w = bytes.readUInt32BE(16); h = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    kind = 'JPEG';
    for (let o = 2; o + 9 < bytes.length;) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const marker = bytes[o + 1];
      const seglen = bytes.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        h = bytes.readUInt16BE(o + 5); w = bytes.readUInt16BE(o + 7); break;
      }
      o += 2 + seglen;
    }
  }
  const mime = img.mimeType || '?';
  console.log(`  ${String(w + 'x' + h).padStart(11)}  ${String((bv.byteLength / 1024).toFixed(0) + 'KB').padStart(8)}  ${kind.padEnd(5)} mime=${mime}  ${img.name || ''}`);
  totals[kind] = (totals[kind] || 0) + bv.byteLength;
}
console.log('  小计: ' + Object.entries(totals).map(([k, v]) => `${k} ${(v / 1048576).toFixed(2)}MB`).join('  |  '));

// ---- 2) 材质：VRM 0.x 可能用 MToon / Unlit，three 不认 ----
console.log('\n== 材质 ==');
const extUse = {};
for (const m of json.materials || []) {
  for (const k of Object.keys(m.extensions || {})) extUse[k] = (extUse[k] || 0) + 1;
}
console.log('  数量 ' + (json.materials || []).length);
console.log('  扩展 ' + (Object.keys(extUse).length ? Object.entries(extUse).map(([k, v]) => `${k} x${v}`).join('  ') : '无'));
console.log('  extensionsUsed ' + JSON.stringify(json.extensionsUsed || []));
const mp = json.extensions?.VRM?.materialProperties || [];
console.log('  VRM materialProperties ' + mp.length + ' 个，shader 分布: ' +
  JSON.stringify(mp.reduce((m, x) => ((m[x.shader] = (m[x.shader] || 0) + 1), m), {})));
const keyList = (o) => Object.keys(o || {}).join(',');
for (const m of mp.slice(0, 4)) {
  console.log(`    ${String(m.name).padEnd(24)} shader=${m.shader} renderQueue=${m.renderQueue}`);
  console.log(`      float: ${keyList(m.floatProperties)}`);
  console.log(`      tex:   ${keyList(m.textureProperties)}`);
}
const hasBase = (json.materials || []).every((m) => m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture);
console.log('  全部材质带 baseColorTexture: ' + (hasBase ? '是 ✅' : '否 ⚠️（有的材质会是纯色）'));

// ---- 3) 骨骼名 ----
console.log('\n== 骨骼节点名（前 20）==');
const skinners = (json.nodes || []).filter((n) => n.skin !== undefined);
console.log('  skin %d 份', (json.skins || []).length);
const jointIdx = new Set();
for (const s of json.skins || []) s.joints.forEach((j) => jointIdx.add(j));
console.log('  joint 节点数 ' + jointIdx.size);
console.log('  ' + [...jointIdx].slice(0, 20).map((i) => json.nodes[i].name).join(' '));

// VRM humanoid -> node 名字映射（验证是否就是上面这批）
const hb = json.extensions?.VRM?.humanoid?.humanBones || [];
const pick = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftHand', 'leftUpperLeg', 'leftFoot'];
console.log('  humanoid 关键骨 → 节点名:');
for (const b of hb.filter((b) => pick.includes(b.bone))) {
  console.log(`    ${b.bone.padEnd(14)} ${json.nodes[b.node].name}`);
}

// ---- 4) T-pose / A-pose：看上臂是不是水平张开 ----
console.log('\n== 姿态 ==');
function worldOf(nodeIdx) {
  // 往上找父，累乘 TRS
  const chain = [];
  const childToParent = new Map();
  (json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => childToParent.set(c, i)));
  let cur = nodeIdx, guard = 0;
  while (cur !== undefined && guard++ < 64) { chain.unshift(cur); cur = childToParent.get(cur); }
  let x = 0, y = 0, z = 0;
  for (const i of chain) {
    const n = json.nodes[i];
    if (n.translation) { x += n.translation[0]; y += n.translation[1]; z += n.translation[2]; }
  }
  return [x, y, z];
}
for (const b of hb.filter((x) => ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'].includes(x.bone))) {
  const p = worldOf(b.node);
  console.log(`  ${b.bone.padEnd(14)} (${p.map((v) => v.toFixed(3)).join(', ')})`);
}
console.log('  判读：上臂-手腕的 Y 差很小且 X 差很大 = T-pose（VRM 规范要求的就是这个）');
