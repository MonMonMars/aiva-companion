// mheye-measure.mjs —— 把 brown_eye.png 摊平成 ASCII / 数据图，肉眼+数据双重确认虹膜位置
// ===========================================================================
// 前面反复量错的原因（记录一下）：
//   · 深色聚类 → 被右上角阴影弧和透明背景污染
//   · alpha 连通域 → 两颗眼球**是重叠的**，整个是一个连通域（1035314px）
//   · 目视估读 → 1024 图上差 0.03 UV 就是 30px，我目视根本读不准
// 所以这里不猜：直接把候选位置**逐像素扫一遍**，用「暗像素密度」找瞳孔圆心。
//
// 输出：
//   · 两张 ASCII 缩略图（亮度图 + 色相图），一眼就能看出虹膜在哪
//   · 全图暗像素（lum<60）的聚类结果，逐个打印圆心/半径/像素数
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data/eyes/materials/brown_eye.png';
const t = decodePNG(fs.readFileSync(SRC));
const { w: W, h: H, ch, data } = t;
const lum = (i) => 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2];
const sat = (i) => {
  const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const isOpaque = (i) => data[i * ch + 3] > 128;

// ---------------------------------------------------------- ASCII 亮度图
const GW = 64, GH = 32;
const ramp = ' .:-=+*#%@';
console.log('=== 亮度图（透明区标 ~）===');
for (let gy = 0; gy < GH; gy++) {
  let line = '';
  for (let gx = 0; gx < GW; gx++) {
    let s = 0, n = 0, alpha = 0;
    for (let y = Math.floor(gy * H / GH); y < Math.floor((gy + 1) * H / GH); y++)
      for (let x = Math.floor(gx * W / GW); x < Math.floor((gx + 1) * W / GW); x++) {
        const i = y * W + x; if (isOpaque(i)) { s += lum(i); n++; } alpha++;
      }
    if (n === 0) { line += '~'; continue; }
    line += ramp[Math.min(9, Math.floor((1 - s / n / 255) * 10))];
  }
  console.log(line);
}

// ------------------------------------------------- ASCII 棕/红 色相图
console.log('\n=== 虹膜图（饱和度>0.30 且 红>绿 的像素标 #）===');
for (let gy = 0; gy < GH; gy++) {
  let line = '';
  for (let gx = 0; gx < GW; gx++) {
    let hit = 0, n = 0;
    for (let y = Math.floor(gy * H / GH); y < Math.floor((gy + 1) * H / GH); y++)
      for (let x = Math.floor(gx * W / GW); x < Math.floor((gx + 1) * W / GW); x++) {
        const i = y * W + x; n++;
        const r = data[i * ch], g = data[i * ch + 1];
        if (isOpaque(i) && sat(i) > 0.30 && r > g + 10) hit++;
      }
    const f = hit / n;
    line += f > 0.75 ? '#' : f > 0.45 ? '+' : f > 0.20 ? '.' : ' ';
  }
  console.log(line);
}

// --------------------------------------------------- 暗像素聚类（找瞳孔）
// 瞳孔 = 亮度 < 60。用网格降采样聚类（16px 粗网格）再求质心。
console.log('\n=== 暗像素（lum<60）分布 ===');
const CELL = 16, CW = Math.ceil(W / CELL), CH = Math.ceil(H / CELL);
const cnt = new Int32Array(CW * CH), sx = new Float64Array(CW * CH), sy = new Float64Array(CW * CH);
let total = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  if (!isOpaque(i) || lum(i) >= 60) continue;
  const c = Math.floor(y / CELL) * CW + Math.floor(x / CELL);
  cnt[c]++; sx[c] += x; sy[c] += y; total++;
}
console.log(`暗像素总计 ${total}px`);
// 连通网格簇
const seen = new Uint8Array(CW * CH);
const clusters = [];
for (let c = 0; c < CW * CH; c++) {
  if (!cnt[c] || seen[c]) continue;
  const st = [c]; seen[c] = 1;
  let n = 0, ax = 0, ay = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  while (st.length) {
    const p = st.pop(); n += cnt[p]; ax += sx[p]; ay += sy[p];
    const px = p % CW, py = (p - px) / CW;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
      const q = ny * CW + nx;
      if (cnt[q] && !seen[q]) { seen[q] = 1; st.push(q); }
    }
  }
  if (n > 200) clusters.push({ n, cx: ax / n, cy: ay / n, w: (x1 - x0 + 1) * CELL, h: (y1 - y0 + 1) * CELL });
}
clusters.sort((a, b) => b.n - a.n);
for (const c of clusters)
  console.log(`  暗簇 ${c.n}px  中心 (${c.cx.toFixed(1)},${c.cy.toFixed(1)}) = UV(${(c.cx / W).toFixed(4)}, ${(c.cy / H).toFixed(4)})  ${c.w}×${c.h}px`);
