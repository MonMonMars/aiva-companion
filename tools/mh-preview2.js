// mh-preview2.js —— 带眼球与真实材质的捏人预览台
// 与 v1 的区别：同时加载 aiva-base-mh.glb（身体）+ aiva-parts-mh.glb（眼球），
// 并把纯色胶泥换成 PBR 皮肤 + 眼球贴图。
//
// 肤色说明：MakeHuman 本身**不带皮肤贴图**，官方做法是用 litsphere + 基色插值。
// 这里直接用 PBR 基色 + sheen 近似，视觉上够用且省一个资源包。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const el = (id) => document.getElementById(id);
const boot = el('boot'), meta = el('meta');
boot.textContent = '正在加载…';

// ---------------------------------------------------------------- 渲染器
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
el('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f3f5);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 1.15, 2.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.25;
controls.maxDistance = 6;

// ---------------------------------------------------------------- 灯光
// 三点光：脸部要有明确明暗交界，否则看不出立体
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.62));
const key = new THREE.DirectionalLight(0xfff6ea, 2.1); key.position.set(1.6, 2.6, 2.2); scene.add(key);
const fill = new THREE.DirectionalLight(0xdce8ff, 0.8); fill.position.set(-2.2, 1.2, 1.4); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(-0.6, 1.8, -2.4); scene.add(rim);

scene.add(new THREE.GridHelper(6, 24, 0xccd2da, 0xe2e6eb));

// ------------------------------------------------------------- 肤色预设
const SKINS = [
  { cn: '白皙', c: 0xf4dccb },
  { cn: '自然', c: 0xe9c6aa },
  { cn: '小麦', c: 0xd4a37c },
  { cn: '健康', c: 0xc28c60 },
  { cn: '深棕', c: 0x8f5c3d },
];
let curSkin = 1;

// --------------------------------------------------------------- 加载模型
const loader = new GLTFLoader();
const readGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

// 可换装部件（全部由 tools/mhproxy.mjs 从 MakeHuman 官方 CC0 素材包 .mhclo 拟合而来）
// 发型可切换：按 H 键在几种之间循环（只有当前选中的会被挂载渲染）。
// 实测对比（都是 o4saken_long01 / learning_anime_hair 这两套 CC0 素材）：
//   · 长发 o4saken_long01：6634 面撑出 15007 顶点，**1019 个连通片** —— 是上千条
//     独立发丝条带拼的"面条发型"。近距离下每条发丝边缘呈锯齿，且会有发丝垂过
//     脸颊。优点是造型飘逸、面数低。
//   · 动漫高模 learning_anime_hair：91392 面，**84 个连通片** —— 连续网格，边缘
//     平滑，无锯齿。缺点是面数高（4.1MB GLB）。
// ⚠️ 实测结论（look1 vs look2 并排渲染，同一身体/骨架/材质）：
//   两套发型里**只有** o4saken_long01 那套看起来是坏的 —— 它的刘海是一块斜切下来的
//   实心黑板，正面直接盖住左眼和左半边脸（量化：眼高带内落在眼球正前方的顶点 290 个，
//   X 集中在 −0.048 ~ −0.075，正是左侧）；发梢是上千条面条发丝被切出来的锯齿硬边；
//   背面像一块撕裂的黑布。
//   换成 learning_anime_hair 后这些**全部消失**：发形连续、发梢自然、背面平滑、
//   脸和双眼完全露出、零黑块零撕裂。
//   → 所以默认用动漫高模那套。身体/骨架/蒙皮/材质从来就没问题。
const HAIR_STYLES = [
  { key: 'anime', cn: '动漫高模', url: '/assets/models4/aiva-hair-anime.glb' },
  { key: 'long', cn: '长直发', url: '/assets/models4/aiva-hair-long-mh.glb' },
];
let hairStyle = 0;

const WEAR = [
  { key: 'brows', cn: '眉毛', url: '/assets/models4/aiva-brows-mh.glb', on: true },
  { key: 'lashes', cn: '睫毛', url: '/assets/models4/aiva-lashes-mh.glb', on: true },
];
const HAIR_URL = () => HAIR_STYLES[hairStyle].url;

// 部件清单 = 当前发型 + 眉毛 + 睫毛
const WEAR_ALL = () => [{ key: 'hair', cn: HAIR_STYLES[hairStyle].cn, url: HAIR_URL(), on: true }, ...WEAR];

