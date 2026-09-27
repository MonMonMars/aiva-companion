// 第 43 步：给第 42 步（lint-ci-paths）配牙齿。
// ---------------------------------------------------------------------------
// 老规矩：一个检查值得存在，当且仅当**能造出「旧检查通过、新检查失败」的场景**。
//
// ⚠️ 这一轮和以往有个本质区别，值得单独说：
//     第 42 步在真仓库上是**绿的**（47 个 CI 脚本，一处违规都没有）。
//     也就是说它今天抓不到任何东西 —— 它是防未来的闸。
//     这种闸最危险的失效方式是**静默失效**：判据改坏了，
//     它照样每轮都绿，而且**没有任何东西会响**（仓库里本来就没违规可抓）。
//     所以本轮的场景表里有一条专门打这儿（③ 扫描器退化 → 必须红），
//     靠的是第 42 步内置的金丝雀自检。
//
// 场景表：
//   ⓐ 原样（对照）                        → 绿（基线）
//   ① 代码里写死 C:/Users/…                → 红（判据本体）
//   ② 同一条路径只写在注释里（对照）        → 绿（抹注释必须生效，SKILL 第 111 条）
//   ③ POSIX 形状 /home/runner/…           → 红（判据不能只认 Windows 一种写法）
//   ④ 扫描器退化：正则永不匹配             → 红（金丝雀失联 —— 本轮最关键的一条）
//   ⑤ workflow 里 tools/ 引用全没了        → 红（一个都没抓到 = 白跑了，必须响）
//   ⑥ 合法写法（os.homedir / /usr/bin / /tmp）→ 绿（不许把正确写法逼成绕过）
//
// ⚠️ ②⑥ 两个对照组为什么必须有：
//    判的是「写死的用户主目录字面量」，而注释里复盘旧路径、
//    `/usr/bin/google-chrome`、`os.homedir()` 都是**合法写法**。
//    少了它们，一个「见到绝对路径就红」的无脑检查也能全绿通过。
//
// 沙盒：只放闸门真正会读的那几件（详见 buildSandbox 里那段注释）。
//   ⚠️ 这里原本是把整个 tools/（9.8MB / 219 个文件）搬进去的，理由是三个：
//      ① 省得在测试里再写一份「workflow 提取」判据（那就会变成第三份清单）；
//      ② 让第 42 步扫到**真实内容**，去注释那步在真代码上跑过才算数；
//      ③ 验它**不会**去扫没被 CI 点名的 lib。
//      结果第 34 步实测到「沙盒清理超时」—— 整套 43 步红在这一步。
//      现在只留 ①（靠真 workflow 保证），②③ 交还给第 42 步自己：
//      它每轮都在真仓库上真扫那 49 个脚本，真内容把它跑崩了当场就红。
//      牙齿脚本只负责一件事 —— 证明判据会对变异做出反应。
//
// 用法：node tools/test-lint-ci-paths-teeth.mjs [项目根]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runStep, rmTreeBounded, rmTreeSyncBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';
// ★ 注入用的路径字面量全部来自 fixtures/，不写在本文件里 ——
//   本文件登记进 CI 之后，它自己也在「CI 直跑的 49 个脚本」里，
//   写在这里会被**第 42 步自己**点着（判据认不出「这是夹具」，SKILL 第 111 条）。
import { WIN_HOME, POSIX_HOME, LEGIT_SAMPLE } from './fixtures/ci-paths-samples.mjs';

const ROOT = path.resolve(process.argv[2] || '.');
const SB = path.join(ROOT, '_teeth_sb_42');
const GATE = 'tools/lint-ci-paths.mjs';
const DEP = 'tools/lib/strip-comments.mjs'; // 闸门 import 它，沙盒里必须有
const FIXTURES = 'tools/fixtures/ci-paths-samples.mjs'; // 样例数据，闸门与本脚本都 import 它
const TARGET = 'tools/test-with-timeout.mjs'; // CI 点名会跑（workflow: run "withTimeout"）

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

