/**
 * Grok realtime voice helpers — session payload + PCM + token shaping.
 *
 * 用法： node tools/grok-voice.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSrc } from './lib/loadSrc.mjs';
import { needBool, needLabel } from './assert-args.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { buildAivaVoiceInstructions, buildGrokVoiceSessionUpdate } =
  await loadSrc(root, 'src/voice/grok/session-config.js');
const { float32ToBase64Pcm16, base64Pcm16ToFloat32, resampleFloat32 } =
  await loadSrc(root, 'src/voice/grok/audio-pcm.js');
const { shapeVoiceSessionResponse, buildWebSocketSubprotocol } =
  await loadSrc(root, 'src/voice/grok/ephemeral-token.js');

let fail = 0;
const ck = (cond, label) => {
  needBool(cond, 'ck()'); needLabel(label, 'ck()');
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) fail++;
};

console.log('=== AIVA Grok session.update ===');
const instr = buildAivaVoiceInstructions({
  personaName: '小柔',
  systemInstructions: '你是小柔，用户的虚拟女友。',
  lang: 'zh-HK',
});
ck(instr.includes('小柔'), 'instructions include persona name');
ck(instr.includes('粤语'), 'instructions mention Cantonese');

const payload = buildGrokVoiceSessionUpdate({
  personaName: '小柔',
  systemInstructions: 'test',
  lang: 'zh-HK',
  voiceId: 'ara',
});
ck(payload.type === 'session.update', 'session.update type');
ck(payload.session.turn_detection.type === 'server_vad', 'server_vad');
ck(payload.session.audio.input.transcription.language_hint === 'yue', 'yue STT hint');
ck(payload.session.voice === 'ara', 'custom voice id');

console.log('\n=== PCM round-trip ===');
const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
const b64 = float32ToBase64Pcm16(samples);
const back = base64Pcm16ToFloat32(b64);
ck(back.length === samples.length, 'pcm length preserved');
ck(Math.abs(back[1] - 0.5) < 0.02, 'pcm sample approx');

const up = resampleFloat32(new Float32Array([0, 1]), 48000, 24000);
ck(up.length === 1, 'resample halved length');

console.log('\n=== Ephemeral token shaping ===');
const shaped = shapeVoiceSessionResponse(
  { value: 'tok_abc', expires_at: 123 },
  'grok-voice-latest',
  'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
);
ck(shaped.token === 'tok_abc', 'token passed through');
ck(buildWebSocketSubprotocol('tok_abc') === 'xai-client-secret.tok_abc', 'ws subprotocol');

if (fail) {
  console.log(`\n${fail} failed`);
  process.exit(1);
}
console.log('\n全部通过。');
