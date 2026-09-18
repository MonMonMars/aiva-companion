/**
 * 端到端验证「读 glb → 解析 → 挂载 → jpg 解码 → DataTexture」整条管线。
 *
 * 为什么需要它：ui 上的截图看不出模型挂没挂上（挂上了也可能只是个白模），
 * 而这里全用数值断言 —— 包围盒、材质、贴图尺寸都能被打出来。
 *
 * 用法： node tools/pipeline.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import jpeg from 'jpeg-js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'assets', 'models');

// companion.js 只 import 了 three（没有任何 RN / DOM 依赖），
// 所以直接复制成 .mjs 就能在 Node 里跑，不用 Metro 打包。
const tmp = path.join(root, 'tools', '.tmp-companion.mjs');
fs.copyFileSync(path.join(root, 'src', 'three', 'companion.js'), tmp);
const { createCompanionScene } = await import('file://' + tmp.replace(/\\/g, '/'));

const PERSONA = {
  avatar: { skin: '#FFE0CF', style: 'twin-tail', hair: '#F0A6CA', top: '#FFFFFF', bottom: '#3B3B5C', eyes: '#3A2A3A', blush: '#FF9FB2' },
  colors: { primary: '#FF7FB0', soft: '#FFD6E7' },
};

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function decodeToTexture(bytes) {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxMemoryUsageInMB: 96 });
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

for (const id of ['girlfriend', 'boyfriend', 'secretary']) {
  console.log(`\n=== ${id} ===`);
  const glb = fs.readFileSync(path.join(modelsDir, `${id}.glb`));
  const jpg = fs.readFileSync(path.join(modelsDir, `${id}.jpg`));

  const comp = createCompanionScene(PERSONA);

  // 1. 解析 glb
  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().parse(toArrayBuffer(glb), '', res, rej)
  );
  check(!!gltf.scene, 'GLB 解析成功');

  // 2. 挂载（缩放 + 落地 + 材质替换）
  const ok = comp.attachModel(gltf.scene);
  check(ok, 'attachModel 返回 true');
  check(comp.isUsingModel(), 'isUsingModel() === true');

  const box = new THREE.Box3().setFromObject(comp.root);
  const size = box.getSize(new THREE.Vector3());
  check(
    Math.abs(size.y - 2.05) < 0.02,
    `统一缩放到 targetHeight=2.05`,
    `实际 ${size.y.toFixed(3)}`
  );
  check(
    Math.abs(box.min.y) < 0.01,
    '双脚落在 y=0 平面（不会浮空也不会陷地）',
    `min.y=${box.min.y.toFixed(4)}`
  );
  check(size.x < 2.05 && size.z < 2.05, '水平尺寸没爆炸', `x=${size.x.toFixed(2)} z=${size.z.toFixed(2)}`);

  // 3. 材质：模型没有顶点色，必须靠贴图，所以要确认 texture 位是空的 + side 被继承
  let mesh = null;
  comp.root.traverse((o) => { if (o.isMesh && !mesh && o.geometry.attributes.position.count > 5000) mesh = o; });
  check(!!mesh, '找到主体 mesh');
  check(mesh?.material?.isMeshToonMaterial === true, '材质被替换成 MeshToonMaterial（赛璐璐）');
  check(mesh?.material?.side === THREE.DoubleSide, '继承 doubleSided，薄面不穿帮');
  check(!mesh?.material?.map, '挂载前确实没有贴图（所以贴图步骤不是可选的）');

  // 4. jpg → DataTexture → applyTexture
  const tex = decodeToTexture(jpg);
  check(tex.image.width === 1024 && tex.image.height === 1024, '贴图解码为 1024²', `${tex.image.width}x${tex.image.height}`);
  check(comp.applyTexture(tex), 'applyTexture 返回 true');
  check(mesh.material.map === tex, '材质的 map 指向这张贴图');
  check(mesh.material.color.getHex() === 0xffffff, 'color 被刷成白色（不然贴图会被染色）');

  // 5. 动画/更新模型仍然不报错（模型替换后 head/arms 引用的是被摘掉的小人）
  let threw = null;
  try {
    for (let i = 0; i < 30; i++) comp.update(i * 0.016, 0.016);
    comp.react('pet');
    for (let i = 0; i < 30; i++) comp.update(0.5 + i * 0.016, 0.016);
  } catch (e) {
    threw = e;
  }
  check(!threw, '换成真模型后 update/react 不报错', threw ? threw.message : '');

  comp.dispose();

  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log(`  体积：glb ${kb(glb.length)} + jpg ${kb(jpg.length)}`);
}

fs.unlinkSync(tmp);
console.log(failed === 0 ? '\n全部通过 ✓' : `\n失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
