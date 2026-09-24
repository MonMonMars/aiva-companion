// 给「试听一句」用的纯播放通道（不驱动 3D 角色口型）
// ---------------------------------------------------------------------------
// VoiceSettings 的「试听」按钮对云端三家（openai/azure/elevenlabs）仍走
// tts.js 的 synthesizeSegment（要 Key）；但对免 Key 的 edge / espeak，
// 这里直接在本地点一声，免得为试听再去要 Key。
import { pickYueVoice, ensureVoices, unlockSpeech } from './cantonese';
import { speakEspeak } from './espeak';

/** 微软神经 zh-HK 嗓音（Edge/Windows 自带，Edge TTS 本体）。挑不到返回 null。 */
function pickEdgeVoice(synth) {
  const voices = (synth && synth.getVoices && synth.getVoices()) || [];
  const yue = voices.filter((v) =>
    /HiuGaaiNeural|HiuMaanNeural|WanLungNeural|GaaiNeural|Microsoft Server Speech Text to Speech Voice \(zh-HK/i.test(v.name || ''));
  return yue[0] || null;
}

function synthPlay(text, lang, { preferEdge, speed }) {
  return new Promise((resolve) => {
    const synth = (typeof window !== 'undefined' && window.speechSynthesis) || null;
    if (!synth) { resolve(); return; }
    unlockSpeech(synth);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    if (/zh-hk|yue|zh-hant-hk/i.test(lang)) {
      const voice = (preferEdge && pickEdgeVoice(synth)) || pickYueVoice(synth);
      if (voice) { u.voice = voice; u.lang = voice.lang || lang; }
    }
    u.rate = Math.max(0.7, Math.min(1.3, speed ?? 1));
    u.onend = () => resolve();
    u.onerror = () => resolve();
    try { synth.cancel(); } catch (_) {}
    synth.speak(u);
  });
}

/**
 * 试听一句。
 * @param {{provider:string, lang?:string, text:string, speed?:number}} opts
 */
export async function previewTts({ provider, lang, text, speed }) {
  if (provider === 'espeak') {
    await speakEspeak(text, { lang, speed });
    return;
  }
  await synthPlay(text, lang, { preferEdge: provider === 'edge', speed });
}
