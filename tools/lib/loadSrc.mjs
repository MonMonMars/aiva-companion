/**
 * 在 node 里加载 `src/` 下的 ESM 源码。
 *
 * ⚠️ 这一段注释是在解释"为什么写成这样"，改动前务必读完，三个坑全是踩过的。
 *
 * 背景：项目 package.json 没有 `"type": "module"`，node 因此把 `src/**.js`
 *       当 CommonJS，一 import ESM 语法就炸。老办法是把源码**复制成 .mjs** 再 import。
 *
 *  坑 1（2026-09-25）：副本放哪儿很要命。
 *       放在 `tools/` 下 —— 源码里那些相对 import（`'../lib/netFetch'`）
 *       会以 **tools/ 为基准**解析，变成 `<root>/lib/netFetch`，直接 Module not found。
 *       所以这里把副本放在**源码同一个目录**里：基准和源码原本的一模一样，
 *       相对路径天然走得通，不需要去改写源码里的 specifier。
 *
 *  坑 2：src/ 里全是 bundler 风格的无扩展名导入（`'../lib/netFetch'`），
 *       Metro/Expo 照单全收，node 的 ESM 解析器却要求写全 `.js`。
 *       这件事交给 tools/src-resolve.mjs —— 仓库里**唯一**的那个 loader，
 *       它会按 parentURL 所在目录补出 `.js` / `/index.js`。别在另外再写一套。
 *
 *  坑 3：那个 loader 必须"被注册"才生效，光 `import` 一个导出 `resolve` 的模块
 *       是静默失效的（详见它顶部注释第 1 条）。所以这里主动 import 它一次；
 *       `module.register()` 对**之后**发生的解析都有效，
 *       而本文件是用动态 `await import()` 加载源码的，时序上刚好够。
 *       这样测试哪怕被 `node tools/xxx.test.mjs` 直接跑也不用额外挂参数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADER = pathToFileURL(path.join(__dirname, '..', 'src-resolve.mjs')).href;

let loaderReady = false;
async function ensureLoader() {
  if (loaderReady) return;
  await import(LOADER); // 副作用：注册 src-resolve 钩子
  loaderReady = true;
}

/**
 * @param {string} root 项目根
 * @param {string} relPath 相对根的源码路径，**含 src/ 前缀**，如 'src/voice/tts.js'
 * @returns {Promise<object>} 加载到的模块
 */
export async function loadSrc(root, relPath) {
  const src = path.join(root, ...relPath.split('/'));
  if (!fs.existsSync(src)) throw new Error(`源码不在这个位置：${src}（relPath 要带 src/ 前缀）`);

  // 副本与源码同目录 —— 见顶部坑 1
  const tmp = path.join(path.dirname(src), `.tmp-${process.pid}-${path.basename(relPath, '.js')}.mjs`);
  fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8'), 'utf8');

  await ensureLoader(); // 见顶部坑 3
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    // 别把删不掉这件事咽下去：副本躺在 src/ 里会被 Metro / lint / git status 看见，
    // 而“测试通过但留下垃圾”最难查。Windows 上偶尔要等句柄放开，退让一次再删。
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e2) {
        console.warn(`[loadSrc] 临时副本没删掉，请手动清理：${tmp}\n         ${e2?.code} ${e2?.message}`);
      }
    }
  }
}
