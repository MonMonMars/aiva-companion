// 盯 CI 配置文件本身的健康度 —— 具体四件事：
//
//   A. workflow 里引用的每个仓库文件，磁盘上必须真的存在
//   B. CI test job 跑的每一步，本地套装 tools/runtests.mjs 里必须也有
//   C. 同名步骤的命令行必须一致（不只是名字对上）
//   D. CI 上必须真的跑一次「登记核对」（第 28 步那道闸），详见文末【D】
//
// 存在的理由是一次真事故（CI #29）：把两套 loader 合并之后，
// 本地 17 步全绿、 build / deploy 也绿，只有 test job 失败 ——
// 因为 `.github/workflows/deploy-pages.yml` 里那三行
// `node --import ./tools/ext-resolve.mjs ...` 指向的是**已经被删掉**的文件。
//
// 为什么当时没发现：ripgrep 默认**跳过隐藏目录**，所以"grep 全仓库引用"
// 压根没扫到 `.github/` —— 这类搜索静默少扫了一整类关键文件，
// 而且**不报任何错**。
//
// 配套的第二层：CI 跑的是 workflow 里的命令清单，本地跑的是 runtests.mjs 里的清单，
// 这两份清单**原本没有任何一步在对照**。所以这里连步骤名一起对，
// 让任何一边新增/改名都会被指出来。（本地独有的步骤是允许的 ——
// 比如依赖本机 Chrome 的 smoke-runtime，只列出来不报错。）
//
// 用法：node tools/lint-ci-refs.mjs [项目根目录]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
// ★ 显式写死 .github —— 不能靠默认 glob，默认会跳过隐藏目录。见上面那段事故。
const WF_DIR = path.join(ROOT, '.github', 'workflows');

if (!fs.existsSync(WF_DIR)) {
  console.error(`✗ 找不到 ${WF_DIR}：CI 目录不存在，这一步检查等于没跑`);
  process.exit(1);
}

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗', msg); };
const ok = (msg) => console.log('  ✓', msg);

// ---------- A. workflow 引用的文件必须存在 ----------
console.log('【A】workflow 引用的仓库文件是否存在');

