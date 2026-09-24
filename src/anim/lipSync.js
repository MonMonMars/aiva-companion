// 口型同步 + 表情驱动
// ---------------------------------------------------------------------------
// 为什么不用音频分析（WebAudio AnalyserNode）做口型：
//   1. Expo 原生端没有 WebAudio，那条路直接在另一半平台废掉；
//   2. 三家 TTS 拿到的都是 mp3，要解码成 PCM 才能算频谱，多一层依赖和延迟；
//   3. **听不出差别，但省一大截电**。口型的目标是"看着在说话"，不是还原频谱。
//      用文本 + 时间驱动，视觉上完全够，而且离线可用、可测试。
//
// 所以这里的做法是：**文本 → 音素 → 口型（viseme）→ 按时间推进**。
//
// 中文用拼音首字母分级，英文按元音/辅音分组，映射到 ARKit 的嘴部形状。
// 这条链路是纯函数，pipeline.test.mjs 里可以直接断言，不依赖任何 API key。
//
// 分两层：
//   - 情绪层：TTS 的 [laughs] / [sad] 这些标签 → 眉眼表情（持续性，缓慢过渡）
//   - 说话层：文字 → 口型（瞬时性，快速跳变）
// 两者作用在不同的 morph 上，互不打架，所以可以叠加。

import { ARKIT_INDEX } from './faceStandard';

