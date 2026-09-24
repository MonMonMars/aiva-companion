// 把「录音 / 识别 / 大模型 / 联网工具 / 情绪语音 / 播放」串成一个 Hook
// ---------------------------------------------------------------------------
// 界面只负责：显示状态、放麦克风按钮、显示字幕。
// 所有脏活（音频队列、打断检测、工具回调）都在这个 Hook 里面，UI 不需要知道。

import { useEffect, useRef, useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { VoiceSession } from './voice/session';
import { WebVoiceSession } from './voice/webSession';
import { stripEmotionTags } from './voice/tts';
import { chatWithTools } from './chatEngine';
import { resolveVoice, getPersona } from './theme';
import { scheduleReminder, setupNotifications } from './services/reminders';
import { matchSong, renderSong } from './services/songs';
import { Audio } from 'expo-av';
import * as S from './store';
import { requestMotion } from './anim/motionBus';

export function useVoice({ personaId, snap, history, kidMode, lang, avatarRef }) {
  const sessionRef = useRef(null);
  const songRef = useRef(null);

  const [state, setState] = useState('idle'); // idle|recording|thinking|speaking
  const [level, setLevel] = useState(0);
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState(null);
  const [detectedLang, setDetectedLang] = useState(null);
  const [usedTools, setUsedTools] = useState([]);

  // 这些每次渲染都在变，用 ref 兜住，避免 session 被反复重建
  const liveRef = useRef({ personaId, snap, history, kidMode, lang, avatarRef });
  liveRef.current = { personaId, snap, history, kidMode, lang, avatarRef };

  const buildTtsCfg = useCallback((spokenLang) => {
    const cfg = S.getSnapshot().config;
    const v = cfg.voice || {};
    const provider = v.ttsProvider || 'openai';
    const base = resolveVoice(liveRef.current.personaId, provider, spokenLang);
    return {
      provider,
      voice: v.ttsVoice || base.voice,
      speed: v.ttsSpeed ?? base.speed,
      ttsModel: v.ttsModel,
      locale: base.locale,
      allowStyle: base.allowStyle,
      personInstruction: base.personInstruction,
      keys: {
        openaiKey: v.openaiKey,
        azureKey: v.azureKey,
        azureRegion: v.azureRegion,
        elevenKey: v.elevenKey,
      },
    };
  }, []);

  useEffect(() => {
    // 浏览器走 WebVoiceSession（SpeechSynthesis 出声，无需 Key）；
    // 原生端走 VoiceSession（expo-av）。接口一致，上层不用感知。
    const Session = Platform.OS === 'web' ? WebVoiceSession : VoiceSession;
    const session = new Session({
      getConfig: () => {
        const cfg = S.getSnapshot().config;
        const v = cfg.voice || {};
        return {
          stt: {
            provider: v.sttProvider || 'openai',
            language: v.sttLanguage || 'auto',
            keys: {
              openaiKey: v.openaiKey,
              groqKey: v.groqKey,
              siliconKey: v.siliconKey,
              azureKey: v.azureKey,
              azureRegion: v.azureRegion,
              // ElevenLabs 的同一把 Key 既能说话（TTS）也能听话（Scribe STT），
              // 少注册一家 —— 对没法做中国实名认证的用户尤其重要
              elevenKey: v.elevenKey,
              // Gemini 只用来听：免费额度最大、门槛最低（Google 账号即可）
              geminiKey: v.geminiKey,
            },
          },
          tts: buildTtsCfg(liveRef.current.lang),
        };
      },

      askLLM: async (userText, extra) => {
        const cfg = S.getSnapshot().config;
        const cur = liveRef.current;
        // 用户切语言了就跟着切口音，不然会得到"粤语提问、普通话回答"
        const spokenLang =
          cur.lang === 'auto'
            ? extra?.detectedLang === 'en' ? 'en-US'
              : extra?.detectedLang === 'yue' ? 'zh-HK'
                : 'zh-CN'
            : cur.lang;

        const res = await chatWithTools({
          config: {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
          },
          personaId: cur.personaId,
          snap: cur.snap,
          history: cur.history || [],
          userText,
          kidMode: cur.kidMode,
          lang: spokenLang,
          ctx: {
            search: { provider: (cfg.voice || {}).searchProvider || 'none', keys: cfg.voice || {} },
            city: (cfg.voice || {}).defaultCity || '',
            onRemember: (fact) => S.remember(fact),
            onReminder: async (title, mins) => scheduleReminder(title, mins),
            onSong: async (req) => {
              const song = matchSong(req);
              const uri = renderSong(song);
              try {
                await songRef.current?.unloadAsync();
                const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 0.45 });
                songRef.current = sound;
              } catch (_) {}
              return `我们一起唱！${song.title}，预备——唱！`;
            },
            // 语音会话是个 hook，拿不到场景 ref，走模块级动作总线
            onMotion: (kind) => requestMotion(kind),
          },
        });

        if (!res.ok) throw new Error(res.error);
        if (res.usedTools?.length) setUsedTools(res.usedTools);

        // 两边都要写进聊天记录。
        // 只写 user 不写 assistant 的话，下一轮模型看到的是 user/user/user 一串，
        // 它会以为自己刚才没说过话，于是重复自我介绍、丢失上下文。
        // 存的是剥掉情绪标记的纯文本 —— 那是给眼睛看的，朗读时才需要标记。
        S.appendMessage(cur.personaId, { role: 'user', content: userText, ts: Date.now() });
        S.appendMessage(cur.personaId, {
          role: 'assistant',
          content: stripEmotionTags(res.raw || ''),
          ts: Date.now(),
        });
        // 一次成功的对话给点好感度，和打字聊天保持同样的养成节奏
        S.rewardChat();

        return res.raw;
      },

      onState: (patch) => {
        if (patch.state) setState(patch.state);
        if (patch.level != null) setLevel(patch.level);
        if (patch.error) setError(patch.error);
        if (patch.detectedLang) setDetectedLang(patch.detectedLang);
        if (patch.speakingText) setSubtitle(patch.speakingText);
      },
      onSubtitle: (t) => setSubtitle(t),

      // --- 3D 角色的嘴 ---------------------------------------------------
      // 这一段声音真的开始播了，才让嘴动起来。用"开始播放"而不是"开始合成"：
      // 合成一段要几百毫秒、一整段要几秒，按合成触发的话嘴会先动完，然后才出声。
      onSpeakSegment: (text, emotion) => {
        liveRef.current.avatarRef?.current?.speak?.(text, {
          emotion,
          // 口型时长要跟真实语速一致，否则长句会"嘴不够用"或"提前闭嘴"
          speed: buildTtsCfg(liveRef.current.lang).speed ?? 1,
        });
      },
      // 播完 / 被打断 / 用户取消 —— 任何一条路都要闭嘴
      onSpeakEnd: () => liveRef.current.avatarRef?.current?.stopSpeaking?.(),
    });

    sessionRef.current = session;
    // App 一进来就把通知权限问了，别等到要设提醒时才弹（那时用户会懵）
    setupNotifications().catch(() => {});

    return () => {
      session.dispose();
      songRef.current?.unloadAsync().catch(() => {});
    };
  }, [buildTtsCfg]);

  /** 点麦克风：录音中→发送 / 说话中→打断 / 空闲→开始录 */
  const toggle = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setError(null);

    if (s.state === 'recording') {
      setState('thinking');
      await s.processTurn();
    } else if (s.state === 'speaking') {
      await s.handleBargeIn();
    } else {
      setSubtitle('');
      await s.startRecording();
    }
  }, []);

  const cancel = useCallback(async () => {
    await sessionRef.current?.cancel();
    setState('idle');
    setSubtitle('');
  }, []);

  // 上次"自己开口"的时间戳。戳一下就出声很爽，但连着戳十下会变成噪音，
  // 所以加个冷却 —— 冷却期内再戳只会做动作不出声。
  const lastSayRef = useRef(0);

  /**
   * 让她直接说一句话（不走录音、不走大模型）。
   * 戳一下、摸一下、被捏脸时的"哎！"就靠这个。
   *
   * @param {string} text 可以带 [gentle] 这类情绪标记
   * @param {object} [opts]
   * @param {boolean} [opts.force]  正在说话/思考时也要打断插进去
   * @param {number}  [opts.cooldown] 冷却秒数，默认 0.9
   * @returns {Promise<boolean>} 到底有没有出声（没配 TTS 会静默降级成只显示字幕）
   */
  const say = useCallback(async (text, opts = {}) => {
    const s = sessionRef.current;
    if (!s || !text) return false;

    const now = Date.now() / 1000;
    const cd = opts.cooldown ?? 0.9;
    if (!opts.force && now - lastSayRef.current < cd) return false;

    // 用户在说话、或者在等大模型回包的时候，别抢话 —— 那很烦人
    if (!opts.force && (s.state === 'recording' || s.state === 'thinking')) return false;

    lastSayRef.current = now;
    try {
      if (opts.force && s.state === 'speaking') await s.handleBargeIn();
      await s.speak(text, { tts: buildTtsCfg(liveRef.current.lang) });
      return true;
    } catch (e) {
      // 出声失败不该影响戳一下的动画和动作，吞掉
      console.warn('[voice] say 失败：', e?.message || e);
      return false;
    }
  }, [buildTtsCfg]);

  return {
    state, level, subtitle, error, detectedLang, usedTools,
    toggle, cancel, say,
    clearError: () => setError(null),
    isBusy: state === 'thinking' || state === 'speaking',
  };
}
