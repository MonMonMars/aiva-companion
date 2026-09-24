// 选择性解压 zip：node zip-extract.mjs <zip> <outdir> <regex>
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const [zip, out, pat] = process.argv.slice(2);
if (!zip || !out) { console.log('usage: zip-extract <zip> <outdir> [regex]'); process.exit(1); }
const filter = pat ? new RegExp(pat, 'i') : /.*/;
const buf = readFileSync(zip);
const size = statSync(zip).size;

let eocd = -1;
for (let i = size - 22; i >= Math.max(0, size - 66000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const total = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
let n = 0;
for (let k = 0; k < total; k++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const method = buf.readUInt16LE(off + 10);
  const csize = buf.readUInt32LE(off + 20);
  const usize = buf.readUInt32LE(off + 24);
  const nlen = buf.readUInt16LE(off + 28);
  const elen = buf.readUInt16LE(off + 30);
  const clen = buf.readUInt16LE(off + 32);
  const lho = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nlen);
  off += 46 + nlen + elen + clen;

  if (usize === 0 || !filter.test(name)) continue;
  // local header
  const lnlen = buf.readUInt16LE(lho + 26);
  const lelen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + lnlen + lelen;
  const raw = buf.subarray(start, start + csize);
  let data;
  if (method === 0) data = raw;
  else if (method === 8) data = inflateRawSync(raw);
  else { console.log(`skip ${name} (method ${method})`); continue; }
  const dest = path.join(out, name.replace(/\//g, path.sep));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  n++;
  console.log(`${(usize / 1024).toFixed(0).padStart(7)}KB -> ${dest}`);
}
console.log(`extracted ${n}`);
