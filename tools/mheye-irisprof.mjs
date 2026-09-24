// mheye-irisprof.mjs —— 沿射线打印虹膜 B 的真实颜色剖面
//
// 目的：确定"素材球 B 从中心往外，每个半径上到底是什么"。
//   上一轮渲染虹膜发白，说明我对素材结构的假设（虹膜 0.108 UV）不对。
//   直接把剖面打出来看，别再猜。
//
// 同时解决一个分析陷阱：这张 PNG 有**透明背景**，透明像素的 RGB 是垃圾值
//   （常为 0,0,0）。看颜色必须先按 alpha 判断可见性。
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data/eyes/materials/brown_eye.png';
const t = decodePNG(fs.readFileSync(SRC));
const IRIS_B = [0.28867, 0.70885];
const cx = IRIS_B[0] * t.w, cy = IRIS_B[1] * t.h;
console.log(`贴图 ${t.w}x${t.h} ch=${t.ch}   虹膜 B 中心 (${cx.toFixed(1)}, ${cy.toFixed(1)})`);

const px = (x, y) => {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= t.w || yi >= t.h) return null;
  const o = (yi * t.w + xi) * t.ch;
  return { r: t.data[o], g: t.data[o + 1], b: t.data[o + 2], a: t.data[o + 3] };
};

// —— 1) 8 方向平均剖面
console.log('\n半径  |  平均RGB（仅算 alpha>200 的）  | 不透明覆盖率 | 判定');
const dirs = [];
for (let k = 0; k < 24; k++) dirs.push([Math.cos(k / 24 * 2 * Math.PI), Math.sin(k / 24 * 2 * Math.PI)]);
for (let r = 0; r <= 400; r += 8) {
  let sr = 0, sg = 0, sb = 0, n = 0, opaque = 0;
  for (const [dx, dy] of dirs) {
    const p = px(cx + dx * r, cy + dy * r);
    if (!p) continue;
    if (p.a > 200) { sr += p.r; sg += p.g; sb += p.b; n++; }
    if (p.a > 200) opaque++;
  }
  const tot = dirs.length;
  const avg = n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
  const lum = 0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2];
  // 简单分类：很暗=瞳孔，偏棕/红=虹膜，很亮=高光或球外
  let tag = '';
  if (n === 0) tag = '全透明（球外）';
  else if (lum < 55) tag = '暗（瞳孔/暗环）';
  else if (avg[0] - avg[2] > 18) tag = `棕红（虹膜 r-b=${(avg[0] - avg[2]).toFixed(0)}）`;
  else if (lum > 150) tag = '亮（浅色/球外过渡）';
  else tag = '中间调';
  console.log(`${String(r).padStart(4)}px (${(r / t.w).toFixed(4)}UV) | ${avg.map(x => Math.round(x).toString().padStart(3)).join(',')} | ${String(Math.round(opaque / tot * 100)).padStart(3)}% | ${tag}`);
}

// —— 2) 单独看 120° 方向（最紧的那个方向，朝兄弟球 A）
console.log('\n120° 方向单独剖面（朝上-左，兄弟球 A 所在方向）：');
for (let r = 0; r <= 260; r += 10) {
  const p = px(cx + Math.cos(120 * Math.PI / 180) * r, cy + Math.sin(120 * Math.PI / 180) * r);
  if (!p) { console.log(`  ${String(r).padStart(4)}px  (出界)`); continue; }
  console.log(`  ${String(r).padStart(4)}px (${(r / t.w).toFixed(4)}UV)  rgb(${String(p.r).padStart(3)},${String(p.g).padStart(3)},${String(p.b).padStart(3)})  a=${p.a}`);
}

// —— 3) 瞳孔半径：找最暗的连续区
console.log('\n瞳孔半径估计（沿 0° 与 180°，找第一处 lum 上升 30% 的位置）：');
for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
  const dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
  let prevLum = null, edge = -1;
  for (let r = 1; r <= 200; r++) {
    const p = px(cx + dx * r, cy + dy * r);
    if (!p || p.a < 200) break;
    const lum = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
    if (prevLum !== null && edge < 0 && lum > prevLum + 28 && r > 4) edge = r;
    prevLum = lum;
  }
  console.log(`  ${String(deg).padStart(3)}°  瞳孔边界 ≈ ${edge}px (${(edge / t.w).toFixed(4)} UV)`);
}
