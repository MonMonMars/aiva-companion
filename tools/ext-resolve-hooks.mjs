/**
 * Node ESM 解析器补丁：给 extensionless 的 import 补 .js / /index.js。
 *
 * 为什么需要：项目源码写的是 `import { X } from './faceStandard'`（Metro 的解析习惯），
 * 但 Node 原生 ESM 强制要求完整扩展名，直接 `node tools/xxx.mjs` 会
 * ERR_MODULE_NOT_FOUND。以前踩过的坑：只能在浏览器里跑，出问题要开无头浏览器，
 * 反馈慢一个数量级。
 *
 * 用法：node --import ./tools/ext-resolve.mjs tools/xxx.mjs
 * （Node 22 已经移除 --experimental-specifier-resolution，只能上 loader hook）
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  // 只管相对路径 / 项目内裸路径；三方包交给默认解析
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const base = path.resolve(parent, specifier);
    const candidates = [
      base,                                  // 原样（可能带扩展名）
      `${base}.js`, `${base}.mjs`, `${base}.json`,
      path.join(base, 'index.js'), path.join(base, 'index.mjs'),
    ];
    for (const c of candidates) {
      if (existsSync(c) && !c.endsWith('.json')) {
        return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

/**
 * 让 `import cfg from './xxx.json'`（不带 import attributes）在 node 里也能跑。
 *
 * 源码按 Metro 的习惯写的裸 JSON import，node 会报
 * ERR_IMPORT_ATTRIBUTE_MISSING。上面 resolve 又故意跳过 .json（否则会把
 * `./foo` 误解析成 `./foo.json`）。所以在这里补一步：把 JSON 当成
 * `export default {...}` 的模块喂回去。
 *
 * 有它之后，凡是间接 import 了 cloudConfig.json 的模块（cloudClient 等）
 * 才第一次能在 node 里被单测到。
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${src};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
