import {
  DEFAULT_GROK_VOICE_ID,
  GROK_VOICE_SAMPLE_RATE,
} from './constants';

/**
 * @typedef {object} GrokVoiceSessionContext
 * @property {string} personaName
 * @property {string} [systemInstructions] full persona + relationship prompt from buildSystemPrompt
 * @property {string} [voiceId]
 * @property {string} [lang] zh-HK | zh-CN | en-US | mix
 * @property {boolean} [kidMode]
 */

/**
 * Voice instructions for AIVA — Cantonese-first when lang is zh-HK.
 * @param {GrokVoiceSessionContext} ctx
 */
export function buildAivaVoiceInstructions(ctx) {
  const name = (ctx.personaName || '').trim() || 'AIVA';
  const base = ctx.systemInstructions || '';

  const langBlock = ctx.lang === 'zh-HK'
    ? [
      '【语言·最高优先级】用香港粤语口语回答，整句都是粤语，不要写成普通话书面语。',
      '句子要短（一两句），像实时通话，不要列表或 Markdown。',
      '若 STT 只支持 zh，用户说粤语时仍尽量用粤语词汇回复；实在无法区分时可用 zh 口音但保持粤语用词。',
    ].join('\n')
    : ctx.lang === 'en-US'
      ? 'Respond in natural spoken English. Keep turns short (one or two sentences).'
      : '用自然的中文口语回答，句子要短，适合实时通话。';

  const kid = ctx.kidMode
    ? '【儿童模式】句子更短、更具体，绝不涉及恐怖/暴力/成人内容。'
    : '';

  return [
    `你是 AIVA 3D 陪伴角色「${name}」，正在和用户进行实时语音通话。`,
    base,
    langBlock,
    kid,
    '不要主动说自己是 AI，除非用户明确问起。',
    '听到用户说完再回应；保持温暖、有表情，像真人聊天。',
  ].filter(Boolean).join('\n\n');
}

/**
 * @param {GrokVoiceSessionContext} ctx
 */
export function buildGrokVoiceSessionUpdate(ctx) {
  const voice = ctx.voiceId?.trim() || DEFAULT_GROK_VOICE_ID;
  const lang = ctx.lang || 'zh-HK';
  const transcription = {
    model: 'grok-transcribe',
    language_hint: lang === 'zh-HK' ? 'yue' : lang === 'en-US' ? 'en' : 'zh',
  };

  return {
    type: 'session.update',
    session: {
      voice,
      instructions: buildAivaVoiceInstructions(ctx),
      turn_detection: { type: 'server_vad' },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: GROK_VOICE_SAMPLE_RATE },
          transcription,
        },
        output: {
          format: { type: 'audio/pcm', rate: GROK_VOICE_SAMPLE_RATE },
          speed: 1,
        },
      },
    },
  };
}
