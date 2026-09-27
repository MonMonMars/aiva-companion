// 第 42 步：CI 上真会跑的脚本，不许写死「某台机器的用户主目录」。
// ---------------------------------------------------------------------------
// 起因是一次真事故（2026-09-27，收第 40/41 步时挖出来的）：
//   `smoke-runtime.mjs` 里有一份「CHROME_PATH → 本机那个 → /usr/bin/google-chrome
//   → /usr/bin/chromium」四选一，而 `verify-app-ui.mjs` 里是另一份更短的：
//   「CHROME_PATH → **写死的** C:/Users/Simon Lai/.agent-browser/.../chrome.exe」。
//   两份并存好几个月没人发现 —— 因为 verify-app-ui 一直没登记，CI 上没人跑它。
//   一收进套装（第 40 步），ubuntu runner 上那个 Windows 路径不存在，
//   它拿一个不存在的文件去 spawn，报错只有 ENOENT，没有任何线索指向
//   「其实是没找浏览器」。而同一台机器上 smoke-runtime 照样跑得好好的。
//
//   事后把两份合并成 tools/lib/find-chrome.mjs 了，但**合并本身不会阻止第三份长出来**。
//   这道闸就是用来阻止的：写死本机路径的脚本一旦被 CI 跑到，必红。
//
// 判据（就一条，但有两个前提必须先成立）：
//   A. 先问「CI 上到底跑哪些脚本」——从 .github/workflows/*.yml 里抓，
//      不自己列清单（自己列 = 第三份清单，必飘）。抓不到任何脚本 = 检查白跑了，红。
//   B. 金丝雀自检：这段扫描器是有可能**静默失效**的（正则改坏、去注释改坏），
//      而仓库里现在一处违规都没有 —— 失效后它会一直绿，没人会知道。
//      所以每次开跑先拿内置样例验一遍自己：**该命中的必须命中、不该命中的不许命中**。
//   C. 逐个脚本：抹掉注释后，不许出现「用户主目录形状的绝对路径字面量」。
//      · `C:/Users/…`、`C:\Users\…`、`/Users/…`、`/home/…`、`/root/…`
//      · 用 os.homedir() / process.env.HOME 取的**不算** —— 卡的是写死的字面量。
//      · `/usr/bin/…`、`/tmp/…` 不算 —— 那是跨平台公认的位置，不是某台机器的主目录。
//
// ⚠️ 覆盖范围（诚实说清，别把它想得比实际更大）：
//   只查 **workflow 里被直接点名** 的脚本（今天 47 个）。
//   被 CI 脚本 import 的 lib（比如 tools/lib/find-chrome.mjs 里那条写死的 Windows
//   Chrome 路径）**不在范围内** —— 那条是「候选清单」的合法写法。
//   所以「新写个 lib、里面只写死本机路径」这种形状它抓不到。
//   刻意没做传递扫描：一做就会把 find-chrome 那种合法候选清单点着，
//   然后只能靠开白名单压下去 —— 而白名单正是第 117 条那条「会烂且烂了没人响」的路。
//
// 用法：node tools/lint-ci-paths.mjs [项目根目录]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { blankComments } from './lib/strip-comments.mjs';
// ★ 金丝雀样例放在 fixtures/ 下而不是写在本文件里 —— 原因见那个文件的顶部注释：
//   里面那条 `C:\Users\...`（反斜杠形态）会被第 25 步 lint-platform-cmds 判成
//   「硬编码的 Windows 盘符路径」。它是**测试数据**，不是代码；
//   那道闸自己就跳过 fixtures/。别把它挪回本文件，一挪第 25 步就红。
import { MUST_HIT, MUST_MISS, WIN_HOME, COMMENT_SAMPLE } from './fixtures/ci-paths-samples.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
// ★ 显式写死 .github —— 不能靠默认 glob，默认会跳过隐藏目录。
//   这个坑在 lint-ci-refs.mjs 那次（CI #29）已经踩过一次了。
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const write = (s) => process.stdout.write(s);
let failures = 0;
const fail = (msg) => { failures++; write(`  ✗ ${msg}\n`); };

/** 用户主目录形状的绝对路径 —— 它是「这台机器专用」的最强信号 */
const HOME_PATH_RE = /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:Users|home|root)\/)/g;

// ---- A. CI 上到底跑哪些脚本 ----------------------------------------------
write('【A】CI 上会跑的脚本清单（从 workflow 里抓，不自己列）\n');

if (!fs.existsSync(WF_DIR)) {
  write(`\n✗ 找不到 ${WF_DIR}：CI 目录不存在，这一步等于没跑\n\n`);
  process.exit(1);
}

// 与 lint-ci-refs.mjs【A】同口径：抓 tools/... 引用，跳过注释行
// （注释里提到的路径不是「会被执行的引用」—— 那边的注释就复盘过被删掉的旧文件）
const FILE_RE = /(?:^|\s)(?:\.\/)?((?:tools|scripts)\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g;
const referenced = new Set();
let scannedWorkflows = 0;
for (const yml of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const text = fs.readFileSync(path.join(WF_DIR, yml), 'utf8');
  scannedWorkflows++;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    FILE_RE.lastIndex = 0; // 带 lastIndex 的正则复用前必须归零
    let m;
    while ((m = FILE_RE.exec(line)) !== null) referenced.add(m[1]);
  }
}

