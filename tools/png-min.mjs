/**
 * 极简 PNG 编解码 —— 只用 node 内置 zlib，不引第三方包。
 * 够用就行：8-bit、非隔行、colorType 0/2/4/6。glTF 内嵌贴图都属于这一类。
 */

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// ---- 解码 ----
export function decodePNG(buf) {
  if (buf.slice(0, 8).equals(SIG) === false) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ct = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`bitDepth ${depth} 不支持（贴图都是 8-bit）`);
  if (interlace !== 0) throw new Error('隔行 PNG 不支持');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!channels) throw new Error(`colorType ${ct} 不支持`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const raw_v = raw[p + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v;
      switch (f) {
        case 0: v = raw_v; break;
        case 1: v = raw_v + a; break;
        case 2: v = raw_v + b; break;
        case 3: v = raw_v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = raw_v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`未知 filter ${f}`);
      }
      cur[x] = v & 255;
    }
    p += stride;
  }
  return { width: w, height: h, channels, colorType: ct, data: out };
}

// ---- 编码 ----
/** 逐行自适应滤波：5 种都算一遍，取绝对值之和最小的，压缩率最好 */
function filterLine(line, prev, channels) {
  const n = line.length;
  let best = null, bestScore = Infinity;
  for (let f = 0; f < 5; f++) {
    const o = Buffer.alloc(n);
    let score = 0;
    for (let x = 0; x < n; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v;
      switch (f) {
        case 0: v = line[x]; break;
        case 1: v = line[x] - a; break;
        case 2: v = line[x] - b; break;
        case 3: v = line[x] - ((a + b) >> 1); break;
        default: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = line[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      v &= 255;
      o[x] = v;
      // 当作有符号字节来估：>127 说明是个大负数，不利于压缩
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) { bestScore = score; best = { f, data: o }; }
  }
  return best;
}

export function encodePNG({ width, height, channels, data }, { level = 9 } = {}) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const line = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    const r = filterLine(line, prev, channels);
    raw[y * (stride + 1)] = r.f;
    r.data.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                                             // bitDepth
  ihdr[9] = { 1: 0, 3: 2, 2: 4, 4: 6 }[channels];          // colorType
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
