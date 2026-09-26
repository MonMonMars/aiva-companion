// 第 30 步：盯「每个断言函数都装了参数守卫」。
// ---------------------------------------------------------------------------
// 起因（2026-09-26，一次真事故）：
//   tools/test-with-timeout.mjs 里的断言函数签名是 `ok(label, cond, detail)`，
//   跟别处 `ck(cond, label, extra)` 的写法**相反**。某处按后者调用，
//   输出里就出现一行 **「✓ false」** —— 一条永远绿的断言，
//   而且它连自己是假的都写在脸上（没人发现，因为它绿着）。
//   写反的后果不是报错：条件位拿到的是非空字符串，永真。
//
//   事故发生后我给当时手写的几个断言函数补了 needBool/needLabel
//   （抽到 tools/assert-args.mjs 里共用）。但**「谁来提醒下一个断言函数
//   也该装守卫」没有答案** —— 那又是「下次记得」。这一步把它变成机器的事：
//   新写的断言函数没装守卫，整套测试不给过。
//
// 认什么：不按文件名认，按**形状**认。
//   按 `*.test.mjs` / `test-*` 这类文件名划范围会漏掉将来换个名字写的验证脚本，
//   又会误伤仓库里那一百多个一次性探针。所以这里看函数体本身。
//
//   ★ 「断言助手」的严格定义（三条全中才算）：
//     1. 有个参数被**直接**当真假用 —— `if (c)` / `if (!c)` / `c ? …`
//        ⚠️ 必须是裸的真假判断，不是 `if (x === 'foo')` 这类比较式。
//        这一条是区分货真价实的断言助手和别的东西的关键：
//           tools/cdp-motion.mjs      的 onEvent(method, p)（CDP 事件记录器）
//           tools/glbvalidate.mjs     的 chk(where, idx, arr)（索引越界检查，idx 是数字）
//           tools/step-registry.mjs   的 verifyRegistry(steps, decl, root)（纯函数）
//        三者形状看着都像，但它们的参数**从来不被直接当真假用**，
//        放宽成「出现在 if 里就算」的话这三个全会被误判，规则就不敢下重手了。
//     2. 会报告结果 —— 打通过/失败标记（✓ ✗ ❌ ✅ …），或者往「问题数组」里 push
//     3. 会记账 —— 累加计数器 / push / 设 process.exitCode
//
//   ⚠️ 「报告」这条必须覆盖三种实际存在的写法，只看 ✓/✗ 会漏掉后两种：
//     A 型：`ok(cond,label)` 里直接 `if (cond) { pass++; console.log('✓'…) }`
//     B 型：助手只收集 —— `const ok = (c,m) => { if (!c) problems.push(m); }`
//           （tools/verify-compare-page.mjs；✓/✗ 在别的行打）
//     C 型：用 emoji ❌/✅ 而不是 ✓/✗（tools/verify-kizuna.mjs、web-check-glb.mjs）
//
// 装什么：必填参数逐个查
//   · 每个「裸条件位」参数 → 必须 needBool(它)，按名字认，不许守卫到别的参数上
//   · 其余必填参数里至少有一个 → 必须 needLabel(它)
//   认的是**参数在函数里的用法**，不是位置也不是参数名 —— 位置恰恰是那次事故的根源。
//
// ⚠️ 自带的两个陷阱堵头：
//   1. 金丝雀：万一扫描器退化成「一个都找不到」，它会输出「0 个助手、0 个问题」
//      从而静默全绿 —— 这个仓库已经四次栽在这个形状上。所以下面要求三种
//      形状的三个代表文件必须各自至少找出 1 个助手，找不到按失败处理。
//   2. 注释屏蔽：注释里举例写的 `ok(label, cond, detail)` 会被当成真函数
//      （我写本文件的头注释时就立刻中了一次），所以先把注释行抹平再扫。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根目录：命令行给了就用给的（第 31 步的牙齿测试要在沙盒副本上跑它），
//   没给就从脚本自己的位置往上推一级 —— ⚠️ 不能默认 '.'，后台任务里 cd 不可用，
//   '.' 解析出来的 CWD 是工作区根，整套会去错误的目录里扫（SKILL 第 74 条）。
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ROOT = path.resolve(rootArg || path.join(HERE, '..'));

