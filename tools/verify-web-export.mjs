// 本地跑一次 Metro 打包，验证 CI 的「导出 Web 静态包」这一步能过。
// ---------------------------------------------------------------------------
// 为什么要有这段脚本（CI #25 的教训）：
//   当时本地 15 步测试全绿，push 上去 CI 的 build job 却炸了 —— 原因是
//   src/llm.js 写成了 `from './netFetch'`，而它在 src/ 根、netFetch.js 在 src/lib/。
//   `node --check` 只解析语法、**不解析 import 路径**，lint 当时也不查路径能否落地，
//   所以这行错代码在本地一路无声通过，只有 Metro 打包时才报错。
//
//   也就是说：**测试全绿 ≠ 能打包**。这两件事之间没有必然联系，
//   缺的那一环就是真的把打包跑一遍。
//
// 实测：热缓存下 6 秒出结果，冷机慢一些。慢得值 —— 它挡的是"推上去才炸"。
// 输出的 30MB 资源写在 dist-localcheck/，不动正常的 dist/。
//
// 用法：node tools/verify-web-export.mjs [项目根目录]
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(process.argv[2] || '.');
const OUT = process.argv[3] || 'dist-localcheck';

// @expo/cli 在 npm 扁平化后常常落在 expo/node_modules 里，
// 两个位置都找一遍，别假设它一定在顶层。
const CLI_CANDIDATES = [
  'node_modules/expo/node_modules/@expo/cli/main.js',
  'node_modules/@expo/cli/build/bin/cli',
  'node_modules/@expo/cli/main.js',
];

const cli = CLI_CANDIDATES.map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
if (!cli) {
  console.log(`✗ 找不到 @expo/cli，试过：\n  ${CLI_CANDIDATES.join('\n  ')}`);
  process.exit(1);
}

const r = spawnSync(
  process.execPath,
  [cli, 'export', '--platform', 'web', '--output-dir', OUT],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' }, // 与 GitHub Actions 上的行为保持一致
    maxBuffer: 64 * 1024 * 1024,
  }
);

process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);

if (r.status !== 0) {
  process.stdout.write(
    '\n[verify-web-export] FAIL — Metro 打包失败。' +
      '最常见的原因是某个相对 import 路径写错（node --check 抓不到这类错）。\n' +
      '             先跑一遍 `node tools/lint-imports.mjs .`，它会直接告诉你该改成什么。\n'
  );
  process.exit(1);
}
process.stdout.write(`\n[verify-web-export] PASS — Metro 打包通过，产物在 ${OUT}/\n`);
