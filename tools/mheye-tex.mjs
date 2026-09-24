// mheye-tex.mjs —— 程序化生成一张「眼球正面盘状贴图」
// ===========================================================================
// 为什么不再用 MakeHuman 自带的 brown_eye.png：
//   那张图上是「两颗完整眼球」并排铺在 1024×1024 里，而且带 alpha 透明背景。
//   它的 UV 布局和 high-poly.obj 自带的 UV 之间的关系，我测了三轮都互相打架
//   （一会儿说虹膜在 ±X，一会儿说要转 90°），根因是：源网格的 UV 在正前方
//   那一圈是**退化的极点收缩**，而贴图又是两颗球共用一张图。
//   与其继续猜，不如**几何 UV 和贴图都由我自己生成** —— 两边同源，绝不可能错位。
//
// 约定（必须和 mheye-uv.mjs 里的 UV 公式严格对应）：
//   · 采样方式：**正交前半球投影**（orthographic disc）
//         u = 0.5 + nx * 0.5
//         v = 0.5 - ny * 0.5        （glTF 的 v=0 在图片第一行，所以取负号）
//     nx/ny/nz 是顶点相对球心的单位方向，nz 指向 +Z（模型正前方）。
//   · 于是：图片中心 = 角膜正前方；图片半径 512px = 赤道（t=1.0）。
//   · 正前方半球面在屏幕上的投影恰好也是 sinθ 半径 → 虹膜是正圆，比例正确。
//   · 后半球 nz<0 直接折叠到同一张图（背面在头骨里 / 背面剔除，看不见），
//     这样赤道处 UV 连续，**没有任何接缝**。
//
// 尺寸比例取自真人解剖值（眼球直径 24mm，虹膜直径 11.7mm，瞳孔 4mm）：
//   虹膜半径 / 眼球半径 = sin(29.2°) = 0.4875 → 这里取 0.46（留一点给眼睑遮挡）
//   瞳孔 / 虹膜 = 4 / 11.7 = 0.342
//
// 用法: node tools/mheye-tex.mjs [输出路径]
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = 1024;
const OUT = process.argv[2] || 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/_eye_brown.png';

// ------------------------------------------------------------------ 随机数
let _s = 0x9e3779b9;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
// 通用 smoothstep：edge0 > edge1 时自动变成「反向渐变」
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
const gauss = (x, mu, s) => Math.exp(-(((x - mu) / s) ** 2));

// ------------------------------------------------------------- 值噪声 / fbm
const HASH = new Float32Array(4096);
for (let i = 0; i < HASH.length; i++) HASH[i] = rnd();
const _h = (a, b) => HASH[((a & 63) + ((b & 63) << 6))];
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const n00 = _h(xi, yi), n10 = _h(xi + 1, yi), n01 = _h(xi, yi + 1), n11 = _h(xi + 1, yi + 1);
  return mix(mix(n00, n10, sx), mix(n01, n11, sx), sy);
}
const fbm = (x, y) => noise2(x, y) * 0.55 + noise2(x * 2.17 + 17.3, y * 2.17 - 5.9) * 0.3 + noise2(x * 4.63 - 8.1, y * 4.63 + 3.7) * 0.15;

// 角度方向的平滑噪声（虹膜纤维用，首尾必须接得上 → 用周期性 hash）
const FIB_N = 256;
const FIB = new Float32Array(FIB_N);
for (let i = 0; i < FIB_N; i++) FIB[i] = rnd();
for (let pass = 0; pass < 3; pass++) {          // 平滑几轮，变成连续的纤维走向
  const t = FIB.slice();
  for (let i = 0; i < FIB_N; i++) FIB[i] = (t[(i - 1 + FIB_N) % FIB_N] + t[i] * 2 + t[(i + 1) % FIB_N]) / 4;
}
const fibAt = (a) => {
  const f = ((a / (Math.PI * 2)) % 1 + 1) % 1 * FIB_N;
  const i = Math.floor(f), s = f - i;
  return mix(FIB[i % FIB_N], FIB[(i + 1) % FIB_N], s);
};

// ------------------------------------------------------------------ 尺寸常量
const C = (N - 1) / 2;          // 511.5
const R = N / 2;                // 512px ↔ t = 1.0（赤道）
const T_IRIS = 0.46;            // 虹膜外缘（角膜缘）
const T_PUPIL = T_IRIS * 0.342; // ≈ 0.157

// ------------------------------------------------------------ 虹膜径向配色
// 真人棕色虹膜从外到内：角膜缘暗环 → 睫状区（最亮）→ 领状脊（暗）→ 瞳孔区（偏暗）
const C_LIMBUS = [0.216, 0.133, 0.078];
const C_CILIARY = [0.451, 0.263, 0.118];
const C_LIGHT = [0.663, 0.443, 0.196];
const C_COLLAR = [0.376, 0.235, 0.110];
const C_PUPILZ = [0.298, 0.180, 0.090];
const C_PUPIL = [0.016, 0.013, 0.011];
const C_SCLERA = [0.945, 0.918, 0.890];
const C_VEIN = [0.780, 0.455, 0.435];

