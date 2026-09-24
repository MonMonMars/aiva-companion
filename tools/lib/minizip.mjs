/**
 * 最小 ZIP 写入器（store / deflate，CRC32 手算）。
 *
 * 为什么自己写：这台机器上命令行 zip 不可用，而 Node 标准库里只有 zlib
 * 没有归档格式。纯 Node 实现零依赖、跨平台稳定。
 *
 * 用法：
 *   import { zipFromEntries } from './lib/minizip.mjs';
 *   fs.writeFileSync(out, zipFromEntries([{ name: 'a/b.txt', data: Buffer }], '包根目录名'));
 *
 * ⚠️ 两个细节：
 *   · 通用位标记写 0x0800（UTF-8 文件名），否则中文文件名在部分解压工具里会乱码。
 *   · deflate 后反而更大就直接 store —— GLB / JPG 基本都压不动，别做无用功。
 */
import zlib from 'node:zlib';

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

/** entries: [{ name: '相对路径/文件名', data: Buffer }]；root 可选，加一层包目录 */
export function zipFromEntries(entries, root = '') {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const raw = e.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(root ? `${root}/${e.name}` : e.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // 需要 2.0
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // 时间戳留 0：不影响解压，省事
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 30);             // extra / comment / disk 都留空
    cd.writeUInt32LE(0, 34);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}
