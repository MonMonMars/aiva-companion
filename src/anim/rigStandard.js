// 通用骨骼标准
// ---------------------------------------------------------------------------
// 目标：任何一个 rigged humanoid 丢进来，都能把它的骨骼认出来，
// 映射到一个统一的骨架命名上。之后所有动作代码只认这套命名。
//
// 标准为什么选 Mixamo 兼容：
// Mixamo（Adobe）是全世界最大的免费动作库，骨骼命名和这套一致意味着
// 从它那儿导出的 FBX/GLB 动画可以**零重定向**直接套到我们的角色身上。

export const BONES = [
  // name,                 parent,         T-pose 位置(米), 备注
  ['Hips',                 null,          [0, 0.98, 0]],
  ['Spine',                'Hips',        [0, 0.10, 0]],
  ['Spine1',               'Spine',       [0, 0.12, 0]],
  ['Spine2',               'Spine1',      [0, 0.14, 0]],
  ['Neck',                 'Spine2',      [0, 0.17, 0]],
  ['Head',                 'Neck',        [0, 0.09, 0]],
  ['HeadTop_End',          'Head',        [0, 0.16, 0]],

  ['LeftShoulder',         'Spine2',      [0.045, 0.14, 0]],
  ['LeftArm',              'LeftShoulder',[0.10, 0, 0]],
  ['LeftForeArm',          'LeftArm',     [0.26, 0, 0]],
  ['LeftHand',             'LeftForeArm', [0.24, 0, 0]],

  ['RightShoulder',        'Spine2',      [-0.045, 0.14, 0]],
  ['RightArm',             'RightShoulder',[-0.10, 0, 0]],
  ['RightForeArm',         'RightArm',    [-0.26, 0, 0]],
  ['RightHand',            'RightForeArm',[-0.24, 0, 0]],

  ['LeftUpLeg',            'Hips',        [0.10, -0.07, 0]],
  ['LeftLeg',              'LeftUpLeg',   [0, -0.42, 0]],
  ['LeftFoot',             'LeftLeg',     [0, -0.43, 0]],
  ['LeftToeBase',          'LeftFoot',    [0, -0.07, 0.06]],
  ['LeftToe_End',          'LeftToeBase', [0, 0, 0.10]],

  ['RightUpLeg',           'Hips',        [-0.10, -0.07, 0]],
  ['RightLeg',             'RightUpLeg',  [0, -0.42, 0]],
  ['RightFoot',            'RightLeg',    [0, -0.43, 0]],
  ['RightToeBase',         'RightFoot',   [0, -0.07, 0.06]],
  ['RightToe_End',         'RightToeBase',[0, 0, 0.10]],
];

export const BONE_NAMES = BONES.map(([n]) => n);
export const BONE_PARENT = BONES.reduce((m, [n, p]) => ((m[n] = p), m), {});
export const BONE_REST = BONES.reduce((m, [n, , v]) => ((m[n] = v), m), {});

