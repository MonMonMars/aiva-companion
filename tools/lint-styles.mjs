// 静态检查：找出 src/ 下所有 `styles.X` / `st.X` 引用了但 StyleSheet 里没定义的键
// 这类错误 Metro 打包不会报错，运行时才炸（undefined style 或字段丢失）。
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');
const SHEET_VARS = ['styles', 'st'];
let bad = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.expo') continue;
      walk(p, out);
    } else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function keysForSheet(src, varName) {
  // 抓 `const styles = StyleSheet.create({ ... })`
  const decl = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*StyleSheet\\.create\\(`);
  const m = src.match(decl);
  if (!m) return null;
  const start = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(start, i + 1);
  const keys = new Set();
  // 顶层键：`  foo: {`  或  `  foo: [...]`
  const line = /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm;
  let mm;
  while ((mm = line.exec(body))) keys.add(mm[1]);
  return keys;
}

const files = walk(ROOT);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const v of SHEET_VARS) {
    const keys = keysForSheet(src, v);
    if (!keys) continue;
    const refs = new Set();
    const re = new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let m2;
    while ((m2 = re.exec(src))) refs.add(m2[1]);
    const missing = [...refs].filter((k) => !keys.has(k) && k !== 'create');
    if (missing.length) {
      bad++;
      console.log(`✗ ${path.relative(ROOT, f)}  [StyleSheet var: ${v}]`);
      console.log(`    引用了但未定义: ${missing.join(', ')}`);
    }
  }
}

console.log(bad === 0 ? `\n✅ 样式引用检查通过（扫描 ${files.length} 个文件）` : `\n发现 ${bad} 个文件有问题`);
process.exit(bad === 0 ? 0 : 1);
