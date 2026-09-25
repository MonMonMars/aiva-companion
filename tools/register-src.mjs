// 一条命令跑 src/ 相关的测试脚本，自动挂上 src-resolve.mjs（唯一的那个解析钩子）
// ---------------------------------------------------------------------------
// 用法：
//   node tools/register-src.mjs tools/test-rig-semantics.mjs [更多参数...]
//
// 存在的理由见 src-resolve-hooks.mjs 顶部注释：src/ 用的是 bundler 风格的
// 无扩展名导入，Node 原生解析不了，必须借 loader 把 '.js' 补上。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node tools/register-src.mjs <脚本> [参数...]');
  process.exit(2);
}

// ⚠️ 必须传 file:// URL：Windows 上传盘符路径（c:\...）会被 ESM loader
//    当成 scheme，报 ERR_UNSUPPORTED_ESM_URL_SCHEME。见 src-resolve-hooks.mjs。
const loader = pathToFileURL(path.join(__dirname, 'src-resolve.mjs')).href;
const child = spawn(process.execPath, ['--import', loader, ...args], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