const FILE_RE = /(?:^|\s)(?:\.\/)?((?:tools|scripts)\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g;
const seenPaths = new Set();
let scanned = 0;

for (const yml of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const text = fs.readFileSync(path.join(WF_DIR, yml), 'utf8');
  scanned++;
  for (const line of text.split('\n')) {
    // ★ 跳过注释行。注释里提到的路径不是「会被执行的引用」——
    //   首次运行就误报过：我在 workflow 里写注释复盘「那三行
    //   `node --import ./tools/ext-resolve.mjs` 忘了改」，结果这个 ext-resolve.mjs
    //   已经被删掉了，检查就把它当成一条坏引用报了出来。
    //   （也别因此以为注释不影响：真正的执行写在 `run:` 里，那才是要卡的。）
    if (/^\s*#/.test(line)) continue;
    FILE_RE.lastIndex = 0; // 正则带 lastIndex，复用前必须归零
    let m;
    while ((m = FILE_RE.exec(line)) !== null) {
      const rel = m[1];
      if (seenPaths.has(`${yml}|${rel}`)) continue;
      seenPaths.add(`${yml}|${rel}`);
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) {
        fail(`${yml} 引用了不存在的文件 ${rel}`);
        // 顺手猜一下是不是被替换掉了，给个建议
        const base = path.basename(rel).replace(/\.[^.]+$/, '');
        const dir = path.dirname(path.join(ROOT, rel));
        let hint = '';
        try {
          const near = fs.readdirSync(dir)
            .filter((f) => f.includes(base.slice(0, 4)) || base.includes(f.slice(0, 4)));
          if (near.length) hint = `；同目录里有 ${near.slice(0, 4).join(' / ')}，是不是换成它了？`;
        } catch { /* 目录本身不存在就不用猜了 */ }
        if (hint) console.log('      ', hint.trim());
      }
    }
  }
}
if (seenPaths.size === 0) {
  fail('一个文件引用都没扫到 —— 多半是正则没匹配上，检查白跑了');
} else {
  ok(`扫了 ${scanned} 个 workflow，校验 ${seenPaths.size} 个文件引用`);
}

// ---------- B + C. 两边清单逐条对照 ----------
console.log('\n【B】CI 的每一步，本地套装里都要有');
console.log('【C】同名步骤的**命令行**必须一致（不是名字对上就算）');
console.log('    C 是后来补的：A 和 B 都只比对名字，而 CI #29 的本质是**命令漂移**');
console.log('    —— 文件名存在、步骤名也在，可两边跑的根本不是同一条命令。');

const RUNTESTS = path.join(ROOT, 'tools', 'runtests.mjs');
// 本地允许比 CI 多带的参数（逐个列出来，理由写在后面）：
//   --keep  第 16 步要把产物留给第 17 步烟雾测试用；CI 上没有第 17 步，自然不带
const LOCAL_ONLY_TOKENS = new Set(['--keep']);

const localCmds = new Map(); // name -> tokens[]
const ciCmds = new Map();    // name -> { yml, tokens[] }

if (!fs.existsSync(RUNTESTS)) {
  fail(`找不到 ${RUNTESTS}，无法对照`);
} else {
  const src = fs.readFileSync(RUNTESTS, 'utf8');
  // 本地每一项写成两种之一：
  //   旧：STEPS.push(['name', ['arg1', 'arg2']])
  //   新：REG.push('name', ['arg1', 'arg2'], { ...登记... })
  // ★ 两种都得认。2026-09-26 把全部步骤改成 REG.push 的登记写法之后，
  //   这里只认旧写法的话会**一条都扫不到** —— 而「扫到 0 条」在这一步里的表现
  //   是 B/C 两项整层静默跳过（只剩 A 项在跑），正是第 22 步在盯的那种假绿。
  //   两个分支都写死在一条正则里，改名 / 换写法时两边一起改。
  const STEP_RE = /\['([^']+)',\s*\[([^\]]*)\]\]|REG\.push\('([^']+)',\s*\[([^\]]*)\]/g;
  let m;
  while ((m = STEP_RE.exec(src)) !== null) {
    const toks = (m[2] !== undefined ? m[2] : m[4])
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    localCmds.set(m[1] !== undefined ? m[1] : m[3], toks);
  }
  ok(`本地套装有 ${localCmds.size} 步`);

  // CI 每一行长这样：run "<名字>" node <脚本> [参数...]
  const RUN_RE = /run\s+"([^"]+)"\s+node\s+(.+?)\s*$/gm;
  for (const yml of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WF_DIR, yml), 'utf8');
    // ★ 跟上面 A 项一样要跳过注释行，理由同出一辙：注释里写「用法：
    //   run "名字" node ...」这种**说明文字**会被当成真步骤扫进来。
    //   2026-09-25 真发生过一次：我在 deploy job 的注释里解释「为什么这条
    //   不写成 run "名字" node ... 的形式」，那句解释自己被扫成一个名叫
    //   「名字」的步骤，这一步当场变红 —— 而它根本不存在于任何 job 里。
    //   真正的执行永远写在 `run:` 里，注释不可能是要跑的步骤。
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      RUN_RE.lastIndex = 0;
      const mm = RUN_RE.exec(line);
      if (mm) ciCmds.set(mm[1], { yml, toks: mm[2].trim().split(/\s+/).filter(Boolean) });
    }
  }

  // ⚠️ B/C 是「扫到什么就对什么」，一旦扫到 0 条就会**静默全绿** ——
  //    哪天 RUN_RE 写坏了（或 workflow 改了写法），这一整层检查就成了摆设
  //    而且不报任何错。所以「本地有步骤、CI 一条都没扫到」必须当失败。
  if (localCmds.size > 0 && ciCmds.size === 0) {
    fail(`一个 CI 步骤都没扫到，本地套装里却有 ${localCmds.size} 步 —— 多半是 RUN_RE 没匹配上，B/C 项等于没跑`);
  }

  let missing = 0;
  for (const [name, ci] of ciCmds) {
    if (!localCmds.has(name)) {
      fail(`${ci.yml} 里的步骤「${name}」在本地套装里没有 —— 本地绿 ≠ CI 绿`);
      missing++;
    }
  }
  // 只在**真的一个都没缺**时才说这句。早先它跟上面的 ✗ 并排打印，
  //    出现过「✗ 步骤 X 在本地没有」下面紧接「✓ 全部能在本地找到」的假绿。
  if (ciCmds.size && !missing) ok(`CI 共 ${ciCmds.size} 步，全部能在本地找到`);

  const before = failures;
  for (const [name, ci] of ciCmds) {
    const loc = localCmds.get(name);
    if (!loc) continue;
    const extraLocal = loc.filter((t) => !ci.toks.includes(t));
    const extraCi = ci.toks.filter((t) => !loc.includes(t));
    if (extraCi.length || extraLocal.some((t) => !LOCAL_ONLY_TOKENS.has(t))) {
      fail(`${ci.yml} 的步骤「${name}」两边命令不一致 —— 同一个名字跑的不是同一条命令`);
      console.log(`        本地: node ${loc.join(' ')}`);
      console.log(`        CI  : node ${ci.toks.join(' ')}`);
    }
  }
  // 同理，扫到 0 条时不许报「完全一致」—— 那是没比过，不是比过了。
  if (failures === before && ciCmds.size) ok('每一步的命令行两边完全一致');

  const localOnly = [...localCmds.keys()].filter((n) => !ciCmds.has(n));
  if (localOnly.length) {
    console.log(`  ℹ️ 只在本机跑的步骤（正常，但要有理由）：${localOnly.join(' / ')}`);
  }
}

