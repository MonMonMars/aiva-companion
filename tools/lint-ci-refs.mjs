// 盯 CI 配置文件本身的健康度 —— 具体两件事：
//
//   A. workflow 里引用的每个仓库文件，磁盘上必须真的存在
//   B. CI test job 跑的每一步，本地套装 tools/runtests.mjs 里必须也有
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

// ---------- B. CI 的每一步，本地套装里都要有 ----------
console.log('\n【B】CI test job 的步骤是否也在本地套装里');

const RUNTESTS = path.join(ROOT, 'tools', 'runtests.mjs');
const localSteps = new Set();
if (!fs.existsSync(RUNTESTS)) {
  fail(`找不到 ${RUNTESTS}，无法对照`);
} else {
  const src = fs.readFileSync(RUNTESTS, 'utf8');
  const STEP_RE = /\['([^']+)',\s*\[/g;
  let m;
  while ((m = STEP_RE.exec(src)) !== null) localSteps.add(m[1]);
  ok(`本地套装有 ${localSteps.size} 步`);

  const RUN_RE = /run\s+"([^"]+)"\s+node\s/g;
  const ciSteps = new Set();
  for (const yml of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WF_DIR, yml), 'utf8');
    RUN_RE.lastIndex = 0;
    let mm;
    while ((mm = RUN_RE.exec(text)) !== null) ciSteps.add(`${yml}|${mm[1]}`);
  }
  for (const key of ciSteps) {
    const [yml, name] = key.split('|');
    if (!localSteps.has(name)) {
      fail(`${yml} 里的步骤「${name}」在本地套装里没有 —— 本地绿 ≠ CI 绿`);
    }
  }
  if (ciSteps.size) ok(`CI 共 ${ciSteps.size} 步，全部能在本地找到`);

  const ciNames = new Set([...ciSteps].map((k) => k.split('|')[1]));
  const localOnly = [...localSteps].filter((n) => !ciNames.has(n));
  if (localOnly.length) {
    console.log(`  ℹ️ 只在本机跑的步骤（正常，但要有理由）：${localOnly.join(' / ')}`);
  }
}

console.log('');
if (failures) {
  console.log(`❌ ${failures} 项不合格`);
  process.exit(1);
}
console.log('✅ CI 配置引用与步骤对照全部通过');
