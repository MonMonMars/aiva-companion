// 把「录音 / 识别 / 大模型 / 联网工具 / 情绪语音 / 播放」串成一个 Hook
// ---------------------------------------------------------------------------
// 界面只负责：显示状态、放麦克风按钮、显示字幕。
// 所有脏活（音频队列、打断检测、工具回调）都在这个 Hook 里面，UI 不需要知道。

import { useEffect, useRef, useCallback, useState } from 'react';
import { VoiceSession } from './voice/session';
import { stripEmotionTags } from './voice/tts';
import { chatWithTools } from './chatEngine';
import { resolveVoice, getPersona } from './theme';
import { scheduleReminder, setupNotifications } from './services/reminders';
import { matchSong, renderSong } from './services/songs';
import { Audio } from 'expo-av';
import * as S from './store';

export function useVoice({ personaId, snap, history, kidMode, lang }) {
  const sessionRef = useRef(null);
  const songRef = useRef(null);

  const [state, setState] = useState('idle'); // idle|recording|thinking|speaking
  const [level, setLevel] = useState(0);
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState(null);
  const [detectedLang, setDetectedLang] = useState(null);
  const [usedTools, setUsedTools] = useState([]);

  // 这些每次渲染都在变，用 ref 兜住，避免 session 被反复重建
  const liveRef = useRef({ personaId, snap, history, kidMode, lang });
  liveRef.current = { personaId, snap, history, kidMode, lang };

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
    const session = new VoiceSession({
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
              azureKey: v.azureKey,
              azureRegion: v.azureRegion,
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

  return {
    state, level, subtitle, error, detectedLang, usedTools,
    toggle, cancel,
    clearError: () => setError(null),
    isBusy: state === 'thinking' || state === 'speaking',
  };
}
