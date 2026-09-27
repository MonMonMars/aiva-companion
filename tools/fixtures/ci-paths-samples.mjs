// 第 42 步（lint-ci-paths）的金丝雀样例 —— 纯数据。
// ---------------------------------------------------------------------------
// ⚠️ 为什么非要单独放在 fixtures/ 下（改动前请先读这段）：
//    第 25 步 lint-platform-cmds 的判据之一是「硬编码的 Windows 盘符路径字面量」，
//    它认 `['"`][A-Za-z]:\\` 这个形状（**反斜杠形态**），出现即红、没有豁免通道。
//    而下面 MUST_HIT 里那条 `C:\Users\...` 是**测试数据**，不是要被执行的代码。
//
//    这就是 SKILL 第 111 条那个坑又来一次：扫源码文本的 lint 分不清
//    「代码」和「被写出去的数据」。修法按那条办 —— **把夹具挪出扫描范围**，
//    而不是去开行内豁免注释的口子（开了口子，真违规也能挂个注释混过去）。
//
//    lint-platform-cmds 自己的 walk() 里就写着 SKIP_DIR_NAMES 含 'fixtures'，
//    也就是说这个目录本来就是它留给「测试数据」的位置 —— 不是我们硬绕出来的。
//
//    （顺带一提：`C:/Users/...` 那种**正斜杠**形态它是不认的 ——
//     所以 tools/lib/find-chrome.mjs 里那条候选路径不会被它点着。
//     判据只覆盖反斜杠形态，这是那道闸自己的已知边界，不是这里要补的。）
// ---------------------------------------------------------------------------

/** 这些**必须**被判据命中 —— 少中一条就说明扫描器坏了 */
export const MUST_HIT = [
  'C:/Users/Simon Lai/x/y',
  'C:\\Users\\Simon Lai\\x\\y',
  '/home/runner/work/x',
  '/Users/someone/x',
  '/root/.cache/x',
];

/** 这些**必须不被**判据命中 —— 中一条就说明它会把合法写法逼成绕过 */
export const MUST_MISS = [
  '/usr/bin/google-chrome',
  '/tmp/x',
  'tools/x.mjs',
  './tools/x.mjs',
];

// ---- 下面这几个是给第 42 步自检、第 43 步变异注入用的「真要写进去的字符串」 ----
// 为什么也得住在这里：第 42、43 步登记进 CI 之后，它们俩**自己**也进了
// 「CI 直跑的脚本」那 49 个里。于是它们体内任何长得像主目录的字面量都会被
// 自己点着 —— 第 111 条这次套到了自己头上。判据认不出「这是夹具」，
// 所以还是同一个修法：把夹具挪出扫描范围。

/** Windows 主目录形状（正斜杠）—— ① 注入用、去注释自检用 */
export const WIN_HOME = 'C:/Users/Simon Lai/somewhere';
/** POSIX 主目录形状 —— ③ 注入用 */
export const POSIX_HOME = '/home/runner/work/x/y';
/** 去注释自检的源码片段：第 1 行是注释、第 2 行是代码，两条同一个路径 */
export const COMMENT_SAMPLE = `// 注释里提到 ${WIN_HOME} 只是说明\nconst X = '${WIN_HOME}';\n`;
/** 对照组⑥：合法写法（不是字面量 / 跨平台公认位置） */
export const LEGIT_SAMPLE =
  "import os from 'node:os';\nconst HOME = os.homedir();\n"
  + "const CHROME = '/usr/bin/google-chrome';\nconst TMP = '/tmp/x';\n"
  + 'export { HOME, CHROME, TMP };\n';
