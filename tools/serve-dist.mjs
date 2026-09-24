// 把 expo export 出来的 dist/ 当静态站点跑起来，用于本地预览
// ---------------------------------------------------------------------------
// 为什么需要：dist/index.html 里引用的是 /_expo/static/... 这类绝对路径，
// 直接用文件预览打开会 404，只有把整个目录当站点根才行。
//
// 用法：node tools/serve-dist.mjs [端口] [dist目录] [路径前缀]
//
// ★ 第三个参数「路径前缀」是给 GitHub Pages 那种子路径部署用的：
//   CI 里会先把 baseUrl 设成 /<仓库名>/，于是 index.html 引用的是
//   /aiva-companion/_expo/static/... ，而 dist/ 本身**就是**站点根，
//   底下并没有 aiva-companion/ 这个目录 ——
//   不剥掉前缀的话每个资源都是 404，页面直接白屏/报
//   SyntaxError: Unexpected token '<'（拿 HTML 当 JS 解析）。
//   本地预览这类产物：node tools/serve-dist.mjs 8123 dist /aiva-companion
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 第二个参数可以指定别的产物目录（比如 dist-kizuna），默认才是 dist
const DIST = path.resolve(__dirname, '..', process.argv[3] || 'dist');
const PREFIX = String(process.argv[4] || '').replace(/\/+$/, ''); // '/aiva-companion' | ''
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
  let rel = decodeURIComponent(req.url.split('?')[0]);
  // 剥掉部署前缀（见文件头说明），让 /aiva-companion/_expo/x.js → /_expo/x.js
  if (PREFIX && (rel === PREFIX || rel.startsWith(PREFIX + '/'))) rel = rel.slice(PREFIX.length) || '/';
  let file = path.join(DIST, rel === '/' || rel === '' ? 'index.html' : rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }

  // ⚠️ SPA 回落要留个口子，别把缺资源也吞掉。
  //    以前这里是"文件不存在或是个目录 → 一律返回 index.html"，看着很省事，
  //    实际会把「JS 文件根本没部署上去 / 路径写错了」伪装成一个 200 的 HTML。
  //    浏览器用它去解析脚本，报的是 SyntaxError: Unexpected token '<' ——
  //    一个和真正原因（资源 404）毫无关系的错误，极难往回追。
  //    所以：**带扩展名的路径找不到就如实 404**，只有无扩展名的深链（前端路由）才回落。
  const hasExt = path.extname(rel) !== '';
  const exists = fs.existsSync(file) && !fs.statSync(file).isDirectory();
  if (!exists) {
    if (hasExt) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel); }
    file = path.join(DIST, 'index.html');
  }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`预览地址 http://127.0.0.1:${PORT}${PREFIX}/  (根目录 ${DIST}${PREFIX ? '，已剥前缀 ' + PREFIX : ''})`);
});