function buildSandbox() {
  rmTreeSyncBounded(SB);
  fs.mkdirSync(SB, { recursive: true });
  // ★ 只搬**闸门真正会读的那几件**，其余一概不放：
  //     GATE + 它 import 的两个模块（lib/strip-comments.mjs、fixtures/ 样例）
  //     + 真实 workflow（第 42 步的清单从这里抓，不能自己造）+ TARGET 的真身。
  //
  //   ⚠️ 早先这里是把整个 tools/（**9.8MB / 219 个文件**）搬过去，7 个场景就是
  //      复制 + 删除各 7 遍。第 34 步实测到 `沙盒已删除（清理超时，进程已杀）`
  //      —— 整套 43 步就红在这一步。沙盒大小和稳定性是直接冲突的。
  //
  //   那「让闸门扫到全部真实内容」这诉求谁来保证？→ **第 42 步自己**。
  //      它每轮都在真仓库上真的扫那 49 个 CI 脚本；真内容要是把它跑崩了，
  //      它当场就红，轮不到牙齿脚本替它操心。
  //      牙齿脚本的职责只有一条：**证明判据会对变异做出反应**。
  //
  //   其余被 workflow 点名、但沙盒里没放的那些脚本：第 42 步按「引用了但磁盘上
  //   不存在」跳过（那种情况由第 18 步 lint-ci-refs 的【A】管），不会误判。
  for (const f of [GATE, DEP, FIXTURES, TARGET]) {
    const dst = path.join(SB, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), dst);
  }
  const wfSrc = path.join(ROOT, '.github', 'workflows');
  const wfDst = path.join(SB, '.github', 'workflows');
  fs.mkdirSync(wfDst, { recursive: true });
  for (const yml of fs.readdirSync(wfSrc).filter((f) => /\.ya?ml$/.test(f))) {
    fs.copyFileSync(path.join(wfSrc, yml), path.join(wfDst, yml));
  }
}

const write = (rel, content) => fs.writeFileSync(path.join(SB, rel), content);
const read = (rel) => fs.readFileSync(path.join(SB, rel), 'utf8');
function rep(rel, from, to) {
  const s = read(rel);
  if (!s.includes(from)) throw new Error(`${rel} 里找不到「${from}」—— 变异没落上，等于没测`);
  fs.writeFileSync(path.join(SB, rel), s.replace(from, to));
}

async function runGate() {
  return runStep([GATE, SB], { cwd: SB, timeoutMs: 120000 });
}

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()');
  needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

const PASS = '[ci-paths] PASS';