let wearGltf = await Promise.all(WEAR_ALL().map((w) =>
  readGLB(w.url).catch((e) => { console.warn('[部件] 加载失败', w.url, e); return null; })));

const [gBody, gParts, sd] = await Promise.all([
  readGLB('/assets/models4/aiva-base-mh.glb'),
  readGLB('/assets/models4/aiva-parts-mh.glb'),
  fetch('/assets/models4/aiva-base-mh.sliders.json').then((r) => r.json()),
]);

let morphMesh = null, dict = {};
gBody.scene.traverse((o) => {
  if (o.isMesh && o.morphTargetDictionary) { morphMesh = o; dict = o.morphTargetDictionary; }
});

// ---- 皮肤材质 ----
const skinMats = [];
gBody.scene.traverse((o) => {
  if (!o.isMesh) return;
  o.material = new THREE.MeshPhysicalMaterial({
    color: SKINS[curSkin].c,
    roughness: 0.55,
    metalness: 0.0,
    clearcoat: 0.30,
    clearcoatRoughness: 0.45,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xff9070),
    sheenRoughness: 0.75,
  });
  skinMats.push(o.material);
  // ⚠️ morph 会让顶点超出初始包围盒，不开这个会在拉大腿长时被剔除
  o.frustumCulled = false;
});
scene.add(gBody.scene);

