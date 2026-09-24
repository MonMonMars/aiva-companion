// mh-crop.mjs —— 把两张 PNG 按指定区域裁出来并**上下拼接**成一张对比图
// 用途：给"闭眼前后"这种细微差异做像素级视觉确认（单看两张全脸图很难判断）。
// 用法: node tools/mh-crop.mjs <left.png> <right.png> <out.png> [x] [y] [w] [h] [scale]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error('只支持 8bit');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error('只支持 RGB/RGBA');
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride)); pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { w, h, ch, px };
}

function encodePng(w, h, ch, px) {
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const colorType = ch === 4 ? 6 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const [f1, f2, out, xs, ys, ws, hs, ss] = process.argv.slice(2);
const x = Number(xs ?? 60), y = Number(ys ?? 280), w = Number(ws ?? 360), h = Number(hs ?? 130), s = Number(ss ?? 3);

const a = decodePng(fs.readFileSync(f1));
const b = decodePng(fs.readFileSync(f2));
console.log(`${f1.split(/[\\/]/).pop()} ${a.w}x${a.h}  ·  ${f2.split(/[\\/]/).pop()} ${b.w}x${b.h}`);
console.log(`裁 x=${x} y=${y} ${w}x${h}，放大 ${s}×，上下拼接`);

function region(img, X, Y, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const sx = X + xx, sy = Y + yy;
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
      const si = (sy * img.w + sx) * img.ch;
      const di = (yy * W + xx) * 4;
      out[di] = img.px[si]; out[di + 1] = img.px[si + 1]; out[di + 2] = img.px[si + 2];
      out[di + 3] = img.ch === 4 ? img.px[si + 3] : 255;
    }
  }
  return out;
}

const W = w * s, H = h * s;
const canvas = Buffer.alloc(W * (H * 2 + 6) * 4, 0);
for (let i = 0; i < W * (H * 2 + 6); i++) { canvas[i * 4] = 24; canvas[i * 4 + 1] = 24; canvas[i * 4 + 2] = 28; canvas[i * 4 + 3] = 255; }

const put = (src, Y0) => {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = (yy * w + xx) * 4;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const di = ((Y0 + yy * s + dy) * W + xx * s + dx) * 4;
          canvas[di] = src[si]; canvas[di + 1] = src[si + 1]; canvas[di + 2] = src[si + 2]; canvas[di + 3] = 255;
        }
      }
    }
  }
};
put(region(a, x, y, w, h), 0);
put(region(b, x, y, w, h), H + 6);

fs.writeFileSync(out, encodePng(W, H * 2 + 6, 4, canvas));
console.log('-> ' + out + ' ' + W + 'x' + (H * 2 + 6) + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB)');
