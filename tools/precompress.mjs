// 给 dist/ 里的文本类产物预先压出 .gz 和 .br
// ---------------------------------------------------------------------------
// 为什么必须做：expo export 出来的单包是 5.7MB，而部署用的静态服务器
// （python3 -m http.server）**完全不压缩**，手机上每一次打开都要实打实
// 下载 5.7MB。同一个包 gzip 只有 1.20MB（小 4.8 倍），br 只有 0.64MB。
// 用户看到的就是"打开 8 秒还是白屏"。
//
// 这里在构建期就把压缩好的兄弟文件写好，服务器只管按 Accept-Encoding 挑一个发出去，
// 运行时零开销（不占用首字节时间）。
//
// 用法：node tools/precompress.mjs [dist目录]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', process.argv[2] || 'dist');

// 只压"压得动"的文本；二进制（glb/png/jpg/字体）本来就压过了，再压是白费 CPU
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.json', '.map', '.css', '.svg', '.txt', '.xml', '.webmanifest']);
const MIN_BYTES = 1024; // 太小压了反而变大

let raw = 0;
let gzBytes = 0;
let brBytes = 0;
let files = 0;
let skipped = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // 别压自己压出来的东西（服务器会自己挑，不能把 .gz 再压一遍）
    if (/\.(gz|br)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('找不到 dist/index.html，先跑 expo export');
  process.exit(1);
}

for (const file of walk(DIST)) {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) { skipped += 1; continue; }
  const buf = fs.readFileSync(file);
  if (buf.length < MIN_BYTES) { skipped += 1; continue; }

  raw += buf.length;
  files += 1;

  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(file + '.gz', gz);
  gzBytes += gz.length;

  // brotli 质量 11 对几 KB 的文件也就是几毫秒，没必要设门槛 ——
  // 之前设了 20KB，结果 index.html（~6KB）拿不到 br，只有 gzip 版。
  const br = zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  fs.writeFileSync(file + '.br', br);
  brBytes += br.length;
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`预压缩完成：${files} 个文本文件（另有 ${skipped} 个跳过）`);
console.log(`  原始    ${mb(raw)}`);
console.log(`  gzip    ${mb(gzBytes)}  (小 ${(raw / Math.max(gzBytes, 1)).toFixed(1)} 倍)`);
console.log(`  brotli  ${mb(brBytes)}  (小 ${(raw / Math.max(brBytes, 1)).toFixed(1)} 倍)`);
