#!/usr/bin/env node
// 看一个 glTF/GLB 里到底有哪些动画、骨架长什么样、能不能套到我们的 VRM 上。
//
// 为什么必须真读文件：动画库的 README 只会说「120+ animations」，
// 但**到底有哪几个、骨名是什么命名体系**只有解析出来才知道。
// 骨名体系决定要不要写重定向适配层 —— 这是能不能用的前提。
//
// 用法：node tools/motion-inspect.mjs assets/motion/AnimationLibrary_Godot_Standard.gltf
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/motion-inspect.mjs <gltf|glb>'); process.exit(1); }

const buf = fs.readFileSync(file);
let json = null;

if (file.toLowerCase().endsWith('.glb')) {
  // GLB: 12 字节头 + chunk。第一个 chunk 必须是 JSON
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('不是 GLB（magic 不对）');
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) { json = JSON.parse(data.toString('utf8')); break; }
    off += 8 + len;
  }
} else {
  json = JSON.parse(buf.toString('utf8'));
}
if (!json) throw new Error('没找到 JSON chunk');

const anims = json.animations || [];
const nodes = json.nodes || [];
const skins = json.skins || [];

console.log('=== ' + path.basename(file) + ' ===');
console.log('生成器     :', json.asset?.generator || '(未标)');
console.log('节点数     :', nodes.length);
console.log('网格数     :', (json.meshes || []).length);
console.log('蒙皮数     :', skins.length);
console.log('动画数     :', anims.length);
console.log('材质数     :', (json.materials || []).length);

// 骨名：从一个 skin 的 joints 里读
const joints = new Set();
for (const s of skins) for (const j of s.joints || []) joints.add(j);
const boneNames = [...joints].map((i) => nodes[i]?.name || `#${i}`).filter(Boolean);
console.log('\n骨名（' + boneNames.length + ' 根，前 60）：');
console.log('  ' + boneNames.slice(0, 60).join(', '));

console.log('\n动画清单：');
anims.forEach((a, i) => {
  // 每个 animation 覆盖哪些节点 —— 数量能反映"这是全身动画还是只动一根骨"
  const targets = new Set((a.channels || []).map((c) => c.target?.node));
  console.log(`  ${String(i + 1).padStart(3)}. ${(a.name || '(无名)').padEnd(34)} 通道 ${String((a.channels || []).length).padStart(3)}  影响节点 ${targets.size}`);
});

// 命名体系判断：决定要不要写重定向
const nameBlob = boneNames.join(' ').toLowerCase();
const hits = [];
if (/mixamorig|leftarm|leftforearm|upleg/.test(nameBlob)) hits.push('Mixamo 语义');
if (/\bhip\b|spine|neck|head/.test(nameBlob)) hits.push('通用人形语义');
if (/j_c_|j_l_|j_r_|vrm/.test(nameBlob)) hits.push('VRM/MMD 日式');
if (/root|pelvis/.test(nameBlob)) hits.push('含 root/pelvis');
console.log('\n命名体系线索:', hits.length ? hits.join(' / ') : '(没识别出来)');
