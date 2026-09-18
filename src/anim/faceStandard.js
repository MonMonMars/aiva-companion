// 面部动作标准：ARKit 52 blendshape
// ---------------------------------------------------------------------------
// 为什么把内部标准定成 ARKit：
//   它是事实上的业界通用语 —— iPhone 面捕、Live Link Face、VTube Studio、
//   Ready Player Me、Meta Avatar SDK、绝大多数数字人 SDK 都输出这套系数。
//   内部统一用这一套，意味着上游随便换成哪家驱动、下游这套代码都不用改。
//
// 这份文件只定义标准和别名表，不做任何运行时判断。

/** 标准名列表，顺序即数组下标（机器人协议也按这个顺序传） */
export const ARKIT = [
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight',
  'browDownLeft', 'browDownRight',
  'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'jawOpen', 'jawForward', 'jawLeft', 'jawRight',
  'mouthClose', 'mouthFunnel', 'mouthPucker',
  'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper',
  'mouthShrugUpper', 'mouthShrugLower',
  'mouthPressLeft', 'mouthPressRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight',
  'tongueOut',
];

export const ARKIT_INDEX = ARKIT.reduce((m, n, i) => ((m[n] = i), m), {});

/** 归一化：小写 + 去掉所有非字母数字。' Eye_Blink.L ' -> 'eyeblinkl' */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 标准名归一化 -> 标准名 的反查表 */
const NORM_TO_CANON = new Map(ARKIT.map((a) => [norm(a), a]));

// ---------------------------------------------------------------------------
// 别名表：归一化名 -> 标准名（或标准名数组，用于"一个形状同时表达多个动作"）
// ---------------------------------------------------------------------------
const ALIAS = {
  // VRM 0.x / 1.0 预设表情
  aa: 'jawOpen', ih: 'jawOpen', ou: 'mouthPucker', ee: 'jawOpen', oh: 'mouthPucker',
  blink: ['eyeBlinkLeft', 'eyeBlinkRight'],
  blinkleft: 'eyeBlinkLeft', blinkright: 'eyeBlinkRight',
  blinkl: 'eyeBlinkLeft', blinkr: 'eyeBlinkRight',
  happy: ['mouthSmileLeft', 'mouthSmileRight', 'cheekSquintLeft', 'cheekSquintRight'],
  joy: ['mouthSmileLeft', 'mouthSmileRight'],
  fun: ['mouthSmileLeft', 'mouthSmileRight'],
  angry: ['browDownLeft', 'browDownRight'],
  sorrow: ['mouthFrownLeft', 'mouthFrownRight', 'browInnerUp'],
  sad: ['mouthFrownLeft', 'mouthFrownRight'],
  surprised: ['jawOpen', 'browInnerUp', 'eyeWideLeft', 'eyeWideRight'],
  relaxed: ['eyeBlinkLeft', 'eyeBlinkRight'],
  neutral: [],
  lookup: 'eyeLookUpLeft', lookdown: 'eyeLookDownLeft',
  lookleft: 'eyeLookOutLeft', lookright: 'eyeLookOutRight',
  // VTube Studio / Live2D 常见
  mouthopen: 'jawOpen', mouthopen2: 'jawOpen', mouthx: 'mouthFunnel',
  eyeopenl: 'eyeWideLeft', eyeopenr: 'eyeWideRight',
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  // 常见 morph 命名变体
  jawopen2: 'jawOpen', mo: 'jawOpen', mth: 'jawOpen',
  left eyeblink: 'eyeBlinkLeft', righteyeblink: 'eyeBlinkRight',
  browleftdown: 'browDownLeft', browrightdown: 'browDownRight',
};

const NORM_ALIAS = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(ALIAS)) m.set(norm(k), v);
  return m;
})();

// 左右后缀词
const SIDE_WORDS = {
  Left: ['left', 'l', 'lh', 'lft'],
  Right: ['right', 'r', 'rh', 'rgt'],
};

/** 前缀/后缀清理：去掉 mesh 命名空间和常见尾巴 */
function cleanName(raw) {
  let s = String(raw || '');
  s = s.replace(/^[^:]*::/, '').replace(/^[^:]*:/, '');   // "Body_m:eyeBlink_L"
  s = s.replace(/(_morph|\.00\d|_shape|\s+\d+)$/gi, '');
  return s;
}

/**
 * 把一个模型自带的 blendshape 名映射到标准 ARKit 名。
 * @param {Record<string,number>} dict three.js 的 morphTargetDictionary
 * @returns {Record<string, string|string[]>} rawName -> 标准名（或标准名数组）
 */
export function mapMorphTargets(dict) {
  const out = {};
  for (const raw of Object.keys(dict || {})) {
    const cleaned = cleanName(raw);
    let n = norm(cleaned);

    // 1) 直接命中标准名（大小写/分隔符不敏感）
    if (NORM_TO_CANON.has(n)) { out[raw] = NORM_TO_CANON.get(n); continue; }

    // 2) 命中别名表
    if (NORM_ALIAS.has(n)) { out[raw] = NORM_ALIAS.get(n); continue; }

    // 3) 一侧loader spelling：尝试把尾部的 l/r/left/right 换成标准 Left/Right
    let hit = null;
    for (const [side, words] of Object.entries(SIDE_WORDS)) {
      for (const w of words) {
        const re = new RegExp(`(${w})$`);
        if (!re.test(n)) continue;
        const base = n.replace(re, '');
        const cand = NORM_TO_CANON.get(base + norm(side));
        if (cand) { hit = cand; break; }
        const cand2 = NORM_ALIAS.get(base + norm(side));
        if (cand2) { hit = cand2; break; }
      }
      if (hit) break;
    }
    // 4) 反过来：标准名 + 尾部 side 词已被吃掉的情况，如 "EyeBlink" + "_L"
    //    上面 3 已覆盖。这里再试一次把 _.l / .L 这类标点后缀考虑进来。
    if (!hit) {
      for (const [side, words] of Object.entries(SIDE_WORDS)) {
        for (const w of words) {
          if (!n.endsWith(w)) continue;
          const base = n.slice(0, -w.length);
          const cand = NORM_TO_CANON.get(base + norm(side));
          if (cand) { hit = cand; break; }
        }
        if (hit) break;
      }
    }
    if (hit) out[raw] = hit;
  }
  return out;
}

/**
 * 看看这个模型覆盖了多少个标准动作
 * @returns {{present:string[], missing:string[], ratio:number}}
 */
export function coverageOf(map) {
  const have = new Set();
  for (const v of Object.values(map || {})) {
    if (Array.isArray(v)) v.forEach((x) => x && have.add(x));
    else if (v) have.add(v);
  }
  const present = ARKIT.filter((a) => have.has(a));
  const missing = ARKIT.filter((a) => !have.has(a));
  return { present, missing, ratio: present.length / ARKIT.length };
}

/** 机器人协议每帧 blendshape 数组的长度 */
export const FRAME_LENGTH = ARKIT.length;
