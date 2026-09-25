// 本地把每个目标平台真的打包一遍
// ---------------------------------------------------------------------------
// 为什么要有这段脚本（CI #25 的教训）：
//   当时本地 15 步全绿，push 上去 CI 的 build job 却炸了 —— 原因是
//   src/llm.js 写成了 `from './netFetch'`，而它在 src/ 根、netFetch.js 在 src/lib/。
//   `node --check` 只解析语法、**不解析 import 路径**，lint 当时也不查路径能否落地，
//   所以这行错代码在本地一路无声通过，只有 Metro 打包时才报错。
//
//   **测试全绿 ≠ 能打包。** 这两件事之间没有必然联系，缺的那一环就是真的把它跑一遍。
//
// ★ 为什么要打多个平台
//   CI 里只导出 web，于是「原生端能不能打包」从来没人验证过。而 web 和原生走的
//   是两套不同的模块解析结果 —— 实测同一个入口 index.js：
//
//       web:  546 modules   （走 react-native-web）
//       iOS:  830 modules   （走真 react-native）
//
//   相差那 284 个模块，每一个都是「只有打原生才会经过」的代码。
//   缺了 `Avatar3D.native.js` 这种事，web 打包照样全绿，只有原生端会报错。
//   所以默认打 **web + ios** 两个：ios 代表原生这一族 —— Metro 里 android 与 ios
//   共用 `.native.js` 解析链，单独再加一个 android 只多 20 秒却几乎没有新增覆盖。
//
// 实测：热缓存下 web 6 秒、iOS 21 秒。慢得值 —— 它挡的是「推上去才炸」。
//
// 用法：node tools/verify-bundle.mjs [项目根目录] [--platform web,ios] [--keep]
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(process.argv[2] || '.');

const argv = process.argv.slice(3);
const platformArg = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : null;
const PLATFORMS = platformArg ? platformArg.split(',') : ['web', 'ios'];
const KEEP = argv.includes('--keep');

// @expo/cli 在 npm 扁平化后常常嵌在 expo/node_modules 里，两个位置都找一遍
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

const summary = [];
let failed = false;

for (const plat of PLATFORMS) {
  const out = path.join(ROOT, `dist-localcheck-${plat}`);
  // 先清掉上一次的，免得旧产物混进来让失败伪装成成功
  fs.rmSync(out, { recursive: true, force: true });

  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [cli, 'export', '--platform', plat, '--output-dir', `dist-localcheck-${plat}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' }, // 与 GitHub Actions 上的行为保持一致
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const dt = Date.now() - t0;
  const outText = `${r.stdout || ''}${r.stderr || ''}`;

  // 顺手记一下模块数 —— web 与原生本来就该不一样；两个平台数一模一样才可疑
  const mod = outText.match(/\((\d+)\s+modules\)/);
  const modules = mod ? Number(mod[1]) : null;

  if (r.status !== 0) {
    failed = true;
    summary.push({ plat, ok: false, modules, dt });
    console.log(`\n✗ [${plat}] 打包失败（${dt}ms）`);
    console.log(outText.split('\n').slice(0, 25).map((l) => `      ${l}`).join('\n'));
    continue;
  }

  summary.push({ plat, ok: true, modules, dt });
  console.log(`v [${plat}] ${modules ?? '?'} modules（${dt}ms）`);
  if (!KEEP) fs.rmSync(out, { recursive: true, force: true });
}

const line = summary.map((s) => `${s.plat}=${s.ok ? `${s.modules}modules` : 'FAIL'}`).join('  ');
if (failed) {
  console.log(
    `\n[verify-bundle] FAIL — ${line}\n` +
      '              最常见的原因是：① 某个相对 import 路径写错（node --check 抓不到）；\n' +
      '              ② 某个模块只有 web 版（X.web.js）却没有原生对应的实现。\n' +
      '              先跑 `node tools/lint-imports.mjs .`，路径错了它会直接告诉你该改成什么。\n'
  );
  process.exit(1);
}
console.log(`\n[verify-bundle] PASS — ${line}`);