// ---- 眼球：导出的是 EyePosX / EyeNegX **两个独立网格**（各自几何已对齐注视轴，
//      见 mheye-final.mjs）。每个网格整体绑到自己那一侧的骨骼上（刚体，权重 1），
//      所以眼球不会被骨骼缩放拉变形，同时又各自跟各自的骨骼走。
// ⚠️ 坑 1：判断网格时不能只看 o.name —— glTF 的 node 名（EyeNegX_node）和 mesh 名
//    （EyeNegX）是两个字段，three.js 里 Mesh.name 取的是 **node 名**。
//    早期版本按 o.name === 'Eyes' 判定，结果整个绑定环节被静默跳过，眼球停在原点。
// ⚠️ 坑 2：**骨骼左右和命名直觉相反** —— 实测 eyeL 骨骼在 +X 侧、eyeR 在 -X 侧
//    （tools/mheye-where.mjs 实测：eyeL pos.x = +0.03141, eyeR pos.x = -0.03141）。
//    所以绝不能按名字里有没有 L 来决定绑哪根，必须按**几何 X 符号**。
const EYE_NAME = /^Eye(Pos|Neg)X(_node)?$|^Eye(L|R|s)(_node)?$/;
const isEyeMesh = (o) => {
  if (!o.isMesh || o.isSkinnedMesh) return false;
  return EYE_NAME.test(o.name || '') || (o.geometry && EYE_NAME.test(o.geometry.name || ''))
    || (o.material && /Eye/.test(o.material.name || ''));
};
// ⚠️ 坑 3（本轮踩到，最致命）：**MakeHuman 导出到 GLB 后骨骼名是 `eye.L` / `eye.R`（带点）**，
//    不是 `eyeL` / `eyeR`。之前的代码硬编码 boneByName['eyeL']，取到 undefined，
//    于是 xL/xR 都是 null → sideBone() 返回 null → boneIdx = -1 → 眼球被绑到
//    skeleton.bones[0]（根骨骼），位置完全错乱。而且这个失败是**静默的**
//    （只有一行 console.log 能看出来）。
//    → 现在改成**按名字模糊匹配**（去掉 . _ - 空格后比对 eye+l / eye+r），
//      再退回按几何 X 符号兜底。
{
  const bones = [];
  gBody.scene.traverse((o) => { if (o.isBone) bones.push(o); });
  // 规范化：'eye.L' / 'eyel' / 'Eye_L' / 'eye-l' → 'eyel'
  const canon = (s) => String(s || '').toLowerCase().replace(/[\s._\-]/g, '');
  const boneByName = {};
  for (const b of bones) if (b.name) boneByName[canon(b.name)] = b;

  let bodySkinned = null;
  gBody.scene.traverse((o) => { if (!bodySkinned && o.isSkinnedMesh) bodySkinned = o; });
  const srcSk = bodySkinned ? bodySkinned.skeleton : null;

  const bonePosX = (b) => { if (!b) return null; b.updateWorldMatrix(true, false); return b.matrixWorld.elements[12]; };

  // 先按名字找（兼容 eye.L / eyeL / Eye_L / eye-l / eyeL_01 …）
  let bL = boneByName['eyel'] || bones.find((b) => /^eye[._\-]?l/i.test(b.name || ''));
  let bR = boneByName['eyer'] || bones.find((b) => /^eye[._\-]?r/i.test(b.name || ''));
  let xL = bonePosX(bL), xR = bonePosX(bR);

  // 名字找不到就按几何 X 分派：+X 侧 = 角色的左眼（MakeHuman 惯例）
  if (xL === null || xR === null) {
    const eyes = bones.filter((b) => /eye/i.test(b.name || ''));
    if (eyes.length >= 2) {
      const sorted = eyes.map((b) => ({ b, x: bonePosX(b) })).filter((o) => o.x !== null).sort((a, b2) => b2.x - a.x);
      bL = sorted[0].b; bR = sorted[sorted.length - 1].b;
      xL = bonePosX(bL); xR = bonePosX(bR);
    }
  }
  console.log('[眼球绑定] 骨骼数', bones.length, '| 左眼骨骼', bL && bL.name, xL, '| 右眼骨骼', bR && bR.name, xR, '| 骨架', !!srcSk);

  const sideBone = (sign) => {
    if (!bL || !bR || xL === null || xR === null) return null;
    // +X 侧 → 名字含 l 的那根（同时用几何 X 校验，避免命名反直觉时绑错）
    const posIsL = xL > xR;
    const want = sign > 0 ? posIsL : !posIsL;
    return (want ? bL : bR).name;
  };
  const idxOf = (n) => bones.findIndex((b) => b.name === n);
  if (!srcSk || !sideBone(+1)) {
    console.warn('[眼球绑定] 失败：找不到身体骨架或眼睛骨骼（bL/bR 为空）');
  } else {
    const targets = [];
    gParts.scene.traverse((o) => { if (isEyeMesh(o)) targets.push(o); });
    console.log('[眼球绑定] 命中网格', targets.length, targets.map((t) => t.name).join(','));
    for (const m of targets) {
      const g = m.geometry;
      const n = g.attributes.position.count;
      // 新格式：网格名带 PosX/NegX；旧格式：Eyes 单网格含两球（按 X 分派）
      const hasSide = /PosX|NegX/.test(m.name || '');
      const bName = hasSide ? sideBone(/PosX/.test(m.name) ? +1 : -1) : null;
      const boneIdx = bName ? idxOf(bName) : -1;
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        let bi;
        if (hasSide) bi = boneIdx;
        else {
          // 旧格式：按顶点 X 符号分派
          const bn = sideBone(g.attributes.position.getX(i) >= 0 ? +1 : -1);
          bi = bn ? idxOf(bn) : -1;
        }
        si[i * 4] = Math.max(0, bi);
        sw[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      const skinned = new THREE.SkinnedMesh(g, m.material);
      skinned.name = m.name;
      skinned.frustumCulled = false;
      skinned.bind(srcSk, new THREE.Matrix4());   // 眼球顶点已是世界空间，故用单位矩阵
      gBody.scene.add(skinned);
      m.parent.remove(m);
      console.log('[眼球绑定] 已绑定', n, '顶点 ->', skinned.name, bName ? `(→${bName})` : '(按X分派)');
    }
  }
}
gParts.scene.traverse((o) => {
  if (!o.isMesh) return;
  o.material = o.material.clone();
  o.material.roughness = 0.10;
  o.material.metalness = 0.0;
  o.frustumCulled = false;
});
scene.add(gParts.scene);

// ---- 换装部件：把自带骨架按**骨骼名**换成身体那套 ----
// 部件 GLB 里带了一整套同名的 Armature（163 根），但那只是为了让 glTF 自洽；
// 真正参与蒙皮的必须是身体场景里的实例，否则两套骨骼各转各的，头发会留在原地。
// ⚠️ 部件几何已经是**米·世界空间**，bindMatrix 必须是单位矩阵。
const baseBones = new Map();
gBody.scene.traverse((o) => { if (o.isBone) baseBones.set(o.name, o); });
// ⚠️ 这两个数组必须**始终同下标对齐**（0 = 当前发型，之后是眉毛 / 睫毛）。
//    之前只有一个 wearRoots，UI 又去遍历长度不同的 WEAR 数组，切换发型后
//    按钮就会绑错 root（点"眉毛"实际隐藏的是头发）。现在两个数组一起维护。
const wearRoots = [];
const wearList = [];

// 把一套部件 GLB 挂进场景（骨骼换成身体那套）。返回 root。
function mountWear(gltf, w) {
  if (!gltf) return null;
  const root = gltf.scene;
  let n = 0;
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      const bones = o.skeleton.bones.map((b) => baseBones.get(b.name) || b);
      o.skeleton = new THREE.Skeleton(bones, o.skeleton.boneInverses);
      o.bind(o.skeleton, o.bindMatrix);
      o.frustumCulled = false;
      n++;
    } else if (o.isMesh) {
      o.frustumCulled = false;
    }
  });
  root.visible = w.on !== false;
  scene.add(root);
  wearRoots.push(root);
  wearList.push(w);
  console.log('[部件] ' + w.key + ' 已挂载，SkinnedMesh ' + n + ' 个（骨骼表 ' + baseBones.size + '）');
  return root;
}

