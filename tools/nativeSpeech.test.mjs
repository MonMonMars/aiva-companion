/**
 * 原生端「系统嗓音」TTS（expo-speech）的回归测试。
 *
 * 为什么值得单独测一遍 —— 这条通道有三个只会**静默**出错的地方，肉眼看不出来：
 *
 *   1. rate / pitch 的量纲。写错不会报错，只会让语速变成机关枪或慢到听不清。
 *      （Exp 源码里 iOS 是 rate * AVSpeechUtteranceDefaultSpeechRate，
 *         Android 是 setSpeechRate，两边都是 1.0 = 正常。）
 *   2. 情绪表覆盖不全。新增一个情绪却忘了给它映射，那一句是**没出错地**失去语气。
 *   3. 接线被改掉。特别是插话时没 stopNative()，声音会一直念到自然结束才停。
 *
 * 用法： node tools/nativeSpeech.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把 .js 源码临时复制成 .mjs 再 import —— 项目没有 type:module，直接 import 会失败 */
async function loadSrc(relPath) {
  const src = path.join(root, ...relPath.split('/'));
  const tmp = path.join(root, 'tools', `.tmp-${path.basename(relPath, '.js')}-${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  try {
    return await import('file://' + tmp.replace(/\\/g, '/'));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

const readSrc = (relPath) => fs.readFileSync(path.join(root, ...relPath.split('/')), 'utf8');

const ttsMod = await loadSrc('src/voice/tts.js');
const { EMOTIONS } = ttsMod;
const emoMod = await loadSrc('src/voice/nativeEmotion.js');
const { NATIVE_EMOTION, nativeSpeechParams } = emoMod;
const provMod = await loadSrc('src/config/providers.js');
const { findTTS, TTS_PROVIDERS } = provMod;

let fail = 0;
const ck = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '\n      ' + extra : ''}`);
  if (!cond) fail++;
};

// ---------------------------------------------------------------------------
console.log('=== 1) provider 已登记且免 Key ===');
const nat = findTTS('native');
ck(nat?.id === 'native', 'TTS_PROVIDERS 里有 native', `实际拿到 ${nat?.id}`);
ck(Array.isArray(nat.keyFields) && nat.keyFields.length === 0, 'keyFields 为空（真的不需要填 Key）');
ck(nat.free === true, '标记为 free');
ck(!!nat.note && nat.note.length > 20, 'note 有内容（界面要显示说明）');
ck(
  TTS_PROVIDERS.filter((p) => p.id === 'native').length === 1,
  '没有重复注册 native',
);

// ---------------------------------------------------------------------------
console.log('\n=== 2) 嗓音选项不能写死设备 identifier ===');
// iOS 源码里：AVSpeechSynthesisVoice(identifier:) 拿到不存在的 id 会 guard 失败并 throw。
// 所以这里要么给空（运行时枚举），要么给设备上必然存在的东西 —— 不能塞一串"常见嗓音名"。
const voiceIds = (nat.voices || []).map((v) => v.id);
ck(
  voiceIds.every((id) => id === ''),
  'voices 里没有写死的嗓音 identifier',
  `实际：${JSON.stringify(voiceIds)}`,
);

// ---------------------------------------------------------------------------
console.log('\n=== 3) 情绪表覆盖 tts.js 的全部情绪 ===');
const missing = EMOTIONS.map((e) => e.tag).filter((t) => !NATIVE_EMOTION[t]);
ck(missing.length === 0, `${EMOTIONS.length} 种情绪都有 native 映射`, `缺：${missing.join(', ')}`);

