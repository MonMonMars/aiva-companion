// 把模型投影成 ASCII 轮廓，肉眼确认姿态和比例。
// 自动绑定最容易错在"假设了错误的姿态"（比如模型其实是 T-pose 站着），
// 这一步就是为了先亲眼看一遍，再决定骨架怎么摆。
import fs from 'fs';

globalThis.FileReader = class {
  readAsArrayBuffer(b) { b.arrayBuffer().then((x) => { this.result = x; this.onloadend && this.onloadend(); }); }
};

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
gltf.scene.updateMatrixWorld(true);

const pts = [];
gltf.scene.traverse((o) => {
  if (!o.isMesh || !o.geometry?.attributes?.position) return;
  const pos = o.geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
    pts.push(v.clone());
  }
});

const box = new THREE.Box3().setFromPoints(pts);
const size = box.getSize(new THREE.Vector3());
const shortFile = file.split('\\').pop().split('/').pop();

console.log(shortFile + '   ' + pts.length + ' 顶点');
console.log('bbox  X[' + box.min.x.toFixed(2) + ',' + box.max.x.toFixed(2) + ']' +
            '  Y[' + box.min.y.toFixed(2) + ',' + box.max.y.toFixed(2) + ']' +
            '  Z[' + box.min.z.toFixed(2) + ',' + box.max.z.toFixed(2) + ']');
console.log('尺寸  W=' + size.x.toFixed(2) + ' H=' + size.y.toFixed(2) + ' D=' + size.z.toFixed(2) +
            '   宽/高=' + (size.x / size.y).toFixed(2) + '  （约0.45=垂手站立，约1.0=T-pose）');

function render(getXY, w, h, label) {
  const count = [];
  for (let y = 0; y < h; y++) count.push(new Array(w).fill(0));

  for (const p of pts) {
    const uv = getXY(p, box, size);
    const gx = Math.round(uv[0] * (w - 1));
    const gy = Math.round(uv[1] * (h - 1));
    if (gx >= 0 && gx < w && gy >= 0 && gy < h) count[gy][gx]++;
  }

  console.log('');
  console.log('--- ' + label + ' ---');
  for (let y = 0; y < h; y++) {
    let line = '|';
    for (let x = 0; x < w; x++) {
      const c = count[y][x];
      line += c === 0 ? ' ' : c < 2 ? '.' : c < 8 ? ':' : c < 30 ? '*' : '#';
    }
    console.log(line);
  }
}

const frontXY = (p, b, s) => [
  (p.x - b.min.x) / s.x,
  1 - (p.y - b.min.y) / s.y,
];
const sideZY = (p, b, s) => [
  (p.z - b.min.z) / (s.z || 1),
  1 - (p.y - b.min.y) / s.y,
];

render(frontXY, 46, 40, '正面 X-Y（头在上）');
render(sideZY, 30, 40, '侧面 Z-Y（左=z最小，右=z最大；脸通常在更"突出"的一端）');
