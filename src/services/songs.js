// 内置儿歌旋律 —— 让角色能"真的唱歌"，而不只是用唱歌的语气说话
// ---------------------------------------------------------------------------
// 为什么自己合成音频而不去下载 mp3：
//  1. 版权：自己生成的旋律不涉及录音版权，儿童产品尤其要紧
//  2. 体积：一个 WAV 合成器几十行代码，比塞几 MB 音频进安装包划算
//  3. 可控：想快想慢想转调随时改，配合 TTS 的语速
//
// 和唱歌配合的方式：先播这段伴奏旋律，同时用 [sing] 情绪合成角色的演唱声。
// 两者叠在一起就是"角色在唱歌"。

const NOTE_HZ = {
  C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0, B: 493.88,
};

// 简易记谱：[音名, 拍数]，null 表示休止
const SONGS = {
  '小星星': {
    title: '小星星',
    bpm: 100,
    notes: [
      ['C', 1], ['C', 1], ['G', 1], ['G', 1], ['A', 1], ['A', 1], ['G', 2],
      ['F', 1], ['F', 1], ['E', 1], ['E', 1], ['D', 1], ['D', 1], ['C', 2],
    ],
  },
  '生日快乐': {
    title: '生日快乐',
    bpm: 108,
    notes: [
      ['C', 0.75], ['C', 0.25], ['D', 1], ['C', 1], ['F', 1], ['E', 2],
      ['C', 0.75], ['C', 0.25], ['D', 1], ['C', 1], ['G', 1], ['F', 2],
    ],
  },
  '两只老虎': {
    title: '两只老虎',
    bpm: 120,
    notes: [
      ['C', 1], ['D', 1], ['E', 1], ['C', 1],
      ['C', 1], ['D', 1], ['E', 1], ['C', 1],
      ['E', 1], ['F', 1], ['G', 2],
      ['E', 1], ['F', 1], ['G', 2],
    ],
  },
  '伦敦大桥': {
    title: 'London Bridge',
    bpm: 112,
    notes: [
      ['G', 1.5], ['A', 0.5], ['G', 1], ['F', 1], ['E', 1], ['F', 1], ['G', 2],
      ['D', 1], ['E', 1], ['F', 2], ['E', 1], ['F', 1], ['G', 2],
    ],
  },
};

export const SONG_LIST = Object.keys(SONGS);

/** 匹配用户想听哪首；匹配不上就随机一首（小孩常常说不清歌名） */
export function matchSong(request) {
  const q = String(request || '').replace(/\s/g, '');
  if (!q) return SONGS[SONG_LIST[Math.floor(Math.random() * SONG_LIST.length)]];
  for (const key of SONG_LIST) {
    if (q.includes(key)) return SONGS[key];
  }
  // 英文歌名也能对上
  if (/birthday|生日/.test(q)) return SONGS['生日快乐'];
  if (/twinkle|星星|star/.test(q)) return SONGS['小星星'];
  if (/tiger|老虎|two/.test(q)) return SONGS['两只老虎'];
  return SONGS[SONG_LIST[Math.floor(Math.random() * SONG_LIST.length)]];
}

/**
 * 生成一段 WAV（单声道 16bit）。返回 base64 data URI，两端都能直接给 expo-av 播。
 * 用包络消除爆音：音符开头/结尾各做一小段淡入淡出，不然会有"啪"的噪声。
 */
export function renderSong(song, sampleRate = 22050) {
  const beatSec = 60 / (song.bpm || 100);
  const total = song.notes.reduce((s, n) => s + n[1], 0) * beatSec;
  const nSamples = Math.ceil(total * sampleRate);
  const buf = new Int16Array(nSamples);

  let cursor = 0;
  for (const [note, beats] of song.notes) {
    const hz = NOTE_HZ[note];
    if (!hz) { cursor += beats * beatSec; continue; }
    const count = Math.floor(beats * beatSec * sampleRate);
    const start = Math.floor(cursor * sampleRate);
    // 留 15% 给释放，避免相邻音符首尾相接产生杂音
    const release = Math.floor(count * 0.15);

    for (let i = 0; i < count && start + i < nSamples; i++) {
      const t = i / sampleRate;
      let env = 1;
      if (i < release * 0.6) env = i / (release * 0.6);
      else if (i > count - release) env = Math.max(0, (count - i) / release);
      // 基频 + 一个弱一点的八度泛音，听起来更像音乐盒而不是刺耳的音叉
      const v =
        Math.sin(2 * Math.PI * hz * t) * 0.7 +
        Math.sin(2 * Math.PI * hz * 2 * t) * 0.18 +
        Math.sin(2 * Math.PI * hz * 3 * t) * 0.06;
      buf[start + i] = Math.round(Math.max(-1, Math.min(1, v * env)) * 32000);
    }
    cursor += beats * beatSec;
  }

  return int16ToWavDataUri(buf, sampleRate);
}

function int16ToWavDataUri(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = globalThis.btoa ? globalThis.btoa(binary) : '';
  return `data:audio/wav;base64,${b64}`;
}
