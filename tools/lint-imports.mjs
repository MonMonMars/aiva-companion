// 静态检查：跨模块具名导入的完整性。
// ---------------------------------------------------------------------------
// 为什么需要：这类错误 Metro 打包**不报错**，只在渲染到那一行时才炸，
// 表现是整个页面白屏（React 抛异常 → 根组件卸载）。
//
// 真实案例：src/screens/VoiceSettings.js 写的是
//     import { GlassCard, PrimaryButton, UI } from '../components/ui';
//   但 components/ui.js 只导出 GlassCard / Pill / PrimaryButton / StatBar /
//   BottomSheet / Empty / shadeColor —— **没有 UI**。
//   于是 UI 是 undefined，样式表里 `color: UI.text` 抛
//   "Cannot read properties of undefined (reading 'text')"，整个设置页白屏。
//
// 两个子检查：
//   A. 导入的名字在目标模块里必须真的被导出
//   B. 用了 `X.` 的地方，X 必须在本文件里被导入或声明过
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');
const SRC = path.join(ROOT, 'src');

// ---- 1. 收集每个模块导出的名字 ----
const exported = new Map(); // absPath -> Set(names)
const allFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.expo'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) allFiles.push(p);
  }
})(SRC);

function collectExports(src) {
  const names = new Set();
  // export const/let/var/function/class  X
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { A, B as C }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const clean = part.trim();
      if (!clean) continue;
      const asMatch = clean.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      names.add(asMatch ? asMatch[1] : clean.split(/\s+/)[0]);
    }
  }
  // export default
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

for (const f of allFiles) exported.set(f, collectExports(fs.readFileSync(f, 'utf8')));

// ---- 2. 解析相对导入并比对 ----
const problems = [];

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 只查项目内的相对导入
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', base + '.jsx', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

for (const file of allFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // ⚠️ 别用 /import\s*\{/ 开头：`import React, { useState } from 'react'` 这种
  //    "默认导入 + 具名导入"的写法匹配不到，具名部分就被整段跳过检查了。
  //    所以这里直接抓 `{...} from '...'`，不管前面有没有默认导入。
  for (const m of src.matchAll(/\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const target = resolveImport(file, m[2]);
    if (!target) continue;
    const exp = exported.get(target) || new Set();
    for (const raw of names) {
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!exp.has(name)) {
        problems.push(
          `✗ ${rel}\n    从 '${m[2]}' 导入了 \`${name}\`，但 ${path.relative(ROOT, target)} 并没有导出它`
        );
      }
    }
  }
}

// ---- 3. 用了某个项目内模块导出的名字，但本文件既没导入也没声明 ----
// 这是最阴的一类 bug：Metro 打包不报错，运行到那一行才 ReferenceError。
// 真实案例：Avatar3D.web.js 里调了 schedule() / warmOtherModels()，
// import 却在并行编辑中丢了 —— 错误被 try/catch 吞掉，
// 表现却是"当前设备不支持 WebGL2"（其实是初始化炸了）。
// 所以这里不再写死几个符号，而是拿"项目里所有导出名"去反查每个文件的用法。
const exportedNames = new Map(); // name -> Set(文件)
for (const [f, names] of exported) {
  for (const n of names) {
    if (!exportedNames.has(n)) exportedNames.set(n, new Set());
    exportedNames.get(n).add(f);
  }
}

// 语言/宿主内置量：这些不算"漏 import"
const BUILTIN = new Set([
  'console', 'window', 'document', 'globalThis', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Date', 'Promise', 'Set', 'Map', 'WeakMap', 'Error',
  'RegExp', 'Symbol', 'Reflect', 'Proxy', 'localStorage', 'sessionStorage', 'navigator',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'process', 'require', 'module', 'exports',
  'React', 'THREE', 'default', 'performance', 'Intl', 'URL', 'Blob', 'FileReader',
]);

/** 去掉注释：JSDoc 里 `@param {object} comp createCompanionScene() 的返回值`
 *  这种写法会被当成真实调用，误报一片。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

for (const file of allFiles) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file);
  const defined = new Set();
  for (const m of src.matchAll(/\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) defined.add(n);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) defined.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // 对象解构 const { a, b } = X
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim();
      if (n) defined.add(n);
    }
  }
  // 数组解构 const [a, setA] = useState(...) —— 少了这条，
  // `pre` / `setPre` 这种会被当成"未声明"，误报（也可能掩盖真问题）
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    }
  }
  // 函数形参 / catch(e) / 箭头函数单参
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/[:=].*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    }
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) defined.add(m[1]);
  // 赋值/属性左值：`name =` `name:`
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)) defined.add(m[1]);

  // 文件里"被用到"的名字：函数调用 `X(` 与成员访问 `X.`
  // ⚠️ 前面必须排除 `.`：`import * as S from '../store'` 之后写的 `S.pet()`
  //    里的 pet 不是独立标识符，不该算"漏 import"。
  const used = new Set();
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[2]);
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\.(?!\d)/g)) used.add(m[2]);

  for (const name of used) {
    if (defined.has(name) || BUILTIN.has(name)) continue;
    if (!exportedNames.has(name)) continue; // 不是项目内导出的名字，不关这里的事
    const lines = src.split('\n');
    const hit = lines.findIndex((l) => new RegExp(`\\b${name}\\s*[(.]`).test(l));
    const from = Array.from(exportedNames.get(name))
      .map((f) => path.relative(ROOT, f)).slice(0, 3).join(' / ');
    problems.push(
      `✗ ${rel}:${hit + 1}\n    用了 \`${name}\`，但本文件没有导入或声明它 —— 它在 ${from} 里有导出`
    );
  }
}

if (problems.length) {
  console.log(problems.join('\n\n'));
  console.log(`\n[lint-imports] FAIL — ${problems.length} 处导入问题，这些会在渲染时直接白屏`);
  process.exit(1);
}
// 输出保持纯 ASCII：Windows 下这条日志会被重定向进文件再读，
// 中文在 GBK/UTF-8 之间来回转一次就成乱码，"PASS/FAIL" 反而看得清。
console.log(`[lint-imports] PASS — 扫描 ${allFiles.length} 个文件，问题 0 处`);
