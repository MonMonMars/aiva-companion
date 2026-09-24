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
import { existsSync } from 'node:fs';
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