WEAR_ALL().forEach((w, i) => mountWear(wearGltf[i], w));

// 切换发型：卸载旧发型、加载并挂载新发型，保持眉毛/睫毛不动。
async function setHairStyle(idx) {
  if (idx === hairStyle) return;
  // 先移除当前发型 root（wearRoots[0] 约定是发型）
  const oldRoot = wearRoots[0];
  if (oldRoot) {
    scene.remove(oldRoot);
    oldRoot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    wearRoots.shift(); wearList.shift();
  }
  hairStyle = idx;
  const url = HAIR_URL();
  try {
    const g = await readGLB(url);
    mountWear(g, { key: 'hair', cn: HAIR_STYLES[hairStyle].cn, url, on: true });
    // 发型必须插回数组第 0 位（其余是眉毛/睫毛）—— 两个数组一起搬，保持对齐
    const r = wearRoots.pop(), wl = wearList.pop();
    wearRoots.unshift(r); wearList.unshift(wl);
    // 让发型保证在最底层渲染（眉毛睫毛要在头发之上）
    r.renderOrder = -1;
    console.log('[发型] 已切换到 ' + HAIR_STYLES[hairStyle].cn);
  } catch (e) {
    console.warn('[发型] 切换失败', url, e);
  }
  refreshWearUI();
}

// 键盘 H 循环切换发型
addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') setHairStyle((hairStyle + 1) % HAIR_STYLES.length);
});

// 给外部脚本/按钮用的开关
window.__setHair = setHairStyle;

// ---------------------------------------------------------------- 滑块 UI
const GROUPS = [{ key: 'Body', cn: '体型' }, { key: 'Face', cn: '面容' }];
const state = new Map(sd.sliders.map((s) => [s.key, 0]));

function applyMorphs() {
  if (!morphMesh) return;
  for (const s of sd.sliders) {
    const i = dict[s.key];
    if (i === undefined) continue;
    morphMesh.morphTargetInfluences[i] = state.get(s.key) || 0;
  }
}

let curGroup = 'Body';
function renderSliders() {
  const host = el('sliders');
  host.innerHTML = '';
  for (const s of sd.sliders.filter((x) => x.group === curGroup)) {
    const v = state.get(s.key) || 0;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<label><span>' + s.cn + '</span><code>' + s.key + '</code></label>' +
      '<div class="ctl"><input type="range" min="-1" max="1" step="0.01" value="' + v + '">' +
      '<output>' + v.toFixed(2) + '</output></div>';
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => {
      const val = +inp.value;
      state.set(s.key, val);
      out.textContent = val.toFixed(2);
      applyMorphs();
    });
    inp.addEventListener('dblclick', () => { inp.value = 0; out.textContent = '0.00'; state.set(s.key, 0); applyMorphs(); });
    host.appendChild(row);
  }
}

