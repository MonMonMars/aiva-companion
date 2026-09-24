/**
 * 把「真实 3D 模型」挂到角色场景上。
 *
 * 管线是这样的：
 *   assets/models/<id>.glb  ──require──>  bytes ──GLTFLoader.parse──> Object3D ──attachModel──> 舞台
 *   assets/models/<id>.jpg  ──require──>  bytes ──jpeg-js──────────> DataTexture ─applyTexture──> 材质
 *
 * 每一步都允许失败，并且失败时的表现是「降级」而不是「崩」：
 *   glb 挂不上  → 保留程序化角色（那个手搓的小人）
 *   jpg 解不了  → 模型以赛璐璐纯色显示
 * 所以对使用者来说最差的结果也只是「没那么好看」，不会出现白屏。
 */

import * as THREE from 'three';
import jpeg from 'jpeg-js';
import { readAssetBytes, readAssetJSON } from './assetBytes';

/**
 * 角色 → 模型资源。
 * 加第 4 个角色时：生成模型丢进 assets/models/，然后在这里补一行即可。
 * 注意：这些都是静态 require，Metro 在打包时解析 —— 文件不存在会直接构建失败，
 * 所以不要在这里引用还没生成的模型。
 *
 * 这里用的是 `.rigged.glb`（不是原始 .glb）：由 tools/autorig.mjs 离线生成，
 * 每个 mesh 都变成了绑在标准骨架上的 SkinnedMesh，材质/UV/贴图原样保留。
 * 有了骨架，`src/three/rigDriver.js` 才能驱动头部跟指尖转、被摸抬手。
 * 原始 .glb 保留在仓库里作为 autorig 的输入，运行时不再引用。
 *
 * 写实档（models2/）是例外：那些 glb 由 tools/build-realistic.mjs **一次性**生成，
 * 生成时就已经是绑好骨架的 SkinnedMesh，不需要再过 autorig。
 */