// ---------------------------------------------------------------------------
// 情绪 → 表情参数
// ---------------------------------------------------------------------------
// 数值是"权重上限"，运行时还会乘上一个总强度（说话时弱一点，免得表情吃掉口型）。
export const EMOTION_FACE = {
  laughs:    { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.7, cheekSquintRight: 0.7, eyeSquintLeft: 0.5, eyeSquintRight: 0.5, jawOpen: 0.25 },
  giggles:   { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.4, eyeSquintRight: 0.4 },
  sighs:     { mouthFrownLeft: 0.3, mouthFrownRight: 0.3, browInnerUp: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  excited:   { browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.7, eyeWideRight: 0.7, mouthSmileLeft: 0.6, mouthSmileRight: 0.6, jawOpen: 0.2 },
  comfort:   { browInnerUp: 0.5, mouthSmileLeft: 0.3, mouthSmileRight: 0.3, eyeSquintLeft: 0.25, eyeSquintRight: 0.25 },
  gentle:    { mouthSmileLeft: 0.4, mouthSmileRight: 0.4, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  sad:       { mouthFrownLeft: 0.6, mouthFrownRight: 0.6, browInnerUp: 0.65, eyeSquintLeft: 0.35, eyeSquintRight: 0.35 },
  shy:       { mouthSmileLeft: 0.5, mouthSmileRight: 0.5, browInnerUp: 0.3, cheekSquintLeft: 0.35, cheekSquintRight: 0.35 },
  whispers:  { mouthPucker: 0.35, eyeSquintLeft: 0.3, eyeSquintRight: 0.3, browInnerUp: 0.2 },
  surprised: { jawOpen: 0.5, eyeWideLeft: 1, eyeWideRight: 1, browOuterUpLeft: 0.85, browOuterUpRight: 0.85, browInnerUp: 0.5 },
  curious:   { browOuterUpLeft: 0.55, browOuterUpRight: 0.35, eyeWideLeft: 0.4, eyeWideRight: 0.4, mouthSmileLeft: 0.35, mouthSmileRight: 0.35 },
  serious:   { browDownLeft: 0.4, browDownRight: 0.4, mouthPressLeft: 0.3, mouthPressRight: 0.3 },
  sing:      { jawOpen: 0.45, mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  teach:     { browInnerUp: 0.3, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 },
  proud:     { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, browOuterUpLeft: 0.35, browOuterUpRight: 0.35, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  sleepy:    { eyeBlinkLeft: 0.55, eyeBlinkRight: 0.55, browInnerUp: 0.2, jawOpen: 0.3 },
};

// ---------------------------------------------------------------------------
// 文字 → 口型
// ---------------------------------------------------------------------------
// 中文按拼音韵母分组（韵母决定嘴形，声母只影响开闭）；
// 英文直接按元音分组。分组结果就是 ARKit 的嘴部形状。
//
// 这张表刻意做得粗 —— 4~5 个口型就够"看着在说话"了。
// 做细反而会因为和真实音频不同步而显得更假（恐怖谷）。
const VISEME = {
  CLOSED: { mouthClose: 1.0 },
  // 张嘴型（a / 啊）
  AA: { jawOpen: 1.0, mouthFunnel: 0.15 },
  // 圆唇（o / u / 哦）
  OU: { jawOpen: 0.5, mouthPucker: 1.0, mouthFunnel: 0.6 },
  // 扁平（i / e / 咦）
  EE: { jawOpen: 0.35, mouthSmileLeft: 0.5, mouthSmileRight: 0.5, mouthStretchLeft: 0.4, mouthStretchRight: 0.4 },
  // 中开口（默认）
  MID: { jawOpen: 0.5, mouthFunnel: 0.25 },
  // 双唇闭合（m / b / p / 呣）
  MBP: { mouthClose: 1.0, mouthPressLeft: 0.6, mouthPressRight: 0.6 },
  // 唇齿（f / v）
  FV: { mouthFunnel: 0.4, mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4 },
};

/** 拼音韵母 → 口型。取最长匹配，所以 'iao' 要先于 'ao' 命中 */
const PINYIN_FINAL = [
  ['iang', 'EE'], ['uang', 'OU'], ['iong', 'OU'], ['ueng', 'OU'],
  ['iao', 'EE'], ['ian', 'EE'], ['uai', 'OU'], ['uan', 'OU'],
  ['ang', 'AA'], ['eng', 'MID'], ['ing', 'EE'], ['ong', 'OU'],
  ['ai', 'EE'], ['ei', 'EE'], ['ao', 'AA'], ['ou', 'OU'],
  ['ia', 'EE'], ['ie', 'EE'], ['iu', 'OU'], ['ua', 'OU'], ['uo', 'OU'],
  ['ui', 'OU'], ['un', 'OU'], ['ve', 'EE'], ['ue', 'EE'],
  ['an', 'AA'], ['en', 'MID'], ['in', 'EE'],
  ['a', 'AA'], ['o', 'OU'], ['e', 'MID'], ['i', 'EE'], ['u', 'OU'], ['v', 'EE'],
];

/** 拉丁元音簇 → 口型 */
const LATIN_VOWEL = [
  ['igh', 'EE'], ['ough', 'OU'],
  ['ee', 'EE'], ['ea', 'EE'], ['ai', 'EE'], ['ay', 'EE'], ['ie', 'EE'], ['oo', 'OU'],
  ['ou', 'OU'], ['ow', 'OU'], ['oa', 'OU'], ['oi', 'OU'], ['oy', 'OU'], ['au', 'AA'],
  ['a', 'AA'], ['e', 'MID'], ['i', 'EE'], ['o', 'OU'], ['u', 'OU'], ['y', 'EE'],
];

const MBP_RE = /[mbp]|呣|唔|姆|妈|买|波|泼|摸/;
const FV_RE = /[fv]|发|飞|风|佛/;

/**
 * 把一句话切成"口型帧"序列。
 *
 * 每条帧是 { viseme, at, dur }，at/dur 单位是**相对该句起点**的秒。
 * 时长按音节数估：中文约 4.5 音节/秒，英文约 3.2 词/秒 —— 这是普通话
 * 正常语速下的经验值，比按字符数估准得多（标点、空格不该占时长）。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.speed=1] 语速倍率（对应 TTS 的 speed 参数）
 * @returns {Array<{viseme:string, at:number, dur:number}>}
 */
export function textToVisemes(text, opts = {}) {
  const { speed = 1 } = opts;
  const raw = String(text || '');
  if (!raw.trim()) return [];

  const frames = [];
  let t = 0;
  // 中文 4.5 音节/秒，英文按元音簇数；两者混排时各算各的
  const cjkRate = 4.5 * speed;
  const latinRate = 3.2 * speed;

  // 逐字符扫，遇到 Latin 单词整体处理（元音簇才是口型单位）
  const tokens = raw.match(/[\u4e00-\u9fff]|[A-Za-z]+|[0-9]+|\s+|[^\sA-Za-z0-9\u4e00-\u9fff]/g) || [];

  for (const tk of tokens) {
    // 空白和标点：给一点停顿（闭嘴），但不出帧
    if (/^\s+$/.test(tk)) { t += 0.06 / speed; continue; }
    if (/^[^\sA-Za-z0-9\u4e00-\u9fff]$/.test(tk)) {
      if (/[。！？!?；;]/.test(tk)) {
        frames.push({ viseme: 'CLOSED', at: t, dur: 0.2 / speed });
        t += 0.24 / speed;
      } else if (/[，,、：:]/.test(tk)) {
        frames.push({ viseme: 'CLOSED', at: t, dur: 0.12 / speed });
        t += 0.16 / speed;
      } else {
        t += 0.08 / speed;
      }
      continue;
    }

    if (/^[\u4e00-\u9fff]$/.test(tk)) {
      // 汉字：不知道读音，用"字符码 + 上下文"的稳定哈希挑一个口型。
      // 这是**故意**的：真实拼音要一张 2 万字的表（或有损），而口型只要
      // 在几个形状之间跳变就已经像在说话了。用哈希保证同一个字每次口型一致，
      // 不会闪来闪去。
      const dur = 1 / cjkRate;
      let v = 'MID';
      // 少数强特征字直接给准口型，其它走哈希
      if (/[啊哈呀哇啦嘛哪]/.test(tk)) v = 'AA';
      else if (/[哦噢喔我握]/.test(tk)) v = 'OU';
      else if (/[诶欸嘿衣一咦]/.test(tk)) v = 'EE';
      else if (/[唔呣姆]/.test(tk)) v = 'MBP';
      else {
        const code = tk.charCodeAt(0);
        v = ['AA', 'OU', 'EE', 'MID'][code % 4];
      }
      frames.push({ viseme: v, at: t, dur: dur * 0.92 });
      t += dur;
      continue;
    }

    if (/^[0-9]+$/.test(tk)) {
      // 数字按"几个音节"算口型
      for (let i = 0; i < tk.length; i++) {
        const dur = 1 / latinRate;
        frames.push({ viseme: ['AA', 'OU', 'EE', 'MID'][Number(tk[i]) % 4], at: t, dur: dur * 0.9 });
        t += dur;
      }
      continue;
    }

    // 拉丁单词：找元音簇
    const w = tk.toLowerCase();
    let i = 0;
    let syllables = 0;
    while (i < w.length) {
      // 双唇音优先（visual-only，视觉上最明显）
      if (i === 0 && MBP_RE.test(w[i])) {
        frames.push({ viseme: 'MBP', at: t, dur: 0.09 / speed });
        t += 0.09 / speed;
        i++;
        syllables++;
        continue;
      }
      if (i === 0 && FV_RE.test(w[i])) {
        frames.push({ viseme: 'FV', at: t, dur: 0.09 / speed });
        t += 0.09 / speed;
        i++;
        syllables++;
        continue;
      }
      let hit = null;
      for (const [pat, v] of LATIN_VOWEL) {
        if (w.startsWith(pat, i)) { hit = { pat, v }; break; }
      }
      if (hit) {
        const dur = 1 / latinRate;
        frames.push({ viseme: hit.v, at: t, dur: dur * 0.9 });
        t += dur;
        syllables++;
        i += hit.pat.length;
      } else {
        i++; // 辅音不单独出帧
      }
    }
    // 一个词里没有一个元音（如 "hmm"）也要有嘴形，否则会僵住
    if (!syllables) {
      frames.push({ viseme: 'MID', at: t, dur: 1 / latinRate * 0.8 });
      t += 1 / latinRate;
    }
    t += 0.05 / speed; // 词间微停顿，不然连成一串
  }

  return frames;
}

/** 一段口型序列的总时长（秒） */
export function visemesDuration(frames) {
  if (!frames?.length) return 0;
  const last = frames[frames.length - 1];
  return last.at + last.dur;
}

/**
 * 取某个时刻应该摆的口型。
 * 两条相邻帧之间做了**交叉淡化**：直接跳变看起来像机械玩偶，
 * 淡入淡出才像肌肉在动。
 *
 * @param {Array} frames textToVisemes 的输出
 * @param {number} t 相对该句起点的秒
 * @param {number} [fade=0.05] 淡化窗口（秒）
 * @returns {Record<string, number>} 形如 { jawOpen: 0.8, ... }
 */
export function sampleViseme(frames, t, fade = 0.05) {
  if (!frames?.length) return {};
  const out = {};
  const acc = (name, v) => { out[name] = Math.max(out[name] || 0, v); };

  for (const f of frames) {
    // 只在 t 附近的帧上算，远处直接跳过（长句里有几百帧，全遍历没必要）
    if (t < f.at - fade || t > f.at + f.dur + fade) continue;
    const shape = VISEME[f.viseme] || VISEME.MID;

    // 上升沿 / 下降沿各淡 fade 秒，中间为 1
    let w = 1;
    if (t < f.at) w = (t - (f.at - fade)) / fade;
    else if (t > f.at + f.dur) w = 1 - (t - (f.at + f.dur)) / fade;
    w = Math.max(0, Math.min(1, w));
    if (w <= 0) continue;

    for (const [k, v] of Object.entries(shape)) acc(k, v * w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/**
 * 造一个口型 + 表情驱动器。
 *
 * @param {object} morph  applyMorphData 返回的句柄
 * @param {object} [opts]
 * @param {number} [opts.fade=0.05]      口型交叉淡化窗口
 * @param {number} [opts.emotionRate=4]  表情过渡速度（越大越快）
 * @returns {null | object}
 */
export function createLipSync(morph, opts = {}) {
  if (!morph || typeof morph.setAll !== 'function') return null;

  const { fade = 0.05, emotionRate = 4 } = opts;

  // 当前说话计划
  let frames = [];
  let startedAt = 0;
  let speaking = false;

  // 表情：目标值 + 当前值，逐步过渡
  let emotion = null;
  const emoCur = {};   // 名字 -> 当前权重
  const emoDst = {};   // 名字 -> 目标权重

  // 眨眼也走这里统一出口，免得两处写 morph 打架
  let blink = 1;

  const ALL_EMO_KEYS = new Set();
  for (const dict of Object.values(EMOTION_FACE)) {
    for (const k of Object.keys(dict)) ALL_EMO_KEYS.add(k);
  }

  /**
   * 开始说一句话。
   * @param {string} text  要朗读的文本（可以带 [laughs] 这类标签，会被忽略）
   * @param {object} [o]
   * @param {number} [o.at=0]    现在时间（秒）
   * @param {string} [o.emotion] 情绪标签
   * @param {number} [o.speed=1] 语速
   */
  function speak(text, o = {}) {
    const { at = 0, emotion: emo = null, speed = 1 } = o;
    // 标签对白没有意义，先剥掉再转口型；它们走 emotion 通道
    const clean = String(text || '').replace(/\[[A-Za-z0-9_]+\]/g, ' ').replace(/［[A-Za-z0-9_]+］/g, ' ');
    frames = textToVisemes(clean, { speed });
    startedAt = at;
    speaking = frames.length > 0;
    setEmotion(emo);
    return speaking;
  }

  /** 直接给一段口型序列（调用方想自己排程时用） */
  function speakFrames(list, o = {}) {
    const { at = 0, emotion: emo = null } = o;
    frames = Array.isArray(list) ? list : [];
    startedAt = at;
    speaking = frames.length > 0;
    setEmotion(emo);
    return speaking;
  }

  /**
   * 说完 / 被打断。
   *
   * **情绪也必须一起放掉**，否则会出现这个 bug：
   * 角色带着 gentle 的 0.4 微笑权重被插话打断，嘴不动了，
   * 但那个笑**永远挂在脸上** —— 因为 emoDst 还停在 0.4，
   * 指数趋近的目标就是 0.4，趋近一万年也不会归零。
   * 所以这里是"回中立"，不是"停住"：表情会平滑地淡下去（fade 由 emotionRate 决定），
   * 既不会硬切，也不会卡住。
   */
  function stop() {
    speaking = false;
    frames = [];
    setEmotion(null);
  }

  /**
   * 切换情绪。传 null 回中立（清空表情但不硬切，会过渡回去）
   */
  function setEmotion(tag) {
    emotion = tag || null;
    const dict = (tag && EMOTION_FACE[tag]) || {};
    for (const k of ALL_EMO_KEYS) emoDst[k] = dict[k] ?? 0;
  }

  /**
   * 每帧调用。
   * @param {number} t  累计时间（秒）
   * @param {number} dt 帧间隔
   * @param {object} [s] 额外叠加
   * @param {number} [s.blink] 眨眼缩放（1=睁 0=闭）—— 口型不应该覆盖眨眼
   */
  function update(t, dt, s = {}) {
    const { blink: blinkScale } = s;
    if (typeof blinkScale === 'number') blink = blinkScale;

    // --- 表情：指数趋近，时间无关（不同帧率下速度一致）-----------------
    const k = Math.min(1, dt * emotionRate);
    const target = {};

    for (const name of ALL_EMO_KEYS) {
      emoCur[name] = (emoCur[name] ?? 0) + ((emoDst[name] ?? 0) - (emoCur[name] ?? 0)) * k;
      if (emoCur[name] > 0.004) target[name] = emoCur[name];
    }

    // --- 口型：当前时刻的瞬时形状 -------------------------------------
    if (speaking) {
      const local = t - startedAt;
      const dur = visemesDuration(frames);
      if (local < 0) {
        // 还没开始：闭嘴等
      } else if (local > dur + 0.15) {
        speaking = false;
      } else {
        const shape = sampleViseme(frames, local, fade);
        // 口型和表情叠加时取 max —— 相加会超过 1，嘴会炸开
        for (const [name, v] of Object.entries(shape)) {
          target[name] = Math.max(target[name] || 0, v);
        }
      }
    }

    // --- 眨眼 ---------------------------------------------------------
    // 眨眼是独立的，不能被口型/表情覆盖掉；用 0~1 缩放
    if (blink < 0.999) {
      const v = 1 - Math.max(0, Math.min(1, blink));
      target.eyeBlinkLeft = Math.max(target.eyeBlinkLeft || 0, v);
      target.eyeBlinkRight = Math.max(target.eyeBlinkRight || 0, v);
    }

    // --- 一次性写进 morph ---------------------------------------------
    // 先清掉上帧可能残留的键（比如句末的 jawOpen 要回 0）
    morph.setAll(target, { clear: true });
  }

  return {
    speak,
    speakFrames,
    stop,
    setEmotion,
    update,
    get speaking() { return speaking; },
    get emotion() { return emotion; },
    /** 调试用：这句话排了多久 */
    get duration() { return visemesDuration(frames); },
    /** 被认出来的 morph 名里，有几个真能驱动 */
    supported: () => morph.names.filter((n) => ARKIT_INDEX[n] !== undefined).length,
  };
}