// ---- 场景表 --------------------------------------------------------------
const scenarios = [
  {
    id: 'ⓐ 原样（对照）',
    mutate: () => {},
    expect: 0,
    expectText: PASS,
    why: `基线：沙盒里 ${TARGET} 是原样的，闸必须是绿的`,
  },
  {
    id: '① 代码里写死 Windows 主目录形状',
    mutate: () => write(TARGET, `import fs from 'node:fs';\nconst ROOT = '${WIN_HOME}';\nexport default ROOT;\n`),
    expect: 1,
    expectText: 'test-with-timeout.mjs',
    why: '判据本体：CI 上跑到这段（Windows 主目录形状），那台机器上根本没有这个目录 —— 就是 find-chrome 那次事故的形状',
  },
  {
    id: '② 同一条路径只写在注释里（对照）',
    mutate: () => write(TARGET, `// 早先这里写死过 ${WIN_HOME}，后来搬走了\nexport const n = 1;\n`),
    expect: 0,
    expectText: PASS,
    why: '抹注释必须生效（SKILL 第 111 条）：仓库里有一大把复盘旧路径的注释，不抹的话它们会把闸点着',
  },
  {
    id: '③ POSIX 主目录形状',
    mutate: () => write(TARGET, `const OUT = '${POSIX_HOME}';\nexport default OUT;\n`),
    expect: 1,
    expectText: 'test-with-timeout.mjs',
    why: '判据不能只认 Windows 一种写法 —— CI 就是 Linux runner，写死 runner 自己的家目录同样是绑死机器',
  },
  {
    id: '④ 扫描器退化：正则永不匹配',
    mutate: () => rep(GATE, '/(?:[A-Za-z]:[\\\\/]Users[\\\\/]|\\/(?:Users|home|root)\\/)/g', '/(?!)/g'),
    expect: 1,
    expectText: '扫描器坏了',
    why: '★ 本轮最关键的一条：闸今天是绿的，判据坏了它照样绿、没人会响。只能靠内置金丝雀把它拽出来',
  },
  {
    id: '⑤ workflow 里 tools/ 引用全没了',
    mutate: () =>
      write(
        '.github/workflows/deploy-pages.yml',
        'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
      ),
    expect: 1,
    expectText: '一个要扫的脚本都没抓到',
    why: '抓不到清单 = 这道闸白跑了；不响的话它会安静地「全绿」下去，和不存在没区别',
  },
  {
    id: '⑥ 合法写法（os.homedir / /usr/bin / /tmp）（对照）',
    mutate: () => write(TARGET, LEGIT_SAMPLE),
    expect: 0,
    expectText: PASS,
    why: '反向对照：os.homedir() 不是字面量，/usr/bin 与 /tmp 是跨平台公认位置 —— 一刀切会把正确写法逼成绕过',
  },
];

// ---- 开跑 ---------------------------------------------------------------
console.log('【第 43 步】第 42 步「CI 脚本不许写死用户主目录」这道闸有没有牙齿');

const before = [GATE, DEP, FIXTURES].map((f) => [f, sha(path.join(ROOT, f))]);
const rootStatusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;

for (const s of scenarios) {
  buildSandbox();
  try {
    s.mutate();
  } catch (e) {
    console.log(`❌ ${s.id} —— 变异没落上：${e.message}`);
    bad++;
    continue;
  }
  const r = await runGate();
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = r.status === s.expect && out.includes(s.expectText);
  console.log(`${pass ? '✅' : '❌'} ${s.id}`);
  console.log(`    期望 exit=${s.expect} 且报出「${s.expectText}」；实际 exit=${r.status}`);
  if (!pass) {
    out
      .trim()
      .split('\n')
      .filter((l) => l.includes('✗') || l.includes('['))
      .slice(0, 6)
      .forEach((l) => console.log('    ' + l.trim()));
  }
  console.log(`    └ ${s.why}`);
  if (!pass) bad++;
}

// ---- 收工核验 -----------------------------------------------------------
console.log('\n  收工核验：');
for (const [f, h] of before) {
  const now = sha(path.join(ROOT, f));
  const ok = now === h;
  console.log(`    ${ok ? '✓' : '✗'} ${f} ${ok ? '逐字节未动' : `★ 变了！${h} → ${now}`}`);
  if (!ok) bad++;
}
const rootStatusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;
const rootClean = rootStatusAfter === rootStatusBefore;
console.log(`    ${rootClean ? '✓' : '✗'} 真仓库状态没变${rootClean ? '' : `（\n${rootStatusAfter}）`}`);
if (!rootClean) bad++;

const rm = await rmTreeBounded(SB, { timeoutMs: 20000 });
console.log(`    ${rm.gone ? '✓' : '✗'} 沙盒已删除${rm.gone ? '' : `（${rm.timedOut ? '清理超时，进程已杀' : '未知原因'}）`}`);
if (!rm.gone) bad++;

console.log(bad ? `\n❌ ${bad} 处不合预期` : `\n✅ ${scenarios.length} 个场景全部合预期`);
process.exit(bad ? 1 : 0);
