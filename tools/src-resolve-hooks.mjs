// Node ESM 解析器补丁 —— 让 node 能直接 import src/ 下 bundler 风格的源码
// ---------------------------------------------------------------------------
// 这是全项目**唯一**的一份解析钩子。之前存在两套做同一件事的 loader
//（ext-resolve-hooks.mjs 和 src-resolve-loader.mjs），2026-09-25 合并过来 ——
// 起因是它们各少一半：前者缺 JSON 支持，后者缺 import attributes 之外的处理。
// 合并后的行为是两者的**并集**，逐条保下来了，别再把它们拆回去。
//
// 为什么需要：src/ 里约 40 个文件 110 处相对导入全是 Metro/bundler 风格
//（'./theme'、'../store'，不带 .js），Expo bundler 照单全收，Node 的 ESM
// 解析器却强制要求完整扩展名，直接跑就是 ERR_MODULE_NOT_FOUND。
//
// 为什么不给 src/ 挨个补 .js：那要把 110 处 bundler 风格改成 Node 风格，
// 改动面大、和现有约定冲突，而且以后新写文件稍不留神又会漏 ——
// 把一个「测试跑不起来」的问题变成了「全库风格不统一」的问题。
// 正确做法是只修运行侧：让测试借这个 loader 启动。
//
// 用法：node --import ./tools/src-resolve.mjs tools/test-xxx.mjs
//      node tools/register-src.mjs tools/test-xxx.mjs        ← 等价，见 register-src.mjs
//
// ⚠️⚠️ 三个坑，全是踩过的，改之前务必看完：
//
//  1) 这里导出 resolve/load **没用**，真正生效的是 src-resolve.mjs 里的 register()。
//     Node 22 里 `--import ./x.mjs` 是把 x 当**入口模块**执行，只有
//     module.register() 才真的注册 hook。只导出一个 `resolve` 看起来"很标准"，
//     实际全程静默失效 —— 症状和"loader 写错了"一模一样，但不报任何错。
//
//  2) 解析必须基于 context.parentURL（发起 import 的那个文件），
//     不能用本模块的 import.meta.url —— 否则相对路径对错了目录，
//     Node 会拿到 'c:\...' 这种字符串，当成 scheme 报
//     ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'。
//
//  3) 返回给 nextResolve 的必须是 URL 字符串或 file:// URL，不能是盘符路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 已带扩展名还找不到 = 真缺失，不要替它救（否则会把拼错的扩展名悄悄改掉） */
const HAS_EXT = /\.[a-z0-9]+$/i;

/** 在 parentURL 所在目录里，给无扩展名的相对路径补出 .js / .mjs / index.js / index.mjs */
function patch(specifier, parentURL) {
  const base = parentURL || pathToFileURL(path.join(process.cwd(), 'x')).href;
  let dir;
  try {
    dir = path.dirname(fileURLToPath(base));
  } catch {
    return null;
  }
  // 绝对路径 '/x' 交给 path.resolve 处理，其余一律按相对 parent 算
  const target = specifier.startsWith('/')
    ? path.resolve(specifier)
    : path.resolve(dir, specifier);

  const tries = [
    `${target}.js`,
    `${target}.mjs`,
    path.join(target, 'index.js'),
    path.join(target, 'index.mjs'),
  ];
  for (const f of tries) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return pathToFileURL(f).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    // ★ 先让默认解析器试。只有在它明确说「找不到」时才插手 ——
    //   顺序反了会遮蔽 Node 原生的解析（包入口、条件导出、node_modules）。
    return await nextResolve(specifier, context);
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!isRelative && !specifier.startsWith('/')) throw e; // 裸包名让 Node 报原本那个错
    if (HAS_EXT.test(specifier)) throw e;

    const fixed = patch(specifier, context.parentURL);
    if (!fixed) throw e;
    return nextResolve(fixed, context);
  }
}

/**
 * 让 `import cfg from './xxx.json'`（不带 import attributes）在 node 里也能跑。
 *
 * 源码按 Metro 的习惯写的裸 JSON import，node 会报
 * ERR_IMPORT_ATTRIBUTE_MISSING。所以在这里补一步：把 JSON 当成
 * `export default {...}` 的模块喂回去。
 *
 * 有它之后，凡是间接 import 了 cloudConfig.json 的模块（cloudClient 等）
 * 才第一次能在 node 里被单测到 —— 这也是原来两套 loader 里**只有一套有的能力**，
 * 合并时千万别漏。
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const src = fs.readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${src};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
