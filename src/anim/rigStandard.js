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
const ALIAS_PAIRS = {
  Hips: ['hips', 'pelvis', 'root', 'jbipchips', 'jbipc pelvis', 'bip01pelvis', 'armaturehips', 'mixamorighips', 'jbipchips'],
  Spine: ['spine', 'spine01', 'spine1', 'jbipcspine', 'bip01spine', 'pelvisspine'],
  Spine1: ['spine1', 'spine02', 'spine2', 'chest', 'jbipcchest', 'upperchest', 'bip01spine1'],
  Spine2: ['spine2', 'spine03', 'spine3', 'upperchest', 'jbipcupperchest', 'chest2', 'bip01spine2'],
  Neck: ['neck', 'neck01', 'neck1', 'jbipcneck', 'bip01neck'],
  Head: ['head', 'head01', 'jbipchead', 'bip01head'],
  HeadTop_End: ['headtopend', 'headtop', 'headtop01', 'skulltop', 'topofhead'],

  LeftShoulder: ['leftshoulder', 'lshoulder', 'claviclel', 'leftclavicle', 'shoulderl', 'leftshoulder01', 'jbipclshoulder', 'bip01lclavicle'],
  LeftArm: ['leftarm', 'larm', 'upperarml', 'leftupperarm', 'armleft', 'jbipclupperarm', 'bip01lupperarm'],
  LeftForeArm: ['leftforearm', 'lforearm', 'lowerarml', 'leftlowerarm', 'forearmleft', 'elbowl', 'jbipcllowerarm', 'bip01lforearm'],
  LeftHand: ['lefthand', 'lhand', 'handl', 'lefthand01', 'jbipclhand', 'bip01lhand'],

  RightShoulder: ['rightshoulder', 'rshoulder', 'clavicler', 'rightclavicle', 'shoulderr', 'rightshoulder01', 'jbipcrshoulder', 'bip01rclavicle'],
  RightArm: ['rightarm', 'rarm', 'upperarmr', 'rightupperarm', 'armright', 'jbipcrupperarm', 'bip01rupperarm'],
  RightForeArm: ['rightforearm', 'rforearm', 'lowerarmr', 'rightlowerarm', 'forearmright', 'elbowr', 'jbipcrlowerarm', 'bip01rforearm'],
  RightHand: ['righthand', 'rhand', 'handr', 'righthand01', 'jbipcrhand', 'bip01rhand'],

  LeftUpLeg: ['leftupleg', 'lupleg', 'thighl', 'leftthigh', 'upperlegl', 'leftupperleg', 'jbipclupperleg', 'bip01lthigh'],
  LeftLeg: ['leftleg', 'lleg', 'calfl', 'lcalf', 'shinl', 'leftshin', 'lowerlegl', 'jbipcllowerleg', 'bip01lcalf'],
  LeftFoot: ['leftfoot', 'lfoot', 'footl', 'jbipclfoot', 'bip01lfoot'],
  LeftToeBase: ['lefttoebase', 'ltoebase', 'toel', 'lefttoe', 'balll', 'leftball', 'jbipcltoe', 'bip01ltoe0'],
  LeftToe_End: ['lefttoeend', 'ltoeend', 'toeendl', 'jbipcltoeend'],

  RightUpLeg: ['rightupleg', 'rupleg', 'thighr', 'rightthigh', 'upperlegr', 'rightupperleg', 'jbipcrupperleg', 'bip01rthigh'],
  RightLeg: ['rightleg', 'rleg', 'calfr', 'rcalf', 'shinr', 'rightshin', 'lowerlegr', 'jbipcrlowerleg', 'bip01rcalf'],
  RightFoot: ['rightfoot', 'rfoot', 'footr', 'jbipcrfoot', 'bip01rfoot'],
  RightToeBase: ['righttoebase', 'rtoebase', 'toer', 'righttoe', 'ballr', 'rightball', 'jbipcrtoe', 'bip01rtoe0'],
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
