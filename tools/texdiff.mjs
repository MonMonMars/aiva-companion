// 对比两张贴图的关键区域颜色，验证改色是否生效且合理
// 用法: node tools/_texdiff.mjs <a.png> <b.png>
import fs from 'node:fs';
import { decodePNG } from './png-min.mjs';

const a = decodePNG(fs.readFileSync(process.argv[2]));
const b = decodePNG(fs.readFileSync(process.argv[3]));
const ch = (p) => p.channels;

const N = (p, i) => p.channels === 4 ? p.data[i * 4 + 3] : 255;
const RGB = (p, i) => {
  const o = i * p.channels;
  return [p.data[o], p.data[o + 1], p.data[o + 2]];
};
const hsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60;
  }
  const l = (mx + mn) / 2;
  return [h, d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l];
};
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

console.log(`A: ${a.width}x${a.height} ch=${ch(a)}   B: ${b.width}x${b.height} ch=${ch(b)}`);
if (a.width !== b.width || a.height !== b.height) { console.error('尺寸不同，无法比对'); process.exit(1); }

const total = a.width * a.height;
let opaqueA = 0, changed = 0;
const changedSamples = [];
// 色相直方图（10° 一档），只看不透明像素
const histA = new Array(36).fill(0), histB = new Array(36).fill(0);
let sumL = [0, 0];
for (let i = 0; i < total; i++) {
  const oa = N(a, i), ob = N(b, i);
  if (oa < 8) continue;
  opaqueA++;
  const ca = RGB(a, i), cb = RGB(b, i);
  const [ha, sa, la] = hsl(...ca);
  const [hb, sb, lb] = hsl(...cb);
  histA[Math.min(35, Math.floor(ha / 10))]++;
  histB[Math.min(35, Math.floor(hb / 10))]++;
  sumL[0] += la; sumL[1] += lb;
  const d = Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2]);
  if (d > 12) {
    changed++;
    if (changedSamples.length < 6 && Math.random() < 0.02) changedSamples.push({ i, ca, cb, ha, hb, sa, sb });
  }
}
console.log(`有效像素 ${opaqueA} (${((opaqueA / total) * 100).toFixed(1)}%)  亮度均值 ${(sumL[0] / opaqueA).toFixed(3)} -> ${(sumL[1] / opaqueA).toFixed(3)}`);
console.log(`变色像素 ${changed} (${((changed / opaqueA) * 100).toFixed(1)}%)`);

const top = (h, n = 6) => h.map((v, i) => [i * 10, v]).sort((x, y) => y[1] - x[1]).slice(0, n)
  .map(([deg, v]) => `${deg}°:${((v / opaqueA) * 100).toFixed(1)}%`).join('  ');
console.log('A 主色相分布: ' + top(histA));
console.log('B 主色相分布: ' + top(histB));
changedSamples.forEach((s) => {
  console.log(`  样本 h=${s.ha.toFixed(0)}°->${s.hb.toFixed(0)}° s=${s.sa.toFixed(2)}->${s.sb.toFixed(2)} ${hex(s.ca)} -> ${hex(s.cb)}`);
});
