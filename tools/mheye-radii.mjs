// mheye-radii.mjs —— 量两颗眼球相对各自虹膜中心的径向剖面，定出瞳孔/虹膜/眼球半径
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const t = decodePNG(fs.readFileSync('C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data/eyes/materials/brown_eye.png'));
const { w: W, h: H, ch, data } = t;
const lum = (i) => 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2];
const sat = (i) => {
  const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx ? (mx - mn) / mx : 0;
};
const op = (i) => data[i * ch + 3] > 128;

const EYES = [['右上', 721.6, 303.9], ['左下', 295.6, 725.9]];
const BIN = 4;   // 每 4px 一档
const NB = 160;
for (const [nm, cx, cy] of EYES) {
  const n = new Int32Array(NB), sL = new Float64Array(NB), nOp = new Int32Array(NB), nSat = new Int32Array(NB);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const b = Math.floor(Math.hypot(x - cx, y - cy) / BIN);
    if (b >= NB) continue;
    n[b]++;
    if (op(i)) { nOp[b]++; sL[b] += lum(i); if (sat(i) > 0.30 && data[i * ch] > data[i * ch + 1] + 10) nSat[b]++; }
  }
  console.log(`\n=== ${nm} 虹膜中心 (${cx},${cy}) 径向剖面（每档 ${BIN}px）===`);
  console.log(' r(px)  r/W    不透明%  平均亮度  棕饱和%');
  for (let b = 0; b < 70; b++) {
    const r = b * BIN;
    const o = n[b] ? (nOp[b] / n[b] * 100) : 0;
    const l = nOp[b] ? sL[b] / nOp[b] : 0;
    const sa = nOp[b] ? (nSat[b] / nOp[b] * 100) : 0;
    if (r % 40 === 0 || (b > 0 && b < 68))
      console.log(`  ${String(r).padStart(4)}  ${(r / W).toFixed(4)}  ${o.toFixed(1).padStart(6)}   ${l.toFixed(1).padStart(6)}   ${sa.toFixed(1).padStart(6)}`);
    if (o < 1 && r > 100) break;
  }
}

// 眼球外轮廓：按「到虹膜中心的距离」找不透明边界
console.log('\n=== 眼球边界（不透明度降到 50% 的半径）===');
for (const [nm, cx, cy] of EYES) {
  const N = 720, radii = [];
  for (let a = 0; a < 360; a++) {
    const th = a * Math.PI / 180;
    let last = 0;
    for (let r = 0; r < 900; r += 1) {
      const x = Math.round(cx + Math.cos(th) * r), y = Math.round(cy + Math.sin(th) * r);
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      const i = y * W + x;
      if (op(i)) last = r;
    }
    radii.push(last);
  }
  radii.sort((a, b) => a - b);
  console.log(`  ${nm}: 中位 ${radii[360]}px (UV ${(radii[360] / W).toFixed(4)})  P90 ${radii[648]}px  P10 ${radii[72]}px  最大 ${radii[719]}px`);
}