const missing = [];
const targets = [];
for (const rel of [...referenced].sort()) {
  const abs = path.join(ROOT, rel);
  if (!rel.endsWith('.mjs') && !rel.endsWith('.js')) continue; // 非 JS 不扫
  if (!fs.existsSync(abs)) { missing.push(rel); continue; }
  targets.push(rel);
}

if (targets.length === 0) {
  write('\n✗ 一个要扫的脚本都没抓到 —— 多半是正则没匹配上，这道闸白跑了\n\n');
  process.exit(1);
}
write(`  ✓ 扫了 ${scannedWorkflows} 个 workflow，CI 直跑的脚本 ${targets.length} 个\n`);
if (missing.length) {
  write(`  · 另有 ${missing.length} 个被引用但磁盘上不存在（由第 18 步 lint-ci-refs 判，这里不重复）\n`);
}

// ---- B. 金丝雀：先证明这套判据自己还活着 ----------------------------------
// 为什么必须有：今天仓库里一处违规都没有。真要是正则改坏了，
// 它会**安静地一直绿** —— 没有任何东西会响。所以每次开跑先自检。
write('\n【B】金丝雀自检（先证明这套判据自己还活着）\n');

// MUST_HIT / MUST_MISS 从 ./fixtures/ci-paths-samples.mjs 来（见文件顶部那条 import 的注释）

for (const s of MUST_HIT) {
  HOME_PATH_RE.lastIndex = 0;
  if (!HOME_PATH_RE.test(s)) fail(`判据该命中却没命中：「${s}」—— 扫描器坏了，下面的结论全是假的`);
}
for (const s of MUST_MISS) {
  HOME_PATH_RE.lastIndex = 0;
  if (HOME_PATH_RE.test(s)) fail(`判据不该命中却命中了：「${s}」—— 会把合法写法逼成绕过`);
}

// 去注释也得自检：注释里写的路径不算数（SKILL 第 111 条）
{
  const blanked = blankComments(COMMENT_SAMPLE);
  const lines = blanked.split('\n');
  if (lines[0].trim() !== '') fail(`抹注释没生效：注释那行还留着「${lines[0].trim()}」`);
  // ★ 这条路径字面量来自 fixtures/（WIN_HOME），不写在本文件里 ——
  //   本文件自己也在「CI 直跑的 49 个脚本」里，写在这里会被自己点着。
  if (!lines[1].includes(WIN_HOME)) fail('抹注释抹过头了：代码里那条真路径也被涂掉了');
}
if (failures === 0) {
  write(`  ✓ 该命中的 ${MUST_HIT.length} 条全中、不该命中的 ${MUST_MISS.length} 条全避、注释与代码分得开\n`);
}

// ---- C. 逐个脚本扫 --------------------------------------------------------
write('\n【C】CI 直跑的脚本里有没有写死的用户主目录\n');

const hits = [];
for (const rel of targets) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const blanked = blankComments(src); // ← 先抹注释：注释里复盘旧路径不算违规
  const lines = blanked.split('\n');
  lines.forEach((line, idx) => {
    HOME_PATH_RE.lastIndex = 0;
    if (!HOME_PATH_RE.test(line)) return;
    hits.push({ rel, line: idx + 1, code: line.trim().slice(0, 120) });
  });
}

if (hits.length === 0) {
  write(`  ✓ 一个都没有\n`);
} else {
  for (const h of hits) fail(`${h.rel}:${h.line}  ${h.code}`);
}

// ---- 结论 ----------------------------------------------------------------
if (failures > 0) {
  write(`\n  ✗ ${failures} 处要处理：\n\n`);
  write('    这些脚本 CI 上会真跑。写死某台机器的主目录，换台机器 / 换 runner 就必红，\n');
  write('    而且报错往往只是 ENOENT —— 看不出「其实是路径写死了」。\n');
  write('    该这么做：\n');
  write('      · 找浏览器 → tools/lib/find-chrome.mjs（候选清单，本机与 CI 都覆盖）\n');
  write('      · 找产物   → tools/lib/find-dist.mjs\n');
  write('      · 找临时目录 → os.tmpdir()，别写字面量\n');
  write("      · 找仓库根   → 由脚本自己的位置推（import.meta.url 往上），别写 '.'\n");
  write('      · 要指向自己的家目录 → os.homedir() / process.env.HOME（不是字面量，不算违规）\n\n');
  process.exit(1);
}

write(
  `\n[ci-paths] PASS — CI 会跑的 ${targets.length} 个脚本里没有一处写死用户主目录`
  + `（金丝雀：内置 ${MUST_HIT.length + MUST_MISS.length} 条样例 + 注释/代码区分自检）\n`
);