// ---------------------------------------------------------------------------
// 别名表：各家人形骨架命名 -> 标准名
// ---------------------------------------------------------------------------
//
// ⚠️ 两张人形骨架命名体系都要覆盖，缺一张就是 0% 覆盖率：
//
//   · Mixamo / Blender Rigify / 3ds Max Biped —— 上面那批（leftarm / bip01lthigh …）
//   · **VRM / PMX / MMD** —— 下面前缀 `vrm_` 的那批
//
// 第二张是踩坑补的：官方 Kizuna AI 的 VRM 骨骼叫 `J_C_hip` / `J_L_uparm` /
// `J_L_lowarm` / `J_L_thigh` / `J_L_lowleg`（C=center、L/R=左右、日式缩写），
// 和 Mixamo 命名一个都对不上，rigDriver 直接判定"认不出"放弃驱动 ——
// 角色能显示，但头不会跟手动、被摸不会抬手。
// 注意 norm() 会剥掉下划线，所以 `J_L_uparm` 要写成 `jluparm`。
const ALIAS_PAIRS = {
  Hips: ['hips', 'pelvis', 'root', 'jbipchips', 'jbipc pelvis', 'bip01pelvis', 'armaturehips', 'mixamorighips', 'jbipchips',
    'jchip', 'jcroot', 'jhips', 'jbipc hips'],
  Spine: ['spine', 'spine01', 'spine1', 'jbipcspine', 'bip01spine', 'pelvisspine',
    'jcspinea', 'jcspine1', 'jcspine01', 'jclowerbody', 'jcwaist'],
  Spine1: ['spine1', 'spine02', 'spine2', 'chest', 'jbipcchest', 'upperchest', 'bip01spine1',
    'jcspineb', 'jcspine2', 'jcspine02', 'jcupperbody'],
  Spine2: ['spine2', 'spine03', 'spine3', 'upperchest', 'jbipcupperchest', 'chest2', 'bip01spine2',
    'jcspinec', 'jcspine3', 'jcspine03'],
  Neck: ['neck', 'neck01', 'neck1', 'jbipcneck', 'bip01neck',
    'jcneck', 'jcneck1'],
  Head: ['head', 'head01', 'jbipchead', 'bip01head',
    'jchead', 'jchead1'],
  HeadTop_End: ['headtopend', 'headtop', 'headtop01', 'skulltop', 'topofhead'],

  LeftShoulder: ['leftshoulder', 'lshoulder', 'claviclel', 'leftclavicle', 'shoulderl', 'leftshoulder01', 'jbipclshoulder', 'bip01lclavicle',
    'jlclavicle', 'jlshoulder', 'jbiplclavicle'],
  LeftArm: ['leftarm', 'larm', 'upperarml', 'leftupperarm', 'armleft', 'jbipclupperarm', 'bip01lupperarm',
    'jluparm', 'jlupperarm', 'jlarm', 'jbiplupperarm'],
  LeftForeArm: ['leftforearm', 'lforearm', 'lowerarml', 'leftlowerarm', 'forearmleft', 'elbowl', 'jbipcllowerarm', 'bip01lforearm',
    'jllowarm', 'jllowerarm', 'jlforearm', 'jbipllowerarm'],
  LeftHand: ['lefthand', 'lhand', 'handl', 'lefthand01', 'jbipclhand', 'bip01lhand',
    'jlhand', 'jbiplhand'],

  RightShoulder: ['rightshoulder', 'rshoulder', 'clavicler', 'rightclavicle', 'shoulderr', 'rightshoulder01', 'jbipcrshoulder', 'bip01rclavicle',
    'jrclavicle', 'jrshoulder', 'jbiprclavicle'],
  RightArm: ['rightarm', 'rarm', 'upperarmr', 'rightupperarm', 'armright', 'jbipcrupperarm', 'bip01rupperarm',
    'jruparm', 'jrupperarm', 'jrarm', 'jbiprupperarm'],
  RightForeArm: ['rightforearm', 'rforearm', 'lowerarmr', 'rightlowerarm', 'forearmright', 'elbowr', 'jbipcrlowerarm', 'bip01rforearm',
    'jrlowarm', 'jrlowerarm', 'jrforearm', 'jbiprlowerarm'],
  RightHand: ['righthand', 'rhand', 'handr', 'righthand01', 'jbipcrhand', 'bip01rhand',
    'jrhand', 'jbiprhand'],

  LeftUpLeg: ['leftupleg', 'lupleg', 'thighl', 'leftthigh', 'upperlegl', 'leftupperleg', 'jbipclupperleg', 'bip01lthigh',
    'jlthigh', 'jlupleg', 'jlupperleg', 'jbiplupperleg'],
  LeftLeg: ['leftleg', 'lleg', 'calfl', 'lcalf', 'shinl', 'leftshin', 'lowerlegl', 'jbipcllowerleg', 'bip01lcalf',
    'jllowleg', 'jlshin', 'jlcalf', 'jlleg', 'jbipllowerleg'],
  LeftFoot: ['leftfoot', 'lfoot', 'footl', 'jbipclfoot', 'bip01lfoot',
    'jlfoot', 'jbiplfoot'],
  LeftToeBase: ['lefttoebase', 'ltoebase', 'toel', 'lefttoe', 'balll', 'leftball', 'jbipcltoe', 'bip01ltoe0',
    'jltoebase', 'jltoe'],
  LeftToe_End: ['lefttoeend', 'ltoeend', 'toeendl', 'jbipcltoeend'],

  RightUpLeg: ['rightupleg', 'rupleg', 'thighr', 'rightthigh', 'upperlegr', 'rightupperleg', 'jbipcrupperleg', 'bip01rthigh',
    'jrthigh', 'jrupleg', 'jrupperleg', 'jbiprupperleg'],
  RightLeg: ['rightleg', 'rleg', 'calfr', 'rcalf', 'shinr', 'rightshin', 'lowerlegr', 'jbipcrlowerleg', 'bip01rcalf',
    'jrlowleg', 'jrshin', 'jrcalf', 'jrleg', 'jbiprlowerleg'],
  RightFoot: ['rightfoot', 'rfoot', 'footr', 'jbipcrfoot', 'bip01rfoot',
    'jrfoot', 'jbiprfoot'],
  RightToeBase: ['righttoebase', 'rtoebase', 'toer', 'righttoe', 'ballr', 'rightball', 'jbipcrtoe', 'bip01rtoe0',
    'jrtoebase', 'jrtoe'],
  RightToe_End: ['righttoeend', 'rtoeend', 'toeendr', 'jbipcrtoeend'],
};

