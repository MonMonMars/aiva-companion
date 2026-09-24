// 粤语模块的确定性验证
// ---------------------------------------------------------------------------
// 不能靠"看着像粤语"来判断，所以要跑成断言：
//   1) 音色挑选：必须从一堆声音里挑出粤语那个，而且要优先本地音色
//   2) 台词：粤语模式下必须返回粤语稿，普通话模式下必须返回原稿
//   3) 缺台词时要能退回兜底池，不能返回空串（空串=不出声）
// cantonese.js 是纯 ESM 且无任何依赖，复制成 .mjs 就能直接被 Node 导入。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'voice', 'cantonese.js');
const tmp = path.join(here, '_cantonese.tmp.mjs');
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8'));

const M = await import('file://' + tmp);
fs.unlinkSync(tmp);

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); }
};

const mkSynth = (voices) => ({ getVoices: () => voices, addEventListener() {}, removeEventListener() {} });
const V = (name, lang, localService = true) => ({ name, lang, localService });

// ---- 1. 粤语识别 ---------------------------------------------------------
console.log('=== 1. 粤语音色识别 ===');
ok(M.isYueVoice(V('Sin-Ji', 'zh-HK')), 'zh-HK 认成粤语');
ok(M.isYueVoice(V('Meijia', 'yue-Hant-HK')), 'yue-Hant-HK 认成粤语');
ok(M.isYueVoice(V('Ting-Ting', 'zh-CN')) === false, 'zh-CN 不算粤语');
ok(M.isYueVoice(V('Samantha', 'en-US')) === false, 'en-US 不算粤语');
// 名字里写了 Cantonese 就当粤语：lang 标签标错是很常见的（尤其第三方/系统音色），
// 名字比标签可信。宁可认错一个，也不要把真粤语声音漏掉。
ok(M.isYueVoice(V('HK Cantonese Voice', 'zh-TW')), '名字写 Cantonese 时忽略错误的 lang 标签');
// 但光是 zh-TW（台湾国语）不能算粤语
ok(M.isYueVoice(V('Yun-Jhe', 'zh-TW')) === false, 'zh-TW 台湾国语不算粤语');
ok(M.isYueVoice(V('Mei-Jia', 'zh-TW')) === false, '普通 zh-TW 女声不算粤语');

// ---- 2. 音色挑选 ---------------------------------------------------------
console.log('=== 2. 从音色列表里挑粤语 ===');
const mixed = [
  V('Ting-Ting', 'zh-CN'),
  V('Samantha', 'en-US'),
  V('Sin-Ji', 'zh-HK', true),
  V('Cloud HK', 'zh-HK', false),   // 云端音色，应被本地那个压下去
];
const picked = M.pickYueVoice(mkSynth(mixed));
ok(picked && picked.name === 'Sin-Ji', '优先本地粤语音色', '→ ' + (picked && picked.name));
ok(M.pickYueVoice(mkSynth([V('Ting-Ting', 'zh-CN')])) === null, '没有粤语时返回 null（不凑合）');

// ---- 3. 台词 -------------------------------------------------------------
console.log('=== 3. 台词按语言切换 ===');
const girlfriend = { id: 'girlfriend', voice: { poke: ['干嘛啦，突然戳人！'] } };
const yue = M.personaLine(girlfriend, 'poke', 'zh-HK');
const cmn = M.personaLine(girlfriend, 'poke', 'zh-CN');
// 直接断言"来自粤语台词表"，比用特征字正则稳（粤语语气字很多，正则容易漏）
ok(M.YUE_LINES.girlfriend.poke.includes(yue), '粤语模式返回粤语台词', '→ ' + yue);
ok(cmn === '干嘛啦，突然戳人！', '普通话模式返回原台词', '→ ' + cmn);

// 没写粤语台词的人格要退回兜底池，不能返回空
const unknown = { id: 'no-such-persona', voice: { poke: ['喂！'] } };
const fb = M.personaLine(unknown, 'poke', 'zh-HK');
ok(typeof fb === 'string' && fb.length > 0, '未知人格退回粤语兜底池', '→ ' + fb);

// 每个有人格的粤语台词都不能是空串（空串 = 张嘴不出声）
const ids = Object.keys(M.YUE_LINES);
let empties = 0;
for (const id of ids) {
  for (const cat of ['pet', 'poke', 'idle']) {
    const line = M.personaLine({ id, voice: {} }, cat, 'zh-HK');
    if (!line || !line.trim()) { empties++; console.log('    空台词: ' + id + '/' + cat); }
  }
}
ok(empties === 0, `全部 ${ids.length} 个人格的 pet/poke/idle 都有粤语台词`, '空=' + empties);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
