// pngutil.mjs —— 无依赖 PNG 读写（8bit，非隔行，支持灰度/RGB/RGBA）
// ===========================================================================
// 踩坑记录（别删）：
//   MakeHuman 的 brown_eye.png 是 **RGBA 且带透明背景**。早期我用「深色像素聚类」
//   找瞳孔，结果把「透明背景被查看器合成成黑色」当成了瞳孔，于是量出了两颗
//   假的"黑色圆盘"（实际是右上角一片阴影弧 + 透明区），虹膜位置全算错。
//   → 一切基于这张图的分析都**必须先看 alpha**。
import zlib from 'node:zlib';

export function decodePNG(b) {
  let p = 8, w = 0, h = 0, ch = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p); p += 4;
    const t = b.toString('ascii', p, p + 4); p += 4;
    const d = b.subarray(p, p + len); p += len + 4;
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
  }
  if (!ch) throw new Error('pngutil: 只支持灰度/RGB/RGBA，colorType=' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, data: out };
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
export function encodePNG(w, h, rgbOrRgba, alpha) {
  const ch = alpha === undefined ? 3 : 4;
  const src = rgbOrRgba;
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const mk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const cb = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cb));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mk('IHDR', ihdr),
    mk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    mk('IEND', Buffer.alloc(0)),
  ]);
}

// 双线性重采样（带 alpha 预乘，避免透明区边缘发黑）
export function resample(src, sw, sh, sc, dst, dw, dh, dc) {
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sh / dh - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = Math.max(0, fy - y0);
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sw / dw - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = Math.max(0, fx - x0);
      const a = src.subarray((y0 * sw + x0) * sc, (y0 * sw + x0) * sc + sc);
      const b = src.subarray((y0 * sw + x1) * sc, (y0 * sw + x1) * sc + sc);
      const c = src.subarray((y1 * sw + x0) * sc, (y1 * sw + x0) * sc + sc);
      const d = src.subarray((y1 * sw + x1) * sc, (y1 * sw + x1) * sc + sc);
      const wa = sc === 4 ? [a[3], b[3], c[3], d[3]] : [1, 1, 1, 1];
      const wsum = (wa[0] * (1 - tx) + wa[1] * tx) * (1 - ty) + (wa[2] * (1 - tx) + wa[3] * tx) * ty;
      const o = (y * dw + x) * dc;
      for (let k = 0; k < Math.min(3, dc); k++) {
        const v = ((a[k] * wa[0]) * (1 - tx) + (b[k] * wa[1]) * tx) * (1 - ty)
          + ((c[k] * wa[2]) * (1 - tx) + (d[k] * wa[3]) * tx) * ty;
        dst[o + k] = Math.round(wsum > 1e-6 ? v / wsum : 0);
      }
      if (dc === 4) dst[o + 3] = Math.round(wsum);
    }
  }
  return dst;
}
