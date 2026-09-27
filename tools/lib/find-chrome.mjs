// 挑「能拿来跑验收」的那个 Chrome。
// ---------------------------------------------------------------------------
// 为什么要单独抽出来（同一个理由，和 find-dist.mjs 那次一模一样）：
//   `smoke-runtime.mjs` 里早就写好了「CHROME_PATH → 本机那个 → /usr/bin/google-chrome
//   → /usr/bin/chromium」四选一，而 `verify-app-ui.mjs` 里是另一份更短的：
//   「CHROME_PATH → 本机那个」，**没有 Linux 的后两条**。
//
//   两份并存的结果本来没问题 —— 因为 verify-app-ui 一直没登记，CI 上没人跑它。
//   一旦收进套装（第 40 步），ubuntu runner 上 `CHROME_PATH` 没设、本机那个
//   Windows 路径又不存在，它就拿一个不存在的文件去 spawn —— spawn 会甩 ENOENT，
//   报错里只说找不到那个路径，没有任何指向「其实是没找浏览器」的线索。
//   而同一台机器上 smoke-runtime 照样跑得好好的。
//   **同一件事两套判据，必有一个是漏的。**
//
//   所以两处共用这一份；将来换位置（或者 CI 镜像换了路径）只改这里。
//
// ⚠️ 那个写死的本机路径是**这台 Windows 机器上** agent-browser 装的 Chrome。
//    它对别人没意义，但放在这里比散在两个脚本里好：至少只有一处需要作废。
//    CI 上由第 ② 条（/usr/bin/google-chrome）兜住 —— 已实测（CI #33/#34/#35）。
// ---------------------------------------------------------------------------

import fs from 'node:fs';

export function chromeCandidates() {
  return [
    process.env.CHROME_PATH,
    'C:/Users/Simon Lai/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
}

/**
 * @returns {string|null} 第一个在磁盘上真存在的候选；一个都没有就 null
 *   （**不是**抛错 —— 由调用方决定「找不到浏览器」该红还是该跳过；
 *    但登记过的步骤一律红：`4.9MB 的 bundle` 都等了，别在起浏览器这步静默放行。）
 */
export function findChrome() {
  return chromeCandidates().find((p) => fs.existsSync(p)) || null;
}
