// 用 three.js 真加载一遍新 GLB，验证 sparse morph / 蒙皮 / 骨骼
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

globalThis.self = globalThis;

const FILE = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/assets/models4/aiva-base-mh.glb';
const out = [];
const log = (s) => { out.push(s); console.log(s); };

const buf = fs.readFileSync(FILE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
loader.parse(ab, '', (gltf) => {
  log('✅ GLTFLoader 加载成功');
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && o.morphTargetDictionary) mesh = o; });
  if (!mesh) { log('❌ 没找到带 morph 的 mesh'); return done(); }

  const g = mesh.geometry;
  log(`mesh: ${mesh.name}`);
  log(`  顶点 ${g.attributes.position.count} / 面 ${g.index.count / 3}`);
  log(`  morphs ${g.morphAttributes.position ? g.morphAttributes.position.length : 0}`);
  const dict = mesh.morphTargetDictionary;
  log(`  morphTargetDictionary: ${Object.keys(dict).length} 个 -> ${Object.keys(dict).slice(0, 6).join(', ')} ...`);
  log(`  morphTargetInfluences: ${mesh.morphTargetInfluences.length}`);

  // sparse 是否真的解出来了：抽查几个 morph 的最大位移
  const ma = g.morphAttributes.position;
  let allZero = 0, maxDisp = 0;
  for (let i = 0; i < ma.length; i++) {
    const a = ma[i].array;
    let mx = 0;
    for (let k = 0; k < a.length; k++) if (Math.abs(a[k]) > mx) mx = Math.abs(a[k]);
    if (mx === 0) allZero++;
    const nm = Object.keys(dict).find((k) => dict[k] === i);
    if (['BodyHeight', 'Masculine', 'EyeSize', 'EarPointed', 'Dimples'].includes(nm)) log(`  [${nm}] 最大位移 ${mx.toFixed(4)}m`);
    if (mx > maxDisp) maxDisp = mx;
  }
  log(`  全部 0 位移的 morph: ${allZero} 条；全局最大位移 ${maxDisp.toFixed(4)}m`);
  log(allZero ? '❌ 有 morph 解出来是空的（sparse 没搬运成功）' : '✅ sparse 全部解出来了');

  // 蒙皮
  const sk = mesh.skeleton;
  log(`  skeleton bones: ${sk ? sk.bones.length : '无'}`);
  if (sk) log(`  根骨: ${sk.bones[0].name}；示例: ${sk.bones.slice(1, 6).map((b) => b.name).join(', ')}`);
  log(`  skinIndex 存在: ${!!g.attributes.skinIndex} / skinWeight: ${!!g.attributes.skinWeight}`);

// 包围盒
  {
    const a = g.attributes.position.array;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < a.length; i += 3) {
      for (let c = 0; c < 3; c++) { if (a[i + c] < mn[c]) mn[c] = a[i + c]; if (a[i + c] > mx[c]) mx[c] = a[i + c]; }
    }
    log(`  位置原始范围 X ${mn[0].toFixed(3)}~${mx[0].toFixed(3)}  Y ${mn[1].toFixed(3)}~${mx[1].toFixed(3)}  Z ${mn[2].toFixed(3)}~${mx[2].toFixed(3)}`);
    log(`  高 ${(mx[1] - mn[1]).toFixed(3)}m  臂展 ${(mx[0] - mn[0]).toFixed(3)}m`);
    if (mn[1] > -0.02 && mn[1] < 0.02) log('  ✅ 脚底已落在 y=0'); else log(`  ⚠️ 脚底不在原点（${mn[1].toFixed(3)}）`);
  }

  // 试着算一下 morph 叠加后的顶点
  const w = g.attributes.skinWeight.array;
  let bad = 0;
  for (let i = 0; i < w.length; i += 4) {
    const s = w[i] + w[i + 1] + w[i + 2] + w[i + 3];
    if (Math.abs(s - 1) > 1e-3 && s > 0) bad++;
  }
  log(`  权重未归一的顶点: ${bad}`);
  done();
}, (e) => { log('❌ 加载失败: ' + (e && (e.stack || e.message || e))); done(); });

function done() {
  fs.writeFileSync('C:/Users/Simon Lai/AppData/Local/Temp/_mhvalidate.txt', out.join('\n'), 'utf8');
}
