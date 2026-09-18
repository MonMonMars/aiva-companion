// 验证拆分后的 glb 仍然可解析，并输出几何信息（比例/面数/材质）
// 用法： node tools/validate_model.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const dir = path.resolve('assets/models');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb'));
if (!files.length) {
  console.error('没有找到 glb，先跑 tools/split_texture.py');
  process.exit(1);
}

const loader = new GLTFLoader();

for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
    let tris = 0, meshes = 0;
    const mats = new Set();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      mats.add(o.material?.type || 'none');
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    console.log(
      `✓ ${f.padEnd(18)} mesh=${meshes} 三角形=${Math.round(tris).toLocaleString()} ` +
      `尺寸=${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} ` +
      `宽高比=${(size.y / Math.max(size.x, size.z)).toFixed(2)} 材质=[${[...mats].join(',')}]`
    );
    if (size.y === 0 || !isFinite(size.y)) console.log(`  ⚠ ${f} 尺寸异常`);
  } catch (e) {
    console.log(`✗ ${f} 解析失败: ${e?.message || e}`);
    process.exit(1);
  }
}
console.log(`\n文件大小：`);
for (const f of fs.readdirSync(dir)) {
  console.log(`  ${f.padEnd(20)} ${(fs.statSync(path.join(dir, f)).size / 1024).toFixed(0).padStart(5)} KB`);
}