// 不扫的地方：依赖、打包产物、`_` 打头的一次性脚本（开发过程产物，不进仓库）
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'tmp', 'preview-site', '.expo', 'web-build',
  'ios', 'android', '.workbuddy', 'preview', 'shots', '.synchk', 'archive',
]);
const SKIP_DIR_PART = ['dist', 'tools/.chrome-profile'];

function walk(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name) || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      if (SKIP_DIR_PART.some((p) => rel.includes(p))) continue;
      walk(abs, acc);
    } else if (e.isFile()) {
      if (!/\.(mjs|js)$/.test(e.name)) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.tmp-')) continue;
      acc.push(rel);
    }
  }
  return acc;
}

// ── 形状识别 ──────────────────────────────────────────────────────────────
// 通过/失败标记。⚠️ 刻意不带 ⚠/❗：那些在普通提示行里也大量出现，
//   带上会把一堆「打印一行警告」的普通函数误认成断言助手。
const MARKS = /[✓✗✔✘❌✅⛔🚫]/;
// 往「问题数组」里丢东西 —— B 型助手唯一的特征
const PUSH_BAD = /\b(?:problems|errs|errors|failures|fails|bad|issues|violations)\.push\s*\(/;

const DEF_RE = [
  /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g,
  /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b[^({]*)?\(([^)]*)\)\s*=>\s*\{/g,
  /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)\s*\{/g,
  /let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)\s*\{/g,
];

// 注释行的示例伪代码会伪装成真函数（我自己被它骗出来一次），抹平了再扫。
// 抹平而不是删掉：**保持长度不变**，行号才准。
function maskComments(src) {
  return src.split('\n').map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? ' '.repeat(l.length) : l)).join('\n');
}

function bodyAt(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return '';
}

const word = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 「裸真假判断」：参数自己直接站在条件位上，不是某个比较式的一部分
function isBareCondition(param, body) {
  const p = word(param);
  return new RegExp(`if\\s*\\(\\s*!?\\s*${p}\\s*[)&|?]`).test(body)
    || new RegExp(`\\bif\\s*\\(\\s*!?\\s*${p}\\s*\\)`).test(body)
    || new RegExp(`\\b${p}\\s*\\?`).test(body)
    || new RegExp(`!\\s*${p}\\s*\\?`).test(body);
}

function collect(rawSrc) {
  const src = maskComments(rawSrc);
  const helpers = [];
  for (const re of DEF_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const [, name, rawParams] = m;
      const body = bodyAt(src, m.index + m[0].length - 1);
      if (!body) continue;
      // ②报告 ③记账
      if (!(MARKS.test(body) || PUSH_BAD.test(body))) continue;
      if (!(/\w+\s*\+\+/.test(body) || PUSH_BAD.test(body) || /exitCode\s*=/.test(body))) continue;

      // 解构 / 剩余参数认不了 —— 不替它下结论，也不判它失败（不是断言助手的概率很高）
      if (/[{}[\]]|\.\.\./.test(rawParams)) continue;

      const line = src.slice(0, m.index).split('\n').length;
      const params = rawParams.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => {
          const i = s.indexOf('=');
          return i < 0 ? { name: s, optional: false } : { name: s.slice(0, i).trim(), optional: true };
        });
      // ①裸条件位。
      //   ⚠️ 只认**必填**参数：`extra` / `detail` / `x` 这类带默认值的第三个参数
      //      在函数里也常写成三元式（`detail ? '→ ' + detail : ''`），那是**格式化**，
      //      不是判据。放宽进去会让几乎每个断言助手多报一条假错。
      //      判据参数不可能有默认值 —— 它是这个函数的命根子。
      const conds = params.filter((p) => !p.optional && isBareCondition(p.name, body)).map((p) => p.name);
      if (conds.length === 0) continue;

      const problems = [];
      for (const c of conds) {
        if (!new RegExp(`needBool\\s*\\(\\s*${word(c)}\\b`).test(body)) {
          problems.push(`参数「${c}」在函数里被直接当真假用，缺 needBool(${c})`);
        }
      }
      const others = params.filter((p) => !conds.includes(p.name) && !p.optional).map((p) => p.name);
      if (others.length && !others.some((o) => new RegExp(`needLabel\\s*\\(\\s*${word(o)}\\b`).test(body))) {
        problems.push(`标签/消息参数（${others.join(' / ')}）没有一个被 needLabel 守着`);
      }
      helpers.push({ name, line, params, guarded: problems.length === 0, problems });
    }
  }
  return helpers;
}

