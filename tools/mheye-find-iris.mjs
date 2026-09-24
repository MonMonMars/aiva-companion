// mheye-find-iris.mjs —— 从 brown_eye.png 精确定位两颗眼球的虹膜中心
// ===========================================================================
// 为什么不能用「深色像素聚类」：这张图是 RGBA + 透明背景，另外还有两片烘焙的
// 阴影（右下角一个圆形、右上一条弧），都会被算成"深色"。必须分两步：
//   1) 用 alpha 求连通域 → 刚好两颗眼球（每颗 51.7 万像素）
//   2) 在每个眼球内找「瞳孔」= 又暗又低饱和度的像素，且必须在眼球内部
//      （瞳孔是真黑：亮度极低；阴影是灰的：饱和度极低但亮度中等）
// 输出：每颗球的虹膜中心、虹膜半径、眼球半径，全部用**整图 UV**表示。
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data/eyes/materials/brown_eye.png';
const t = decodePNG(fs.readFileSync(SRC));
const { w: W, h: H, ch, data } = t;
console.log(`贴图 ${W}×${H} ch=${ch}`);

const opq = (i) => data[i * ch + 3] > 128;

// ---- 1) alpha 连通域（洪水填充，8 邻域）
const label = new Int32Array(W * H).fill(-1);
let nl = 0;
const comps = [];
const stack = new Int32Array(W * H);
for (let s = 0; s < W * H; s++) {
  if (!opq(s) || label[s] >= 0) continue;
  const id = nl++;
  let sp = 0; stack[sp++] = s; label[s] = id;
  let n = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  while (sp > 0) {
    const p = stack[--sp]; n++;
    const x = p % W, y = (p - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (label[q] >= 0 || !opq(q)) continue;
      label[q] = id; stack[sp++] = q;
    }
  }
  comps.push({ id, n, x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
}
comps.sort((a, b) => b.n - a.n);
console.log(`alpha 连通域 ${comps.length} 个：`);
for (const c of comps.slice(0, 6))
  console.log(`  #${c.id} ${c.n}px  包围盒 x${c.x0}-${c.x1} y${c.y0}-${c.y1}  中心 (${c.cx.toFixed(1)},${c.cy.toFixed(1)})`);

// ---- 2) 在每个大域里找瞳孔
const lum = (i) => 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2];
const sat = (i) => {
  const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

for (const c of comps.slice(0, 2)) {
  // 瞳孔候选：亮度 < 45（真黑），且必须是眼球内部的实心块
  let sx = 0, sy = 0, n = 0;
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    const i = y * W + x;
    if (label[i] !== c.id) continue;
    if (lum(i) < 45) { sx += x; sy += y; n++; }
  }
  if (!n) { console.log(`  #${c.id}: 没找到暗像素`); continue; }
  const px = sx / n, py = sy / n;
  console.log(`  #${c.id} 瞳孔：${n}px  质心 (${px.toFixed(1)},${py.toFixed(1)}) = UV(${(px / W).toFixed(4)}, ${(py / H).toFixed(4)})`);
  // 虹膜：在该球内，红色占优（棕/红）的像素半径分布
  let rmax = 0, rn = 0, rsum = 0, nr = 0;
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    const i = y * W + x;
    if (label[i] !== c.id) continue;
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    if (lum(i) < 150 && sat(i) > 0.35 && r > g + 12) {
      const d = Math.hypot(x - px, y - py);
      rn++; rsum += d; if (d > rmax) rmax = d;
    }
  }
  console.log(`  #${c.id} 虹膜：${rn}px  平均半径 ${(rsum / rn).toFixed(1)}px  最大半径 ${rmax.toFixed(1)}px = UV ${(rmax / W).toFixed(4)}`);
  console.log(`      → 虹膜直径 ≈ ${(2 * rmax).toFixed(0)}px = UV ${(2 * rmax / W).toFixed(4)}`);
  // 眼球等效半径（按面积）
  console.log(`  #${c.id} 眼球等效半径 ${Math.sqrt(c.n / Math.PI).toFixed(1)}px = UV ${(Math.sqrt(c.n / Math.PI) / W).toFixed(4)}`);
}
