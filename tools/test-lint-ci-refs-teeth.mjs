// lint-ci-refs 的牙齿测试 —— 证明那三条检查**真的拦得住东西**，而不只是跑通。
//
// 为什么它要常驻（而不是一次性脚本）：
//   lint-ci-refs 本身的规则一旦被改（比如为了消误报放宽一条正则），
//   最容易发生的事就是「拦截能力被顺手改掉了，而所有测试还是绿的」。
//   SKILL 第 52 条写着「改完这条规则必须重跑牙齿测试」——
//   可没有任何东西会提醒你重跑。所以把它变成第 19 步，自动提醒。
//
// 两条做法上的讲究（都是踩出来的）：
//   1. **不动真实文件**。改动全部落在沙盒副本上：先把 workflow 和 runtests
//      复制进 `_teeth_ci_sandbox/`，所有破坏只落在副本上，跑完整个删掉。
//      （这样写的原因见 SKILL 第 50 条：这个环境里 `git rm` 出过整目录消失的事故，
//        所以「改坏了再改回来」这件事本身就不该被信任。）
//   2. **沙盒只拷它真正会读的东西**。lint-ci-refs 实际 Read 的只有两类：
//      `.github/workflows/*.yml` 和 `tools/runtests.mjs`；
//      被 workflow 引用到的其它文件它只做 `existsSync` —— 所以那些放零字节占位就够。
//      整目录复制会把 tools/ 下两个共 7.3MB 的 .tmp html 也拷进每个场景，
//      实测跑到第二个场景就被超时掐断；改成「2 个真文件 + 22 个占位」后每个场景 260ms。
//
// 用法：node tools/test-lint-ci-refs-teeth.mjs [项目根目录]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.argv[2] || '.');
const NODE = process.execPath;
const SANDBOX = path.join(ROOT, '_teeth_ci_sandbox');
const LINT = path.join(ROOT, 'tools', 'lint-ci-refs.mjs');

const REAL_WF_DIR = path.join(ROOT, '.github', 'workflows');
const REAL_RT = path.join(ROOT, 'tools', 'runtests.mjs');

if (!fs.existsSync(LINT)) {
  console.error(`✗ 找不到被检查的脚本 ${LINT}：这一步没法跑`);
  process.exit(1);
}

