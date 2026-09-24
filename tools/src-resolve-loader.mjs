// 让 Node ESM 能直接 import src/ 下的源码
// ---------------------------------------------------------------------------
// 问题：src/ 里所有相对导入都是 bundler 风格（'./theme'、'../store'，不带 .js），
//       约 40 个文件 110 处，且这是全库一致的写法 —— Expo bundler 照单全收，
//       Node 的 ESM 解析器却严格得多，直接 ERR_MODULE_NOT_FOUND。
//       以前 tools/ 下只有 .mjs 脚本，且大部分只 import 第三方包，
//       所以这个裂缝一直没被踩到；一旦某个测试要 import src/ 深处就炸。
//
// 为什么不给 src/ 挨个补 .js：那会把 110 处 bundler 风格改成 Node 风格，
//   改动面大、和现有约定冲突，而且以后新写文件稍不留神又会漏 ——
//   把一个"测试跑不起来"的问题变成了"全库风格不统一"的问题。
//   正确做法是只修运行侧：让测试借这个 loader 启动。
//
// 用法（两种等价）：
//   node --import ./tools/src-resolve-loader.mjs tools/test-xxx.mjs
//   node tools/register-src.mjs tools/test-xxx.mjs        ← 推荐，见 register-src.mjs
//
// ⚠️⚠️ 三个坑，全是踩过的，改之前务必看完：
//
//  1) 必须导出 `register()`，否则 hook 一次都不会被调用。
//     Node 22 里 `--import ./x.mjs` 是把 x 当**入口模块**执行，
//     只有 `registerHook()` / `module.register()` 才真的注册 hook。
//     只导出一个 `resolve` 函数看起来"很标准"，实际全程静默失效 ——
//     症状和"loader 写错了"一模一样，但不报任何错。
//     验证办法：在 resolve 里往 globalThis 记数，跑完打印。必须是 undefined 以外的东西。
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
import { register } from 'node:module';

/** 在 parentURL 所在目录里，给无扩展名的相对路径补出 .js 或 /index.js */
function patch(specifier, parentURL) {
  const base = parentURL || pathToFileURL(path.join(process.cwd(), 'x')).href;
  let dir;
  try {
    dir = path.dirname(fileURLToPath(base));
  } catch (_) {
    return null;
  }
  const asFile = path.join(dir, `${specifier}.js`);
  if (fs.existsSync(asFile) && fs.statSync(asFile).isFile()) return pathToFileURL(asFile).href;

  const asIndex = path.join(dir, specifier, 'index.js');
  if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) return pathToFileURL(asIndex).href;

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    // 只救相对路径；裸包名让 Node 报原本那个错
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw e;
    if (/\.[a-z0-9]+$/i.test(specifier)) throw e; // 已带扩展名却找不到 = 真缺失

    const fixed = patch(specifier, context.parentURL);
    if (!fixed) throw e;
    return nextResolve(fixed, context);
  }
}

// ★ 这一行是"能不能生效"的关键，别删（原因见顶部第 1 条）。
//   直接指向本文件：Node 会把它当 hooks 模块再加载一次，
//   这次走的是 hooks 通道，里面的 `resolve` 才真正接上。
register(import.meta.url);