export const PERSONA_MODELS = {
  girlfriend: {
    model: require('../../assets/models/girlfriend.rigged.glb'),
    texture: require('../../assets/models/girlfriend.jpg'),
    // 24 个 ARKit blendshape 的稀疏位移（只含脸部顶点）。同样是 autorig 的产物。
    // 有了它才能对口型、做表情 —— 没有就只是「有个脸」，不会动。
    morph: require('../../assets/models/girlfriend.morph.json'),
  },
  boyfriend: {
    model: require('../../assets/models/boyfriend.rigged.glb'),
    texture: require('../../assets/models/boyfriend.jpg'),
    morph: require('../../assets/models/boyfriend.morph.json'),
  },
  secretary: {
    model: require('../../assets/models/secretary.rigged.glb'),
    texture: require('../../assets/models/secretary.jpg'),
    morph: require('../../assets/models/secretary.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // 写实档（assets/models2/）
  //
  // 和可爱档的差异：**没有 texture 字段**。写实模型由 tools/build-realistic.mjs
  // 程序化生成，上色靠顶点色（COLOR_0），所以不需要 jpg，下面的贴图分支会自然跳过。
  // morp 同样是 v3 稀疏定点格式，applyMorphData 直接吃得下。
  //
  // 注意：这些 .glb 已经是绑好骨架的 SkinnedMesh（生成时就绑了 23 根 Mixamo 骨），
  // 不需要再过一遍 tools/autorig.mjs。
  // ---------------------------------------------------------------------------
  'realistic-elena': {
    model: require('../../assets/models2/realistic-elena.glb'),
    morph: require('../../assets/models2/realistic-elena.morph.json'),
  },
  'realistic-mika': {
    model: require('../../assets/models2/realistic-mika.glb'),
    morph: require('../../assets/models2/realistic-mika.morph.json'),
  },
  'realistic-aria': {
    model: require('../../assets/models2/realistic-aria.glb'),
    morph: require('../../assets/models2/realistic-aria.morph.json'),
  },
  'realistic-marcus': {
    model: require('../../assets/models2/realistic-marcus.glb'),
    morph: require('../../assets/models2/realistic-marcus.morph.json'),
  },
  'realistic-kai': {
    model: require('../../assets/models2/realistic-kai.glb'),
    morph: require('../../assets/models2/realistic-kai.morph.json'),
  },
  'realistic-ren': {
    model: require('../../assets/models2/realistic-ren.glb'),
    morph: require('../../assets/models2/realistic-ren.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // 第二批扩列（2026-09）：Noa / Sora / Leon / Haruka
  //
  // 和上面 6 个完全同构（build-realistic.mjs 同一条管线、同样 23 骨 + 24 blendshape），
  // 所以这里只是多 4 行。选角刻意避开已有剪影：软糯针织 / 运动短发 /
  // 银发三件套 / 和风绯色。
  // ---------------------------------------------------------------------------
  'realistic-noa': {
    model: require('../../assets/models2/realistic-noa.glb'),
    morph: require('../../assets/models2/realistic-noa.morph.json'),
  },
  'realistic-sora': {
    model: require('../../assets/models2/realistic-sora.glb'),
    morph: require('../../assets/models2/realistic-sora.morph.json'),
  },
  'realistic-leon': {
    model: require('../../assets/models2/realistic-leon.glb'),
    morph: require('../../assets/models2/realistic-leon.morph.json'),
  },
  'realistic-haruka': {
    model: require('../../assets/models2/realistic-haruka.glb'),
    morph: require('../../assets/models2/realistic-haruka.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // FF 风格档
  //
  // ⚠️ 人格 id 是 `ff-*`，但**模型文件名仍是 `realistic-*`** ——
  //    这不是笔误：它们由 tools/build-realistic.mjs 生成，属于写实资产族，
  //    而 tools/inspect-*.mjs 都按 `realistic-` 前缀去 assets/models2/ 里找文件
  //    （还能自动补前缀）。改名会让体检工具静默跳过这 4 个。
  //    档位（tier: 'ff'）是 UI 分组，和资产命名是两件事。
  // ---------------------------------------------------------------------------
  'ff-rion': {
    model: require('../../assets/models2/realistic-rion.glb'),
    morph: require('../../assets/models2/realistic-rion.morph.json'),
  },
  'ff-celine': {
    model: require('../../assets/models2/realistic-celine.glb'),
    morph: require('../../assets/models2/realistic-celine.morph.json'),
  },
  'ff-bryce': {
    model: require('../../assets/models2/realistic-bryce.glb'),
    morph: require('../../assets/models2/realistic-bryce.morph.json'),
  },
  'ff-nyx': {
    model: require('../../assets/models2/realistic-nyx.glb'),
    morph: require('../../assets/models2/realistic-nyx.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // VTuber 低模档
  //
  // 同样沿用 `realistic-*` 资产命名（理由同 FF 档：体检工具按这个前缀找文件）。
  // 这一档和其他档唯一的结构差异是 **lod: 0.62** —— 全局降面系数，
  // 让三角面从 ~21k 降到 8.8k。运行时完全无感：骨架仍是 23 根，
  // blendshape 仍是 24 个 ARKit 子集，morph.json 仍是 v3 稀疏格式。
  // ---------------------------------------------------------------------------
  'vt-hikari': {
    model: require('../../assets/models2/realistic-hikari.glb'),
    morph: require('../../assets/models2/realistic-hikari.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // ⚠️ 2026-09 已删除的三条 Kizuna 档（vt-kizuna / kizuna-aiva / aiva-composed）
  //
  // 删除原因 —— 授权不允许再分发：
  //   licenseUrl          https://vrm.dev/licenses/1.0/
  //   commercialUsage     personalNonProfit   ← 只能个人非商用
  //   allowRedistribution false               ← **禁止再分发**
  //   modification        allowModification
  //   avatarPermission    onlyAuthor
  //
  // 它们被打进 dist 后一共 20.6 MB（kizuna-aiva 9.22 + kizuna-kamatte 7.43
  // + aiva-hair-kizuna 1.68 + aiva-outfit-kizuna 2.27），
  // 而这些字节会推到公开分享链接上 —— 等于公开分发。
  // 个人本地自用没问题，但既然新默认角色是 CC0 的 aiva-shino，没有理由再带着它们。
  //
  // 现在默认角色见 PRO_MODEL_PERSONA。要临时用回来做对比：
  // 本地改一条 require 即可（**改完不要再推公开链接**）。
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 纯底座：只有身体 + 脸，没有头发也没有衣服。（MakeHuman 档，CC0）
  //
  // 这是给「以后做新角色」用的底模，不是给最终用户看的（裸体）。
  // ---------------------------------------------------------------------------
  'aiva-base': {
    model: require('../../assets/models2/aiva-body.glb'),
    builtinMorph: true,
  },
  // ---------------------------------------------------------------------------
  // 日系动漫角色（Blender 建模 + autorig 绑骨）
  //
  // 和上面所有角色的关键差别：**它是 4 个独立 mesh**（Body / Hair / Eyes / Outfit）。
  // 现有 19 个角色都是单 mesh 顶点色，头发衣服焊死在身体上，换不了。
  // 拆开之后换发型 = 换掉 Hair 的几何，换衣服 = 换掉 Outfit，不用重做整只角色。
  //
  // 几何在 Blender 里程序化生成（_blender/build_anime.py，走 Blender MCP），
  // 骨骼和 24 个 ARKit blendshape 由 tools/autorig.mjs 自动生成。
  // ---------------------------------------------------------------------------
  'anime-aiva': {
    model: require('../../assets/models3/anime-aiva.rigged.glb'),
    morph: require('../../assets/models3/anime-aiva.morph.json'),
  },

  // ---------------------------------------------------------------------------
  // MakeHuman 真人底模档（assets/models4/）—— 当前默认
  //
  // 全部由 tools/mhproxy.mjs 从 MakeHuman 官方 CC0 素材包拟合而来，
  // 授权是 **CC0 1.0**（MakeHuman 全库无版权限制），和上面的 Kizuna 完全不同，
  // 这一个可以随便分发、商用。
  //
  //   aiva-base-mh.glb     身体（裸）+ 163 骨 + 58 个体型滑块(morph)   3.0 MB
  //   aiva-hair-anime.glb  动漫高模发型  91392 面 / 84 连通片          4.0 MB
  //   aiva-hair-long-mh.glb 长直发（面条发丝）13268 面 / 1019 连通片   2.1 MB
  //   aiva-brows-mh.glb    眉毛
  //   aiva-lashes-mh.glb   睫毛
  //   aiva-parts-mh.glb    眼球（两个独立网格，**没有骨架，要运行时绑**）
  //
  // ⚠️ 三个和其他档位不一样的地方，换模型前必读：
  //   1) **morph 是体型滑块，不是表情**。58 个 target 全是 BodyHeight /
  //      EyeSize / NoseWidth 这类。所以这里用 builtinMorph:false ＋ eyeBinder
  //      ＋ faceDriver，表情走**骨架**（jaw / orbicularis / risorius…）。
  //   2) 眼球在独立文件里且自带 skinIndex 全 0，必须由 eyeBinder 重绑到
  //      eye.L / eye.R，否则头一动眼睛就飞走。
  //   3) 发型有两套，默认用**动漫高模**那套：实测长直发（o4saken_long01）
  //      的刘海是一块斜切实心板，正面会盖住左眼和左半边脸，且发梢全是锯齿。
  //      高模那套同样身体/骨架/材质下完全正常。详见 tools/mh-look.mjs 的注释。
  // ---------------------------------------------------------------------------
  'aiva-mh': {
    model: require('../../assets/models4/aiva-base-mh.glb'),
    parts: [
      require('../../assets/models4/aiva-hair-anime.glb'),
      require('../../assets/models4/aiva-brows-mh.glb'),
      require('../../assets/models4/aiva-lashes-mh.glb'),
      require('../../assets/models4/aiva-parts-mh.glb'),
    ],
    // 体型滑块：SD 里 58 个 key 都能用 comp.applyMorph 灌（见 aiva-base-mh.sliders.json）
    sliders: require('../../assets/models4/aiva-base-mh.sliders.json'),
    // 非默认项 —— 见 loadCompanionModel 里的分支
    builtinMorph: false,
    eyeBinder: true,     // 眼球重绑到 eye.L / eye.R
    faceDriver: true,    // 用骨架驱动面部表情（代替 morph）
  },

  // ---------------------------------------------------------------------------
  // VRoid Studio「Sendagaya Shino」—— **当前默认**
  //
  // 用户明确要求：「找现成的高质量模型来改，别从零建」。这一条就是那个答案。
  //
  // 为什么是它（而不是继续修 MakeHuman 底模）：
  //   · MakeHuman 的 58 个 morph **全是体型滑块**，零个表情 ——
  //     所以它的脸永远是"蜡像"，不是绑骨/材质的问题，是**没数据**。
  //     自建 blendshape 这条路走不通，改换现成资产才是对的。
  //   · Shino 是 VRoid Studio 官方 sample，17 材质 / 29 贴图 /
  //     22,778 顶点 / 474 骨骼（含 30 根手指骨，零缺失）/ 15 个表情组。
  //
  // 授权（VRoid 官方 FAQ 明确）：CC0 1.0，著作者权放弃。
  //   https://vroid.pixiv.help/hc/en-us/articles/4402614652569
  //   base 模型与 **A/B/C 之外的** sample 均可商用、可再分发。
  //   ⚠️ 和上面 kizuna-* 那两条的 personalNonProfit + 禁再分发**完全不同**，
  //      这一条可以直接放进公开分享链接和商店包体。
  //
  // 转换：tools/vrm2glb.mjs（VRM 0.x → app 就绪的 GLB）
  //   14.18 MB → 4.69 MB（-67%）
  //   丢掉 MToon 专属图（_nml/_out/_spe/Matcap/Thumbnail/Shader_None*），
  //   保留 KHR_materials_unlit → three 映射成 MeshBasicMaterial，
  //   正好还原 VRoid 的赛璐璐平涂观感；基色贴图全部保留。
  //
  // ⚠️ 表情映射是**用数据定出来的**，别凭 ARKit/VRM 的名字对应去改：
  //   实测各表情的「嘴带纯度」（嘴带动点 / 全部动点）：
  //     a 99%  i 100%  u 100%  e 100%  o 99%    ← 纯口型
  //     blink_l / blink_r  嘴带 0%              ← 纯眼部
  //     joy 38%  fun 39%  sorrow 39%  angry 30% ← **整脸**表情
  //   把整脸表情直接接给单通道（比如 mouthSmile ← joy），
  //   会让嘴唇顺带执行眼睛和眉毛的动作 ——
  //   拍出来就是"下巴掉到胸口、脸下半塌成 V 形"。
  //   转换器现在的做法：纯口型的直接合成，整脸的用 maskUpper() 裁掉嘴带以下。
  //   依据见 tools/vrm2glb.mjs 顶部的 2a 段注释。
  //
  // ⚠️⚠️ 朝向：文件后缀链 aiva-shino.glb → -apose → -front，**只登记最后那个 -front**
  //   · app 相机在 companion.js 里写死 yaw=0 → position.z = +dist，也就是**站在 +Z 看向原点**；
  //     我们自建的 18 个角色都是朝 +Z 建的，所以一直没暴露问题。
  //   · VRM/VRM0 规范规定模型**面朝 −Z**（实测 J_Bip_C_Head 在 z=-0.03，眼球更负）。
  //     直接注册 -apose 会看到一颗后脑勺。
  //   · tools/face-front.mjs 把 5 个顶层 root（Face/Body/Root/Hairs/secondary）
  //     一起左乘 Ry(180°) 烘进节点旋转，做出 -front。
  //     必须 5 个一起转，只转 Body 会让零件散架。
  //   · 没有改 app 的原因：改 companion.js 会把另外 18 个自建角色的朝向全部翻过来。
  'aiva-shino': {
    model: require('../../assets/models4/aiva-shino-front.glb'),
    builtinMorph: true,   // 表情走模型自带的 16 条 ARKit 命名 blendshape
  },

  // ---------------------------------------------------------------------------
  // 同一个 Shino，**拆成三块**（当前默认）
  //
  // 为什么要拆：上面的单文件版把脸/身/发/衣烘死在一棵几何里 ——
  // （Face.baked 10 个材质分量共享同一份 2148 点；Body 9 个共享 7798 点；
  //   Hair 48 个共享 12832 点）**都是同一个 POSITION accessor，只靠 indices 区分材质**，
  // 所以常规的「按 node 切」剥不掉衣服，只能在 primitive 层面过滤 ——
  // 这就是 tools/glbpart-filter.mjs 干的事。
  //
  // 产物（assets/models5/）：
  //   aiva-shino-base.glb    脸(10 prim) + 裸躯干(4 个 _SKIN prim)   16 个表情 morph 全在
  //   aiva-shino-outfit.glb  Tops / Accessory / Bottoms / Shoes      4 个 CLOTH prim
  //   aiva-shino-hair.glb    主头发 48 prim + Body 里的后发          合成一顶完整头发
  //
  // 三份文件都保留**完整且逐字相同**的 163 节点树 / 3 套 skin / 158 joints，
  // 所以运行时能按节点路径把部件挂回底座（companion.js 的 attachParts），再重绑骨骼。
  // ⚠️ 拆分时只要节点数对不上 163，模型就会散架并抛
  //    `Cannot read properties of undefined`（原因和表象隔了十万八千里）。
  //
  // ⚠️ 体积：三份合计 5.6MB > 整只 4.69MB，因为共享的那份身体顶点缓冲被复制了 3 遍。
  //    这是已知的待优化项（顶点压实），不影响正确性。
  'aiva-shino-parts': {
    model: require('../../assets/models5/aiva-shino-base.glb'),
    parts: [
      require('../../assets/models5/aiva-shino-outfit.glb'),
      require('../../assets/models5/aiva-shino-hair.glb'),
    ],
    builtinMorph: true,   // 表情在 base 的 Face.baked 上，与部件无关
  },
};

export const hasModel = (personaId) => !!PERSONA_MODELS[personaId];

/** 一张 1024² RGBA = 4MB，给上限防止将来换成大图时把低端机打爆 */
const DECODE_MEMORY_MB = 96;

function decodeToTexture(bytes) {
  const img = jpeg.decode(bytes, {
    useTArray: true,          // 必须：不给它用 Buffer，RN 里没有
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxMemoryUsageInMB: DECODE_MEMORY_MB,
  });

  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  // glTF 的 UV 原点在左上，DataTexture 默认 flipY=false，两者正好对上 —— 千万别 flip
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** GLTFLoader.parse 只吃正经 ArrayBuffer，而 subarray 出来的视图 byteOffset 可能不为 0 */
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * 读 URL 上的 ?model=<glb 地址> 参数。
 * 这是「用在线专业 VTuber / AAA 模型」的开关：把任意 GLB 链接贴进地址栏即可，
 * 例如 Ready Player Me 的 avatar、VRoid 导出的 GLB、或任何 Mixamo 骨架的模型。
 * 没有 / 不是合法 URL 就返回 null（走下面的打包专业模型）。
 */
function getParamModel() {
  try {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const m = new URLSearchParams(window.location.search).get('model');
      if (m && /^https?:\/\//i.test(m)) return m;
    }
  } catch (_) { /* 非浏览器环境（原生端）忽略 */ }
  return null;
}

/**
 * 全局专业模型人格 id。
 * 用户要求：暂时全部角色都用「真实专业 VTuber / AAA 模型」，不再用我们自研的程序化/绑定模型，
 * 先「学别人的模型」，以后再做自己的。这里默认指向已打包的官方免费 VTuber（Kizuna AI）。
 * 想换成别的：改这个 id（指向 PERSONA_MODELS 里任意一项），或用 ?model=<url> 在线指定。
 */
// 2026-09 更新：换成 'aiva-shino'（VRoid Studio 官方 CC0 sample）。
// 换的理由：
//   · 授权：Kizuna 那份是 personalNonProfit + allowRedistribution:false，
//     放进公开分享链接就是越线。VRoid 官方 sample 是 CC0，可以随便分发商用。
//   · 数据：aiva-mh 的底模（MakeHuman）58 个 morph **全是体型滑块、零个表情**，
//     所以那张脸永远做不出表情 —— 不是绑定坏，是没数据。
//     Shino 自带 15 个表情组，转出 16 条标准 ARKit 通道，全部实测可驱动。
//   · 质量：22,778 顶点 / 17 材质 / 29 贴图 / 474 骨骼（含 30 根手指骨）。
//
// 想回退到旧模型：把这里改成 'aiva-mh' 或 'aiva-composed' 即可（条目都还在）。
const PRO_MODEL_PERSONA = 'aiva-shino-parts';

/**
 * 解析这一次要加载哪个模型。
 * 优先级：?model=在线URL  >  全局打包专业模型  >  该人格自带模型（保底）。
 * 返回值：{ kind:'url', model } | { kind:'bundled', entry }
 */
function resolveModelEntry(personaId) {
  const url = getParamModel();
  if (url) return { kind: 'url', model: url };

  const pro = PERSONA_MODELS[PRO_MODEL_PERSONA];
  if (pro) return { kind: 'bundled', entry: pro };

  const own = PERSONA_MODELS[personaId];
  return own ? { kind: 'bundled', entry: own } : null;
}

/**
 * @param {object} comp  createCompanionScene() 的返回值
 * @param {string} personaId
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function loadCompanionModel(comp, personaId) {
  const resolved = resolveModelEntry(personaId);
  if (!resolved) return { ok: false, reason: 'no-asset' };

  // --- 1) 主来源：在线 URL 或 打包专业模型 ---------------------------------
  let ok = false;
  try {
    if (resolved.kind === 'url') {
      // 在线专业模型：直接让 GLTFLoader 去 fetch（已挂 DRACOLoader，压缩模型也能解）
      ok = await comp.loadModel(resolved.model);
    } else {
      const { bytes } = await readAssetBytes(resolved.entry.model);
      ok = await comp.loadModel(toArrayBuffer(bytes));
    }
  } catch (e) {
    console.warn('[model] 主模型加载失败：', e?.message || e);
  }

  // --- 1.5) 可换装部件（头发 / 衣服）：挂到刚加载的底座上 -------------------
  // 底座自己只有身体和脸，头发衣服是单独的文件，在运行时按节点路径拼回去。
  // 这一步失败不翻脸：最坏结果是"没头发/没穿衣服"，角色本体照常能动能说话。
  if (ok && resolved.kind === 'bundled' && Array.isArray(resolved.entry.parts)) {
    try {
      const bufs = [];
      for (const p of resolved.entry.parts) {
        const { bytes } = await readAssetBytes(p);
        bufs.push(toArrayBuffer(bytes));
      }
      const n = await comp.attachParts(bufs);
      console.info(`[model] 换装部件挂载完成：${n} 个网格`);
    } catch (e) {
      console.warn('[model] 部件挂载失败，角色可能缺头发/衣服：', e?.message || e);
    }
  }

  // --- 1.6) 眼球重绑（只对 MakeHuman 档）-----------------------------------
  // 眼球 GLB 里 skinIndex 全是 0（两个球都绑在第 0 根骨上），头一动就飞。
  // 必须在部件挂载**之后**、morph 之前做：部件挂载会把眼球搬进身体那棵树，
  // 重绑要拿到最终的父子关系和骨骼世界坐标。
  const eyeHandle = { measure: null, sides: null };
  if (ok && resolved.kind === 'bundled' && resolved.entry.eyeBinder) {
    try {
      const r = comp.bindEyes?.();
      if (r?.bound) {
        Object.assign(eyeHandle, r);
        console.info(`[model] 眼球已重绑：${r.bound} 个网格 → ${r.sides?.posX} / ${r.sides?.negX}`);
      } else {
        console.warn('[model] 眼球重绑没生效，眼睛可能不跟随头部');
      }
    } catch (e) {
      console.warn('[model] 眼球重绑失败：', e?.message || e);
    }
  }

  // --- 2) 在线 URL 挂了 → 退回「打包专业模型」，保证一定有真实模型 ----------
  if (!ok && resolved.kind === 'url' && PERSONA_MODELS[PRO_MODEL_PERSONA]) {
    try {
      const pro = PERSONA_MODELS[PRO_MODEL_PERSONA];
      const { bytes } = await readAssetBytes(pro.model);
      ok = await comp.loadModel(toArrayBuffer(bytes));
      resolved.entry = pro;
      resolved.kind = 'bundled';
      console.info('[model] 在线模型加载失败，已退回打包专业模型');
    } catch (e) {
      console.warn('[model] 保底专业模型也挂了：', e?.message || e);
    }
  }

  if (!ok) {
    console.warn('[model] 专业模型都没挂上，保留程序化角色（不会白屏）');
    return { ok: false, reason: 'attach-failed' };
  }

  const entry = resolved.entry || {};

  // 贴图（仅自研模型需要；专业模型自带材质，跳过）
  if (entry.texture) {
    try {
      const { bytes } = await readAssetBytes(entry.texture);
      const tex = decodeToTexture(bytes);
      if (!comp.applyTexture(tex)) {
        tex.dispose();
        console.warn('[model] 贴图挂载失败，模型以纯色显示');
      }
    } catch (e) {
      console.warn('[model] 贴图解码失败，模型以纯色显示：', e?.message || e);
    }
  }

  // 表情 / 口型：把 blendshape 位移灌进 geometry.morphAttributes。
  // 失败只是"不会做表情"，模型和骨架照常工作，所以这里同样吞掉异常。
  if (resolved.kind === 'url') {
    // 外部模型：复用它自带的 blendshape（若有）
    try {
      const h = comp.applyBuiltinMorph();
      if (!h) console.info('[model] 在线模型没有可用的内置 blendshape（口型将不驱动）');
    } catch (e) {
      console.warn('[model] 内置 blendshape 接管失败：', e?.message || e);
    }
  } else if (entry.morph) {
    try {
      const data = await readAssetJSON(entry.morph);
      const handle = comp.applyMorph(data);
      if (!handle) console.warn('[model] morph 数据没接上（网格对不上或格式不符）');
    } catch (e) {
      console.warn('[model] morph 加载失败，角色不会做表情：', e?.message || e);
    }
  } else if (entry.builtinMorph) {
    // 外部模型（官方 VRM 转来的 GLB）：复用它自带的 blendshape。
    try {
      const handle = comp.applyBuiltinMorph();
      if (!handle) console.warn('[model] 模型没有可用的内置 blendshape');
    } catch (e) {
      console.warn('[model] 内置 blendshape 接管失败：', e?.message || e);
    }
  } else if (entry.faceDriver) {
    // MakeHuman 档：58 个 morph 全是体型滑块，一个表情都没有。
    // 表情走骨架 —— 见 src/anim/makehumanFace.js 的长注释。
    try {
      const handle = comp.applySkeletalFace?.();
      if (!handle) console.warn('[model] 骨架表情没接上，角色不会做表情（体型滑块仍可用）');
      else eyeHandle.face = handle;
    } catch (e) {
      console.warn('[model] 骨架表情接管失败：', e?.message || e);
    }
  }

  return { ok: true, eyes: eyeHandle.measure ? eyeHandle : null };
}
