// 把 expo export 出来的 dist/ 当静态站点跑起来，用于本地预览
// ---------------------------------------------------------------------------
// 为什么需要：dist/index.html 里引用的是 /_expo/static/... 这类绝对路径，
// 直接用文件预览打开会 404，只有把整个目录当站点根才行。
//
// 用法：node tools/serve-dist.mjs [端口] [dist目录]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 第二个参数可以指定别的产物目录（比如 dist-kizuna），默认才是 dist
const DIST = path.resolve(__dirname, '..', process.argv[3] || 'dist');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 npx expo export --platform web');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const PORT = Number(process.argv[2] || 8123);
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`预览地址 http://127.0.0.1:${PORT}/  (根目录 ${DIST})`);
});
