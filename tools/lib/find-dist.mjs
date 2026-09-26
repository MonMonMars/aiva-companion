// 挑「可以真跑一遍」的那份 web 产物。
// ---------------------------------------------------------------------------
// 为什么单独抽出来（2026-09-27，第 34 步实测抓到的）：
//   第 17 步 `smoke-runtime.mjs` 找产物用的是
//       [ --dir 给的, dist-localcheck-web, dist ] 三选一 + 必须有 index.html，找不到就 exit 1；
//   它的牙齿 `test-smoke-runtime-teeth.mjs` 却**只认 dist-localcheck-web 一个**，
//   而且连 index.html 都不查，找不到时打印「跳过」然后 exit 0。
//
//   两边各写一份的结果就是：环境里只有 `dist/`（比如跑过 npm run export:web）
//   的时候，第 17 步照常在 `dist/` 上做实验，而它的牙齿**什么都不验还报绿**。
//   这正是「静默全绿」最讨厌的形状 —— 全套 33 步全绿，其中一步是空转。
//
//   抽到一处之后，两边挑的必然是同一份，改判据也只改一个地方。
//   （这个仓库里「两份逻辑飘开」出现过四次，多一份副本就多一份飘的机会。）
//
// ⚠️ 判据里**必须查 index.html**：只查目录存在不够 ——
//    实测就撞上一个残留目录 dist-localcheck-web，里面只有 espeak 的两个文件，
//    没有任何 index.html 和 .glb。目录在 ≠ 产物在。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

export function distCandidates(dirArg = null) {
  return [dirArg, 'dist-localcheck-web', 'dist'].filter(Boolean);
}

/**
 * @returns {string|null} 找到的绝对目录；一个都没有就 null（**不是**抛错，
 *   由调用方决定「找不到」该红还是该跳过 —— 但牙齿脚本一律不许跳过）。
 */
export function findDist(root, dirArg = null) {
  for (const d of distCandidates(dirArg)) {
    const abs = path.resolve(root, d);
    try {
      if (fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, 'index.html'))) return abs;
    } catch {
      /* 不存在 / 不是目录，看下一个 */
    }
  }
  return null;
}
