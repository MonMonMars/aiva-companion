// 直接从 GLB 里解出 MakeHuman 身体的全部骨骼名（离线、不需要起服务）。
// 目的：避免手写对照表时用错名字（历史上因为写成 eye.L / orbicularis03.L 导致只剩 3 个通道）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'assets', 'models4', 'aiva-base-mh.glb');

const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');

let off = 12;
let json = null;
let bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const start = off + 8;
  if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
  else if (type === 0x004e4942) bin = buf.slice(start, start + len);
  off = start + len + ((4 - (len % 4)) % 4) * 0;
  off = start + len;
}

const nodes = json.nodes;
console.log(`== ${path.basename(file)} ==  节点 ${nodes.length} 个，皮肤 ${(json.skins || []).length} 个`);

const skin = json.skins[0];
const jointIdx = new Set(skin.joints);
console.log(`== 该皮肤绑定的骨骼（${skin.joints.length} 根）==`);
const names = skin.joints.map((i) => nodes[i].name);

// 按层级打印：只看 Skin root 以下
const parentOf = new Map();
const childrenOf = new Map();
nodes.forEach((n, i) => {
  if (n.children) for (const c of n.children) parentOf.set(c, i);
});

function childIds(i) { return nodes[i].children || []; }
const skinRoot = skin.skeleton != null ? skin.skeleton : skin.joints[0];

// 找 head
function findId(name) { return nodes.findIndex((n) => n.name === name); }
const headId = findId('head');

console.log('== head 子树（名字 | 是否在蒙皮里 | 局部位移）==');
function walk(id, depth) {
  const n = nodes[id];
  if (!n) return;
  const t = n.translation ? n.translation.map((v) => v.toFixed(4)).join(',') : '-';
  const r = n.rotation ? n.rotation.map((v) => v.toFixed(3)).join(',') : '-';
  const skinFlag = jointIdx.has(id) ? ' ' : '·';
  console.log(
    `${skinFlag} ${'  '.repeat(depth)}${n.name.padEnd(18 - depth * 2)}  t=(${t})  r=(${r})`
  );
  for (const c of childIds(id)) walk(c, depth + 1);
}
walk(headId, 0);

console.log('\n== 全部骨名（逗号分隔，方便直接拷进对照表）==');
console.log(names.join(' '));

console.log('\n== 名字里含这些关键词的：==');
for (const kw of ['levator', 'orbicularis', 'oculi', 'temporalis', 'risorius', 'oris', 'special', 'tongue', 'eye', 'jaw', 'masseter', 'mentalis', 'depressor']) {
  const hit = names.filter((n) => n.toLowerCase().includes(kw));
  if (hit.length) console.log(`  ${kw.padEnd(13)} ${hit.join(' ')}`);
}