for (const g of GROUPS) {
  const b = document.createElement('button');
  b.className = 'btn tab' + (g.key === curGroup ? ' on' : '');
  b.textContent = g.cn;
  b.dataset.tab = g.key;
  b.onclick = () => {
    curGroup = g.key;
    document.querySelectorAll('.btn.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === curGroup));
    renderSliders();
  };
  el('tabs').appendChild(b);
}

// 肤色
SKINS.forEach((s, i) => {
  const b = document.createElement('button');
  b.className = 'btn sw' + (i === curSkin ? ' on' : '');
  b.style.background = '#' + s.c.toString(16).padStart(6, '0');
  b.title = s.cn;
  b.onclick = () => {
    document.querySelectorAll('.btn.sw').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    curSkin = i;
    for (const m of skinMats) { m.color.setHex(s.c); m.needsUpdate = true; }
  };
  el('skins').appendChild(b);
});

// 换装开关。⚠️ 必须做成**可重复调用的函数**而不是一次性 forEach：
// 切换发型后 wearRoots 的第 0 项换了对象，按钮要重新绑一次，否则开关失效。
function refreshWearUI() {
  const hh = el('hair');
  if (hh) {
    hh.innerHTML = '';
    HAIR_STYLES.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'btn' + (i === hairStyle ? ' on' : '');
      b.textContent = s.cn;
      b.onclick = () => setHairStyle(i);
      hh.appendChild(b);
    });
  }
  const wh = el('wear');
  if (!wh) return;
  wh.innerHTML = '';
  WEAR_ALL().forEach((w, i) => {
    const root = wearRoots[i];
    if (!root) return;
    const b = document.createElement('button');
    b.className = 'btn' + (w.on ? ' on' : '');
    b.textContent = w.cn;
    b.onclick = () => { w.on = !w.on; root.visible = w.on; b.classList.toggle('on', w.on); };
    wh.appendChild(b);
  });
}
refreshWearUI();

// 预设
const PRESETS = {
  '默认': {},
  '高挑': { BodyHeight: 0.75, LegLength: 0.7, TorsoLength: -0.3, ShoulderWidth: 0.2 },
  '娇小': { BodyHeight: -0.8, LegLength: -0.5, Younger: 0.55, HeadWidth: 0.15, NeckLength: -0.2 },
  '健美': { Muscle: 0.85, ShoulderWidth: 0.55, WaistCirc: -0.45, ArmMuscle: 0.7, TorsoVShape: 0.6 },
  '丰满': { BreastSize: 0.85, HipsCirc: 0.6, ThighCirc: 0.4, WaistCirc: -0.25 },
  '男生': { Masculine: 1, ShoulderWidth: 0.7, WaistCirc: 0.15, HipsCirc: -0.35, BreastSize: -1, ChinWidth: 0.3 },
  '精灵': { EarPointed: 1, EarSize: 0.35, EyeSize: 0.5, HeadOval: -0.3, NoseHeight: -0.25, ChinWidth: -0.3 },
  '成熟': { Older: 0.6, ChinWidth: 0.2, HeadOval: 0.25, EyeBag: 0.4, CheekVolume: -0.2 },
};
for (const [name, kv] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = name;
  b.onclick = () => {
    for (const s of sd.sliders) state.set(s.key, 0);   // 先清零，避免叠加残留
    for (const [k, v] of Object.entries(kv)) if (state.has(k)) state.set(k, v);
    applyMorphs();
    renderSliders();
  };
  el('presets').appendChild(b);
}

// 视角
el('front').onclick = () => { camera.position.set(0, 1.15, 2.6); controls.target.set(0, 1.0, 0); };
el('face').onclick = () => { camera.position.set(0, 1.575, 0.55); controls.target.set(0, 1.555, 0.05); };
el('side').onclick = () => { camera.position.set(2.4, 1.2, 0.6); controls.target.set(0, 1.0, 0); };
el('reset').onclick = () => { for (const s of sd.sliders) state.set(s.key, 0); applyMorphs(); renderSliders(); };

renderSliders();
applyMorphs();

meta.textContent = sd.vertexCount + ' 顶点 · ' + sd.triangleCount + ' 面 · ' + sd.boneCount +
  ' 骨 · ' + sd.sliders.length + ' 滑块 · 眼球 ' + (gParts ? '已加载' : '无') +
  ' · 部件 ' + wearRoots.length + '/' + WEAR_ALL().length;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let frames = 0;
function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
  if (++frames === 3) { boot.textContent = ''; window.__mhReady = true; }
}
loop();

