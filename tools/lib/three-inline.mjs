/**
 * 把 node_modules/three 内联成一段**经典脚本**（非 ES module）可用的代码。
 *
 * 为什么需要：预览页要用 file:// 或本地 HTTP 打开，不能用 type="module" +
 * importmap 去 unpkg 拉（离线就废了，而且 file:// 下 module 会被 CORS 拦）。
 * 所以要把 three 整个塞进 <script> 里。
 *
 * ⚠️ 踩过的坑（这段注释比代码值钱）：
 *
 *   坑① 只内联 three.core.js 是不够的。
 *        r152 之后 three 把构建拆成两个文件：
 *          · three.core.js   1.46MB —— 数学 + 场景图 + 几何，**没有 WebGLRenderer**
 *          · three.module.js 662KB  —— 渲染器 / 材质 / 贴图，靠 import core 拼起来
 *        只内联 core 的话，页面跑起来静悄悄：下拉框、表格、标题全正常，
 *        只有 `new THREE.WebGLRenderer()` 抛 "is not a constructor"，两个画布全黑。
 *        我为此误判过两次（一次以为模型坏了，一次以为取景错了）。
 *
 *   坑② 两个文件不能简单拼在一起。
 *        它们都是 rollup 的独立产物，各自的**顶层私有变量会重名**
 *        （_vector / _matrix 之类），拼进同一个脚本作用域直接 SyntaxError。
 *        所以各包一层 IIFE，作用域隔离，再把导出对象合并。
 *
 * 用法：
 *   import { inlineThree } from './lib/three-inline.mjs';
 *   const THREE_SRC = inlineThree(ROOT);   // ROOT = 项目根（含 node_modules）
 */
import fs from 'node:fs';
import path from 'node:path';

/** 取出末尾 `export { A, B };` 的「前面的代码」和「{ A, B };」 */
function grab(src, tag) {
  const i = src.lastIndexOf('export {');
  if (i < 0) throw new Error(tag + ' 里找不到 export { —— three 的构建格式变了，需要重新适配');
  const list = src.slice(i + 'export '.length).trim();
  if (!/^\{[\s\S]*\};?$/.test(list)) {
    throw new Error(tag + ' 的 export 不是预期的对象列表形式：' + list.slice(0, 60));
  }
  // ⚠️ 三个 export 列表里都没有 `X as Y` 别名（已核对 r186）。
  //    哪天 three 加了别名，这里必须把 `X as Y` 转成 `Y: X`。
  if (/\sas\s/.test(list)) throw new Error(tag + ' 的 export 出现了 as 别名，本转换器需要先升级');
  return { body: src.slice(0, i), list };
}

export function inlineThree(ROOT) {
  const B = path.join(ROOT, 'node_modules', 'three', 'build');
  const core = grab(fs.readFileSync(path.join(B, 'three.core.js'), 'utf8'), 'three.core.js');
  const mod = fs.readFileSync(path.join(B, 'three.module.js'), 'utf8');

  // three.module.js 顶部有两条对 core 的引用，处理完全不同：
  //   import     → 必须转成解构，否则 module 内部用到的 Matrix3 / Vector2 全是未定义
  //   re-export  → 纯转发，THREE 里已经有一份了，整行删掉
  const IMP = /^import\s*\{([\s\S]*?)\}\s*from\s*'\.\/three\.core\.js';?[ \t]*$/m;
  const REE = /^export\s*\{([\s\S]*?)\}\s*from\s*'\.\/three\.core\.js';?[ \t]*$/m;
  const mImp = mod.match(IMP);
  const mRe = mod.match(REE);
  if (!mImp) throw new Error('three.module.js 里找不到对 three.core.js 的 import');
  if (!mRe) throw new Error('three.module.js 里找不到对 three.core.js 的 re-export');

  const m = grab(mod.replace(IMP, '').replace(REE, ''), 'three.module.js');

  return [
    'const THREE = (function(){',
    core.body,
    'return ' + core.list,
    '})();',
    'Object.assign(THREE, (function(){',
    'const {' + mImp[1] + '} = THREE;',
    m.body,
    'return ' + m.list,
    '})());',
    'if (typeof window !== "undefined") window.THREE = THREE;',
    '',
  ].join('\n');
}
