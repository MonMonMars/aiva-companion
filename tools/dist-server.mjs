// 零依赖静态服务器：会按 Accept-Encoding 发预压好的 .br / .gz
// ---------------------------------------------------------------------------
// 这个文件会被原样复制到 dist/server.js 一起部署，所以
//   · 只能用 node 内置模块，不能 import 项目里的任何东西
//   · 目录要自己找：在 dist/ 里跑时 dist 就是自己的目录
//
// 关键：Content-Type 必须按**原始扩展名**给，不能按 .gz 给 ——
//       否则浏览器拿到 application/gzip 的 .js，直接拒绝执行，页面白屏。
//
// 用法：node server.js [端口] [目录]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 部署沙箱会注入 PORT，本地跑用 argv
const PORT = Number(process.env.PORT || process.argv[2] || 8123);
// 部署环境必须绑 0.0.0.0（反向代理从外面进来）；本地只绑回环，别暴露到局域网
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const argDir = process.argv[3] || 'dist';

// 明确传了目录就用它；否则把常见落点全试一遍。
//
// ⚠️ 部署沙箱会把 dist/ 的**内容**当成项目根上传 —— 那时 index.html 就在
//    server.js 自己旁边，不存在任何 dist 子目录。早期版本的候选列表里
//    没有 `__dirname` 自己，于是云端起不来（报"找不到 index.html"），
//    但本地预览却正常，属于典型的"本地能跑线上炸"。所以自等量必须先试。
const candidates = [
  ...(process.argv[3] ? [path.resolve(process.argv[3])] : []),
  path.resolve(__dirname),
  path.resolve(__dirname, argDir),
  path.resolve(__dirname, '..', argDir),
];
const DIST = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));

if (!DIST) {
  console.error('找不到 index.html，试过：' + candidates.join(' | '));
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 挑一个能用的压缩版本：br > gzip > 原文件 */
function pick(file, accept) {
  const canBr = /\bbr\b/.test(accept);
  const canGz = /\bgzip\b/.test(accept);
  if (canBr && fs.existsSync(file + '.br')) return { file: file + '.br', enc: 'br' };
  if (canGz && fs.existsSync(file + '.gz')) return { file: file + '.gz', enc: 'gzip' };
  if (fs.existsSync(file)) return { file, enc: null };
  return null;
}

http
  .createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400);
      return res.end('bad url');
    }

    let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
    // 目录穿越防护
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      return res.end('403');
    }
    // SPA 兜底：找不到就回 index.html，让前端路由自己处理
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }

    const chosen = pick(file, req.headers['accept-encoding'] || '');
    if (!chosen) {
      res.writeHead(404);
      return res.end('404');
    }

    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 有了这一条，CDN/浏览器才不会把 gzip 版发给不支持的客户端
      Vary: 'Accept-Encoding',
    };
    if (chosen.enc) headers['Content-Encoding'] = chosen.enc;

    // 带 hash 的静态产物可以永久缓存；index.html 每次都要问，否则发新版用户看不到
    const isHashed = /\/_expo\/static\//.test(rel) || /-[0-9a-f]{16,}\./.test(rel);
    headers['Cache-Control'] = isHashed
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, must-revalidate';

    const stat = fs.statSync(chosen.file);
    headers['Content-Length'] = stat.size;
    res.writeHead(req.method === 'HEAD' ? 200 : 200, headers);
    if (req.method === 'HEAD') return res.end();

    fs.createReadStream(chosen.file)
      .on('error', () => res.end())
      .pipe(res);
  })
  .listen(PORT, HOST, () => {
    console.log(`serving ${DIST}  ->  http://${HOST}:${PORT}/`);
  });
