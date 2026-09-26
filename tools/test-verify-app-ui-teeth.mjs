// `tools/verify-app-ui.mjs` 里那条「人格卡 N 张 = 各档位声明之和 M」的牙齿。
// ---------------------------------------------------------------------------
// ⚠️ 本脚本**没有登记进 runtests.mjs 的套装**，需要手动跑：
//      node tools/test-verify-app-ui-teeth.mjs
//   原因是它需要三样套装里刻意没有的东西：本机 Chrome、打一份 web 包（约 4 秒）、
//   以及**临时改一次 src 再还原**（有 sha256 收工核验）。放进 CI 会让每次都要
//   装浏览器并多花半分钟，性价比不划算；但留着它，是因为那条断言一旦被改坏，
//   没有任何常驻的东西会提醒 —— 这仓库里「静默全绿」的事故已经出现过四次。
//
// 为什么这条断言本身值得配牙齿：它红的时候**看不出是产品坏了还是断言坏了**。
//   2026-09-27 实测：它报「19 张 ≠ 36」红了很久，查下来两处都是**断言自己的
//   算术错了**（见 verify-app-ui.mjs 里 PROBE 的注释）：
//     · 底部常驻 CTA 写着「开始相处 · 她」，被当成第 19 张卡；
//     · 页面顶部写着「18 位全部开放」，被当成第 5 个档位头。
//   产品其实是对的：18 个人格，4 个档位 3+10+4+1 = 18。
//   修完之后如果不再验一次「改错数字它会不会红」，就只是把红灯摘掉了而已。
//
// 做法：把档位头报的数字 +1，重新打一份包，看它红不红。
//   ① 变异后必须红 —— 否则"绿"是假的（它可能只是永远绿）
//   ② 还原后必须绿 —— 否则我不知道自己还原干净了没有
//   ③ 收工核验：src/screens/PersonaSelect.js 的 sha256 必须逐字节回到原样
//
// ⚠️ 打好的临时包用 `UI_DIST` 指过去，**不要**覆盖 dist/ ——
//    拿一个会被反复覆盖的产物当判据，等于不知道自己验的是哪一版源码。
//    （step-runner 的 runStep 以前不接 env，传了也是静默无效 —— 那时以为
//     这条断言没有牙齿，其实是它一直在测旧包。已修。）
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runStep, rmTreeBounded } from './step-runner.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const SRC = path.join(ROOT, 'src/screens/PersonaSelect.js');
const DIST = 'dist-localcheck-web';

let bad = 0;
const check = (cond, msg) => {
  needBool(cond, 'check()'); needLabel(msg, 'check()');
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

const sha = () => crypto.createHash('sha256').update(fs.readFileSync(SRC)).digest('hex').slice(0, 16);
// 档位头那一行。⚠️ 找不到就当失败：静默变成「什么都没改」的话，
// 下面测出来的"还是绿的"会被误读成"这条断言没牙齿"，比不做还糟。
const FROM = 'meta={`${g.list.length} 位`}';
const TO = 'meta={`${g.list.length + 1} 位`}';

async function build() {
  const r = await runStep(['tools/verify-bundle.mjs', '.', '--platform', 'web', '--keep'], { cwd: ROOT, timeoutMs: 180000 });
  if (r.status !== 0) throw new Error('打包失败 —— 后面的判断都没意义了');
}
async function runUi(port) {
  const r = await runStep(['tools/verify-app-ui.mjs'], {
    cwd: ROOT, timeoutMs: 120000,
    env: { ...process.env, UI_DIST: DIST, WEB_PORT: String(port), UI_CDP_PORT: String(port + 700) },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status, line: (out.split('\n').find((l) => l.includes('人格卡')) || '(没抓到人格卡那一行)').trim() };
}

console.log('【verify-app-ui 的牙齿】「人格卡 = 各档位声明之和」改错数字时会不会红\n');
const before = sha();

try {
  let s = fs.readFileSync(SRC, 'utf8');
  if (!s.includes(FROM)) throw new Error('找不到待改的原串 —— PersonaSelect.js 的写法变了，这张表要跟着改');
  fs.writeFileSync(SRC, s.replace(FROM, TO));
  await build();
  const red = await runUi(8811);
  console.log(`\n① 变异：档位头报的数字 +1（卡片还是 18 张，各档位之和应变成 22）`);
  console.log(`   exit=${red.code}\n   ${red.line}`);
  check(red.code !== 0, '变异后必须红 —— 否则"绿"是假的（它可能只是永远绿）');

  s = fs.readFileSync(SRC, 'utf8');
  fs.writeFileSync(SRC, s.replace(TO, FROM));
  check(sha() === before, `② 还原：${path.basename(SRC)} 的 sha256 逐字节回到原样（${before}）`);
  await build();
  const green = await runUi(8812);
  console.log(`\n③ 还原后\n   exit=${green.code}\n   ${green.line}`);
  check(green.code === 0, '还原后必须绿 —— 否则我不知道自己还原干净了没有');
} finally {
  const s = fs.readFileSync(SRC, 'utf8');
  if (s.includes(TO)) { fs.writeFileSync(SRC, s.replace(TO, FROM)); console.log('\n（finally 里又还原了一次）'); }
  const after = sha();
  check(after === before, `收工核验：${path.basename(SRC)} 最终 sha256 与原始一致（${after}）`);
  await rmTreeBounded(path.join(ROOT, DIST), { timeoutMs: 30000 });
  check(!fs.existsSync(path.join(ROOT, DIST)), `收工核验：临时产物 ${DIST} 已删除`);
}

console.log(bad
  ? `\n[app-ui-teeth] FAIL — ${bad} 项没达标`
  : `\n[app-ui-teeth] PASS — 改错数字它红、还原它绿，源文件逐字节没被动过`);
process.exit(bad ? 1 : 0);