// --- 调试出口（截图器用） ---
window.__dbg = {
  // 外部脚本拿不到 ESM 里的 THREE（它不是 window 上的全局），这里显式透出去，
  // 让诊断脚本能做 unproject / Raycaster，而不用手写易错的矩阵运算。
  THREE_NS: THREE,
  // 从真正的 scene 根开始遍历（外部脚本拿不到 scene，只能走这个口）
  walk: (fn) => scene.traverse(fn),
  // 投影探针需要相机对象（外部只能拿到 cam() 的数值快照，不能做 project）
  getCamera: () => camera,
  cam: () => ({ pos: camera.position.toArray().map(x=>+x.toFixed(3)), tgt: controls.target.toArray().map(x=>+x.toFixed(3)) }),
  scene: () => {
    const out = [];
    scene.traverse(o => { if (o.isMesh || o.isSkinnedMesh) {
      const b = new THREE.Box3().setFromObject(o);
      out.push({ n: o.name, type: o.type, vis: o.visible,
        min: b.min.toArray().map(x=>+x.toFixed(3)), max: b.max.toArray().map(x=>+x.toFixed(3)) });
    }});
    return out;
  },
  renderer: () => ({ info: renderer.info.render, size: renderer.getSize(new THREE.Vector2()).toArray() }),
  // 截图器用来强制 drawing buffer 与显示尺寸 1:1（避免 toDataURL 水平平铺）
  getRenderer: () => renderer,
  // 供截图器精确定位相机（OrbitControls 的阻尼插值在无头环境里不可靠）
  setCam: (px, py, pz, tx, ty, tz) => {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    camera.near = Math.max(0.01, Math.min(0.05, camera.position.distanceTo(controls.target) * 0.05));
    camera.updateProjectionMatrix();
    controls.update();
    renderer.render(scene, camera);
    return { pos: camera.position.toArray(), tgt: controls.target.toArray(), near: camera.near };
  },
  // 无头截图前强制同步渲染（rAF 在无头标签里会被节流）
  forceRender: () => { renderer.render(scene, camera); },
  // ---------------------------------------------------------------- 遮挡探针
  // 判定"眼睛/脸有没有被头发挡住"。外部脚本手写 Möller–Trumbore 容易出错，
  // 这里直接借页面里的 THREE.Raycaster 做，结果最可信。
  //   view: 'front' 从脸前方沿 -Z 射向脸（模拟正面看向角色）
  // 返回每个采样格是否被头发命中，方便画 ASCII 遮挡图。
  occlude: (opts) => {
    // ⚠️ 关键：起点必须在**脸的前方很近处**。一开始我用 z=0.30 起步 + far=1.0，
    //    结果每一条射线都穿过后脑勺打到脑后的头发上，报出"100% 遮挡"的假象。
    //    正确做法：从脸最前点再往前 1.5cm 起步，far 只给 3cm，
    //    这样只统计"紧贴脸前方那层头发"，正是决定视觉遮挡的那层。
    const o = Object.assign({ y0: 1.50, y1: 1.62, dy: 0.01, x0: -0.09, x1: 0.09, dx: 0.015, near: 0.015, far: 0.03 }, opts || {});
    const hairMeshes = [];
    scene.traverse((m) => { if ((m.isMesh || m.isSkinnedMesh) && m.visible && /Hair|长发/i.test(m.name || '')) hairMeshes.push(m); });
    if (!hairMeshes.length) return { err: 'no hair mesh' };
    // 脸的最前点（用身体网格在 |X|<0.04 区间取最大 Z）
    let faceFront = -Infinity;
    scene.traverse((m) => {
      if (!(m.isMesh || m.isSkinnedMesh) || !m.visible) return;
      if (/Hair|长发|Eye|Brow|Lash/i.test(m.name || '')) return;
      const p = m.geometry.attributes.position; const e = m.matrixWorld.elements;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const X = e[0] * x + e[4] * y + e[8] * z + e[12];
        const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (Math.abs(X) < 0.04 && Z > faceFront) faceFront = Z;
      }
    });
    const z0 = faceFront + o.near;
    const rc = new THREE.Raycaster();
    rc.far = o.far;
    const dir = new THREE.Vector3(0, 0, -1);
    const rows = [];
    for (let y = o.y0; y <= o.y1 + 1e-9; y += o.dy) {
      let row = '';
      for (let x = o.x0; x <= o.x1 + 1e-9; x += o.dx) {
        rc.set(new THREE.Vector3(x, y, z0), dir);
        const hit = rc.intersectObjects(hairMeshes, false);
        row += hit.length ? '#' : '.';
      }
      rows.push('y=' + y.toFixed(3) + ' ' + row);
    }
    return { faceFront: +faceFront.toFixed(4), z0: +z0.toFixed(4), far: o.far, cols: rows[0] ? rows[0].length - 7 : 0, rows };
  },
  // 眼睛是否被遮挡：在眼裂椭圆上采样，返回遮挡率
  eyeBlocked: () => {
    // 同上：只关心眼睛前方 2cm 内那层头发，不要穿到脑后去。
    const meshes = [];
    scene.traverse((m) => { if ((m.isMesh || m.isSkinnedMesh) && m.visible) meshes.push(m); });
    const hairMeshes = meshes.filter((m) => /Hair|长发/i.test(m.name || ''));
    const eyes = meshes.filter((m) => /Eye/i.test(m.name || ''));
    if (!hairMeshes.length) return { err: 'no hair' };
    if (!eyes.length) return { err: 'no eyes' };
    const rc = new THREE.Raycaster();
    const dir = new THREE.Vector3(0, 0, -1);
    const out = [];
    for (const e of eyes) {
      const bb = new THREE.Box3().setFromObject(e);
      const c = bb.getCenter(new THREE.Vector3());
      const hw = (bb.max.x - bb.min.x) / 2;
      const hh = (bb.max.y - bb.min.y) / 2;
      const frontZ = bb.max.z;
      let blocked = 0, total = 0;
      const N = 15;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const X = c.x - hw + 2 * hw * i / (N - 1);
        const Y = c.y - hh + 2 * hh * j / (N - 1);
        if (((X - c.x) / hw) ** 2 + ((Y - c.y) / hh) ** 2 > 1.15) continue;
        total++;
        // 起点在眼球前极再往前 1mm，只往前探 2cm
        rc.set(new THREE.Vector3(X, Y, frontZ + 0.001), dir);
        rc.far = 0.02;
        const hit = rc.intersectObjects(hairMeshes, false);
        if (hit.length) blocked++;
      }
      out.push({ name: e.name, ctr: c.toArray().map((v) => +v.toFixed(4)), frontZ: +frontZ.toFixed(4),
        samples: total, blocked, blockedPct: +(blocked / Math.max(1, total) * 100).toFixed(1) });
    }
    return out;
  },
  parts: () => {
    const out = [];
    gParts.scene.traverse(o => { if (o.isMesh) {
      const m = o.material;
      out.push({ name: o.name, matType: m.type, hasMap: !!m.map,
        mapImg: m.map ? (m.map.image ? (m.map.image.width + 'x' + m.map.image.height) : 'no-image') : 'no-map',
        uvAttr: !!o.geometry.attributes.uv,
        uvCount: o.geometry.attributes.uv ? o.geometry.attributes.uv.count : 0,
        uvSample: o.geometry.attributes.uv ? [o.geometry.attributes.uv.getX(0), o.geometry.attributes.uv.getY(0)].map(x=>+x.toFixed(4)) : null,
        color: m.color ? m.color.getHexString() : null,
        parent: o.parent ? o.parent.name : null });
    }});
    return out;
  },
  uvRange: () => {
    let out = null;
    scene.traverse(o => { if (o.isMesh && EYE_NAME.test(o.name || '')) {
      const a = o.geometry.attributes.uv; let u0=9,u1=-9,v0=9,v1=-9;
      for (let i=0;i<a.count;i++){ const u=a.getX(i), v=a.getY(i);
        if(u<u0)u0=u; if(u>u1)u1=u; if(v<v0)v0=v; if(v>v1)v1=v; }
      out = { u: [+u0.toFixed(4), +u1.toFixed(4)], v: [+v0.toFixed(4), +v1.toFixed(4)] };
    }});
    return out;
  },
  eyePos: () => {
    const out = [];
    scene.traverse(o => { if (o.isMesh && EYE_NAME.test(o.name || '')) {
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      out.push({ n: o.name, isSkinned: !!o.isSkinnedMesh, boneL: o.skeleton ? o.skeleton.bones.length : 0,
        lsMin: b.min.toArray().map(x=>+x.toFixed(4)), lsMax: b.max.toArray().map(x=>+x.toFixed(4)),
        worldPos: o.getWorldPosition(new THREE.Vector3()).toArray().map(x=>+x.toFixed(4)) });
    }});
    return out;
  },
  // 眼睛朝向自检：找每只眼球**最靠 +Z（正前方）**的顶点，打印它的 UV。
  // 配合 Node 侧解码贴图，就能确定正面看到的是虹膜还是眼白。
  // 这比看截图靠谱：截图里只有一条缝，很难分辨是"虹膜转到背面"还是"贴图反了"。
  // 注意：局部坐标转世界时**不能用 o.localToWorld** —— 眼球是 SkinnedMesh，
  // 顶点在 bind 空间就已经是世界坐标了，localToWorld 会再乘一次矩阵。
  irisProbe: () => {
    const out = [];
    scene.traverse(o => {
      if (!o.isMesh || !EYE_NAME.test(o.name || '')) return;
      const pos = o.geometry.attributes.position, uv = o.geometry.attributes.uv;
      const v = new THREE.Vector3();
      const best = { z: -Infinity };
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i); o.localToWorld(v);
        if (v.z > best.z) best = { z: v.z, uv: [uv.getX(i), uv.getY(i)], p: v.toArray() };
      }
      out.push({
        side: o.name,
        uv: [+best.uv[0].toFixed(4), +best.uv[1].toFixed(4)],
        pos: best.p.map(x => +x.toFixed(4)),
      });
    });
    return out;
  },

  // ── 眼球深度诊断（世界坐标，一次性把所有相关几何放同一坐标系） ──
  // 上一版把"眼球是否可见"简化成"眼眶矩形里的棕色占比"，结果脸壳自己的肤色
  // 被算成了虹膜（棕 92.8%），彻底误导。这里改成直接量：
  //   1) 每只眼球的世界包围盒（中心 + 半径）
  //   2) 脸部（head 机身网格）在眼球 X 处、眼球 Y 附近的**最大 Z**（前轮廓）
  //   3) 两者之差 → 眼球到底是埋在里面还是凸在外面
  eyeAudit: (cz) => {
    const hv = new THREE.Vector3();
    const out = { eyes: [], face: {} };
    // ★ 眼球网格在场景里是 **SkinnedMesh**（被绑到 eye.L / eye.R 骨骼），
    //   所以这里**不能**用 !isSkinnedMesh 排除 —— 上一版就是因为加了
    //   `o.isSkinnedMesh` 排除条件，把所有眼球都筛掉了，返回空数组，
    //   让我误以为"眼球完全没加载"。判据改成用几何包围盒是否落在头部区域。
    const isEye = (o) => o.isMesh && /Eye/i.test((o.name || '') + '|' + (o.geometry && o.geometry.name || ''));
    // 头皮/脸部机身：排除眼球、头发、辅助件
    const isHeadSkin = (o) => o.isMesh && !/Eye|Hair|helper|lash|brow|teeth|tongue|Tongue|Teeth/i.test(o.name || '') && !isEye(o);
    scene.traverse(o => {
      if (!isHeadSkin(o)) return;
      const pos = o.geometry.attributes.position; if (!pos) return;
      const bb = new THREE.Box3();
      for (let i = 0; i < pos.count; i++) { hv.fromBufferAttribute(pos, i); o.localToWorld(hv); bb.expandByPoint(hv); }
      out.face[o.name] = {
        min: bb.min.toArray().map(x => +x.toFixed(4)),
        max: bb.max.toArray().map(x => +x.toFixed(4)),
      };
    });
    // 脸部前轮廓：以 eyeball 的 (x,y) 为中心，在半径 r 内找最大 z
    const silhouetteAt = (x, y, r) => {
      let best = -Infinity;
      scene.traverse(o => {
        if (!isHeadSkin(o)) return;
        const pos = o.geometry.attributes.position; if (!pos) return;
        for (let i = 0; i < pos.count; i++) {
          hv.fromBufferAttribute(pos, i); o.localToWorld(hv);
          if (Math.abs(hv.x - x) > r || Math.abs(hv.y - y) > r) continue;
          if (hv.z > best) best = hv.z;
        }
      });
      return best;
    };
    scene.traverse(o => {
      if (!isEye(o)) return;
      const pos = o.geometry.attributes.position; if (!pos) return;
      const bb = new THREE.Box3();
      for (let i = 0; i < pos.count; i++) { hv.fromBufferAttribute(pos, i); o.localToWorld(hv); bb.expandByPoint(hv); }
      const c = bb.getCenter(new THREE.Vector3());
      const rad = (bb.max.z - bb.min.z) / 2;
      const front = silhouetteAt(c.x, c.y, Math.max(rad * 1.2, 0.008));
      out.eyes.push({
        n: o.name,
        skinned: !!o.isSkinnedMesh,
        center: c.toArray().map(x => +x.toFixed(4)),
        radius: +rad.toFixed(4),
        faceFrontZ: +front.toFixed(4),
        // >0 表示球心在脸前面（凸出），<0 表示埋进脸里
        protrusion: +(c.z - front).toFixed(4),
      });
    });
    if (cz) out.skip = cz;
    return out;
  },
};