// ---------- D. CI 上必须真的执行「登记核对」 ----------
// 2026-09-26 查出来的缺口：CI 是自己在 bash 里逐步跑的（`run "名字" node ...`），
// **从来没调用过 tools/runtests.mjs** —— 于是它开头那句「漏登记就整套拒绝开跑」
// 在 CI 上一遍都没执行过。上面补了一行 `node tools/runtests.mjs . --check-registry`，
// 而这一项盯的就是**那一行还在不在**：不然它跟别的「下次记得」一样，会被无声删掉。
//
// ⚠️ 诚实说明这一项能盯到什么程度：它只认「命令行里出现了这段」。
//    如果有人把它包进 `echo "node tools/runtests.mjs . --check-registry"`，
//    这一项照样绿 —— 它防的是**整行被删/被改坏**，不防「写了却不执行」。
//    再往上就该是牙齿的牙齿了，到此为止。
console.log('\n【D】CI 上必须真的跑一次登记核对（第 28 步那道闸）');

const REG_RE = /tools\/runtests\.mjs[^\n]*--check-registry/;
let regHits = 0;
for (const yml of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const text = fs.readFileSync(path.join(WF_DIR, yml), 'utf8');
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue; // 同 A/B/C：注释里的说明不算执行
    if (REG_RE.test(line)) {
      regHits++;
      console.log(`  ✓ ${yml} 里有一行在跑登记核对：${line.trim()}`);
    }
  }
}
if (regHits === 0) {
  // ★ fail-closed：扫不到就当不合格。这条若写成「扫到才算」反倒会在正则坏掉时静默全绿。
  fail('CI 上没有任何一行在跑 `tools/runtests.mjs --check-registry` —— '
    + '「漏登记就拒绝开跑」那道闸在 CI 上是哑的，没写牙齿的步骤照样能加进来');
}

console.log('');
if (failures) {
  console.log(`❌ ${failures} 项不合格`);
  process.exit(1);
}
console.log('✅ CI 配置引用与步骤对照全部通过');