function irisProfile(rn) {
  let c = mix3(C_LIMBUS, C_CILIARY, smoothstep(1.0, 0.62, rn));
  c = mix3(c, C_LIGHT, smoothstep(0.74, 0.44, rn));
  c = mix3(c, C_COLLAR, gauss(rn, 0.40, 0.060) * 0.80);
  c = mix3(c, C_PUPILZ, smoothstep(0.30, 0.12, rn));
  return c;
}

// --------------------------------------------------------------- 眼白血丝
const vein = new Float32Array(N * N);
function stamp(x, y, w, a) {
  const x0 = Math.max(0, Math.floor(x - w - 1)), x1 = Math.min(N - 1, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - w - 1)), y1 = Math.min(N - 1, Math.ceil(y + w + 1));
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    const d = Math.hypot(px - x, py - y);
    const f = 1 - clamp01(d / (w + 0.6));
    if (f > 0) vein[py * N + px] = Math.min(1, vein[py * N + px] + a * f);
  }
}
for (let i = 0; i < 30; i++) {
  let a2 = rnd() * Math.PI * 2;
  const target = 0.40 + rnd() * 0.32;          // 血丝往里长到的 t
  const steps = 60 + Math.floor(rnd() * 50);
  for (let s = 0; s <= steps; s++) {
    const p = s / steps;
    const t = 1.0 + (target - 1.0) * (1 - Math.cos(p * Math.PI)) / 2;
    a2 += (rnd() - 0.5) * 0.075;
    const x = C + Math.cos(a2) * t * R, y = C + Math.sin(a2) * t * R;
    const w = 0.7 + 2.0 * (1 - p) * (1 - p);
    const al = 0.34 * Math.pow(1 - p, 1.5) + 0.05;
    stamp(x, y, w, al);
  }
}

// ------------------------------------------------------------------ 主循环
const img = Buffer.alloc(N * N * 3);
for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    const dx = px - C, dy = py - C;
    const dist = Math.hypot(dx, dy);
    const t = dist / R;
    const ang = Math.atan2(dy, dx);

    // ---- 眼白
    let sh = 1 - 0.34 * smoothstep(0.60, 1.02, t);                  // 边缘（眼睑下）变暗
    const up = clamp01((C - py) / R);                               // 图片上方 = 眼睛上方
    sh *= 1 - 0.16 * smoothstep(0.02, 0.95, up) * smoothstep(0.12, 0.85, t);
    let col = [C_SCLERA[0] * sh, C_SCLERA[1] * sh, C_SCLERA[2] * sh];
    col[0] += 0.030 * smoothstep(0.62, 1.0, t);                     // 靠边缘偏暖
    col[2] -= 0.020 * smoothstep(0.62, 1.0, t);

    // ---- 血丝
    const vm = vein[py * N + px];
    if (vm > 0) col = mix3(col, C_VEIN, vm * 0.55);

    // ---- 角膜缘暗环（虹膜外侧压一圈，让虹膜和眼白之间有过渡）
    col = mix3(col, [0.353, 0.243, 0.188], 0.55 * gauss(t, T_IRIS + 0.010, 0.013));

    // ---- 虹膜
    const ai = 1 - smoothstep(T_IRIS - 0.014, T_IRIS + 0.004, t);
    if (ai > 0) {
      const rn = t / T_IRIS;
      let ic = irisProfile(rn);
      // 放射状纤维（两层频率）
      const f1 = fibAt(ang) * 2 - 1;
      const f2 = fibAt(ang * 3.0) * 2 - 1;
      const amp = 0.30 * smoothstep(0.05, 0.22, rn) * (1 - smoothstep(0.78, 0.98, rn));
      let m = 1 + amp * (f1 * 0.7 + f2 * 0.3);
      m *= 1 + 0.11 * (fbm(Math.cos(ang) * rn * 3.1, Math.sin(ang) * rn * 3.1) - 0.5);
      ic = [ic[0] * m, ic[1] * m, ic[2] * m];
      col = mix3(col, ic, ai);
    }

    // ---- 瞳孔
    const ap = (1 - smoothstep(T_PUPIL - 0.007, T_PUPIL + 0.003, t)) * ai;
    if (ap > 0) col = mix3(col, C_PUPIL, ap);

    const o = (py * N + px) * 3;
    img[o] = Math.round(clamp01(col[0]) * 255);
    img[o + 1] = Math.round(clamp01(col[1]) * 255);
    img[o + 2] = Math.round(clamp01(col[2]) * 255);
  }
}

// ---------------------------------------------------------------- PNG 写出
const CRC = (() => {
  const tb = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c; }
  return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = tb[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(N * (N * 3 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 3 + 1)] = 0;
  img.copy(raw, y * (N * 3 + 1) + 1, y * N * 3, (y + 1) * N * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`写出 ${OUT}  ${N}×${N} RGB  ${(png.length / 1024).toFixed(0)}KB`);
console.log(`虹膜半径 ${(T_IRIS * R).toFixed(0)}px  瞳孔半径 ${(T_PUPIL * R).toFixed(0)}px`);

// 自查：中心 / 虹膜 / 瞳孔 / 眼白 四处的颜色
const at = (t) => {
  const px = Math.round(C + t * R), py = Math.round(C);
  const o = (py * N + px) * 3;
  return `t=${t.toFixed(3)} rgb(${img[o]},${img[o + 1]},${img[o + 2]})`;
};
console.log([0, 0.10, 0.30, 0.42, 0.55, 0.75, 0.95].map(at).join('  '));
