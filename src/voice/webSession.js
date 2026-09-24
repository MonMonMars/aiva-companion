// 浏览器端语音会话（Web 版专用）
// ---------------------------------------------------------------------------
// 原生端用 expo-av 走录音/播放，那些是 React Native 原生模块，浏览器里没有。
// 云端纯前端部署时走这里：出声用浏览器自带的 SpeechSynthesis（无需 Key），
// 录音用 webkitSpeechRecognition（免费、无需 Key，不可用时自动降级为纯文字）。
//
// 这样纯前端部署到云端后，iPhone 上"戳一下出声"、聊天回复念出来都可用，
// 而且不暴露任何第三方 API Key。
//
// 接口故意和 voice/session.js 的 VoiceSession 对齐（state / startRecording /
// processTurn / handleBargeIn / cancel / dispose / speak），useVoice 只用 Platform 切换。

import { stripEmotionTags } from './tts';
import { pickYueVoice, ensureVoices, unlockSpeech, isYueVoice, YUE } from './cantonese';
import { MicRecorder, micSupport } from './webRecorder';
import { transcribe, detectLang } from './stt';
import { speakEspeak } from './espeak';
import { currentCountry, ccName, sttStatus } from '../lib/region';

export class WebVoiceSession {
  constructor(opts) {
    this.opts = opts || {};
    this.state = 'idle'; // idle | recording | thinking | speaking
    this.aborted = false;
    this.playing = false;
    this.recognition = null;
    this.recorder = null;
    this.mode = null; // 'recorder' | 'asr' | null
    this._heard = '';
    const w = typeof window !== 'undefined' ? window : null;
    this.synth = (w && w.speechSynthesis) || null;
    this.recogCtor = w ? (w.SpeechRecognition || w.webkitSpeechRecognition) : null;
    // 音色列表是异步填充的，先起个 Promise 预热，真要开口时多半已经就绪
    this.voicesReady = this.synth ? ensureVoices(this.synth) : Promise.resolve([]);
    // 给无头验证/排障用：实际选中的音色写这里
    if (w && this.synth) w.__yueVoicePicked = null;
  }

  /** 这个 locale 是不是粤语 */
  _isYue(lang) {
    const l = String(lang || '').toLowerCase().replace(/_/g, '-');
    return l.startsWith('zh-hk') || l.startsWith('zh-hant-hk') || l.startsWith('yue');
  }

  /** 拿一个粤语声音；列表还没好就等一下再试，都没有就返回 null */
  async _yueVoice() {
    if (!this.synth) return null;
    let v = pickYueVoice(this.synth);
    if (v) return v;
    try { await this.voicesReady; } catch (_) {}
    v = pickYueVoice(this.synth);
    if (v) return v;
    try { await ensureVoices(this.synth, 1200); } catch (_) {}
    return pickYueVoice(this.synth);
  }

  setState(s) {
    this.state = s;
    this.opts.onState?.({ state: s });
  }

  _lang() {
    const cfg = this.opts.getConfig?.();
    return cfg?.tts?.locale || cfg?.locale || 'zh-CN';
  }

  // -------------------------------------------------------------------------
  // 出声：浏览器自带 TTS 念出来，同时驱动 3D 角色对口型
  // -------------------------------------------------------------------------
  /**
   * 出声主入口。
   * - provider === 'espeak'：走浏览器内 eSpeak NG WASM（真正离线、免 Key），见 _speakEspeak
   * - 其余（edge / openai / azure / elevenlabs）：走浏览器自带 SpeechSynthesis。
   *   'edge' 会优先挑 Microsoft 神经 zh-HK 嗓音（在 Edge/Windows 上就是真正的 Edge TTS），免 Key。
   */
  async speak(raw, cfg) {
    const text = stripEmotionTags(raw || '');
    this.opts.onSubtitle?.(text);
    if (!text) {
      this.setState('idle');
      return;
    }
    const provider = cfg?.tts?.provider;
    if (provider === 'espeak') {
      return this._speakEspeak(text, cfg);
    }
    return this._speakSynth(text, cfg, provider === 'edge');
  }

