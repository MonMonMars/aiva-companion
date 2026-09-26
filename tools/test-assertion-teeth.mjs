// 第 29 步：给四个「只靠 why」的断言型步骤配牙齿。
// ---------------------------------------------------------------------------
// 起因：第 28 步把「每步的牙齿在哪」变成显式登记之后，屏幕上多了一份欠账单
//   —— 28 步里 19 步只靠 `why`，其中 9 步是真的没有常驻牙齿。
//   而我在那些 `why` 里写的是「它断言的是真实行为，断言写坏会红」，旁边老实
//   标了「未验证」。**未验证的断言不算数**（这条纪律在这里已经应验过很多次），
//   所以本步就是去把它们证掉 —— 方法还是变异：改坏它测的东西，看它红不红。
//
// 审计结果（三个判断里两个被证伪，一个坐实了洞）：
//   tts         清空 EMOTIONS      → 13 项 ✗   ✅ 我的判断是对的，它真的有牙齿
//   nativeSpeech 清空 NATIVE_EMOTION → 5 项 ✗  ✅ 同上
//   songs       清空 SONG_LIST      → 「曲库 0 首」，WAV 那批实质判据**整批被跳过**，
//                                     靠 matchSong 抛 TypeError 才退出非 0 ❌ 洞
//   espeak      粤语码改回 yue      → 应红（这是它存在的理由：防 yue→zhy 回归）
//
// 洞已补（tools/songs.test.mjs 加了 0 条闸门，并把崩溃改成一条 ✗）。
// 本步把「补完之后仍然红」钉住，免得有人为了让测试变绿又把那条闸门删掉。
//
// ⚠️ 本步会**临时改真实源文件**再还原。这是第 21 步（lipsync-teeth）用过的做法，
//    三重保险：① 内存里留原文 ② 每个场景 try/finally 还原 ③ 收工前比对 sha256，
//    不一致就还原并大声报错。**清理不干净比测试失败更糟** —— 它会把仓库弄脏，
//    而脏的源文件会让后面每一步的结论都不可信。
//
// 场景表（🟢 要求绿 / 🔴 要求红）：
//   ⓐ 对照组 ×4：四个步骤原样都要 exit 0 且无 ✗             🟢
//   ⓑ songs 清空曲库      → 红，且要点名「曲库非空」、不许 TypeError 🔴
//   ⓒ tts 清空情绪表      → 红，且有 ✗                        🔴
//   ⓓ nativeSpeech 清空映射 → 红，且有 ✗                      🔴
//   ⓔ espeak 粤语码改回 yue → 红，且要点名 zh-hk              🔴
//   ⓕ 变异必须真的改到了东西（否则"绿"没被验过）              🟢
//   ⓖ 收工前四个源文件必须与原文**逐字节一致**                 🟢

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runStep, rmTreeBounded } from './step-runner.mjs';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const R = (rel) => path.join(ROOT, rel);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

let bad = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// ★ 判「有没有失败」只认**行首两空格 + ✗**。
//   第一版写的是裸 `/✗/.test(out)`，结果命中了说明文字里我自己写的那个 ✗
//   （「曲库为空时这里也必须是一条 ✗，不是崩溃」被打印在一条 **✓** 行上）——
//   于是「原样没有 ✗」这条断言凭空变红。这跟第 25 步踩过的「/全部通过/ 命中了
//   正在解释为什么不算通过的报错文案本身」是同一类：**判据宽到能命中说明文字**。
const FAILED_LINE = /^ {2}✗/m;
const hasFail = (out) => FAILED_LINE.test(out);

/** 把 `export const NAME = [` / `{` 起到同缩进的 `];` / `};` 止，整体换成 `[]` / `{}` */
function emptyBlock(src, declLine, open, close) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.includes(declLine));
  if (i < 0) throw new Error('找不到声明行：' + declLine);
  const start = lines[i];
  const indent = /^(\s*)/.exec(start)[1];
  const name = /const (\w+)/.exec(start)[1];
  if (start.trim().endsWith(open + ';')) {
    return start.replace(open + ';', open + close + ';');
  }
  let j;
  for (j = i + 1; j < lines.length; j++) if (lines[j] === indent + close + ';') break;
  if (j >= lines.length) throw new Error('找不到闭合行：' + declLine);
  lines.splice(i, j - i + 1, `${indent}export const ${name} = ${open}${close};`);
  return lines.join('\n');
}

