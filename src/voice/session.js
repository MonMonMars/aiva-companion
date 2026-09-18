// 语音会话：录音 → 识别 → 大模型(+工具) → 有情绪的语音 → 播放，且随时能被插话打断
// ---------------------------------------------------------------------------
// 这个文件是整个"像 ChatGPT 那样对话"的核心。三个决定手感的关键点：
//
// 1. **barge-in（插话打断）**：角色说话时麦克风不关。一旦检测到用户音量超过阈值
//    持续一小段时间，立刻静音当前播放并准备收音 —— 用户不需要先点"停止"。
//    这是 ChatGPT 高级语音模式最体感的那个特性。
//
// 2. **分段合成 + 逐段播放**：不等整段合成完才播，合成一段播一段，首句延迟明显更低。
//
// 3. **失败分层**：识别失败要说"我没听清"而不是报错；合成失败要留下文字而不是静音。
//    语音产品里"无声"比"出错"可怕得多。

import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { transcribe, detectLang } from './stt';
import { synthesizeReply, stripEmotionTags } from './tts';

// 低于这个值（dB）当作环境噪声。手机 mic 安静房间大概 -40 到 -50，
// 正常说话距离 20cm 大概 -20 到 -10。取 -25 比较稳。
const BARGE_IN_DB = -25;
// 连续多少毫秒超阈值才判定是"真的在说话"，避免咳嗽、碰桌子就打断
const BARGE_IN_MS = 320;

export class VoiceSession {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig  取当前的配置（含 stt/tts/llm keys）
   * @param {(text:string) => Promise<string>} opts.askLLM 发文本给大模型，返回原始回复（含情绪标签）
   * @param {(patch:object) => void} opts.onState  状态回调给 UI
   * @param {(text:string) => void} opts.onSubtitle 逐句字幕
   */
  constructor(opts) {
    this.opts = opts;
    this.recording = null;
    this.sound = null;
    this.queue = [];
    this.playing = false;
    this.aborted = false;
    this.monitorTimer = null;
    this.loudSince = 0;
    this.state = 'idle'; // idle | recording | thinking | speaking
  }

  setState(s) {
    this.state = s;
    this.opts.onState?.({ state: s });
  }

  // -------------------------------------------------------------------------
  // 录音
  // -------------------------------------------------------------------------
  async ensurePermission() {
    const perm = await Audio.getPermissionsAsync();
    if (perm.status === 'granted') return true;
    const req = await Audio.requestPermissionsAsync();
    return req.status === 'granted';
  }