  /** 浏览器自带 SpeechSynthesis 出声（edge 优先微软神经嗓音） */
  async _speakSynth(text, cfg, preferEdge) {
    if (!this.synth) {
      // 浏览器不支持 SpeechSynthesis：至少留字幕，不报错
      this.setState('idle');
      return;
    }

    // iOS 上第一次 speak 必须发生在用户手势里，否则静默失败（不报错、就是没声）。
    // 大模型回包是异步的，那时手势早过了，所以每次都尝试解锁一次（内部有去重）。
    unlockSpeech(this.synth);

    const lang = (cfg?.tts?.locale) || this._lang();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;

    // 粤语：只设 lang 是不够的。很多浏览器（尤其 iOS 内嵌 WebView）会拿一个
    // 普通话声音去念粤语稿，念出来就是塑料粤语。必须显式指定粤语 voice。
    if (this._isYue(lang)) {
      const voice = preferEdge
        ? ((await this._edgeVoice()) || (await this._yueVoice()))
        : (await this._yueVoice());
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang || lang;
      } else {
        console.warn('[voice] 这台设备没有粤语声音，只能拿默认声音念粤语稿');
      }
      if (typeof window !== 'undefined') {
        window.__yueVoicePicked = voice ? { name: voice.name, lang: voice.lang } : { name: null, lang };
      }
    }
    // 排障用：把实际朗读的语言写出去，无头探针会读它
    if (typeof window !== 'undefined') window.__spokenLocale = lang;

    u.rate = Math.max(0.7, Math.min(1.3, cfg?.tts?.speed ?? 1));

    this.setState('speaking');
    this.playing = true;

    u.onstart = () => {
      this.playing = true;
      this.opts.onSpeakSegment?.(text, null);
    };
    // 每个词重新触发一下，让嘴一直跟着动（SpeechSynthesis 没有精确音素事件）
    u.onboundary = () => {
      if (!this.aborted) this.opts.onSpeakSegment?.(text, null);
    };
    const finish = () => {
      this.playing = false;
      this.opts.onSpeakEnd?.();
      if (!this.aborted) this.setState('idle');
    };
    u.onend = finish;
    u.onerror = finish;