// ---------- 搭最小沙盒 ----------
// 复用 lint 自己的引用正则，免得两边对「什么算一个引用」的理解漂移。
const FILE_RE = /(?:^|\s)(?:\.\/)?((?:tools|scripts)\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g;

function buildSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const swf = path.join(SANDBOX, '.github', 'workflows');
  fs.mkdirSync(swf, { recursive: true });

  const ymls = fs.readdirSync(REAL_WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  const referenced = new Set();
  for (const f of ymls) {
    const text = fs.readFileSync(path.join(REAL_WF_DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue; // 与 lint 保持一致：注释行不算引用
      FILE_RE.lastIndex = 0;
      let m;
      while ((m = FILE_RE.exec(line)) !== null) referenced.add(m[1]);
    }
    fs.copyFileSync(path.join(REAL_WF_DIR, f), path.join(swf, f));
  }
  for (const rel of referenced) {
    const abs = path.join(SANDBOX, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
  const srt = path.join(SANDBOX, 'tools', 'runtests.mjs');
  fs.mkdirSync(path.dirname(srt), { recursive: true });
  fs.copyFileSync(REAL_RT, srt);

  if (referenced.size === 0) throw new Error('一个引用都没扫到，沙盒搭不起来 —— 多半是正则坏了');
  return referenced.size;
}

const WF = path.join(SANDBOX, '.github', 'workflows', 'deploy-pages.yml');
const RT = path.join(SANDBOX, 'tools', 'runtests.mjs');
const pristine = new Map();

// 按正则改一次；改不到就抛错 —— 「本该改到的地方没改到」必须响，
// 否则哪天 workflow 里的写法变了，这个测试会变成「什么都没验却全绿」。
function replaceOnce(file, re, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!re.test(text)) throw new Error(`沙盒里 ${path.basename(file)} 找不到匹配 ${re} 的内容`);
  fs.writeFileSync(file, text.replace(re, to));
}

const scenarios = [
  {
    id: 'S0 基线：真实配置当然要过（里面已含「本地多带 --keep」这种合法差异）',
    expect: 0,
    mutate: () => {},
  },
  {
    id: 'A 引用一个不存在的文件',
    expect: 1,
    expectText: '引用了不存在的文件',
    mutate: () => replaceOnce(WF, /tools\/check-persona-coverage\.mjs/, 'tools/check-persona-coverageX.mjs'),
  },
  {
    id: 'B CI 步骤名改掉（本地没有同名步骤）',
    expect: 1,
    expectText: '在本地套装里没有',
    mutate: () => replaceOnce(WF, /run "auth-timeout"/, 'run "auth-timeout-x"'),
  },
  {
    id: 'C1 ★ CI 漏掉 loader：文件名在、步骤名也在，可两边跑的不是同一条命令',
    expect: 1,
    expectText: '两边命令不一致',
    // 写 `$1` 而不是写死 loader 名字 —— 以后换了 loader 也照样测得出漂移
    mutate: () => replaceOnce(WF, /run "auth-timeout" node --import \S+ (tools\/\S+)/, 'run "auth-timeout" node $1'),
  },
  {
    id: 'C2 CI 比本地多一个参数',
    expect: 1,
    expectText: '两边命令不一致',
    mutate: () => replaceOnce(WF, /run "lint-imports" node tools\/lint-imports\.mjs \./, 'run "lint-imports" node tools/lint-imports.mjs . --strict'),
  },
  {
    id: 'C3 本地比 CI 多一个白名单外的参数',
    expect: 1,
    expectText: '两边命令不一致',
    mutate: () => replaceOnce(RT, /\['withTimeout', \['tools\/test-with-timeout\.mjs'\]\]/, "['withTimeout', ['tools/test-with-timeout.mjs', '--verbose']]"),
  },
  {
    // 2026-09-25 真踩过：我在 deploy job 的注释里写「为什么这条不写成
    // run "名字" node ... 的形式」，那句解释自己被 RUN_RE 扫成一个名叫
    // 「名字」的步骤，第 18 步当场变红 —— 而它根本不存在于任何 job 里。
    // RUN_RE 必须跟 FILE_RE 一样跳过注释行，这条盯着的就是那个「一样」。
    id: 'D1 ★ workflow 注释里提到 run "名字" node ... 不该被当成一步',
    expect: 0,
    // 只有「一个都没缺」时那句才会打印 —— 注释若被算进去，它就不出现了
    expectText: '全部能在本地找到',
    mutate: () => fs.appendFileSync(WF, '\n# 用法：run "注释里的名字" node tools/nope.mjs\n'),
  },
  {
    // B/C 是「扫到什么就对什么」，扫到 0 条时会**静默全绿**：
    // 实测旧版在这种仓库上 exit=0，一整层检查等于没跑。必须当场响。
    id: 'D2 ★ 一条都扫不到时必须响（否则 B/C 静默全绿）',
    expect: 1,
    expectText: '一个 CI 步骤都没扫到',
    mutate: () => {
      const t = fs.readFileSync(WF, 'utf8');
      if (!/run "/.test(t)) throw new Error('沙盒里找不到 `run "` 形式，这个场景没验到东西');
      fs.writeFileSync(WF, t.replace(/run "/g, 'runx "'));
    },
  },
];

let count = 0;
let bad = 0;
try {
  count = buildSandbox();
  for (const f of [WF, RT]) pristine.set(f, fs.readFileSync(f, 'utf8'));
  console.log(`沙盒：deploy-pages.yml + runtests.mjs + ${count} 个占位文件\n`);

  for (const s of scenarios) {
    // 每个场景之前把两个文件写回原样，而不是重建整个沙盒
    for (const [f, buf] of pristine) fs.writeFileSync(f, buf);
    s.mutate();
    const r = spawnSync(NODE, [LINT, SANDBOX], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const pass = r.status === s.expect && (!s.expectText || out.includes(s.expectText));
    console.log(`${pass ? '✅' : '❌'} ${s.id}`);
    if (!pass) {
      bad += 1;
      console.log(`    期望 exit=${s.expect}${s.expectText ? ` 且报出「${s.expectText}」` : ''}`);
      console.log(`    实际 exit=${r.status}`);
      out.split('\n').filter((l) => /✗|本地:|CI  :/.test(l)).slice(0, 4)
        .forEach((l) => console.log('    ' + l.trim()));
    }
  }
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(bad ? `\n❌ ${bad} 个场景不合预期` : `\n✅ ${scenarios.length} 个场景全部合预期`);
process.exit(bad ? 1 : 0);