// ---------------------------------------------------------------------------
console.log('\n=== 4) pitch / rate 在合法区间内（写坏必静默变味） ===');
const bad = [];
for (const [tag, v] of Object.entries(NATIVE_EMOTION)) {
  if (!(v.pitch >= 0.5 && v.pitch <= 2.0)) bad.push(`${tag}.pitch=${v.pitch}`);
  if (!(v.rate >= 0.1 && v.rate <= 2.0)) bad.push(`${tag}.rate=${v.rate}`);
  if (v.volume != null && !(v.volume >= 0 && v.volume <= 1)) bad.push(`${tag}.volume=${v.volume}`);
}
ck(bad.length === 0, '情绪表本身的值都合法', bad.join(', '));

const dflt = nativeSpeechParams({});
ck(
  dflt.pitch === 1 && dflt.rate === 1 && dflt.volume === 1,
  '默认（无情绪、无语速）= 正常 1.0/1.0/1.0',
  JSON.stringify(dflt),
);

// 极端组合必须被夹住，不能溢出
const fast = nativeSpeechParams({ emotion: 'excited', speed: 3 });
ck(fast.rate <= 2.0, 'speed=3 + excited 的 rate 被夹到上限', `rate=${fast.rate}`);
const slow = nativeSpeechParams({ emotion: 'sleepy', speed: 0.1 });
ck(slow.rate >= 0.1, 'speed=0.1 + sleepy 的 rate 被夹到下限', `rate=${slow.rate}`);

const pSleepy = nativeSpeechParams({ emotion: 'sleepy', speed: 1 });
const pExcited = nativeSpeechParams({ emotion: 'excited', speed: 1 });
ck(pSleepy.rate < pExcited.rate, '困倦比兴奋慢（情绪要有可听的差别）');
ck(pSleepy.pitch < pExcited.pitch, '困倦比兴奋低沉');
ck(nativeSpeechParams({ emotion: 'whispers' }).volume < 1, '耳语音量更小');
ck(
  nativeSpeechParams({ emotion: '不存在的标签', speed: 1.2 }).rate === 1.2,
  '认不出的情绪标签按中性处理、不报错',
);

// speed 与情绪是相乘关系：整体语速不被情绪吃掉
const spd = nativeSpeechParams({ emotion: 'excited', speed: 1.5 });
ck(Math.abs(spd.rate - 1.5 * 1.15) < 1e-9, '用户语速 × 情绪档（不是覆盖）', `rate=${spd.rate}`);

// ---------------------------------------------------------------------------
console.log('\n=== 5) 接线没被改掉 ===');
const session = readSrc('src/voice/session.js');
ck(
  /provider === 'native'[\s\S]{0,80}_speakNative/.test(session),
  'session.speak() 会把 native 分发到 _speakNative',
);
// 这一条最关键：少了它，插话时系统嗓音停不下来
const stopIdx = session.indexOf('stopNative()');
const queueIdx = session.indexOf('stopQueue()');
ck(
  queueIdx >= 0 && stopIdx > queueIdx,
  'stopQueue() 里调用了 stopNative()（插话要能立刻闭嘴）',
);
ck(session.includes("from './nativeSpeech'"), 'session.js 确实引入了这个模块');

const theme = readSrc('src/theme.js');
ck(
  /provider === 'native'[\s\S]{0,200}locale/.test(theme),
  'theme.resolveVoice 有 native 分支且返回 locale',
);

const store = readSrc('src/store.js');
ck(store.includes("'edge' : 'native'"), 'store.js 原生端默认 provider 是 native');
ck(store.includes('ttsMigratedToNative'), '有原生端一次性迁移标记');
ck(
  /ttsProvider: 'native', ttsVoice: ''/.test(store),
  '迁移到 native 时清空旧的 ttsVoice',
  "留着 nova 这类云端音色名会被当成设备嗓音 id，iOS 上直接抛 InvalidVoiceException",
);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(50));
if (fail === 0) {
  console.log(`全部通过 ✓ （${EMOTIONS.length} 种情绪 / ${Object.keys(NATIVE_EMOTION).length} 条映射）`);
} else {
  console.log(`失败 ${fail} 项 ✗`);
}
process.exit(fail === 0 ? 0 : 1);
