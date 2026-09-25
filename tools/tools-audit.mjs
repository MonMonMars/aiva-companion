/**
 * tools/ 体检：哪些脚本还被引用着，哪些已经没人提了。
 *
 * 用法： node tools/tools-audit.mjs [--all]
 *       不带 --all 只打印「零引用」候选（归档要看的那一半）。
 *
 * ⚠️ 为什么要有它：靠「猜哪个没用」来删脚本一定会误伤。
 *    183 个入库脚本里只有 15 个被 package.json 引用，但剩下那些**不是**死代码 ——
 *    发布流水线（fixhtml / buildadmin / precompress）、线上核查（verify-live）、
 *    各种取证探针（cdp- 系列、shot- 系列）都是 workflow 或 README 在用。
 *    「没被 package.json 引用」≠「没人用」，必须真的扫一遍全仓库的引用。
 *
 * 判据：脚本文件名（含扩展名）在**别的文件**里出现过 = 有引用。
 *    扫描范围：package.json / app.json / metro.config.js / eas.json / README.md /
 *    .github/workflows/ / src/ / tools/ / public/（文本类），跳过 node_modules、dist、.git、assets。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showAll = process.argv.includes('--all');

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.htm', '.sh', '.txt']);
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'assets', '.expo', '.shots-front', '.shots-admin', 'tmp', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// ---- 1. 入库的 tools 脚本 -------------------------------------------------
const tracked = execSync('git ls-files tools', { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .map((f) => path.basename(f))
  .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
  .sort();

// ---- 2. 语料：除 tools 自身之外的所有文本文件 -----------------------------
const corpusFiles = [
  ...walk(root).filter((p) => !p.startsWith(path.join(root, 'tools'))),
  ...['package.json', 'app.json', 'metro.config.js', 'eas.json'].map((f) => path.join(root, f)).filter((p) => fs.existsSync(p)),
  ...walk(path.join(root, '.github')),
];
const corpus = [];
for (const f of [...new Set(corpusFiles)]) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  corpus.push({ file: path.relative(root, f).replace(/\\/g, '/'), text: s });
}
// tools 内部的互相引用也算引用（但排除自己）
const toolsFiles = walk(path.join(root, 'tools'));
const toolsCorpus = [];
for (const f of toolsFiles) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  toolsCorpus.push({ file: path.relative(root, f).replace(/\\/g, '/'), text: s });
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pkgScripts = Object.values(pkg.scripts || {}).join(' ');

const rows = tracked.map((name) => {
  const self = 'tools/' + name;
  // 两种写法都算引用：带扩展名的文件名（shot.mjs）和路径式（tools/shot）。
  // ⚠️ 只查带扩展名的会漏：README 里经常写 `tools/diag-startup-phases`，
  //    于是把它误判成零引用 —— 那种脚本恰恰是文档里明确记着的，不能归档。
  const stem = name.replace(/\.(mjs|js)$/, '');
  const pathForm = 'tools/' + stem;
  const hit = (text) => text.includes(name) || text.includes(pathForm);
  const hits = new Set();
  for (const c of corpus) if (hit(c.text)) hits.add(c.file);
  for (const c of toolsCorpus) if (c.file !== self && hit(c.text)) hits.add(c.file);
  return {
    name,
    inPkg: pkgScripts.includes(name),
    refs: [...hits].sort(),
  };
});

const dead = rows.filter((r) => r.refs.length === 0);
const alive = rows.filter((r) => r.refs.length > 0);

console.log('=== tools/ 引用体检 ===');
console.log(`入库脚本：${tracked.length} 个`);
console.log(`  有引用：${alive.length}`);
console.log(`  零引用：${dead.length}  ← 归档候选`);
console.log(`  被 package.json 直接引用：${rows.filter((r) => r.inPkg).length}`);

if (showAll) {
  console.log('\n--- 有引用的（前 5 个引用源）---');
  for (const r of alive) {
    console.log(`  ${r.name}${r.inPkg ? ' [npm]' : ''}  ${r.refs.slice(0, 5).join(', ')}`);
  }
}

console.log('\n--- 零引用候选（按名字排序）---');
for (const r of dead) {
  const size = fs.existsSync(path.join(root, 'tools', r.name))
    ? Math.round(fs.statSync(path.join(root, 'tools', r.name)).size / 1024)
    : 0;
  console.log(`  ${r.name}  (${size} KB)`);
}

// 一次性脚本（下划线开头，被 gitignore，只在本机）
const oneoff = fs.readdirSync(path.join(root, 'tools')).filter((f) => f.startsWith('_'));
console.log(`\n一次性脚本（下划线开头，未入库，只在本机）：${oneoff.length} 个`);
for (const f of oneoff) console.log('  ' + f);

console.log('\n⚠️ 零引用只代表「仓库里没人提到它」，不等于没用 ——');
console.log('   手动跑的取证探针、只在某次排障时用过的脚本也会落在这里。归档前逐个过一眼。');