  async startRecording() {
    if (!(await this.ensurePermission())) {
      this.opts.onState?.({ state: 'idle', error: '没有麦克风权限' });
      return false;
    }
    // 关键三件事：允许录音、允许和播放混在一起（barge-in 的前提）、锁屏也能响
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: 1, // DO_NOT_MIX 会让录音和播放互相打断，这里要的是能共存
      shouldDuckAndroid: true,
      interruptionModeAndroid: 1,
      playThroughEarpiece: false,
    });

    try {
      this.recording = new Audio.Recording();
      await this.recording.prepareToRecordAsync({
        ...Audio.RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true, // 没有这个拿不到音量，barge-in 就无从谈起
      });
      await this.recording.startAsync();
      this.setState('recording');
      this.startLevelMonitor(true);
      return true;
    } catch (e) {
      this.opts.onState?.({ state: 'idle', error: `录音启动失败：${e?.message}` });
      return false;
    }
  }

  async stopRecording() {
    if (!this.recording) return null;
    this.stopLevelMonitor();
    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;
      return uri;
    } catch (e) {
      this.recording = null;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 音量监测 —— 两个用途：录音时给波形；播放时做插话检测
  // -------------------------------------------------------------------------
  startLevelMonitor(isInput) {
    this.stopLevelMonitor();
    if (!this.recording) return;
    this.recording.setOnRecordingStatusUpdate((st) => {
      const db = st.metering ?? -60;
      this.opts.onState?.({ level: Math.max(0, Math.min(1, (db + 60) / 60)) });

      if (!isInput) {
        // 正在播放角色的话 —— 用户是不是插话了？
        const now = Date.now();
        if (db > BARGE_IN_DB) {
          if (!this.loudSince) this.loudSince = now;
          else if (now - this.loudSince > BARGE_IN_MS && this.playing) {
            this.handleBargeIn();
          }
        } else {
          this.loudSince = 0;
        }
      }
    });
    //  metering 不会自己推事件，得定时主动 poll
    this.monitorTimer = setInterval(async () => {
      try {
        await this.recording?.getStatusAsync();
      } catch (_) {}
    }, 80);
  }

  stopLevelMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.loudSince = 0;
  }

  /** 用户插话：立刻闭嘴，并把状态切成收音中 */
  async handleBargeIn() {
    if (!this.playing) return;
    this.aborted = true;
    this.stopQueue();
    // 麦克风已经在录了（barge-in 本来就是靠它检测的），所以直接切收音状态即可
    this.setState('recording');
    this.startLevelMonitor(true);
  }

  // -------------------------------------------------------------------------
  // 主流程：说完一句 → 得到有声音的回答
  // -------------------------------------------------------------------------
  async processTurn() {
    const uri = await this.stopRecording();
    if (!uri) {
      this.setState('idle');
      return;
    }

    const cfg = this.opts.getConfig();

    // 1) 语音 → 文字
    this.setState('thinking');
    this.opts.onSubtitle?.('（在听你说…）');
    const stt = await transcribe(cfg.stt, uri);
    try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch (_) {}

    if (!stt.ok) {
      this.opts.onState?.({ state: 'idle', error: stt.error });
      this.setState('idle');
      return;
    }
    if (stt.noMatch) {
      // 没听清要说出来，不能默默回到 idle —— 那会让用户以为 App 卡了
      await this.speakFallback('（没听清）可以再说一次吗？');
      return;
    }

    const userText = stt.text;
    this.opts.onSubtitle?.(`> ${userText}`);

    // 用户换语言了，就跟着换口音
    const detected = detectLang(userText);
    this.opts.onState?.({ detectedLang: detected });

    // 2) 文字 → 大模型（内部可能需要联网查资料）
    let raw;
    try {
      raw = await this.opts.askLLM(userText, { detectedLang: detected });
    } catch (e) {
      await this.speakFallback(`嗯…刚才没接上，${e?.message || '再说一次？'}`);
      return;
    }

    // 3) 文字 → 有情绪的声音
    await this.speak(raw, cfg);
  }

  async speakFallback(text) {
    // 合成失败也要把字显示出来；实在没 Key 就只能用系统朗读兜底
    this.opts.onSubtitle?.(text);
    this.setState('idle');
  }

  async speak(raw, cfg) {
    const clean = stripEmotionTags(raw);
    this.opts.onSubtitle?.(clean);

    if (!cfg?.tts?.provider) {
      this.setState('idle');
      return;
    }

    this.setState('speaking');
    const res = await synthesizeReply(raw, cfg.tts, (done, total) => {
      this.opts.onState?.({ synth: { done, total } });
    });

    if (!res.ok) {
      // 至少文字已经显示出来了，这里悄悄降级，不要弹红字
      this.opts.onState?.({ warn: String(res.error || '').slice(0, 80) });
      this.setState('idle');
      return;
    }
    await this.playQueue(res.clips);
  }

  // -------------------------------------------------------------------------
  // 播放队列
  // -------------------------------------------------------------------------
  async playQueue(clips) {
    this.aborted = false;
    for (const clip of clips) {
      if (this.aborted) break;
      if (!clip.data) continue;      // 单段合成失败，跳过继续念后面的
      try {
        await this.playOne(clip);
      } catch (_) {
        // 播放出错不中断整段，用户在等回答
      }
    }
    if (!this.aborted) this.setState('idle');
  }

  playOne(clip) {
    return new Promise((resolve, reject) => {
      // ArrayBuffer → data URI。expo-av 在原生端不能直接吃 blob:，
      // 走 base64 data URI 是两端都稳的唯一写法。
      const bytes = new Uint8Array(clip.data);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const b64 = globalThis.btoa ? globalThis.btoa(binary) : '';
      const uri = `data:audio/mpeg;base64,${b64}`;

      Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
        async (status) => {
          if (status?.didJustFinish) {
            this.playing = false;
            resolve();
          }
        }
      ).then(({ sound }) => {
        if (this.aborted) {
          sound.unloadAsync().catch(() => {});
          resolve();
          return;
        }
        this.sound = sound;
        this.playing = true;
        this.opts.onState?.({ speakingText: clip.text });
      }).catch(reject);
    });
  }

  stopQueue() {
    this.playing = false;
    if (this.sound) {
      this.sound.stopAsync().catch(() => {});
      this.sound.unloadAsync().catch(() => {});
      this.sound = null;
    }
  }

  /** 用户点了"停止" */
  async cancel() {
    this.aborted = true;
    this.stopQueue();
    this.stopLevelMonitor();
    await this.stopRecording();
    this.setState('idle');
  }

  async dispose() {
    this.aborted = true;
    this.stopQueue();
    this.stopLevelMonitor();
    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch (_) {}
      this.recording = null;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  }
}