const NORM_TO_CANON = (() => {
  const m = new Map();
  for (const [canon, list] of Object.entries(ALIAS_PAIRS)) {
    for (const a of list) m.set(a, canon);
  }
  return m;
})();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 单个骨骼名 -> 标准名。认不出来返回 null。
 * @param {string} raw
 */
export function matchBone(raw) {
  let s = String(raw || '');
  // 命名空间前缀："mixamorig:Hips"、"Armature|Hips"、"Armature/Hips"
  s = s.replace(/^[^:]*::/, '').replace(/^[^:]*:/, '');
  s = s.split(/[|/]/).pop();
  const n = norm(s);
  if (NORM_TO_CANON.has(n)) return NORM_TO_CANON.get(n);
  // 再退一步：去掉明显的 _01 / .001 尾巴
  const n2 = n.replace(/(0[1-9])$/, '');
  if (NORM_TO_CANON.has(n2)) return NORM_TO_CANON.get(n2);

  // 最后一步：剥掉各家的命名空间前缀再查一次。
  // VRM/PMX 生态的前缀花样多（J_ / J_Bip_ / J_Bip_C_ / Bip01 / Armature…），
  // 与其穷举每个组合，不如把前缀剥掉再回到主表 —— 这样 `j_bip_c_hip`
  // 最终会退化成 `hip`，命中 Hips。
  const PREFIX = /^(?:j|jbip|jbipc|jbipc?|bip|bip01|biped|armature|rig|vrm|chr|mixamorig|def|ctrl)_?/;
  let stripped = n;
  for (let i = 0; i < 4; i++) {
    const next = stripped.replace(PREFIX, '');
    if (next === stripped) break;
    stripped = next;
    if (NORM_TO_CANON.has(stripped)) return NORM_TO_CANON.get(stripped);
  }
  return null;
}

/**
 * 把一整个模型的骨骼列表映射成 { 标准名: Bone对象 }
 * @param {Array<{name:string, obj:any}>} boneList
 * @returns {{ mapping: Record<string, any>, unknown: string[], missing: string[] }}
 */
export function mapSkeleton(boneList) {
  const mapping = {};
  const unknown = [];
  for (const { name, obj } of boneList) {
    const canon = matchBone(name);
    if (!canon) { unknown.push(name); continue; }
    // 同名取"更靠近根节点/更短路径"的那个，减少误命中末端骨
    if (mapping[canon]) {
      const depth = (o) => { let d = 0, p = o?.parent; while (p) { d++; p = p.parent; } return d; };
      if (depth(obj) < depth(mapping[canon])) mapping[canon] = obj;
    } else mapping[canon] = obj;
  }
  const missing = BONE_NAMES.filter((b) => !mapping[b]);
  return { mapping, unknown, missing };
}

/** 核心骨：缺了这些基本没法做人形动画 */
export const CORE_BONES = [
  'Hips', 'Spine', 'Spine1', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
  'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
];

/** 覆盖率评估 */
export function rigCoverage(mapping) {
  const have = CORE_BONES.filter((b) => mapping[b]);
  return { have, missing: CORE_BONES.filter((b) => !mapping[b]), ratio: have.length / CORE_BONES.length };
}
