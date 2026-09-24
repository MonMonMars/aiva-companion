#!/usr/bin/env node
// 列出 CC0 通用动画库镜像里的文件，并可选下载。
//
// 来源两个（都是 CC0 1.0，作者 Quaternius，可商用可修改可再分发）：
//   · GitHub 镜像 J-Ponzo/gltf-universal-animation-library（glTF 格式，标准免费版 45 个动画）
//   · Godot Store 官方分发包（Godot 标准版，46 clips，单个大 GLB）
//
// 用法：
//   node tools/motion-fetch.mjs list
//   node tools/motion-fetch.mjs get <path> [outfile]
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'J-Ponzo/gltf-universal-animation-library';
const OUT = 'assets/motion';
fs.mkdirSync(OUT, { recursive: true });

const cmd = process.argv[2] || 'list';

async function tree() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, {
    headers: { 'User-Agent': 'aiva-build' },
  });
  if (!r.ok) throw new Error('GitHub API ' + r.status);
  const j = await r.json();
  return (j.tree || []).filter((t) => t.type === 'blob');
}

if (cmd === 'list') {
  const t = await tree();
  const assets = t.filter((x) => /\.(glb|gltf|bin|png|json|md|txt)$/i.test(x.path));
  console.log(`共 ${t.length} 个文件，其中资源 ${assets.length} 个\n`);
  for (const a of assets.sort((x, y) => (y.size || 0) - (x.size || 0))) {
    console.log(`${String(Math.round((a.size || 0) / 1024)).padStart(6)}KB  ${a.path}`);
  }
} else if (cmd === 'get') {
  const p = process.argv[3];
  if (!p) { console.error('用法: get <repo 内路径> [输出文件]'); process.exit(1); }
  const out = process.argv[4] || path.join(OUT, path.basename(p));
  const url = `https://raw.githubusercontent.com/${REPO}/main/${encodeURIComponent(p).replace(/%2F/g, '/')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'aiva-build' } });
  if (!r.ok) throw new Error('下载失败 ' + r.status + ' ' + url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`✓ ${out}  ${Math.round(buf.length / 1024)}KB`);
}