// 四个被测步骤 + 各自的变异。变异**必须是真实可能发生的事故**，不是随便改坏：
const CASES = [
  {
    id: 'songs',
    label: 'songs（清空曲库）',
    step: ['tools/songs.test.mjs'],
    file: 'src/services/songs.js',
    mutate: (s) => s.replace('export const SONG_LIST = Object.keys(SONGS);', 'export const SONG_LIST = [];'),
    mustSay: ['曲库非空'],
    mustNotSay: ['TypeError'], // 必须是断言在拦，不是崩溃在拦
    note: '靠崩溃才红是 fragile 的：哪天给 matchSong 加个空表兜底，静默全绿就回来了',
  },
  {
    id: 'tts',
    label: 'tts（清空情绪表）',
    step: ['tools/tts.test.mjs'],
    file: 'src/voice/tts.js',
    mutate: (s) => emptyBlock(s, 'export const EMOTIONS = [', '[', ']'),
    mustFail: true,
  },
  {
    id: 'nativeSpeech',
    label: 'nativeSpeech（清空情绪映射）',
    step: ['tools/nativeSpeech.test.mjs'],
    file: 'src/voice/nativeEmotion.js',
    mutate: (s) => emptyBlock(s, 'export const NATIVE_EMOTION = {', '{', '}'),
    mustFail: true,
  },
  {
    id: 'espeak',
    label: 'espeak（粤语嗓音码改回 yue）',
    step: ['tools/espeak.test.mjs'],
    file: 'src/voice/espeak.js',
    mutate: (s) => s.replace("'zh-hk': 'zhy',", "'zh-hk': 'yue',"),
    mustSay: ['zh-hk'],
    note: '这就是它存在的理由：eSpeak-ng 里粤语嗓音是 zhy 不是 yue，写错会静默回落英文',
  },
];

// 先把四个文件的原文记下来 —— 收工前要逐字节比对
const ORIGINAL = new Map();
for (const c of CASES) {
  if (!fs.existsSync(R(c.file))) { console.log(`✗ 找不到 ${c.file}`); process.exit(1); }
  ORIGINAL.set(c.file, fs.readFileSync(R(c.file), 'utf8'));
}

async function runStepScript(args) {
  return runStep(args, { cwd: ROOT, timeoutMs: 180000 });
}

try {
  /* ⓐ 对照组：原样都必须绿 */
  console.log('ⓐ 对照组：四个步骤原样都要 exit 0 且没有 ✗');
  for (const c of CASES) {
    const r = await runStepScript(c.step);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status === 0, `${c.id} 原样通过（exit ${r.status}${r.timedOut ? '，超时' : ''}）`);
    check(!hasFail(out), `${c.id} 原样没有失败行`);
    if (r.status !== 0) console.log(out.split('\n').slice(-8).map((l) => `        ${l}`).join('\n'));
  }

  /* ⓑ~ⓔ 变异：改坏它测的东西，它必须红 */
  for (const c of CASES) {
    console.log(`\n${c.note ? 'ⓑ' : ''}${c.id === 'songs' ? 'ⓑ' : c.id === 'tts' ? 'ⓒ' : c.id === 'nativeSpeech' ? 'ⓓ' : 'ⓔ'} ${c.label}`);
    const abs = R(c.file);
    const orig = ORIGINAL.get(c.file);
    let mutated;
    try {
      mutated = c.mutate(orig);
    } catch (e) {
      check(false, `变异构造失败：${e.message}`);
      continue;
    }
    check(mutated !== orig, 'ⓕ 变异真的改到了东西（否则这一轮等于没验）');
    if (mutated === orig) continue;

    fs.writeFileSync(abs, mutated, 'utf8');
    let r;
    try {
      r = await runStepScript(c.step);
    } finally {
      fs.writeFileSync(abs, orig, 'utf8');
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check(r.status !== 0, `${c.id} 看见这条事故要红（exit ${r.status}${r.timedOut ? '，超时' : ''}）`);
    if (c.mustFail) check(hasFail(out), '要有失败行 —— 靠崩溃退出不算（那说明闸门本身没在拦）');
    for (const s of c.mustSay || []) check(out.includes(s), `报错要包含「${s}」`);
    for (const s of c.mustNotSay || []) check(!out.includes(s), `不该出现「${s}」—— ${c.note || '那说明是别的原因在拦'}`);
    if (r.status === 0) console.log(out.split('\n').slice(-8).map((l) => `        ${l}`).join('\n'));
    check(sha(fs.readFileSync(abs, 'utf8')) === sha(orig), `${c.id} 跑完立刻还原了源文件`);
  }
} finally {
  /* ⓖ 收工核验：四个文件必须与原文逐字节一致 */
  console.log('\nⓖ 收工核验：四个源文件必须与原文逐字节一致');
  for (const [rel, orig] of ORIGINAL) {
    let now = '';
    try { now = fs.readFileSync(R(rel), 'utf8'); } catch { /* 读不到就当不一致 */ }
    const same = sha(now) === sha(orig);
    if (!same) {
      try { fs.writeFileSync(R(rel), orig, 'utf8'); } catch { /* 尽力 */ }
      console.log(`  ⚠️ ${rel} 被改动过，已还原 —— 若还原失败请 \`git checkout -- ${rel}\``);
    }
    check(same, `${rel} 与原文一致（${sha(orig)}）`);
  }
  // songs 那一步会在 tools/ 下留个临时副本，崩了就不会自己删
  const tmp = R('tools/.tmp-songs.mjs');
  if (fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); console.log('  清理遗留的 tools/.tmp-songs.mjs'); } catch { /* 不挡结论 */ }
  }
}

console.log(bad ? `\n[assertion-teeth] FAIL — ${bad} 项没达标` : '\n[assertion-teeth] PASS — 四个断言型步骤看见真事故都会红，原样照旧绿，源文件已逐字节还原');
process.exit(bad ? 1 : 0);
