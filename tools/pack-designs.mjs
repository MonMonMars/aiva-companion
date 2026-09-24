#!/usr/bin/env node
/**
 * pack-designs.mjs — 把角色设计产物打成一个 ZIP，方便整体上传/分享。
 *
 * 为什么单独打这个包（而不是用 mkzip.mjs 打整个项目）：
 *   mkzip 打的是**整个 App 工程源码**（给开发用）；
 *   这个包只装**设计产物**（给看效果 / 交给别人用），不含 node_modules 和源码。
 *
 * 包内容：
 *   README.txt              说明 + 角色清单
 *   compare.html            3D A/B 对比器（单文件自包含，双击即开）
 *   characters.html         三视图对照表（仅覆盖最早的 6 个角色）
 *   sheets/<角色>-sheet.jpg 11 张三视图设定图（正 / 侧 / 背）
 *   models/<角色>.glb       11 个模型本体
 *   models/<角色>.morph.json 表情侧车文件
 *
 * 用法：node tools/pack-designs.mjs [输出 zip 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFromEntries } from './lib/minizip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'assets', 'models2');
const SHEETS = path.join(ROOT, 'assets', 'preview', 'sheets');
const PREVIEW = path.join(ROOT, 'assets', 'preview');
const OUT = process.argv[2]
  || path.join(path.dirname(ROOT), 'AIVA-character-designs.zip');

const ROSTER = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/compare-page.mjs'), 'utf8');
  const i = src.indexOf('const ROSTER = [');
  if (i < 0) throw new Error('compare-page.mjs 里找不到 ROSTER');
  const j = src.indexOf('\n];', i);
  return new Function('return ' + src.slice(i + 'const ROSTER = '.length, j + 2))();
})();

function triCount(file) {
  const buf = fs.readFileSync(file);
  let off = 12, json = null;
  while (off < buf.readUInt32LE(8)) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const prim = json.meshes[0].primitives[0];
  const acc = prim.indices != null ? json.accessors[prim.indices] : json.accessors[prim.attributes.POSITION];
  return Math.round(acc.count / 3);
}

const entries = [];
const missing = [];

const readme = [
  'AIVA 3D 角色设计包',
  '==================',
  '',
  `${ROSTER.length} 个原创角色，全部程序化生成，无外部素材、无版权风险。`,
  '',
  '目录：',
  '  compare.html            3D A/B 对比器（单文件自包含，双击用浏览器打开即可，',
  '                          不需要起服务。可左右各选一个角色对比，拖动旋转、滚轮缩放）',
  '  characters.html         三视图对照表（注意：只覆盖最早的 6 个角色）',
  '  sheets/                 三视图设定图 JPG（正面 / 侧面 / 背面，正交投影）',
  '  models/*.glb            模型本体（二进制 glTF）',
  '  models/*.morph.json     表情混合形状（侧车文件，与同名 glb 配套）',
  '',
  '模型规格：',
  '  骨骼 23 根（Mixamo 命名，可直接重定向到 Mixamo 动画）',
  '  表情 24 个 ARKit 混合形状',
  '  顶点色按部位分区（头发 / 皮肤 / 服装 / 眼睛…），可直接当材质 ID 用',
  '  姿态：A-pose 已烘进几何',
  '',
  '角色清单：',
  ...ROSTER.map((r) => {
    const g = path.join(MODELS, r.file + '.glb');
    const tris = fs.existsSync(g) ? triCount(g).toLocaleString('en-US') : '—';
    return `  ${r.name.padEnd(8)} ${r.tier.padEnd(7)} ${r.role.padEnd(6)} ` +
           `${r.h.toFixed(2)}m  ${r.heads.toFixed(2)} 头身  ${tris.padStart(6)} 三角面  ${r.note}`;
  }),
  '',
].join('\r\n');   // CRLF：Windows 记事本打开不串行
entries.push({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });

for (const f of ['compare.html', 'characters.html']) {
  const p = path.join(PREVIEW, f);
  if (fs.existsSync(p)) entries.push({ name: f, data: fs.readFileSync(p) });
  else missing.push(f);
}

if (fs.existsSync(SHEETS)) {
  for (const f of fs.readdirSync(SHEETS).filter((x) => x.endsWith('.jpg')).sort()) {
    entries.push({ name: 'sheets/' + f, data: fs.readFileSync(path.join(SHEETS, f)) });
  }
} else missing.push('sheets/');

for (const r of ROSTER) {
  for (const ext of ['.glb', '.morph.json']) {
    const p = path.join(MODELS, r.file + ext);
    if (fs.existsSync(p)) entries.push({ name: 'models/' + r.file + ext, data: fs.readFileSync(p) });
    else missing.push(r.file + ext);
  }
}

const rawMb = entries.reduce((s, e) => s + e.data.length, 0) / 1048576;
const buf = zipFromEntries(entries, 'AIVA-character-designs');
fs.writeFileSync(OUT, buf);
const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);

console.log('✓ ' + OUT);
console.log(`  ${entries.length} 个文件 · 未压缩 ${rawMb.toFixed(2)} MB · 打包后 ${mb} MB`);
const byDir = {};
for (const e of entries) {
  const d = e.name.includes('/') ? e.name.split('/')[0] : '(根目录)';
  byDir[d] = (byDir[d] || 0) + 1;
}
for (const [d, n] of Object.entries(byDir)) console.log(`    ${d.padEnd(14)} ${n} 个`);
if (missing.length) console.log('  ⚠ 缺失：' + missing.join(', '));