    try {
      this.synth.cancel(); // 打断上一句
    } catch (_) {}
    this.synth.speak(u);
  }

  /** 微软神经 zh-HK 嗓音（Edge/Windows 自带，Edge TTS 的本体）。挑不到返回 null。 */
  async _edgeVoice() {
    if (!this.synth) return null;
    const voices = await ensureVoices(this.synth);
    const yue = voices.filter(isYueVoice);
    const neural = yue.filter((v) =>
      /HiuGaaiNeural|HiuMaanNeural|WanLungNeural|GaaiNeural|Microsoft Server Speech Text to Speech Voice \(zh-HK/i.test(v.name || ''));
    return neural[0] || yue[0] || null;
  }

  /** eSpeak NG WASM 出声（真正离线、免 Key）。任何失败都回落浏览器语音，保证不出静音。 */
  async _speakEspeak(text, cfg) {
    const lang = (cfg?.tts?.locale) || this._lang();
    this.setState('speaking');
    this.playing = true;
    this.opts.onSpeakSegment?.(text, null);
    try {
      await speakEspeak(text, { lang, speed: cfg?.tts?.speed ?? 1 });
    } catch (e) {
      console.warn('[voice] eSpeak 合成失败，回落浏览器语音：', e?.message || e);
      return this._speakSynth(text, cfg, false);
    } finally {
      this.playing = false;
      this.opts.onSpeakEnd?.();
      if (!this.aborted) this.setState('idle');
    }
  }

  async speakFallback(text) {
    this.opts.onSubtitle?.(text);
    this.setState('idle');
  }

  // -------------------------------------------------------------------------
  // 录音
  // -------------------------------------------------------------------------
  // ⚠️ 这里是 2026-09 修过的重灾区。原实现只认 webkitSpeechRecognition，
  //    而 iOS Safari **根本没实现它**（WebKit Bug #170773，标记 Not planned），
  //    于是 iPhone 上一律走"此浏览器不支持语音输入"，系统麦克风权限弹窗
  //    一次都没弹过 —— 用户看到的就是"只能打字"。
  //    正确顺序：配了听写 Key → getUserMedia 录音 + 云端识别（iPhone 唯一通路）；
  //    没配 Key 但浏览器自带识别（桌面 Chrome）→ 退回自带识别；
  //    都没有 → 给一句"去哪配 Key"的人话，而不是干巴巴的"不支持"。
  //
  // this.mode: 'recorder'（录完上传） | 'asr'（浏览器自带） | null

  /**
   * 这家听写服务需要的 Key 齐了没
   *
   * ⚠️ 2026-09 踩过的坑：这里原来是 switch + default: return !!k.openaiKey，
   *    后来加了 ElevenLabs 供应商却**忘了给这里加 case**，结果
   *    「明明装了 ek，iPhone 上点麦还是报没配 Key」—— default 帮 elevenlabs
   *    答了 false，直接掉了浏览器自带识别那条死路。
   *    教训：新增 STT 供应商必须同时更新 providers.js / stt.js / useVoice.js /
   *    keyLink.js / App.js / **这里**。所以下面改成显式列表 + 明确 default:false。
   */
  _sttReady(stt) {
    const k = stt?.keys || {};
    switch (stt?.provider) {
      case 'gemini': return !!k.geminiKey;
      case 'elevenlabs': return !!k.elevenKey;
      case 'groq': return !!k.groqKey;
      case 'azure': return !!(k.azureKey && k.azureRegion);
      case 'siliconflow': return !!k.siliconKey;
      case 'openai': return !!k.openaiKey;
      default: return false;
    }
  }

  /**
   * 没配 Key 时该说什么 —— 得看人在哪。
   * 全世界通用的是 ElevenLabs；Gemini 免费额度最大但有地区门槛
   * （中国内地/香港/澳门不在 Google 名单里，EEA/瑞士/英国禁止用免费层）。
   * 在受限地区还硬推 Gemini，等于让人去申请一把注定拿不到的 Key。
   */
  _noKeyError() {
    const where = currentCountry();
    const st = sttStatus(where, 'gemini');
    const head = '还没配「听懂你说话」的 Key：右上角 ☰ → 语音设置 → 耳朵，选一家填上去就行。';
    if (where && st.level === 'ok') {
      return head + '你在' + ccName(where) + '，推荐 Gemini（Google 账号免费拿，额度最大）；'
        + '介意录音被用于改进 Google 产品的话用 ElevenLabs（邮箱注册就有，还能顺便当她的嗓子）。';
    }
    if (where) {
      return head + '推荐 ElevenLabs（邮箱注册就有，听说共用一把 Key，全世界基本都能用）。'
        + 'Gemini 免费额度更大，但' + (st.msg || '你现在所在的地区用不了它') + '。';
    }
    return head + '想听粤语又不想办中国实名：推荐 ElevenLabs（邮箱注册就有，全世界基本都能用）'
      + '或 Gemini（Google 账号免费拿，额度最大，但部分地区用不了）。';
  }

  async startRecording() {
    const cfg = this.opts.getConfig?.() || {};
    const stt = cfg.stt || {};

    // 点麦是货真价实的用户手势，在这里解锁最稳
    unlockSpeech(this.synth);

    const cloud = this._sttReady(stt);
    const sup = micSupport();

    if (cloud && sup.ok) {
      this.mode = 'recorder';
      this.recorder = new MicRecorder({
        onLevel: (lv) => this.opts.onState?.({ level: lv }),
        // 说完停一下就自动收尾，不用再点一次 —— ChatGPT 的手感
        onAutoStop: () => {
          if (this.state === 'recording') this.processTurn();
        },
      });
      const r = await this.recorder.start();
      if (!r.ok) {
        this.mode = null;
        this.recorder = null;
        this.opts.onState?.({ state: 'idle', error: r.error, level: 0 });
        return false;
      }
      this.setState('recording');
      return true;
    }

    if (cloud && !sup.ok) {
      this.opts.onState?.({ state: 'idle', error: sup.hint || '这个环境不能录音' });
      return false;
    }

    // 没配 Key：桌面 Chrome 还能白嫖自带识别；iPhone 上这条必然是 undefined
    if (this.recogCtor) {
      this.mode = 'asr';
      return this._startAsr();
    }

    this.opts.onState?.({ state: 'idle', error: this._noKeyError() });
    return false;
  }

  _startAsr() {
    try {
      const rec = new this.recogCtor();
      rec.lang = this._lang();
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      this._heard = '';
      rec.onresult = (e) => {
        this._heard = e.results?.[0]?.[0]?.transcript || '';
      };
      rec.onerror = (e) => {
        // not-allowed = 用户拒了麦；这时光说"识别失败"没用，得告诉他去哪开
        if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
          this.opts.onState?.({ state: 'idle', error: '麦克风权限没开，去浏览器/系统设置里允许一下。' });
        } else {
          this.opts.onState?.({ state: 'idle', error: `语音识别失败：${e?.error || '未知'}` });
        }
      };
      rec.onend = () => {
        const txt = this._heard;
        this._heard = '';
        if (txt) this._finishTurn(txt);
        else this.setState('idle');
      };
      this.recognition = rec;
      rec.start();
      this.setState('recording');
      return true;
    } catch (e) {
      this.opts.onState?.({ state: 'idle', error: `无法启动语音识别：${e?.message || e}` });
      return false;
    }
  }

  /**
   * 收尾一次对话：停录 → 转文字 → 丢给大模型。
   * @returns {Promise<string|null>} 识别到的文字
   */
  async processTurn() {
    if (this.mode === 'recorder') {
      const rec = this.recorder;
      this.recorder = null;
      this.mode = null;
      this.opts.onState?.({ level: 0 });

      if (!rec) { this.setState('idle'); return null; }
      const r = await rec.stop();
      if (!r.ok) {
        this.opts.onState?.({ state: 'idle', error: r.error });
        return null;
      }

      // 太短的一声"嗯"没什么好识别的，直接重来，省一次网络往返
      if (r.ms < 350) {
        this.opts.onState?.({ state: 'idle', error: '太短啦，再说清楚一点？' });
        return null;
      }

      this.setState('thinking');
      const cfg = this.opts.getConfig?.() || {};
      let res;
      try {
        res = await transcribe(cfg.stt || {}, r.url);
      } finally {
        try { URL.revokeObjectURL(r.url); } catch (_) {}
      }
      if (!res.ok) {
        this.opts.onState?.({ state: 'idle', error: res.error || '识别失败' });
        return null;
      }
      if (res.noMatch || !res.text) {
        this.opts.onState?.({ state: 'idle', error: '没听清，靠近一点再说一次？' });
        return null;
      }
      this._finishTurn(res.text);
      return res.text;
    }

    // 浏览器自带识别：onend 里已经处理了；这里兜底处理还没触发的情形
    const txt = await this.stopRecording();
    if (txt) this._finishTurn(txt);
    return txt || null;
  }

  async stopRecording() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
    }
    return this._heard || null;
  }

  async _finishTurn(userText) {
    if (!userText) {
      this.setState('idle');
      return;
    }
    this.setState('thinking');
    this.opts.onSubtitle?.(`> ${userText}`);
    try {
      // 顺手判一下他这次说的是哪种话，让角色切口音跟上
      // （"粤语提问、普通话回答"就是少了这一步）
      const heard = detectLang(userText);
      const raw = await this.opts.askLLM(userText, { detectedLang: heard });
      const cfg = this.opts.getConfig?.();
      await this.speak(raw, { tts: cfg?.tts });
    } catch (e) {
      await this.speakFallback(`嗯…刚才没接上，${e?.message || '再说一次？'}`);
    }
  }

  // -------------------------------------------------------------------------
  // 打断 / 取消 / 释放
  // -------------------------------------------------------------------------
  async handleBargeIn() {
    this.aborted = true;
    if (this.synth) {
      try { this.synth.cancel(); } catch (_) {}
    }
    this.playing = false;
    this.opts.onSpeakEnd?.();
    this.setState('recording');
  }

  async cancel() {
    this.aborted = true;
    if (this.synth) {
      try { this.synth.cancel(); } catch (_) {}
    }
    if (this.recognition) {
      try { this.recognition.abort(); } catch (_) {}
    }
    if (this.recorder) {
      try { this.recorder.cancel(); } catch (_) {}
      this.recorder = null;
    }
    this.mode = null;
    this.playing = false;
    this.opts.onSpeakEnd?.();
    this.setState('idle');
  }

  async dispose() {
    this.aborted = true;
    if (this.synth) {
      try { this.synth.cancel(); } catch (_) {}
    }
    if (this.recognition) {
      try { this.recognition.abort(); } catch (_) {}
    }
    if (this.recorder) {
      try { this.recorder.cancel(); } catch (_) {}
      this.recorder = null;
    }
  }
}
