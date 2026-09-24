// mheye-clean.mjs —— 量出素材球 B 周围"干净可采样"的半径
//
// 背景：渲染后眼白里出现大片灰蓝色块。来源是素材球 B 的**重叠兄弟球 A**
// （两颗球沿反对角线重叠摆放）被采样窗覆盖到了。要确定采样窗该缩到多小，
// 就必须量出"从 B 的虹膜中心往外，走多远开始不再是 B 自己"。
//
// 判据两条：
//   1) alpha 掉下 250（B 球边界）
//   2) 颜色跳变 > 90（踩到了另一个球或阴影贴片）
// 取所有方向里最小的那个半径 = 安全半径。
import fs from 'node:fs';
import { decodePNG } from './pngutil.mjs';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data/eyes/materials/brown_eye.png';
const t = decodePNG(fs.readFileSync(SRC));
console.log(`贴图 ${t.w}x${t.h} ch=${t.ch}`);

const IRIS_B = [0.28867, 0.70885];
const cx = IRIS_B[0] * t.w, cy = IRIS_B[1] * t.h;
console.log(`虹膜 B 中心像素 (${cx.toFixed(1)}, ${cy.toFixed(1)})`);

// 逐像素环扫描（0.5 度一档，360 档），得到每个角度的"干净半径"
const N = 720;
const rows = [];
for (let k = 0; k < N; k++) {
  const a = (k / N) * Math.PI * 2;
  const dx = Math.cos(a), dy = Math.sin(a);
  let clean = 0, prev = null;
  for (let r = 1; r < 600; r++) {
    const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) break;
    const o = (y * t.w + x) * t.ch;
    const al = t.data[o + 3];
    const c = [t.data[o], t.data[o + 1], t.data[o + 2]];
    let bad = false;
    if (al < 250) bad = true;                         // 出 B 球
    if (prev) {
      const d = Math.abs(c[0] - prev[0]) + Math.abs(c[1] - prev[1]) + Math.abs(c[2] - prev[2]);
      if (d > 90) bad = true;                          // 色相突变
    }
    if (bad) break;
    prev = c; clean = r;
  }
  rows.push({ deg: +(k / N * 360).toFixed(0), clean });
}

rows.sort((a, b) => a.clean - b.clean);
console.log('\n最紧的 12 个方向（干净半径最小的角度）：');
for (let i = 0; i < 12; i++) console.log(`  ${String(rows[i].deg).padStart(3)}°  →  ${rows[i].clean} px  (${(rows[i].clean / t.w).toFixed(4)} UV)`);

const minR = rows[0].clean;
const p10 = rows[Math.floor(N * 0.10)].clean;
const medR = rows[Math.floor(N * 0.5)].clean;
console.log(`\n最小 ${minR}px (${(minR / t.w).toFixed(4)} UV)   P10 ${p10}px (${(p10 / t.w).toFixed(4)} UV)   中位 ${medR}px (${(medR / t.w).toFixed(4)} UV)`);

// 按 30 度分桶看趋势
console.log('\n按 30° 分桶的平均干净半径：');
for (let b = 0; b < 12; b++) {
  const sel = rows.filter((r) => r.deg >= b * 30 && r.deg < (b + 1) * 30);
  const avg = sel.reduce((s, r) => s + r.clean, 0) / sel.length;
  console.log(`  ${String(b * 30).padStart(3)}°~${String(b * 30 + 30).padStart(3)}°  平均 ${avg.toFixed(0)} px  (${(avg / t.w).toFixed(4)} UV)`);
}

// 结论建议：用 P05 作为安全半径（允许最紧的少数方向被轻微裁掉）
const p05 = rows[Math.floor(N * 0.05)].clean;
console.log(`\n建议采样半径：${p05}px = ${(p05 / t.w).toFixed(4)} UV（P05，兼顾可用面积与干净度）`);