// ── 开跑 ──────────────────────────────────────────────────────────────────
const files = walk(ROOT).sort();
const bad = [];
let nFiles = 0;
let nHelpers = 0;

for (const f of files) {
  const src = maskComments(fs.readFileSync(path.join(ROOT, f), 'utf8')); // ⚠️ 注释遮蔽：
  //   `needBool(cond, 'ok()')` 同样会被下面的正则当成真的在调用 —— 这一整份文件里
  //   已经三次栽在「注释里的示例代码」上了。

  // 「用了守卫却没 import」—— 漏了它本检查会打出「守卫都在」，而那些脚本一跑就
  //   ReferenceError: needBool is not defined。看起来不可能发生（needBool 明明在用），
  //   但**清理 import 清单**正是它的死法；这道检查不该给出它兑现不了的承诺。
  //   ⚠️ 定义守卫的那份文件（tools/assert-args.mjs）自己不用 import，排除掉。
  const declaresThem = /export\s+(?:function|const)\s+need(?:Bool|Label)/.test(src);
  const usesGuard = /\bneed(?:Bool|Label)\s*\(/.test(src);
  if (!declaresThem && usesGuard && !/from\s+['"][^'"]*assert-args\.mjs['"]/.test(src)) {
    bad.push({ f, imports: true, helpers: [] });
    continue;
  }

  const helpers = collect(src);
  if (!helpers.length) continue;
  nFiles += 1;
  nHelpers += helpers.length;
  if (helpers.every((h) => h.guarded)) continue;
  bad.push({ f, helpers: helpers.filter((h) => !h.guarded), missingImport: false });
}

process.stdout.write(`\n[assert-guards] 扫了 ${files.length} 个脚本，其中 ${nFiles} 个定义了断言函数（共 ${nHelpers} 个）\n`);

if (bad.length) {
  process.stdout.write(`\n  ✗ ${bad.length} 个文件的断言函数没装全守卫：\n\n`);
  for (const b of bad) {
    process.stdout.write(`    ${b.f}\n`);
    if (b.imports) {
      process.stdout.write('        用了 needBool/needLabel 却没有 import —— 这些脚本一跑就是\n');
      process.stdout.write("        ReferenceError: needBool is not defined，而本检查会误报「守卫都在」\n");
      continue;
    }
    for (const h of b.helpers) for (const p of h.problems) {
      process.stdout.write(`        @${h.line} ${h.name}() —— ${p}\n`);
    }
    if (b.missingImport) {
      process.stdout.write(`        缺 import { needBool, needLabel } from './assert-args.mjs'\n`);
    }
  }
  process.stdout.write('\n  守卫的意义：断言函数的参数顺序一旦写反，**条件位拿到非空字符串就是永真**，\n');
  process.stdout.write('  于是那条断言永远绿。它不会报错，只会假装通过 —— tools/test-with-timeout.mjs 出过一次。\n\n');
  process.exit(1);
}

// 陷阱堵头 1：三种形状的金丝雀必须各自被认出来，认不出来说明上面的规则改坏了
const CANARY = [
  'tools/test-with-timeout.mjs',   // A 型（✓/✗ + 计数），也是当年出事的那一个
  'tools/verify-kizuna.mjs',       // C 型（❌/✅）
  'tools/verify-compare-page.mjs', // B 型（助手里只有 push，标记在别处打）
];
const missing = CANARY.filter((f) => {
  if (!fs.existsSync(path.join(ROOT, f))) return true;
  return collect(fs.readFileSync(path.join(ROOT, f), 'utf8')).length === 0;
});
if (missing.length) {
  process.stdout.write(`\n  ✗ 金丝雀失联：${missing.join(' / ')}\n`);
  process.stdout.write('    这几种形状本来应该被认出来却没认出来 —— 多半是上面的识别规则被改坏了。\n');
  process.stdout.write('    认不出来会让这条检查静默全绿，比直接报错更坏，所以按失败处理。\n\n');
  process.exit(1);
}

process.stdout.write(`[assert-guards] PASS — ${nHelpers} 个断言函数都装了守卫`
  + `（A/B/C 三种形状各有一路金丝雀盯着「认得出来」这件事）\n`);
