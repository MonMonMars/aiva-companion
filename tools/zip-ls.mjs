// 极简 zip 目录解析器（只读中央目录，不解压）
import { readFileSync, statSync } from 'node:fs';

const file = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const buf = readFileSync(file);
const size = statSync(file).size;

// 从尾部找 End Of Central Directory
let eocd = -1;
for (let i = size - 22; i >= Math.max(0, size - 66000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.log('EOCD not found'); process.exit(1); }
const total = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);

const rows = [];
for (let n = 0; n < total; n++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const method = buf.readUInt16LE(off + 10);
  const csize = buf.readUInt32LE(off + 20);
  const usize = buf.readUInt32LE(off + 24);
  const nlen = buf.readUInt16LE(off + 28);
  const elen = buf.readUInt16LE(off + 30);
  const clen = buf.readUInt16LE(off + 32);
  const lho = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nlen);
  rows.push({ name, usize, csize, method, lho });
  off += 46 + nlen + elen + clen;
}

const shown = filter ? rows.filter((r) => filter.test(r.name)) : rows;
console.log(`${file}  entries=${rows.length}  matched=${shown.length}`);
const dirs = new Set();
for (const r of shown) {
  if (r.usize === 0) { dirs.add(r.name); continue; }
  console.log(`${(r.usize / 1024).toFixed(0).padStart(8)}KB  ${r.name}`);
}
if (dirs.size) {
  console.log('--- dirs ---');
  for (const d of [...dirs].sort()) console.log('  ' + d);
}
