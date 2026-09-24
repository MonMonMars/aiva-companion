import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const PORT = Number(process.argv[3] || 8800);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.json5': 'application/json',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(path.resolve(ROOT))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + p); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, () => console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT + '/'));
