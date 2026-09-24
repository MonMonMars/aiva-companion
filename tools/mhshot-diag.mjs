// mhshot-diag.mjs —— 诊断截图里的"水平平铺"现象
// 目的：确定平铺是发生在 canvas 内容里，还是读取/编码环节。
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const f = process.argv[2] || 'C:/Users/Simon Lai/AppData/Local/Temp/mh2/eyes-v17-face.png';
const t = decodePNG(fs.readFileSync(f));
console.log(`图 ${t.w}x${t.h} ch=${t.ch}`);

const bg = [242, 243, 245];   // 预览页背景 #f2f3f5
const isBg = (x, y) => {
  const o = (y * t.w + x) * t.ch;
  return Math.abs(t.data[o] - bg[0]) + Math.abs(t.data[o + 1] - bg[1]) + Math.abs(t.data[o + 2] - bg[2]) < 14;
};

// ① 水平中线上的非背景区段
for (const frac of [0.35, 0.5, 0.62, 0.72]) {
  const y = Math.floor(t.h * frac);
  const runs = []; let inRun = false, st = 0;
  for (let x = 0; x < t.w; x++) {
    const on = !isBg(x, y);
    if (on && !inRun) { inRun = true; st = x; }
    if (!on && inRun) { inRun = false; runs.push([st, x - 1, x - st]); }
  }
  if (inRun) runs.push([st, t.w - 1, t.w - st]);
  const big = runs.filter((r) => r[2] > 4);
  console.log(`y=${y} (${(frac * 100).toFixed(0)}%)  非背景段 ${big.length} 个: ` +
    big.map((r) => `x${r[0]}-${r[1]}(w${r[2]})`).join(' '));
}

// ② 垂直中线上的非背景区段
{
  const x = Math.floor(t.w * 0.5);
  const runs = []; let inRun = false, st = 0;
  for (let y = 0; y < t.h; y++) {
    const on = !isBg(x, y);
    if (on && !inRun) { inRun = true; st = y; }
    if (!on && inRun) { inRun = false; runs.push([st, y - 1, y - st]); }
  }
  if (inRun) runs.push([st, t.h - 1, t.h - st]);
  const big = runs.filter((r) => r[2] > 4);
  console.log(`x=${x} (垂直中线)  非背景段 ${big.length} 个: ` +
    big.map((r) => `y${r[0]}-${r[1]}(h${r[2]})`).join(' '));
}

// ③ 自相关：把某一行与自身平移 k 像素比对，找最佳重复周期
{
  const y = Math.floor(t.h * 0.62);
  const row = [];
  for (let x = 0; x < t.w; x++) {
    const o = (y * t.w + x) * t.ch;
    row.push((t.data[o] + t.data[o + 1] + t.data[o + 2]) / 3);
  }
  let best = { k: 0, s: Infinity };
  for (let k = 20; k < Math.floor(t.w / 2); k++) {
    let s = 0, n = 0;
    for (let x = 0; x + k < t.w; x += 3) { s += Math.abs(row[x] - row[x + k]); n++; }
    s /= n;
    if (s < best.s) best = { k, s };
  }
  console.log(`最佳重复周期 k=${best.k}px（平均差 ${best.s.toFixed(2)}，越小越像重复）`);
  console.log(`  → 若是平铺，k 应等于"单个头 + 间隙"的宽度；画布宽 ${t.w}`);
}
