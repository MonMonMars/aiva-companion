import fs from 'fs';
globalThis.FileReader = class { readAsArrayBuffer(b){ b.arrayBuffer().then(x=>{this.result=x;this.onloadend&&this.onloadend();}); } };
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));

const bones = [];
const meshes = [];
gltf.scene.traverse((o) => {
  if (o.isBone) bones.push(o.name);
  if (o.isSkinnedMesh || o.isMesh) {
    const morphs = o.morphTargetDictionary ? Object.keys(o.morphTargetDictionary) : [];
    const nVert = o.geometry?.attributes?.position?.count || 0;
    if (nVert > 40) meshes.push({ name: o.name || '(unnamed)', verts: nVert, morphs: morphs.length, hasSkin: !!o.isSkinnedMesh, hasNormals: !!o.geometry?.attributes?.normal });
    if (morphs.length) console.log(`\n  [${o.name}] morphs(${morphs.length}):`, morphs.slice(0, 60).join(', '));
  }
});
console.log('\n=== ' + file.split('\\').pop() + ' ===');
console.log('bones:', bones.length);
console.log('  头: ', bones.slice(0, 25).join(', '));
meshes.sort((a,b)=>b.verts-a.verts);
meshes.slice(0, 12).forEach(m => console.log(`  mesh ${m.name}: verts=${m.verts} morphs=${m.morphs} skinned=${m.hasSkin}`));
