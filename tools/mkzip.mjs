/**
 * 把项目打成 zip。为什么不用命令行 zip：
 * 这台机器上 zip 不可用，而纯 Node 实现零依赖、跨平台稳定。
 *
 * 用法： node tools/mkzip.mjs [输出路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.dirname(root);
const projectName = path.basename(root);
const outPath = process.argv[2] || path.join(projectRoot, 'aiva-app.zip');

const EXCLUDE_DIRS = new Set(['node_modules', '.expo', 'dist', '.git', '.chrome-profile']);
const EXCLUDE_EXT = new Set(['.log']);
const EXCLUDE_NAMES = new Set(['.tmp-companion.mjs', '.dbg.mjs', '.DS_Store']);

function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name), relPath);
    } else if (entry.isFile()) {
      if (EXCLUDE_NAMES.has(entry.name)) continue;
      if (EXCLUDE_EXT.has(path.extname(entry.name))) continue;
      yield { abs: path.join(dir, entry.name), rel: relPath };
    }
  }
}

// ---- 最小 ZIP 写入器（store 存储 + deflate 压缩，CRC32 手算） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const files = [...walk(root)];
const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const raw = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // 压缩后更大就存原样，别做无用功
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(`${projectName}/${f.rel}`, 'utf8');
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // 需要 2.0
  local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);          // 时间戳写 0，不是问题却省字节
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
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));

const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
const rawMb = (files.reduce((s, f) => s + fs.statSync(f.abs).size, 0) / 1024 / 1024).toFixed(2);
console.log(`打包完成 -> ${outPath}`);
console.log(`  文件数 ${files.length}，未压缩 ${rawMb} MB，压缩后 ${mb} MB`);
console.log('\n包含的关键内容：');
for (const pat of ['assets/models/', 'src/three/', 'src/lib/', 'tools/', 'app.json', 'README.md']) {
  const hit = files.filter((f) => f.rel.startsWith(pat));
  if (hit.length) console.log(`  ${pat}  (${hit.length} 个文件)`);
}
