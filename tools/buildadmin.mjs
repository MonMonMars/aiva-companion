// 把管理后台产到 dist/admin.html
// ---------------------------------------------------------------------------
// ⚠️ 为什么必须有这一步：expo export 会重出整个 dist，任何手工丢进去的文件都会被洗掉。
//    所以后台源文件放在 admin/admin.html，每次打包后由这个脚本重新产出。
//
// ★ 新的打包红线顺序（顺序不能乱）：
//    1) expo export --platform web     （重出 dist）
//    2) tools/fixhtml.mjs              （补安全网 + 复制 server.js）
//    3) tools/buildadmin.mjs           （这一步：补回 admin.html）
//    4) tools/precompress.mjs          （预压缩，要在这之后再跑，否则 admin.html 不会被压）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = path.join(ROOT, 'admin', 'admin.html');
const DIST = path.join(ROOT, 'dist', 'admin.html');
// 唯一来源：workbuddy_cloud_service 返回的 publicConfig 写进来的配置。不要在这里硬编码 endpoint，
// 不要从 dist/index.html 或 window.location 猜 —— 云端按 Origin 精确匹配。
const CFG = path.join(ROOT, 'src', 'lib', 'cloudConfig.json');

if (!fs.existsSync(SRC)) {
  console.error('找不到后台源文件：' + SRC);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html 不存在 —— 先跑 expo export，再跑本脚本');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
if (!cfg.endpoint || !cfg.publishableKey) {
  console.error('cloudConfig.json 缺 endpoint / publishableKey');
  process.exit(1);
}
if (cfg.publishableKey) {
  console.log('使用 publishableKey：' + cfg.publishableKey.slice(0, 10) + '…（其余不打印）');
}

let html = fs.readFileSync(SRC, 'utf8');
const before = html;
html = html
  .replace('__CLOUD_ENDPOINT__', cfg.endpoint)
  .replace('__CLOUD_PUBLISHABLE_KEY__', cfg.publishableKey);

if (html === before) {
  console.error('占位符没替换成功 —— 检查 admin/admin.html 里的 __CLOUD_ENDPOINT__ 是否还在');
  process.exit(1);
}
if (html.includes('__CLOUD_')) {
  console.error('还有未替换的占位符残留在产物里');
  process.exit(1);
}

fs.writeFileSync(DIST, html);
console.log('已输出后台：dist/admin.html  (' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + 'KB)');
console.log('endpoint：' + cfg.endpoint);
console.log('提示：后台和主 app 同源，共用同一个云环境，所以后台读到的就是这批数据。');
