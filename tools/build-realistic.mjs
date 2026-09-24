// 写实人形角色生成器（离线构建步骤）
// ---------------------------------------------------------------------------
// 和 build-character.mjs 的关系：
//   那个是「可爱 Q 版」，这个是「写实档」。两者**不是二选一**——
//   输出的结构完全一致（Mixamo 兼容骨架 + ARKit blendshape + 顶点色），
//   所以 autorig / rigDriver / morphData / lipSync 这整条运行时链路
//   对两种角色一视同仁，运行时不需要知道这个角色是可爱还是写实。
//
// 为什么不共用一份代码：
//   「更写实」不是把参数调大写就行 —— 写实的本质是**多出好几个几何层**：
//     · 立体五官（鼻梁 / 鼻头 / 鼻翼 / 唇 / 颧骨 / 下颌线）—— Q 版是一颗球
//     · 独立眼球 + 虹膜 + 瞳孔 + 高光点 —— Q 版是贴片
//     · 分层头发（发际线 + 发束 + 发尾）—— Q 版是一块罩壳
//     · 分件服装（外套 / 内搭 / 腰带 / 下装）—— Q 版是单层色块
//     · 皮肤多段渐变（额头偏亮、脸颊偏红、四肢偏黄）
//   硬塞进一个函数会用一堆 if 搅在一起，不如分开写、共享底层几何原语。
//
// 用法：node tools/build-realistic.mjs <id> [<id> ...]
//       node tools/build-realistic.mjs --list        # 看有哪些预设

import fs from 'fs';
import path from 'path';

// GLTFExporter 内部会读 Blob，Node 里缺 FileReader
globalThis.FileReader = class {
  readAsArrayBuffer(b) {
    b.arrayBuffer().then((x) => { this.result = x; this.onloadend && this.onloadend(); });
  }
};

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

// ===========================================================================
// 写实预设
// ===========================================================================
// 关键：全是**真实成人比例**。8 头身意味着头高 ≈ 身高/7.7，
// 这个比例一改，整个人的气质就从小孩变成成年人 —— 这是写实和 Q 版最大的分水岭。
//
// ratio 是「头高 / 身高」的倒数（头身数）。写实女性取 7.5，男性取 7.8。

const PRESETS = {
  // --- 女 ---
  'realistic-elena': {
    label: 'Elena · 知性女教师',
    gender: 'female',
    height: 1.70,
    // FF7R 标准：角色约 8 头身（原 7.5）。FF7 Rebirth 的角色比真人略修长，
    // 四肢更长、头更小，这是"写实但理想化"的关键比例特征。
    headsTall: 8.0,
    shoulder: 0.36,
    hip: 0.35,
    build: 'slim',
    skin: [0.95, 0.80, 0.71],
    skinShade: [0.88, 0.70, 0.62],   // 暗部（下颌 / 颈部）
    skinBlush: [0.96, 0.74, 0.68],   // 脸颊
    hair: [0.20, 0.13, 0.10],        // 深棕
    hairHi: [0.34, 0.23, 0.17],      // 高光发丝
    eye: [0.32, 0.22, 0.14],         // 琥珀
    browStyle: 'arched',
    hairStyle: 'long-straight',
    outfit: {
      outer: [0.72, 0.74, 0.78],     // 灰西装外套
      inner: [0.96, 0.95, 0.93],     // 白衬衫
      bottom: [0.24, 0.26, 0.34],    // 深灰西裤
      shoes: [0.14, 0.13, 0.14],
      accents: [0.62, 0.20, 0.24],   // 领口一点暗红
    },
  },
  'realistic-mika': {
    label: 'Mika · 冷感御姐',
    gender: 'female',
    height: 1.74,
    headsTall: 8.0,
    shoulder: 0.37,
    hip: 0.36,
    build: 'slim',
    skin: [0.97, 0.86, 0.80],
    skinShade: [0.90, 0.76, 0.70],
    skinBlush: [0.98, 0.78, 0.74],
    hair: [0.06, 0.06, 0.08],        // 黑
    hairHi: [0.19, 0.18, 0.22],
    eye: [0.14, 0.20, 0.28],         // 冷灰蓝
    browStyle: 'straight',
    hairStyle: 'long-wavy',
    outfit: {
      outer: [0.10, 0.10, 0.13],
      inner: [0.16, 0.17, 0.21],
      bottom: [0.08, 0.08, 0.11],
      shoes: [0.06, 0.06, 0.07],
      accents: [0.78, 0.72, 0.60],   // 金属扣
    },
  },
  'realistic-aria': {
    label: 'Aria · 暖阳少女',
    gender: 'female',
    height: 1.63,
    headsTall: 7.9,
    shoulder: 0.33,
    hip: 0.34,
    build: 'soft',
    skin: [0.96, 0.83, 0.74],
    skinShade: [0.89, 0.73, 0.64],
    skinBlush: [0.98, 0.76, 0.70],
    hair: [0.55, 0.33, 0.16],        // 栗棕
    hairHi: [0.72, 0.50, 0.28],
    eye: [0.36, 0.48, 0.30],         // 浅绿
    browStyle: 'soft',
    hairStyle: 'long-wavy',
    outfit: {
      outer: [0.90, 0.62, 0.42],     // 奶茶色针织
      inner: [0.97, 0.95, 0.92],
      bottom: [0.42, 0.44, 0.52],
      shoes: [0.72, 0.66, 0.60],
      accents: [0.86, 0.72, 0.44],
    },
  },

  // --- 男 ---
  'realistic-marcus': {
    label: 'Marcus · 沉稳男性',
    gender: 'male',
    height: 1.84,
    headsTall: 8.1,
    shoulder: 0.47,
    hip: 0.37,
    build: 'athletic',
    skin: [0.86, 0.68, 0.56],
    skinShade: [0.78, 0.58, 0.47],
    skinBlush: [0.88, 0.63, 0.53],
    hair: [0.14, 0.11, 0.10],
    hairHi: [0.26, 0.21, 0.18],
    eye: [0.28, 0.20, 0.14],
    browStyle: 'straight',
    hairStyle: 'short-crop',
    outfit: {
      outer: [0.20, 0.24, 0.33],     // 深蓝大衣
      inner: [0.93, 0.92, 0.90],
      bottom: [0.22, 0.22, 0.26],
      shoes: [0.10, 0.10, 0.11],
      accents: [0.55, 0.42, 0.28],
    },
  },
  'realistic-kai': {
    label: 'Kai · 阳光型男',
    gender: 'male',
    height: 1.80,
    headsTall: 8.0,
    shoulder: 0.45,
    hip: 0.36,
    build: 'athletic',
    skin: [0.93, 0.79, 0.66],
    skinShade: [0.85, 0.69, 0.57],
    skinBlush: [0.94, 0.72, 0.61],
    hair: [0.22, 0.16, 0.11],
    hairHi: [0.40, 0.31, 0.20],
    eye: [0.30, 0.42, 0.46],         // 灰蓝
    browStyle: 'straight',
    hairStyle: 'short-swept',
    outfit: {
      outer: [0.78, 0.74, 0.66],     // 米色夹克
      inner: [0.24, 0.30, 0.40],
      bottom: [0.30, 0.33, 0.42],
      shoes: [0.90, 0.89, 0.86],
      accents: [0.72, 0.34, 0.28],
    },
  },
  'realistic-ren': {
    label: 'Ren · 清瘦艺术家',
    gender: 'male',
    height: 1.77,
    headsTall: 8.0,
    shoulder: 0.42,
    hip: 0.34,
    build: 'slim',
    skin: [0.95, 0.84, 0.75],
    skinShade: [0.87, 0.74, 0.65],
    skinBlush: [0.95, 0.75, 0.68],
    hair: [0.10, 0.10, 0.12],
    hairHi: [0.24, 0.23, 0.28],
    eye: [0.16, 0.16, 0.18],
    browStyle: 'soft',
    hairStyle: 'medium-tousled',
    outfit: {
      outer: [0.30, 0.31, 0.35],     // 炭灰针织
      inner: [0.86, 0.85, 0.83],
      bottom: [0.18, 0.18, 0.20],
      shoes: [0.52, 0.40, 0.30],
      accents: [0.42, 0.52, 0.48],
    },
  },

  // =========================================================================
  // FF 风格四件套
  // =========================================================================
  // ⚠️ 这 4 个是**原创角色**，不是 Square Enix 的角色。
  //    借鉴的只是 Square Enix 的**工艺与比例标准**（见 buildHead / buildHair 里的
  //    FF7R 注释）：约 8 头身、窄 V 下颌、放大眼、小鼻、card-based 的密发束。
  //    外观（配色 / 发型 / 装备剪影）全部重新设计，用来和上面 6 个做 A/B 横评。
  //
  //    extras 是本轮新增的「剪影特征」开关，由 buildExtras() 生成。
  //    四个特征指向四个**远离脸**的方向：尖发往上、肩甲往两侧、
  //    长裙往下、兜帽往后 —— 见 buildExtras 顶上的两条硬规则。
  'realistic-rion': {
    label: 'Rion · 尖发剑士',
    gender: 'male',
    height: 1.82,
    headsTall: 8.1,
    shoulder: 0.46,
    hip: 0.36,
    build: 'athletic',
    skin: [0.93, 0.79, 0.68],
    skinShade: [0.85, 0.68, 0.57],
    skinBlush: [0.94, 0.72, 0.62],
    hair: [0.62, 0.50, 0.28],        // 亚麻金
    hairHi: [0.82, 0.70, 0.44],
    eye: [0.22, 0.42, 0.58],         // 晴蓝
    browStyle: 'straight',
    hairStyle: 'short-swept',
    extras: { spikes: 14, cape: true },
    outfit: {
      outer: [0.20, 0.26, 0.42],     // 深蓝军服
      inner: [0.42, 0.46, 0.56],     // 钢灰胸甲
      bottom: [0.16, 0.18, 0.26],
      shoes: [0.24, 0.18, 0.14],
      accents: [0.62, 0.16, 0.18],   // 暗红披风
    },
  },
  'realistic-celine': {
    label: 'Celine · 长裙法师',
    gender: 'female',
    height: 1.68,
    headsTall: 8.0,
    shoulder: 0.34,
    hip: 0.35,
    build: 'slim',
    skin: [0.97, 0.89, 0.85],
    skinShade: [0.90, 0.80, 0.76],
    skinBlush: [0.98, 0.80, 0.78],
    // ⚠️ 银发不能取到 [0.9,0.9,0.95] 以上：那和「眼白」[0.97,0.96,0.95] 的
    //    欧氏距离会掉到 0.12 以内，inspect-hair 会把发尖误判成 eye，
    //    于是最顶上的头发被排除在统计外（顶厚静默失效）。淡紫银是安全上限。
    hair: [0.70, 0.68, 0.80],
    hairHi: [0.85, 0.83, 0.92],
    eye: [0.42, 0.30, 0.60],         // 紫
    browStyle: 'soft',
    hairStyle: 'long-straight',
    extras: { skirt: true },
    outfit: {
      outer: [0.90, 0.90, 0.94],     // 月白长袍
      inner: [0.72, 0.74, 0.86],
      bottom: [0.80, 0.81, 0.88],
      shoes: [0.42, 0.40, 0.46],
      accents: [0.78, 0.66, 0.34],   // 金饰边
    },
  },
  'realistic-bryce': {
    label: 'Bryce · 重装佣兵',
    gender: 'male',
    height: 1.88,
    headsTall: 8.2,
    shoulder: 0.52,                  // 盔甲下的宽肩（真人 0.25H，他 0.28H）
    hip: 0.40,
    build: 'heavy',
    skin: [0.82, 0.64, 0.52],
    skinShade: [0.73, 0.54, 0.43],
    skinBlush: [0.85, 0.58, 0.48],
    hair: [0.22, 0.19, 0.17],        // 灰褐
    hairHi: [0.38, 0.33, 0.28],
    eye: [0.30, 0.26, 0.20],
    browStyle: 'straight',
    hairStyle: 'short-crop',
    extras: { pauldron: true },
    outfit: {
      outer: [0.26, 0.27, 0.30],     // 暗铁
      inner: [0.34, 0.35, 0.39],
      bottom: [0.20, 0.20, 0.23],
      shoes: [0.14, 0.13, 0.13],
      accents: [0.66, 0.50, 0.22],   // 黄铜
    },
  },
  'realistic-nyx': {
    label: 'Nyx · 兜帽游侠',
    gender: 'female',
    height: 1.70,
    headsTall: 8.0,
    shoulder: 0.35,
    hip: 0.35,
    build: 'slim',
    skin: [0.91, 0.76, 0.64],
    skinShade: [0.83, 0.66, 0.55],
    skinBlush: [0.93, 0.68, 0.58],
    hair: [0.34, 0.19, 0.12],        // 赤褐
    hairHi: [0.52, 0.30, 0.18],
    eye: [0.26, 0.44, 0.34],         // 苔绿
    browStyle: 'arched',
    hairStyle: 'medium-tousled',
    extras: { hood: true },
    outfit: {
      outer: [0.24, 0.32, 0.24],     // 深林绿斗篷
      inner: [0.46, 0.42, 0.34],     // 皮革
      bottom: [0.30, 0.28, 0.24],
      shoes: [0.22, 0.18, 0.14],
      accents: [0.72, 0.62, 0.36],
    },
  },

  // =========================================================================
  // VTuber 低模档（第 11 个角色 · 单独一档）
  // =========================================================================
  // ⚠️ 法务边界（先说清楚，这条比代码重要）：
  //    Kizuna AI 官网免费配布的 kizunaai.pmx（作者 Tomitake / 监修 Tda / 人设 森倉円）
  //    利用規約的「禁止事項」里明写着两条：
  //      · データの再配布（禁止再分发）
  //      · **モデルの一部を移植、または素材として別のモデルを作成すること**
  //        （禁止把模型的一部分移植、或当作素材去制作另一个模型）
  //      · 商用利用は別途問い合わせ（商用需另行联系）
  //    也就是说：**拿她的模型改一改是明确违规的**，即使只是"参考着做"也很容易踩线。
  //
  //    所以这里借鉴的**只有公开的工程规格与制作方法**，没有任何一行几何来自她：
  //      · 面数预算   —— VRChat 用减面版约 19.7k tris / 12.5k verts（Sketchfab 同量级）
  //                      本档取 lod 0.62，实测落在 ~8k tris，明显低于那条线
  //      · 骨骼       —— 她那份 93 骨（含 MMD 表情骨 + 动态骨），
  //                      我们仍是 23 骨 Mixamo 标准（运行时链条决定的，不动）
  //      · 表情       —— VTuber 通用 ARKit / PerfectSync 52 形，我们沿用已有 24 形子集
  //      · 比例       —— 动漫向 6.5 头身（不是 FF 档的 8 头身，也不是 Q 版）
  //      · 剪影       —— 大体积发型 + 头戴耳机（VTuber 的强识别特征）
  //
  //    外观全部原创：薄荷青→奶油金渐变发、青蓝瞳、深蓝白偶像装。
  //
  // ⚠️ headsTall 6.5 会让 inspect-character 原来的 6.8~8.6 断言失败 ——
  //    那是**写实档**的合格带。本档是动漫比例，体检工具已按 name 分档（见该文件）。
  'realistic-hikari': {
    label: 'Hikari · 虚拟歌姬',
    gender: 'female',
    height: 1.60,
    // 动漫 / VTuber 标准头身。真人女性 7.5、FF 档 8.0，动漫向要**头更大**：
    // 6.5 头身下头高 = 1.60/6.5 = 0.246m，一眼就是"二次元"而不是"写实成年人"。
    headsTall: 6.5,
    shoulder: 0.33,                  // 0.206H —— 比真人窄，动漫角色的肩都收着
    hip: 0.31,
    build: 'slim',
    style: 'vtuber',                 // 触发 buildHead 的动漫五官分支
    lod: 0.62,                       // 全局降面系数，见上面的 LOD 注释
    skin: [0.99, 0.89, 0.83],        // 动漫皮肤：亮、低饱和、几乎无瑕疵
    skinShade: [0.93, 0.80, 0.75],
    skinBlush: [1.00, 0.78, 0.76],
    // ⚠️ 发色和「眼白」[0.97,0.96,0.95] 必须拉开欧氏距离 >0.12，
    //    否则 inspect-hair 会把发尖判成 eye，顶厚统计静默失效（celine 踩过）。
    hair: [0.36, 0.72, 0.66],        // 薄荷青
    hairHi: [0.86, 0.80, 0.46],      // 奶油金挑染
    eye: [0.25, 0.62, 0.85],         // 青蓝（动漫瞳色：高饱和）
    browStyle: 'soft',
    hairStyle: 'long-straight',
    extras: { ahoge: true, headset: true },
    outfit: {
      outer: [0.30, 0.34, 0.52],     // 深蓝偶像外套
      inner: [0.97, 0.96, 0.98],     // 白衬衫
      bottom: [0.26, 0.29, 0.46],    // 百褶裙
      shoes: [0.85, 0.86, 0.92],     // 白长靴
      accents: [0.30, 0.80, 0.88],   // 青色发光条（VTuber 的科技感）
    },
  },

  // =========================================================================
  // 第二批扩列（2026-09 新增）
  // =========================================================================
  // 起因：用户要「更多 3D 角色模型」。这 4 个和上面 11 个一样是**原创角色**，
  // 走同一条生成管线（Mixamo 骨架 + ARKit blendshape + 顶点色），
  // 所以运行时不需要为它们改任何代码 —— 只是多 4 行预设。
  //
  // 选角原则：**和已有 11 个的剪影不重复**。
  //   已有：西装教师 / 黑长直御姐 / 红裙辣妹 / 大衣沉稳男 / 米色阳光男 /
  //         炭灰艺术家 / 尖发剑士 / 长裙法师 / 肩甲重甲 / 兜帽刺客 / 耳机歌姬
  //   新增：邻家学妹（软糯针织）/ 运动系学姐（短发 + 运动服）/
  //         银发绅士（三件套西装）/ 和风料理人（深红上装 + 黑长直）

  'realistic-noa': {
    label: 'Noa · 邻家学妹',
    gender: 'female',
    height: 1.63,
    headsTall: 7.6,                  // 比 FF 档矮一点、头大一点 = 更"邻家"
    shoulder: 0.35,
    hip: 0.35,
    build: 'soft',
    skin: [0.98, 0.87, 0.80],
    skinShade: [0.91, 0.78, 0.71],
    skinBlush: [0.99, 0.78, 0.74],   // 腮红重一点：软糯感靠这个
    hair: [0.55, 0.38, 0.24],        // 亚麻棕（和 mika 的纯黑、aria 的红拉开）
    hairHi: [0.78, 0.62, 0.40],
    eye: [0.45, 0.34, 0.22],         // 浅褐
    browStyle: 'soft',
    hairStyle: 'long-wavy',
    outfit: {
      outer: [0.94, 0.90, 0.84],     // 米白针织开衫
      inner: [0.98, 0.97, 0.95],
      bottom: [0.52, 0.60, 0.72],    // 浅牛仔
      shoes: [0.86, 0.82, 0.76],
      accents: [0.86, 0.52, 0.56],   // 藕粉小丝带
    },
  },
  'realistic-sora': {
    label: 'Sora · 运动系学姐',
    gender: 'female',
    height: 1.71,
    headsTall: 7.9,                  // 修长但不走 FF 的 8.0
    shoulder: 0.38,
    hip: 0.36,
    build: 'athletic',               // 肩背有训练痕迹，和 slim 档明显不同
    skin: [0.90, 0.74, 0.62],        // 晒过的小麦色
    skinShade: [0.82, 0.65, 0.53],
    skinBlush: [0.93, 0.70, 0.60],
    hair: [0.13, 0.19, 0.34],        // 深蓝黑短发
    hairHi: [0.30, 0.40, 0.60],
    eye: [0.20, 0.38, 0.42],         // 青绿
    browStyle: 'straight',
    hairStyle: 'medium-tousled',     // 及颈乱发：方便和长发系一眼区分
    outfit: {
      outer: [0.16, 0.30, 0.55],     // 藏青运动外套
      inner: [0.95, 0.95, 0.96],
      bottom: [0.14, 0.18, 0.30],    // 深蓝短裤
      shoes: [0.96, 0.96, 0.97],     // 白运动鞋
      accents: [0.95, 0.72, 0.18],   // 荧光黄滚边
    },
  },
  'realistic-leon': {
    label: 'Leon · 银发绅士',
    gender: 'male',
    height: 1.83,
    headsTall: 8.1,
    shoulder: 0.46,
    hip: 0.37,
    build: 'athletic',
    skin: [0.90, 0.78, 0.68],
    skinShade: [0.82, 0.69, 0.59],
    skinBlush: [0.92, 0.72, 0.64],
    hair: [0.68, 0.69, 0.72],        // 银灰（和 marcus 深黑、kai 棕拉开）
    hairHi: [0.88, 0.89, 0.92],
    eye: [0.30, 0.44, 0.38],         // 沉静绿
    browStyle: 'arched',
    hairStyle: 'short-swept',
    outfit: {
      outer: [0.26, 0.28, 0.34],     // 炭灰三件套西装
      inner: [0.97, 0.96, 0.94],
      bottom: [0.22, 0.24, 0.30],
      shoes: [0.12, 0.11, 0.12],
      accents: [0.60, 0.48, 0.26],   // 黄铜袖扣 / 怀表链
    },
  },
  'realistic-haruka': {
    label: 'Haruka · 和风料理人',
    gender: 'female',
    height: 1.66,
    headsTall: 7.7,
    shoulder: 0.35,
    hip: 0.36,
    build: 'soft',
    skin: [0.99, 0.90, 0.85],
    skinShade: [0.92, 0.81, 0.76],
    skinBlush: [0.99, 0.79, 0.77],
    hair: [0.09, 0.08, 0.10],        // 纯黑长直
    hairHi: [0.26, 0.24, 0.30],
    eye: [0.33, 0.20, 0.18],         // 深褐
    browStyle: 'soft',
    hairStyle: 'long-straight',
    outfit: {
      outer: [0.55, 0.16, 0.20],     // 深红绯色上装
      inner: [0.98, 0.97, 0.95],     // 白襦袢领
      bottom: [0.16, 0.15, 0.18],    // 墨黑袴
      shoes: [0.72, 0.66, 0.55],     // 草履
      accents: [0.86, 0.78, 0.40],   // 金腰带
    },
  },
};

// ===========================================================================
// 几何原语
// ===========================================================================
// 和 build-character.mjs 是同一套思路，但这里全部按**实数比例**算半径：
// 人的手臂不是圆管而是扁的，躯干是椭圆截面，这些在写实档必须体现。

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smoothstep = (t) => t * t * (3 - 2 * t);
const falloff = (d, r) => (r <= 0 ? 0 : smoothstep(Math.max(0, 1 - d / r)));
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ===========================================================================
// 全局 LOD（低模档用）
// ===========================================================================
// 为什么放在这里而不是每个调用点：全文件有 60 多处 segs/ring 字面量，
// 逐个改既不可能维护，也会让"降面"变成一次性的手工活。
// tube() / ellipsoid() 是**所有几何的唯一入口**，在这里统一乘一次系数就够了。
//
// ⚠️ 为什么是 `let` 而不是 const：buildCharacter 会在每次构建前按 preset.lod 设置它。
//    这是本文件里唯一的模块级可变状态 —— 单线程顺序构建（main 里 for-await），
//    不会互相污染。如果哪天要并行构建，必须先改成参数传递。
//
// ⚠️ 下限取 4：ring=3 的管截面是三角形，锥刺（segs:5, ring:7）降到 4×4 还能认出是刺，
//    再低就直接退化成一根线段，剪影特征会消失。
let LOD = 1;
const qSeg = (n) => (LOD >= 1 ? n : Math.max(4, Math.round(n * LOD)));

/**
 * 头宽。⚠️ 这个必须**三处共用**（buildHead / buildHair / buildExtras）。
 *
 * 踩过的坑：buildHead 为 VTuber 档把头加宽到 0.78 头高，
 * 但 buildHair 和 buildExtras 里各自写死 `headH * 0.72`，
 * 于是发壳（0.545×0.72 = 0.392 头高）比耳朵（0.50×0.78 + 0.022 = 0.412 头高）还窄 ——
 * 耳朵直接从头发里戳出来。inspect-hair 的表现是「侧炸 -0.021H」（负数 = 头发在颅骨里面）。
 * 头一宽，头发、呆毛、耳机全得跟着宽，所以抽成一个函数，谁也不许再写字面量。
 */
const headWidthOf = (preset, headH) => headH * (preset.style === 'vtuber' ? 0.78 : 0.72);

function newAcc() {
  // eye 必须是**数组**（每个顶点一个标记：0=非眼球，1=左眼，2=右眼）。
  // build-character.mjs 里它是标量 0（因为那份代码只用它做整体判断），
  // 这里直接用数组，别忘了 —— 踩过一次 `acc.eye.push is not a function`。
  return { pos: [], uv: [], idx: [], color: [], bone: [], face: [], eye: [], kind: [] };
}

/**
 * 锥形管，截面可被 shape(t, angle) 调成椭圆。
 * 写实档用它做：躯干 / 四肢 / 脖子 / 鼻梁 / 手指。
 */
function tube({ a, b, ra, rb, segs, ring, shape, capA = false, capB = false, twist = 0 }) {
  segs = qSeg(segs); ring = qSeg(ring);      // 低模档统一降面，见上面的 LOD 注释
  const dir = new THREE.Vector3().subVectors(b, a);
  dir.normalize();
  const up = Math.abs(dir.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const fwd = new THREE.Vector3().crossVectors(dir, right).normalize();

  const verts = [], uvs = [], idx = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const center = new THREE.Vector3().lerpVectors(a, b, t);
    const r0 = lerp(ra, rb, t);
    for (let c = 0; c <= ring; c++) {
      const ang = (c / ring) * Math.PI * 2 + twist * t;
      const mod = shape ? shape(t, ang) : [1, 1];
      const rx = r0 * mod[0] * Math.cos(ang);
      const rz = r0 * mod[1] * Math.sin(ang);
      verts.push(
        center.x + right.x * rx + fwd.x * rz,
        center.y + right.y * rx + fwd.y * rz,
        center.z + right.z * rx + fwd.z * rz,
      );
      uvs.push(c / ring, t);
    }
  }
  const stride = ring + 1;
  for (let s = 0; s < segs; s++) {
    for (let c = 0; c < ring; c++) {
      const i0 = s * stride + c, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  for (const [flag, isB] of [[capA, false], [capB, true]]) {
    if (!flag) continue;
    const cv = isB ? b : a;
    const ci = verts.length / 3;
    verts.push(cv.x, cv.y, cv.z);
    uvs.push(0.5, isB ? 1 : 0);
    const base = isB ? segs * stride : 0;
    for (let c = 0; c < ring; c++) idx.push(ci, base + c, base + c + 1);
  }
  return { verts, uvs, idx };
}

/**
 * 椭球。写实档用它做：颅骨 / 眼球 / 肌肉隆起 / 关节 / 手掌。
 *
 * rot: 可选，绕 Z 轴旋转的弧度。用来让「长轴在 X 的椭球」贴合斜向的肢体 ——
 *      手掌在 A-pose 下是斜的，不加这个旋转就会横插在手腕上（看起来像断开）。
 */
function ellipsoid({ c, r, segs = 20, ring = 20, deform = null, rot = 0 }) {
  segs = qSeg(segs); ring = qSeg(ring);      // 低模档统一降面，见上面的 LOD 注释
  const verts = [], uvs = [], idx = [];
  const cs = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i <= segs; i++) {
    const v = i / segs;
    const phi = v * Math.PI;
    for (let j = 0; j <= ring; j++) {
      const u = j / ring;
      const theta = u * Math.PI * 2;
      let x = Math.sin(phi) * Math.cos(theta);
      let y = Math.cos(phi);
      let z = Math.sin(phi) * Math.sin(theta);
      if (deform) [x, y, z] = deform(x, y, z, u, v);
      let px = x * r.x, py = y * r.y, pz = z * r.z;
      if (rot) {
        const rx = px * cs - py * sn;
        const ry = px * sn + py * cs;
        px = rx; py = ry;
      }
      verts.push(c.x + px, c.y + py, c.z + pz);
      uvs.push(u, 1 - v);
    }
  }
  const stride = ring + 1;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < ring; j++) {
      const i0 = i * stride + j, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return { verts, uvs, idx };
}

/** 把一批 part 追加进累加器，并打上 kind / 骨骼归属 */
function appendParts(acc, parts) {
  for (const p of parts) {
    if (!p || !p.verts) continue;
    const base = acc.pos.length / 3;
    for (let i = 0; i < p.verts.length; i += 3) {
      acc.pos.push(p.verts[i], p.verts[i + 1], p.verts[i + 2]);
      acc.color.push(p.color[0], p.color[1], p.color[2]);
      acc.bone.push(p.bone);
      acc.face.push(p.isFace ? 1 : 0);
      acc.eye.push(p.eyeSide || 0);
      acc.kind.push(p.kind || 'body');
    }
    for (let i = 0; i < p.idx.length; i++) acc.idx.push(base + p.idx[i]);
  }
}

// ===========================================================================
// 骨架（Mixamo 兼容，和可爱版同一套命名）
// ===========================================================================
// 写实档的关节位置用**真实人体比例**：
//   肩高 ≈ 0.815H，肘 ≈ 0.63H，腕 ≈ 0.50H（手臂自然下垂时）
//
// ⚠️ 绑定姿势 = **A-pose（自然放松站姿）**，不是 T-pose。
//
//    为什么不用 T-pose：T-pose 是给绑定师调权重用的工作姿势，人一辈子不会
//    那样站着。实测对比（肩胸区 70~85% 身高处的 X 跨度 / 总高）：
//       可爱档 小柔（手臂下垂）   0.71
//       写实档 elena（原 T-pose） 0.90   ← 明显比可爱档"宽"
//       写实档 marcus（原 T-pose）0.95
//    用户看到的直接感受就是"写实档看着像根衣架"。而 rigDriver.js 只叠加
//    相对位移、**不重置绑定姿势**，所以姿势必须烘进几何里。
//
//    A-pose 也是 Mixamo / 3A 角色管线的事实标准绑定姿势，
//    动画库（idle / walk / talk）本来就是按 A-pose 绑的，反而更贴合。
//
//    实现：肩点保持不动，从肩点开始整条手臂**绕肩关节向下旋转**。
//    上臂 52°、前臂再折 12°（总 64°），腕落在髋侧略外 —— 真人放松站姿。

// ⚠️ 这两个角度是"看起来像不像人"的关键，别随手改。
//
//   真人安静站立时，上臂离垂直方向只有约 12~18°（也就是**离水平线 72~78°**），
//   手臂是**贴着躯干**垂下来的，中间只留很窄一道缝。
//   第一版取 52°（离垂直线 38°），截图上看就是"两条胳膊支棱在外面"，
//   和躯干之间空出一大块 —— 那是"举手到一半"的姿势，不是站姿。
//
//   现在取 74°/8°：上臂几乎竖直、肘部再微屈 8°，手自然落在大腿外侧。
const ARM_DROP_UPPER = 74 * Math.PI / 180;   // 上臂相对水平线向下
const ARM_DROP_LOWER = 22 * Math.PI / 180;   // 前臂再往下折（肘部明显弯，真人放松手臂都有 ~20° carry angle，不再是直筒）
const ARM_FWD_UPPER = 0.015;                 // 上臂相对肩点向前（脱离纯侧面平面，手臂有立体感不贴成板）
const ARM_FWD_LOWER = 0.018;                 // 前臂相对肘点再向前（手自然落在大腿前侧，而不是僵在身体两侧）

function buildSkeleton(preset) {
  const H = preset.height;
  const hw = preset.shoulder / 2;
  const hh = preset.hip / 2;
  const headH = H / preset.headsTall;   // 头高

  // ⚠️ Head 关节的位置 = **颅底/下颌铰点**，不是头的中心。
  //    真人颏下点到头顶 ≈ 1 个头高，所以 Head 放在「0.875H」时，
  //    整个头应该**向上**长 headH，头顶落在 0.875H + headH ≈ H。
  //    早期版本把颅骨椭球以 Head 为中心（±0.52·headH），导致头有一半
  //    埋在肩膀里 —— 表现是总高只有 1.62m（应为 1.70m）、实测头身比
  //    6.3（应为 7.5）。头部构件一律用 headBase 作为基准点。
  const headBase = 0.875 * H;

  // ---- A-pose 手臂展开：从肩点出发，逐段向下旋转 ----
  // 骨长取真人比例（上臂 ≈ 0.186H、前臂 ≈ 0.146H、手 ≈ 0.108H）
  const UPPER_LEN = 0.186 * H;
  const FORE_LEN  = 0.146 * H;
  const HAND_LEN  = 0.108 * H;

  // ⚠️ 肩关节要往**内侧**收一点（0.86×半肩宽）。
  //    半肩宽 hw 量的是三角肌的**外缘**，而肩关节（盂肱关节）在它内侧约 1.5cm。
  //    顶着外缘放关节，手臂一转下来，上臂就会贴着躯干外侧擦出去，
  //    中段出现一条明显的缝（截图上的"手臂悬空"）。
  // ⚠️ 肩点高度 = **78.5%H**，不是 80.5H。
  //    真人肩峰（acromion）在 81~82%H，而盂肱关节（真正的手臂转轴）比它再低 2~3cm，
  //    折算下来 ≈ 78~79%H。原来放 80.5%H 时，三角肌球顶会顶到 84%H，
  //    把下颌（87.5%H）以下的空间吃掉一大半 —— 表现是"没有脖子、头陷在肩膀里"，
  //    实测可见脖子只剩 6.2cm（真人 8~10cm）。降下来之后脖子露出约 9cm。
  const ARM_ROOT = 0.86;

  const shoulderY = 0.785 * H;
  const armAt = (s) => {
    const shoulder = V(s * hw * ARM_ROOT, shoulderY, 0);
    const a1 = ARM_DROP_UPPER;
    const elbow = shoulder.clone().add(V(s * UPPER_LEN * Math.cos(a1), -UPPER_LEN * Math.sin(a1), ARM_FWD_UPPER * H));
    const a2 = ARM_DROP_UPPER + ARM_DROP_LOWER;
    const wrist = elbow.clone().add(V(s * FORE_LEN * Math.cos(a2), -FORE_LEN * Math.sin(a2), ARM_FWD_LOWER * H));
    const handTip = wrist.clone().add(V(s * HAND_LEN * Math.cos(a2), -HAND_LEN * Math.sin(a2), ARM_FWD_LOWER * H));
    return { shoulder, elbow, wrist, handTip };
  };

  const L = armAt(1);
  const R = armAt(-1);

  const j = {
    Hips:        V(0, 0.53 * H, 0),
    Spine:       V(0, 0.60 * H, 0),
    Spine1:      V(0, 0.68 * H, 0),
    Spine2:      V(0, 0.76 * H, 0),
    Neck:        V(0, 0.845 * H, 0),
    Head:        V(0, headBase, 0),
    HeadTop_End: V(0, headBase + headH, 0),

    LeftShoulder:  V(hw * 0.34, 0.795 * H, 0),
    LeftArm:       L.shoulder.clone(),
    LeftForeArm:   L.elbow.clone(),
    LeftHand:      L.wrist.clone(),

    RightShoulder: V(-hw * 0.34, 0.795 * H, 0),
    RightArm:      R.shoulder.clone(),
    RightForeArm:  R.elbow.clone(),
    RightHand:     R.wrist.clone(),

    LeftUpLeg:   V(hh * 0.52, 0.50 * H, 0),
    LeftLeg:     V(hh * 0.52, 0.28 * H, 0.004 * H),
    LeftFoot:    V(hh * 0.52, 0.045 * H, 0),
    LeftToeBase: V(hh * 0.52, 0.012 * H, 0.055 * H),

    RightUpLeg:   V(-hh * 0.52, 0.50 * H, 0),
    RightLeg:     V(-hh * 0.52, 0.28 * H, 0.004 * H),
    RightFoot:    V(-hh * 0.52, 0.045 * H, 0),
    RightToeBase: V(-hh * 0.52, 0.012 * H, 0.055 * H),
  };

  const parent = {
    Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
    Neck: 'Spine2', Head: 'Neck', HeadTop_End: 'Head',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
  };

  const order = Object.keys(parent);
  const seg = {};
  for (const name of order) {
    const child = order.find((k) => parent[k] === name);
    seg[name] = [name, child || name];
  }

  // 写实档多出几根「表情辅助骨」：咀嚼/眉/唇。ARKit 那套 blendshape 靠变形笼驱动，
  // 但下颌骨必须真的存在，否则张嘴时下巴不会跟着动。
  //
  // arm: A-pose 的单位方向向量，供 buildBody 沿线摆手臂构件
  //      （手掌 / 三角肌球都要沿这条斜线走，不能再用 ±X）。
  const armDir = (s) => {
    const a2 = ARM_DROP_UPPER + ARM_DROP_LOWER;
    return { upper: V(s * Math.cos(ARM_DROP_UPPER), -Math.sin(ARM_DROP_UPPER), 0),
             lower: V(s * Math.cos(a2), -Math.sin(a2), 0) };
  };
  const arm = { 'Left': armDir(1), 'Right': armDir(-1) };

  return { j, parent, order, seg, headH, headBase, arm,
           lens: { upper: UPPER_LEN, fore: FORE_LEN, hand: HAND_LEN } };
}

// ===========================================================================
// 身体
// ===========================================================================

function buildBody(preset, skel) {
  const H = preset.height;
  const parts = [];
  const skin = preset.skin;
  const shade = preset.skinShade;
  const o = preset.outfit;
  const built = preset.build;

  // 体型系数：slim 更窄、athletic 更宽
  // ⚠️ heavy 是 FF 风格「重装佣兵」加的档：比 athletic 再宽一圈，
  //    但只到 1.08 —— 再宽肩胸区跨度会顶到 inspect-character 的
  //    poseRatio < 0.80 红线（盔甲本来就比真人宽，这点余量必须留）。
  const k = built === 'heavy' ? 1.08 : built === 'athletic' ? 1.0 : built === 'soft' ? 0.94 : 0.88;

  // ---- 骨盆 / 胯 ----
  parts.push({
    ...ellipsoid({
      c: skel.j.Hips.clone().add(V(0, -0.015 * H, 0)),
      r: V(preset.hip * 0.52, 0.085 * H, 0.072 * H),
      segs: 14, ring: 20,
    }),
    color: o.bottom,
    bone: 'Hips',
    kind: 'clothes',
  });

  // ---- 躯干：写实档要做「胸廓 + 收腰」两段，不是一根直筒 ----
  // 上段：腰 -> 胸廓（截面明显是扁椭圆，前后薄、左右宽）
  parts.push({
    ...tube({
      a: skel.j.Spine, b: skel.j.Spine2,
      ra: preset.hip * 0.40 * k, rb: preset.shoulder * 0.36 * k,
      segs: 16, ring: 22,
      shape: (t, ang) => {
        // 胸：前半（sin>0 那侧）往前推，做出胸廓起伏
        const front = Math.max(0, Math.sin(ang));
        const chest = preset.gender === 'female' ? 1.0 + 0.42 * front * smoothstep(t) : 1.0 + 0.18 * front * smoothstep(t);
        return [1.0 * (0.94 + 0.06 * t), (0.62 + 0.10 * t) * chest];
      },
    }),
    color: mix3(o.inner, o.outer, 0.55),
    bone: 'Spine',
    kind: 'clothes',
  });

  // 下段：胯 -> 腰（收腰）
  parts.push({
    ...tube({
      a: skel.j.Hips, b: skel.j.Spine,
      ra: preset.hip * 0.46 * k, rb: preset.hip * 0.38 * k,
      segs: 8, ring: 22,
      shape: (t) => [1.0, 0.70 + 0.06 * (1 - t)],
    }),
    color: o.bottom,
    bone: 'Hips',
    kind: 'clothes',
  });

  // 外套 / 上装外层（比躯干略大一圈，做出衣服厚度）
  parts.push({
    ...tube({
      a: skel.j.Spine.clone().add(V(0, -0.01 * H, -0.004 * H)),
      b: skel.j.Spine2.clone().add(V(0, 0.012 * H, -0.006 * H)),
      ra: preset.hip * 0.43 * k, rb: preset.shoulder * 0.345 * k,
      segs: 12, ring: 22,
      shape: (t) => [1.0, 0.60 + 0.16 * t],
    }),
    color: o.outer,
    bone: 'Spine',
    kind: 'clothes',
  });

  // ---- 脖子（写实档做圆柱 + 一点前倾）----
  // ⚠️ 半径别用 0.040H：1.84m 的人算出来 7.4cm 半径（直径 14.7cm），
  //    比真人（颈围约 37cm → 半径 5.9cm）粗一大圈，看起来像"头直接长在肩膀上"。
  //    改成绝对值（1.75m 基准折算），壮实的人略粗。
  parts.push({
    ...tube({
      a: skel.j.Neck.clone().add(V(0, -0.012 * H, -0.004 * H)),
      b: skel.j.Head.clone().add(V(0, 0.010 * H, 0.002 * H)),
      ra: 0.032 * H / 1.75 * (built === 'heavy' ? 1.18 : built === 'athletic' ? 1.10 : 1.0),
      rb: 0.034 * H / 1.75 * (built === 'heavy' ? 1.18 : built === 'athletic' ? 1.10 : 1.0),
      segs: 6, ring: 14,
      shape: () => [1.0, 0.90],
    }),
    color: mix3(skin, shade, 0.45),
    bone: 'Neck',
    kind: 'skin',
  });

  // ---- 四肢 ----
  const limb = (prox, dist, r1, r2, col, boneName, flat = 0.88) => ({
    ...tube({
      a: prox, b: dist, ra: r1, rb: r2, segs: 12, ring: 14, capB: true,
      shape: () => [1.0, flat],   // 四肢截面是椭的，不是正圆
    }),
    color: col,
    bone: boneName,
    kind: 'skin',
  });

  for (const s of [1, -1]) {
    const S = s > 0 ? 'Left' : 'Right';
    // A-pose 的两段单位方向（上臂 / 前臂+手共用同一段方向）
    const dUpper = skel.arm[S].upper;
    const dLower = skel.arm[S].lower;

    // 上臂 / 前臂：写实档要有肌肉隆起（三角肌 → 肱二头 → 肘窝 → 前臂鼓）
    //
    // ⚠️ 接缝的坑：tube 的 shape() 是**截面缩放系数**，不是绝对半径。
    //    所以「上臂末端真实半径」= rb * shape(1)[0]，必须和「前臂起始真实半径」
    //    = ra * shape(0)[0] 对齐，否则肘部会出现一圈台阶（看起来像断了一截）。
    //    这里显式算出两端的收缩量再互相咬合。
    const ARM_SHAPE_END = 0.86;   // 上臂 shape 在 t=1 处的截面系数
    const FA_SHAPE_END = 0.82;    // 前臂 shape 在 t=1 处的截面系数

    // ⚠️ 手臂粗细**不能按身高线性放大**。
    //    原来写的是 0.052*H，marcus（1.84m）算出来半径 9.6cm —— 上臂直径 19cm，
    //    比真人（约 10~12cm）粗一倍。后果是肩膀那一片被撑成两个大球，
    //    视觉上头被"埋"进肩膀里，看起来头特别小（实测肩宽占到身高的 34%，
    //    真人只有 25% 左右）。
    //    正确做法：用**成年人体的绝对半径**，再按 build 微调。
    //    真人参考值（半径）：上臂近肩 4.2~5.6cm、肘 3.4~3.8、腕 2.5~2.8。
    const girth = built === 'heavy' ? 1.14 : built === 'athletic' ? 1.06 : built === 'soft' ? 1.04 : 0.95;

    const upperR = 0.043 * H / 1.75 * girth;    // 肩端（以 1.75m 为基准折算）
    const elbowR = 0.034 * H / 1.75 * girth;    // 肘部（上下臂共用半径）
    const wristR = 0.025 * H / 1.75 * girth;    // 腕部

    // 三角肌球：把「躯干侧壁 → 上臂」的接缝盖住。
    // ⚠️ 必须落在**肩关节**上。A-pose 之后肩点没动，但手臂已经斜向下，
    //    所以球心要沿上臂方向往里收一点才对得上。
    // ⚠️ 半径别放大：三角肌只是"肩头的那一点隆起"，
    //    之前写成 upperR*1.15（且 upperR 本身偏大）时，肩膀会鼓成两个球。
    //    现在取 upperR*1.04，只比上臂略粗一点点。
    parts.push({
      ...ellipsoid({
        c: skel.j[`${S}Arm`].clone()
          .add(dUpper.clone().multiplyScalar(0.016 * H))
          .add(V(0, 0.010 * H, 0)),
        r: V(upperR * 1.06, upperR * 1.00, upperR * 0.96),
        segs: 12, ring: 14,
      }),
      color: skin, bone: `${S}Arm`, kind: 'skin',
    });

    parts.push({
      ...tube({
        a: skel.j[`${S}Arm`], b: skel.j[`${S}ForeArm`],
        ra: upperR, rb: elbowR / ARM_SHAPE_END, segs: 14, ring: 14, capB: true,
        shape: (t) => {
          const bulge = 1 + 0.14 * Math.sin(Math.PI * Math.min(1, t * 1.4));  // 上臂中段鼓起
          // 两端收一点，避免和肩球/前臂打架；中间保持隆起
          const taper = 1 - 0.14 * Math.pow(t, 3);
          return [bulge * taper, 0.86 * bulge * taper];
        },
      }),
      color: skin, bone: `${S}Arm`, kind: 'skin',
    });
    parts.push({
      ...tube({
        a: skel.j[`${S}ForeArm`], b: skel.j[`${S}Hand`],
        ra: elbowR, rb: wristR / FA_SHAPE_END, segs: 12, ring: 14, capB: true,
        shape: (t) => {
          const bulge = 1 + 0.10 * Math.sin(Math.PI * Math.min(1, t * 2.0));  // 前臂鼓
          // t=0 必须正好是 1.0，才能和上臂末端半径严丝合缝
          const taper = 1 - 0.18 * Math.pow(t, 2.5);
          return [bulge * taper, 0.82 * bulge * taper];
        },
      }),
      color: skin, bone: `${S}ForeArm`, kind: 'skin',
    });

    // 手：掌心 + 四指（自然微曲）+ 拇指
    // 旧版只有两块椭球，看上去像一块平板 / 连指团块。现在按「放松手」造出分开的手指：
    // 每根指两节、指尖向内微曲（学 VRChat / VRM 的 relaxed 手，而不是僵直木板）。
    const a2 = ARM_DROP_UPPER + ARM_DROP_LOWER;
    const handRot = -s * a2;
    const handC = skel.j[`${S}Hand`];
    // ⚠️ 手指方向必须跟**真实的肘→腕 3D 向量**走。
    //    上一步把前臂加了一点向前(z)的偏移，所以这里不能再用 dLower（只有 xy 平面），
    //    否则手指会停在侧面、和手臂脱节。
    const handDir = skel.j[`${S}Hand`].clone().sub(skel.j[`${S}ForeArm`]);
    // 局部手坐标系：ex=指尖方向（沿前臂），ey=手掌可见面内的宽度方向（手指左右展开轴），
    // ez=掌心法向（也是手指弯曲轴）。手指尖沿着 ex 长出去、沿 ey 排开、绕 ey 微曲。
    const ex = handDir.clone().normalize();
    const ey = new THREE.Vector3(ex.y, -ex.x, 0).normalize();
    const ez = new THREE.Vector3().crossVectors(ex, ey).normalize();
    const fin = H / 1.75;

    // 掌心（长轴沿 ex，薄沿 ez）；尺寸按绝对人体值折算（长 ~7cm、宽 ~5cm、厚 ~3cm）
    parts.push({
      ...ellipsoid({
        c: handC.clone().add(ex.clone().multiplyScalar(0.030 * fin)),
        r: V(0.034 * fin, 0.028 * fin, 0.017 * fin), segs: 12, ring: 14,
        rot: handRot,
      }),
      color: skin, bone: `${S}Hand`, kind: 'skin',
    });

    // 造一根手指：两节（近节/远节），远节相对近节绕 ey 向内微曲。
    const makeDigit = ({ y, x0, len, curl, r0, r1, r2 }) => {
      const Lp = len * 0.58, Ld = len * 0.42;
      const base = handC.clone().add(ex.clone().multiplyScalar(x0)).add(ey.clone().multiplyScalar(y));
      const joint = base.clone().add(ex.clone().multiplyScalar(Lp));
      const q = new THREE.Quaternion().setFromAxisAngle(ey, curl);
      const ddir = ex.clone().applyQuaternion(q);
      const tip = joint.clone().add(ddir.clone().multiplyScalar(Ld));
      return [
        { ...tube({ a: base, b: joint, ra: r0, rb: r1, segs: 6, ring: 8, capA: true }), color: skin, bone: `${S}Hand`, kind: 'skin' },
        { ...tube({ a: joint, b: tip, ra: r1, rb: r2, segs: 6, ring: 8, capB: true }), color: skin, bone: `${S}Hand`, kind: 'skin' },
      ];
    };
    // 四指从掌心前缘（x0）沿 ey 均匀展开；中指最长、小指最短（人体真实比例）
    const xs = 0.034 * fin;
    parts.push(...makeDigit({ y: -0.026 * fin, x0: xs, len: 0.070 * fin, curl: 0.42, r0: 0.011 * fin, r1: 0.0085 * fin, r2: 0.0050 * fin })); // 食指
    parts.push(...makeDigit({ y: -0.009 * fin, x0: xs, len: 0.082 * fin, curl: 0.38, r0: 0.012 * fin, r1: 0.0090 * fin, r2: 0.0055 * fin })); // 中指
    parts.push(...makeDigit({ y: 0.009 * fin, x0: xs, len: 0.076 * fin, curl: 0.40, r0: 0.0115 * fin, r1: 0.0085 * fin, r2: 0.0050 * fin })); // 无名指
    parts.push(...makeDigit({ y: 0.026 * fin, x0: xs, len: 0.058 * fin, curl: 0.46, r0: 0.0095 * fin, r1: 0.0070 * fin, r2: 0.0040 * fin })); // 小指

    // 拇指：从掌侧外缘（-ey 边）伸出，朝外偏并略向掌心收
    const tdir = new THREE.Vector3()
      .add(ex.clone().multiplyScalar(0.45))
      .add(ey.clone().multiplyScalar(-0.85))
      .add(ez.clone().multiplyScalar(0.25))
      .normalize();
    const tBase = handC.clone().add(ex.clone().multiplyScalar(0.018 * fin)).add(ey.clone().multiplyScalar(-0.030 * fin));
    const tJoint = tBase.clone().add(tdir.clone().multiplyScalar(0.030 * fin));
    const qT = new THREE.Quaternion().setFromAxisAngle(ez, 0.6 * s);
    const tdir2 = tdir.clone().applyQuaternion(qT);
    const tTip = tJoint.clone().add(tdir2.clone().multiplyScalar(0.022 * fin));
    parts.push({ ...tube({ a: tBase, b: tJoint, ra: 0.013 * fin, rb: 0.010 * fin, segs: 5, ring: 8, capA: true }), color: skin, bone: `${S}Hand`, kind: 'skin' });
    parts.push({ ...tube({ a: tJoint, b: tTip, ra: 0.010 * fin, rb: 0.006 * fin, segs: 5, ring: 8, capB: true }), color: skin, bone: `${S}Hand`, kind: 'skin' });

    // 大腿 / 小腿（小腿肚是写实的关键起伏）
    // ⚠️ 和手臂同一个坑：粗细按身高线性放大会粗一倍。
    //    真人（1.75m）半径参考：大腿近髋 8.5cm、膝 5.5、小腿肚 5.0、踝 3.4。
    const legR = H / 1.75;
    parts.push({
      ...tube({
        a: skel.j[`${S}UpLeg`], b: skel.j[`${S}Leg`],
        ra: 0.086 * legR * (built === 'heavy' ? 1.12 : built === 'athletic' ? 1.06 : built === 'soft' ? 1.05 : 0.96),
        rb: 0.056 * legR,
        segs: 14, ring: 16, capB: true,
        shape: (t) => [1.0 + 0.05 * Math.sin(Math.PI * t), 0.90],
      }),
      color: mix3(o.bottom, [0, 0, 0], 0.12),
      bone: `${S}UpLeg`, kind: 'clothes',
    });
    parts.push({
      ...tube({
        a: skel.j[`${S}Leg`], b: skel.j[`${S}Foot`],
        ra: 0.056 * legR, rb: 0.034 * legR, segs: 12, ring: 16, capB: true,
        shape: (t) => {
          const calf = 1 + 0.18 * Math.sin(Math.PI * Math.min(1, t * 1.5));  // 小腿肚
          return [calf, 0.88 * calf];
        },
      }),
      color: mix3(o.bottom, [0, 0, 0], 0.12),
      bone: `${S}Leg`, kind: 'clothes',
    });

    // 脚：脚背 + 后跟，前掌略宽（真人脚长约 25cm、宽 9cm、鞋底到脚背约 8cm）
    //
    // ⚠️ Y 半径别用 0.023*legR（只有 2.4cm），那会让脚底悬空 3.6cm。
    //    鞋的竖直半高要 ≈ 0.022H（4cm），并且中心要压到「骨位 - 半高」，
    //    这样椭球底正好落在 y=0。
    // ⚠️ 鞋底必须压到 y=0。
    //    Foot 骨在 0.045H（1.84m 的人 = 8.3cm），鞋要是以骨为中心放，
    //    底就停在 3cm 高的地方 —— 模型会**悬空**（体检里的「贴地」项会报警）。
    //    所以鞋心要按「骨位 - 半高 - 一点余量」来放，让椭球底 ≈ 0。
    const shoeHalf = 0.024 * legR;
    const shoeCenterY = Math.max(shoeHalf * 0.92, skel.j[`${S}Foot`].y - 0.040 * legR);
    parts.push({
      ...ellipsoid({
        c: V(skel.j[`${S}Foot`].x, shoeCenterY, skel.j[`${S}Foot`].z + 0.028 * legR),
        r: V(0.036 * legR, shoeHalf, 0.072 * legR), segs: 10, ring: 14,
      }),
      color: o.shoes, bone: `${S}Foot`, kind: 'shoes',
    });
    // 脚踝
    parts.push({
      ...ellipsoid({
        c: skel.j[`${S}Foot`].clone().add(V(0, 0.010 * H, 0)),
        r: V(0.030 * legR, 0.026 * legR, 0.030 * legR), segs: 8, ring: 12,
      }),
      color: skin, bone: `${S}Foot`, kind: 'skin',
    });
  }

  // ---- 腰带 / 腰线分隔（写实的衣服会有层次，不是一整块）----
  parts.push({
    ...tube({
      a: skel.j.Spine.clone().add(V(0, -0.012 * H, 0)),
      b: skel.j.Spine.clone().add(V(0, 0.010 * H, 0)),
      ra: preset.hip * 0.425 * k, rb: preset.hip * 0.425 * k,
      segs: 3, ring: 22,
      shape: () => [1.0, 0.68],
    }),
    color: o.accents, bone: 'Spine', kind: 'clothes',
  });

  return parts;
}

// ===========================================================================
// 头部 + 立体五官
// ===========================================================================
// 这是写实档最花功夫的地方。Q 版是一颗扁球 + 两个眼球贴片；
// 写实档要做出：颅骨、额头、眉骨、眼窝、鼻梁、鼻头、鼻翼、人中、上下唇、
// 颧骨、下颌角、下巴、耳朵。全部靠椭球的 deform 回调雕出来。

function buildHead(preset, skel) {
  const H = preset.height;
  // ⚠️ 头部中心不是 Head 关节，而是 Head 关节往上抬「将近半个头高」的位置。
  //    Head 关节在颅底（下颌铰点），颅骨椭球半高 = headH*0.52，
  //    所以中心 ≈ headBase + headH*0.52 时，颅骨底 ≈ 颅底、顶 ≈ 头顶。
  const headH = skel.headH;
  const c = V(0, skel.headBase + headH * 0.52, 0);
  const parts = [];
  const skin = preset.skin;
  const shade = preset.skinShade;
  // VTuber / 动漫档的头更**宽更圆**（真人 0.72，动漫 0.78）：
  // 二次元的颅骨侧面更饱满、正面更宽，配上大眼才有那种"娃娃脸"的底子。
  const VT = preset.style === 'vtuber';
  const headW = headWidthOf(preset, headH);   // 真人头宽约等于头高的 0.7

  const parts_ = {};

  // ---- 颅骨：底部收窄成下颌，前面推出额头与眉骨 ----
  const skullR = V(headW * 0.5, headH * 0.52, headH * 0.56);
  parts.push({
    ...ellipsoid({
      c,
      r: skullR,
      segs: 36, ring: 36,
      deform: (x, y, z) => {
        // y: -1(底) .. +1(顶)
        let nx = x, ny = y, nz = z;

        // 下颌收窄：越低越窄，做出 V 形下巴
        //
        // ⚠️ FF7R 标准：下颌收得更狠（0.46→0.58）、下巴尖更突出（0.12→0.17）。
        //    Square Enix 的面部骨架是"窄 V 脸 + 明确的下颌线"，
        //    这是日式角色区别于欧美写实的骨相特征之一。
        if (y < 0.05) {
          const t = Math.min(1, (0.05 - y) / 1.0);
          const k = Math.pow(t, 0.8);
          // VTuber 档下颌收得**更柔和**（0.58→0.46），但下巴尖保留（0.15）：
          // 动漫脸是"圆脸收成一个小尖"，不是写实那种明显棱角的下颌线。
          // 收太狠会变成 FF 档的窄 V 脸，就失去二次元味道了。
          nx *= 1 - (VT ? 0.46 : 0.58) * k;
          nz *= 1 - 0.34 * k;
          // 下巴尖：下端中点往前顶一点
          if (z > 0.3 && y < -0.35) nz *= 1 + (VT ? 0.15 : 0.17) * k;
        }

        // 额头：上 1/3 略后倾（真人额头不是球）
        if (y > 0.35 && z > 0) {
          const t = (y - 0.35) / 0.65;
          nz *= 1 - 0.16 * t;
        }

        // 眉骨：眼睛上方往前推
        // ⚠️ VTuber 档几乎取消眉骨（0.10→0.04）。动漫脸的额头到眼睛是**平的**，
        //    有眉骨立刻就往写实方向跑。
        if (z > 0.25 && y > -0.10 && y < 0.28) {
          const band = 1 - Math.abs((y - 0.09) / 0.19);
          if (band > 0) nz *= 1 + (VT ? 0.04 : 0.10) * band;
        }

        // 眼窝：眼球那一带往里凹
        // ⚠️ VTuber 档凹得浅（0.12→0.09）：眼窝太深会让放大的眼睛陷进去，
        //    只剩一条缝 —— 那正是"写实眼小"的观感，和动漫相反。
        if (z > 0.3 && y > -0.22 && y < 0.02) {
          const band = 1 - Math.abs((y + 0.10) / 0.12);
          if (band > 0) nz *= 1 - (VT ? 0.09 : 0.12) * band;
        }

        // 后脑：略微往后拉，让侧面轮廓更像人
        if (z < -0.3 && y < 0.4) nz *= 1.06;

        return [nx, ny, nz];
      },
    }),
    color: skin,
    bone: 'Head',
    isFace: true,
    kind: 'skin',
  });

  // ---- 鼻：鼻梁 + 鼻头 + 两侧鼻翼 ----
  const noseY = c.y + 0.005 * headH;
  const noseZ = c.z + skullR.z * 0.94;
  parts.push({
    ...tube({
      // VTuber 档鼻梁更短更细：动漫脸的鼻子常常只是一个小点 + 一点点鼻梁影子
      a: V(c.x, c.y + (VT ? 0.10 : 0.16) * headH, noseZ - skullR.z * 0.06),
      b: V(c.x, noseY - (VT ? 0.040 : 0.055) * headH, noseZ + 0.012 * headH),
      ra: headW * (VT ? 0.038 : 0.055), rb: headW * (VT ? 0.055 : 0.085),
      segs: 8, ring: 10, capB: true,
      shape: () => [1.0, 1.25],
    }),
    color: skin, bone: 'Head', isFace: true, kind: 'skin',
  });
  // 鼻头 + 鼻翼：⚠️ FF7R 标准 —— 鼻子整体收小（宽 0.085→0.062，高 0.045→0.034）。
  //   日式 idealize 的脸鼻子显著小于真人比例，把视觉重心让给眼睛。
  // ⚠️ VTuber 档比 FF 档还要再小一档（0.062→0.040 / 0.034→0.020）：
  //    动漫脸的鼻子在正面几乎只有一个小高光点，做大了立刻"出戏"。
  parts.push({
    ...ellipsoid({
      c: V(c.x, noseY - 0.050 * headH, noseZ + 0.016 * headH),
      r: V(headW * (VT ? 0.040 : 0.062), headH * (VT ? 0.020 : 0.034), headH * (VT ? 0.026 : 0.040)),
      segs: 10, ring: 12,
    }),
    color: skin, bone: 'Head', isFace: true, kind: 'skin',
  });
  for (const s of [1, -1]) {
    parts.push({
      ...ellipsoid({
        c: V(c.x + s * headW * (VT ? 0.040 : 0.058), noseY - 0.055 * headH, noseZ + 0.006 * headH),
        r: V(headW * (VT ? 0.022 : 0.032), headH * (VT ? 0.017 : 0.026), headH * (VT ? 0.020 : 0.030)), segs: 8, ring: 10,
      }),
      color: mix3(skin, shade, 0.35), bone: 'Head', isFace: true, kind: 'skin',
    });
  }

  // ---- 唇：上唇两瓣 + 下唇一瓣，中间是唇缝 ----
  const mouthY = c.y - 0.235 * headH;
  const mouthZ = c.z + skullR.z * (1 - 0.46 * Math.pow(0.235, 2) / 0.30);
  const lipR = [0.82, 0.45, 0.46];
  // VTuber 档嘴也收小：动漫嘴在正面通常只占脸宽的 1/6 左右，做宽了就"成人化"
  for (const s of [1, -1]) {
    parts.push({
      ...ellipsoid({
        c: V(c.x + s * headW * (VT ? 0.066 : 0.085), mouthY + 0.012 * headH, mouthZ + 0.008 * headH),
        r: V(headW * (VT ? 0.058 : 0.075), headH * (VT ? 0.024 : 0.030), headH * (VT ? 0.024 : 0.030)), segs: 10, ring: 12,
      }),
      color: mix3(skin, lipR, 0.55), bone: 'Head', isFace: true, kind: 'skin',
    });
  }
  parts.push({
    ...ellipsoid({
      c: V(c.x, mouthY - 0.022 * headH, mouthZ + 0.006 * headH),
      r: V(headW * (VT ? 0.078 : 0.105), headH * (VT ? 0.026 : 0.034), headH * (VT ? 0.026 : 0.032)), segs: 12, ring: 14,
    }),
    color: mix3(skin, lipR, 0.62), bone: 'Head', isFace: true, kind: 'skin',
  });

  // ---- 耳 ----
  for (const s of [1, -1]) {
    parts.push({
      ...ellipsoid({
        c: V(c.x + s * headW * 0.50, c.y - 0.02 * headH, c.z - headH * 0.03),
        r: V(headH * 0.022, headH * 0.085, headH * 0.055), segs: 10, ring: 12,
      }),
      color: mix3(skin, shade, 0.25), bone: 'Head', isFace: false, kind: 'skin',
    });
  }

  // ---- 眼球：独立球体 + 虹膜 + 瞳孔 + 高光 ----
  // 位置由颅骨几何算出来，保证"眼球正好落在眼窝里"
  const L = {
    center: c,
    headH, headW, skullR,
    eyeY: c.y + 0.015 * headH,
    eyeX: headW * (VT ? 0.255 : 0.245),
    // ⚠️ FF7R 标准：眼睛明显放大（0.082 → 0.105 头高，约 +28%）。
    //   大眼 + 小鼻 + 尖下巴是日式"写实但理想化"的三件套，
    //   比纯写实更接近玩家对 AAA 日式角色的期待。
    //
    // ⚠️ VTuber 档再放大一档（0.105 → 0.138 头高，再 +31%），并且拉成**横向椭圆**
    //   （宽高比 1.26 : 1.10）：动漫眼的关键不是"圆大"，是"横向的杏仁形"。
    //   纯等比放大会变成"瞪眼的写实人"，必须同时压扁高度。
    eyeR: headH * (VT ? 0.138 : 0.105),
    browY: c.y + 0.105 * headH,
    mouthY,
    mouthW: headW * 0.20,
    mouthR: headH * 0.10,
    noseY,
    H,
  };
  L.eyeZ = c.z + skullR.z * 0.74;

  // 动漫眼的横向拉伸系数（只对 X / Y 生效，Z 是厚度不能动）
  const EWX = VT ? 1.26 : 1.0;
  const EWY = VT ? 1.10 : 1.0;

  for (const [sideTag, s] of [[1, 1], [2, -1]]) {
    const ec = V(c.x + s * L.eyeX, L.eyeY, L.eyeZ);

    // 眼白
    parts.push({
      ...ellipsoid({ c: ec, r: V(L.eyeR * EWX, L.eyeR * EWY, L.eyeR * 0.92), segs: 16, ring: 18 }),
      color: [0.97, 0.96, 0.95],
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'eye',
    });
    // 虹膜：⚠️ VTuber 档占眼白的比例更大（0.52→0.60）。
    //   动漫眼的特征就是虹膜几乎撑满眼白，只在上下留一条细边。
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(0, 0, L.eyeR * 0.72)),
        r: V(L.eyeR * (VT ? 0.60 : 0.52) * EWX, L.eyeR * (VT ? 0.60 : 0.52) * EWY, L.eyeR * 0.34), segs: 12, ring: 14,
      }),
      color: preset.eye,
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'eye',
    });
    // 瞳孔
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(0, 0, L.eyeR * 0.90)),
        r: V(L.eyeR * (VT ? 0.26 : 0.22) * EWX, L.eyeR * (VT ? 0.26 : 0.22) * EWY, L.eyeR * 0.16), segs: 10, ring: 12,
      }),
      color: [0.04, 0.03, 0.03],
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'eye',
    });
    // 高光点：小且偏上外侧，写实眼睛的"活"全靠它
    //
    // ⚠️ VTuber 档高光更大（0.13→0.17）且**再补一个下方小高光**：
    //   动漫眼几乎都画"上大光点 + 下小反光"两处，只有一个会显得呆。
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(s * L.eyeR * 0.22, L.eyeR * 0.30, L.eyeR * 0.82)),
        r: V(L.eyeR * (VT ? 0.17 : 0.13), L.eyeR * (VT ? 0.17 : 0.13), L.eyeR * 0.09), segs: 8, ring: 10,
      }),
      color: [1, 1, 1],
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'eye',
    });
    if (VT) {
      parts.push({
        ...ellipsoid({
          c: ec.clone().add(V(-s * L.eyeR * 0.24, -L.eyeR * 0.34, L.eyeR * 0.80)),
          r: V(L.eyeR * 0.085, L.eyeR * 0.085, L.eyeR * 0.07), segs: 6, ring: 8,
        }),
        color: [1, 1, 1],
        bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'eye',
      });
    }
    // 上下眼睑：让眼睛"镶"在眼眶里，而不是两个球浮在脸上
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(0, L.eyeR * 0.86, -L.eyeR * 0.10)),
        r: V(L.eyeR * 1.22 * EWX, L.eyeR * 0.44 * EWY, L.eyeR * 0.62), segs: 10, ring: 14,
      }),
      color: skin,
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'skin',
    });
    parts.push({
      ...ellipsoid({
        c: ec.clone().add(V(0, -L.eyeR * 0.92, -L.eyeR * 0.08)),
        r: V(L.eyeR * 1.14 * EWX, L.eyeR * 0.34 * EWY, L.eyeR * 0.56), segs: 10, ring: 14,
      }),
      color: mix3(skin, shade, 0.18),
      bone: 'Head', isFace: true, eyeSide: sideTag, kind: 'skin',
    });
  }

  // ---- 眉：细长椭球 + 中间拱起 ----
  //
  // ⚠️ 旧版本的三个问题（在头部特写截图里表现为"额前两条细刺/触须"）：
  //    ① 厚度太薄：r.y = headH*0.016 + arch*headH*0.2，arched 也只有 headH*0.022 ≈ 5mm。
  //       渲染出来是一条**几乎零厚度的薄片**，在低分辨率下只留一条暗边 —— 看成刺。
  //    ② 拱起量用错量纲：deform 里的 y 是**归一化椭球坐标**（-1..1），
  //       而 `arch` 是米（0.030）。`y += arch*6` 再乘 r.y（0.005m）实际只动 0.9mm，
  //       等于什么都没做，眉形完全平直。
  //    ③ 结果：一条 5mm×38mm 的平薄片贴在眉弓上，既不"眉"也不好看。
  //
  //    现在：厚度按真人眉毛取 8~9mm（headH*0.038，随 headH 走），
  //    拱起量换算成归一化坐标（arch / r.y），并根据 browStyle 给出内外端的粗细差，
  //    让眉尾自然变细 —— 这才是"眉"而不是"条"。
  for (const s of [1, -1]) {
    const arch = preset.browStyle === 'arched' ? 0.30 : preset.browStyle === 'soft' ? 0.18 : 0.08;
    const browRy = headH * 0.038;                     // 眉毛厚度（真人约 8~9mm）
    const browCenter = V(
      c.x + s * L.eyeX * 0.96,
      L.browY,
      L.eyeZ + L.eyeR * 0.42,
    );
    parts.push({
      ...ellipsoid({
        c: browCenter,
        r: V(headW * 0.115, browRy, headH * 0.026),
        segs: 10, ring: 14,
        deform: (x, y, z, u) => {
          // u: 0..1 沿椭球赤道一圈。0/1 = 眉尾，0.5 = 眉心侧。
          // 中间拱起（归一化量：arch 已是无量纲比例），两端下沉
          const a = (u - 0.5) * 2;                      // -1..1
          const archN = arch;                           // 直接就是归一化量
          let ny = y + archN * (1 - a * a);
          // 眉尾（|a| 大）收细，做出自然尖梢
          const taper = 1 - 0.35 * Math.pow(Math.abs(a), 2.2);
          return [x * taper, ny * taper, z];
        },
      }),
      color: mix3(preset.hair, [0, 0, 0], 0.15),
      bone: 'Head', isFace: true, kind: 'hair', isBrow: true,
    });
  }

  return { parts, L };
}

// ===========================================================================
// 头发（分层）
// ===========================================================================

function buildHair(preset, skel) {
  // 调试开关：只想验某一层时，用 AIVA_HAIR_ONLY=shell|strands|drop 只生成那一层。
  // 排查「正面两条发丝划过脸」时靠它定位到具体是哪一层，省得来回删代码。
  const ONLY = process.env.AIVA_HAIR_ONLY || '';
  const on = (k) => !ONLY || ONLY === k;
  const H = preset.height;
  const headH = skel.headH;
  // 和 buildHead 用同一个中心，否则头发会整个沉到脖子以下
  const c = V(0, skel.headBase + headH * 0.52, 0);
  const parts = [];
  const hair = preset.hair;
  const hi = preset.hairHi;
  const headW = headWidthOf(preset, headH);   // ⚠️ 必须和 buildHead 同一个口径，见该函数注释
  const style = preset.hairStyle;
  const VT = preset.style === 'vtuber';

  // ---- 底层：罩住颅骨，但**露出发际线**（写实档的关键，Q 版是直接扣个壳）----
  //
  // ⚠️ 发际线是这块壳唯一的难点，踩过的坑记录在这里：
  //    旧逻辑 `if (z > 0.55 && y > 0.25)` 只把前额中上部的 y 往下压了 0.30，
  //    却**完全没有回收 nz**。结果是壳被"压矮"但没"后退"，
  //    在眼睛/鼻梁高度（y≈0.1~0.2 归一化）仍然向前鼓出 2~3cm，把脸盖住。
  //    实测 marcus：y=1.80m（眼）处 hairMaxZ=0.117 > skinMaxZ=0.110，
  //    y=1.78m（鼻）处 0.129 > 0.125 —— 一个短寸头居然盖到鼻子上。
  //
  //    现在的做法：沿「y 越低 → 越靠后」连续收敛 nz，
  //    并在眼睛高度以下把前半球整体推到颅骨内侧，从根上不再遮脸。
  if (on('shell')) parts.push({
    ...ellipsoid({
      c: c.clone().add(V(0, 0.010 * headH, -0.012 * headH)),
      // ⚠️ VTuber 档横向再放宽一档（0.545 → 0.585）。
      //    动漫档头本来就宽（0.78 头高），发壳按 0.545 算出来只比耳朵宽 0.002 头高，
      //    耳朵会从头发里戳出来（实测侧炸 -0.021H）。二次元的发型本来也该有横向体积。
      //    只放宽 X —— Z 一动就会顶到额头，前面那五轮发际线调校全白做。
      r: V(headW * (VT ? 0.585 : 0.545), headH * 0.575, headH * 0.615),
      segs: 30, ring: 30,
      deform: (x, y, z, u, v) => {
        let nx = x, ny = y, nz = z;
        // 上半球保留，下半球沿侧后方向垂下（后脑的头发）
        if (y < 0) {
          const t = Math.min(1, -y);
          // 前面（+z）不收，后面（-z）垂下来
          if (z < 0) { ny -= 0.55 * t; nz *= 1 + 0.15 * t; }
          else { ny *= 1 - 0.10 * t; }
        }

        // ---- 发际线：前半球（z>0）在发际线处**收口** ----
        //
        // 真人发际线在眉上约 2~3cm 就开始后退，到眼睛高度时前额已是纯皮肤。
        //
        // ⚠️ 这个式子调过四轮，记录踩坑过程（每一轮都有实测数据）：
        //    ① `k = drop*drop`（缓入）—— 阈值附近修正最弱，正好是额头最需要收的地方。
        //       marcus y=1.80m（眼）hair z=0.122 > skin 0.102，差 2cm。
        //    ② `k = drop^0.55` + 眼睛以下把 nz 推负 —— elena 在 y=1.67~1.72m
        //       （额头上三分之一）仍有 2~8cm 的头发压在脸前。
        //    ③ `nz *= (1-k)` 叠加 `nz -= 0.34*t` —— 数值指标终于合格（遮脸 8.6%），
        //       **但头部特写里额正中垂下两条细发丝**（hair2-elena-head.png）。
        //
        //    ③ 的病根：壳是个**闭合椭球**。把前下部顶点往 -z 推，它们只是"退到脸后面"，
        //       依然构成一片曲面；而在近中轴处（|nx| 小）每格顶点密，
        //       只要 k 没到 1 就有一列顶点露在脸前 —— 于是形成两条竖直细刺。
        //
        //    ④ 现在（正解）：**不做平移，做收口**。
        //       前半球凡低于发际线的顶点，直接把它**抬到发际线高度**（ny 上提）
        //       并把 nz 收到颅骨内侧。效果等于"头发到发际线就断了"，
        //       就像真发在额头终止一样 —— 不再有任何东西垂到脸上。
        //
        //    ⚠️ ⑤ 第五轮修正（tools/probe-front.mjs 的逐行数据把它抓出来的）：
        //       上面 ①②③ 的修正项在 t=0（即 y 正好等于 HAIRLINE 的那一圈）**完全不生效**，
        //       而那一圈恰恰是"头发和额头的交界"，它超前的量最大。
        //       实测 elena：壳在 y0=0.46 处的前沿 z = 114.4~128.2mm，
        //       而额头皮肤在 y=1.676m 处只有 98.3mm —— 头发比皮肤领先 16~30mm，
        //       probe 于是在 y=1.676~1.732m 连续 6 行报"头发盖脸"。
        //
        //       根因不是"收口不够狠"，而是**壳的前半径本身太大**：
        //       rz = headH*0.615，而颅骨前半径只有 headH*0.56 左右。
        //       半球壳在前方天然外扩了约 3cm，这是发厚的合理量，
        //       但**在额头这一段不能保留** —— 额头的发际线是要贴在皮上的。
        //
        //       做法：把"发厚"做成**随高度变化**的量 ——
        //       颅顶（y 大）保留 1.10 倍发厚，到发际线（y=0.46）收敛到 1.00 倍（正好贴皮），
        //       发际线以下继续收缩。这样额头前沿永远只比皮肤多不到 1mm。
        if (z > 0.15) {
          const HAIRLINE = 0.46;
          const FULL = 0.10;
          const t = Math.min(1, Math.max(0, (HAIRLINE - y) / (HAIRLINE - FULL)));
          if (t > 0) {
            const k = 1 - Math.pow(1 - t, 1.8);
            // ① 收口：把低于发际线的前半球顶点抬回发际线附近
            ny += (HAIRLINE - y) * 0.72 * t;
            // ② 同时按 k 把前凸削掉并整体后移，双保险
            nz *= 1 - k;
            nz -= 0.30 * t;
            nx *= 1 - 0.10 * k;
          }
          // ③ 额头前沿必须收到皮肤以内。
          //    ⚠️ 注意方向：这里是**乘一个小于 1 的系数往回收**，不是加大。
          //    （曾经写成 `*= 1.00 + 0.10*topToHair`，结果额头从 117mm 涨到 118mm，
          //      越改越糟 —— 因为壳的前半径本来就比颅骨大 3cm，再放大只会更凸。）
          //    颅顶保留 1.0（发厚靠 ② 之外的上半球自然外扩），
          //    从颅顶往下到发际线线性收到 0.90，让额头前沿压进皮肤里。
          const topToHair = Math.min(1, Math.max(0, (y - HAIRLINE) / (0.95 - HAIRLINE)));
          nz *= 1.00 - 0.10 * (1 - topToHair);
        }
        return [nx, ny, nz];
      },
    }),
    color: hair,
    bone: 'Head',
    kind: 'hair',
  });

  // ---- 发束：沿头顶到两侧铺若干条，做出"一绺一绺"的分组感 ----
  //
  // ⚠️ 旧写法是「从头顶垂直往下拉一根管子」，端点只改 y、不改 z。
  //    头顶正前方那条（cz≈+1）于是**径直穿过额头继续往下**，
  //    到眼睛/鼻子高度还在脸前面 —— 短发也糊脸。
  //
  //    正确做法：发束要**贴着颅骨弧面**走。
  //    参数化：从头顶沿球面弧往下走 phi 弧度，位置 = 球心 + R*(sin·cos, cos, sin·sin)。
  //    同时按发型限制"能往下走多远"：
  //      · 短发：只走到发际线以上（phi 小），绝不越过额头
  //      · 长发：可以往下走很多，但必须**让开脸** —— 越过发际线后改为沿侧后方垂落
  // ⚠️ FF7R 标准：发束数量翻倍（10/12/16 → 20/24/32）。
  //   FF7 Rebirth 用的是 card-based hair —— 头发由许多**薄片**叠成，
  //   层次多、边缘碎、有明确的自我阴影。我们的 tube 图元就是"card"的近似，
  //   所以加密发束密度是最直接贴近该工艺的做法（代价是面数上涨）。
  const strands = style === 'short-crop' ? 20 : style === 'short-swept' ? 24 : 32;
  const isShort = style.startsWith('short');
  const isMedium = style === 'medium-tousled';

  // 发型允许的"沿球面最大下探角"（弧度）。角度越大越往下。
  // 短发 0.95rad ≈ 54°，正好停在发际线附近；长发 2.6rad ≈ 149°，绕到耳后再垂。
  //
  // ⚠️ 长发 2.60rad=149° 是个**错误**的值：它让侧面发束（a≈90°/270°）
  //    在球面上绕过头顶、跨过耳朵、一直卷到**下巴以下**
  //    （复算 i=4：py = shellR.y*cos(2.595) = -105mm，即下颌高度；
  //     而 tube 的起点在颅顶 —— 于是这条长管**从颅顶斜穿整张脸**到下巴，
  //      正视图里就是那两条怎么也去不掉的竖直发束）。
  //
  //    真人侧面头发下探到**耳垂/颌角**就停了，对应球面角约 1.85rad≈106°。
  //    超过这个角，发束必然穿过面部投影区。
  const maxPhi = isShort ? 0.95 : isMedium ? 1.70 : 1.85;

  // ⚠️ 球面半径不能用一个标量！
  //    实测 aria/mika/ren「耳朵高度侧炸 0.128~0.262 头高」的元凶就是这里：
  //    shellR = headH*0.60 比颅骨的每一个半径都大 ——
  //    颅骨实际是 (headW*0.5, headH*0.52, headH*0.56) = (0.36, 0.52, 0.56)*headH，
  //    X 方向更是超了 67%，发束因此整体飘在头外侧，成为"蘑菇头"。
  //    正确做法：发束壳**按颅骨的椭球半径等比例放大一点点**（就是发厚），
  //    于是它天然贴合头型，侧面不再外扩。
  const HAIR_THICK = 1.055;
  const shellR = V(headW * 0.5 * HAIR_THICK, headH * 0.52 * HAIR_THICK, headH * 0.56 * HAIR_THICK);

  for (let i = 0; i < strands; i++) {
    const a = (i / (strands - 1)) * Math.PI * 2;
    const sx = Math.sin(a);
    const cz = Math.cos(a);
    // 只铺在前半圈到侧面，后脑由底层负责
    if (cz < -0.35) continue;

    // 这条发束下探到哪：按 |sx| 微调（侧面的束比正前方略长，符合真发走向）
    const phi = maxPhi * (1 - 0.18 * (1 - Math.abs(sx)));
    // ⚠️ 判据要从 cz>0.55 放宽到 cz>0.15。
    //    原来只收"正前方那一束"，但实测 mika/ren 遮眼 22~25% 改不动 ——
    //    说明压住眼睛的是 cz≈0.2~0.5 那几束**斜前方**的卷，
    //    它们不在 cz>0.55 的门槛里，一路垂到了眼睛高度。
    //    斜前方在真实发型里是"鬓角往前的碎发"，同样不该过眼。
    // ⚠️ 第三次修正（离线正视图 shot-head.mjs 推翻了前两次的判断）：
    //    前两次改的都是"落点长度"，但真正难看的是**走向** ——
    //    正面那几束从颅顶出发、贴着额面斜插到嘴的高度，像两根筷子架在脸上。
    //    根因：正面（|sx| 小）的发束无论怎么缩 phi，它都是从**最高点**往下垂，
    //    而真发在额前根本不是"垂下"，是**从发际线往两侧/往后梳走**。
    //
    // ⚠️ 第四次修正（正视图仍能看到两条发束压在脸颊两侧）：
    //    第三次只跳过了 cz>0.55（±56°），剩下的**斜前方**（0.15<cz<0.55）
    //    依然从颅顶往下垂，落点算出来正好在颧骨～下颌之间，
    //    在正视图里就是"两条发束贴着两颊垂下来"。
    //
    //    真人长发在**脸的两侧**确实有头发，但它是**从耳后往前包**的，
    //    起点在耳上后方，而不是颅顶正中。
    //    所以：斜前方那几束的起点继续往后拉（不参与正面），
    //    并且它们的终点要往**侧后方**收，而不是留在脸侧正面。
    //
    //    最终规则：只有在**侧后方**（cz < 0.15）才正常垂落；
    //    cz > 0.15 的全部改成"只走一小段、贴在发际线附近"，不下到脸。
    const isFrontal = cz > 0.55;                       // 正前方 ±56° 内
    const isFrontQuarter = cz > 0.15 && !isFrontal;    // 斜前方
    if (isFrontal) continue;

    const frontExtra = (style === 'long-wavy' || style === 'medium-tousled') ? 0.40 : 0.48;
    const phiClamp = isFrontQuarter ? Math.min(phi, frontExtra) : phi;

    // 椭球面上的起止点：从头顶（phi=0）走到 phi
    //   x = R.x * sin(phi) * sin(a)
    //   y = R.y * cos(phi)
    //   z = R.z * sin(phi) * cos(a)
    const sp = Math.sin(phiClamp), cp = Math.cos(phiClamp);
    let px = shellR.x * sp * sx;
    const py = shellR.y * cp;
    let pz = shellR.z * sp * cz;

    // ---- 发束的**起点**必须离开顶点，否则所有前发都从颅顶正中最尖处出发 ----
    //
    // ⚠️ 这是离线头部正视图（tools/shot-head.mjs）一眼看穿的毛病：
    //    额前两条发束在脸上写成一个大大的"Λ"。
    //    成因：p0 恒为 V(0, shellR.y, 0)，即所有发束共用**颅顶最高点**作起点。
    //    对正面那几束（a≈0/π，sx≈0）来说，起点 x=0、终点也被 push 推到 x≠0，
    //    于是 tube 就是一条"从颅顶中心斜切到脸侧"的长条 —— 正好压过眼睛和鼻梁。
    //
    //    真发的分缝在**发际线上**，不在颅顶正中。所以起点要跟终点用**同一个 a**
    //    在椭球面上取一个小 phi0，让发束沿着头壳的弧面走，而不是穿过颅腔直线切下去。
    const phi0 = cz > 0.15 ? 0.30 : 0.16;      // 正面起束更高一点，形成分缝
    const sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
    const p0 = V(shellR.x * sp0 * sx, shellR.y * cp0, shellR.z * sp0 * cz);

    // ---- 正面发束"让开中线"：改成**整体侧分**，而不是把端点掰到一边 ----
    //
    // ⚠️ 历史教训（上一版）：只把**终点**往两侧推（push），起点仍是颅顶正中，
    //    于是 tube 变成"从正中斜切到脸侧"的长条，在正视图里就是一个大 "Λ"。
    //    平移整个发束（起点+终点一起）才是"分缝"的几何含义。
    //
    //    做法：给正面区域（cz>0.15）的所有发束加一个**同向**的 x 偏移，
    //    偏移量取 (1-|sx|) —— 越靠中轴推得越多，两侧自然不动。
    //    方向统一取正（全部往角色左耳侧梳），形成明确的"三七分"，
    //    这样既不会在脸中轴留缝，也不会左右对称成"中分"。
    let pzOut = pz;
    let pxOut = px;
    let p0x = p0.x;
    if (isFrontQuarter) {
      const part = headW * 0.34 * (1 - Math.abs(sx));
      pxOut += part;
      p0x += part * 0.35;                  // 起点只跟一部分，保持发根还在头顶
      // 斜前方那几束整体后移，让它们包在**颧骨侧面**而不是挂在脸前面。
      // 直接减 z 而不是乘系数 —— 乘系数在 pz 很小的时候几乎没效果，
      // 而后移一个固定量才能保证它们退到耳前（真发鬓角的位置）。
      pzOut -= shellR.z * 0.34;
    }

    // ---- 关键约束：发束落点的 |x| 不得小于该高度处的颅骨半宽 ----
    //
    // ⚠️ 这条是"脸上两条发束"的最终解。
    //    复算每条发束端点（node -e 打印 i / a / 起点 / 终点）后发现元凶是
    //    **i=4 与 i=11**（a=96° 与 264°，即正侧面）：它们的 cz=-0.10，
    //    既不是正面（不跳过）也不是斜前方（不加 part 推力），
    //    落点是 shellR.x*sin(phiClamp)*sx = 44mm —— 而颧骨高度处颅骨半宽约 81mm，
    //    于是发束稳稳落在**脸颊正中**，并在正视图里形成两条竖直发束。
    //
    //    真发在这个方位是从耳后往下走的，绝不会贴着脸颊。
    //    所以给所有外侧发束加一个下限：落点 |x| 至少到颅骨外缘。
    const landY = py;                                  // 落点高度（相对头心）
    const yNorm = landY / shellR.y;                    // -1..1，用于估该高度的颅骨半宽
    const skullHalfHere = shellR.x * Math.sqrt(Math.max(0.05, 1 - yNorm * yNorm));
    const minAbsX = skullHalfHere * 0.98;
    if (Math.abs(pxOut) < minAbsX && !isFrontQuarter) {
      pxOut = Math.sign(pxOut || sx || 1) * minAbsX;
    }

    const outward = 1.015 + (i % 3) * 0.010;   // 每条略微不同，避免"塑料盔"
    const jitter = style === 'long-wavy' ? Math.sin(i * 1.7) * headW * 0.05 : 0;
    if (on('strands')) parts.push({
      ...tube({
        a: V(c.x + p0x * outward, c.y + p0.y * outward + headH * 0.020, c.z + p0.z * outward),
        b: V(c.x + pxOut * outward, c.y + py * outward, c.z + pzOut * outward + jitter),
        ra: headH * 0.052,
        rb: isShort ? headH * 0.030 : headH * 0.040,
        segs: isShort ? 4 : 8,
        ring: 7,
        capB: true,
        shape: (t) => [1.0, 0.62],
      }),
      color: i % 4 === 0 ? mix3(hair, hi, 0.55) : hair,
      bone: 'Head',
      kind: 'hair',
    });
  }

  // ---- 刘海/额发：正面那一层 ----
  //
  // ⚠️ 这里**曾经**放了一个"压扁椭球 + 把 band 外的顶点塌缩到 [0,-2.5,0]"的壳，
  //    想做个刘海。实测（tools/probe-front.mjs）证明它是一场灾难：
  //    塌缩点和 band 之间会连出一圈**锥面**，在额前形成一块 100~110mm 的平板，
  //    而额头皮肤本身只到 37~98mm —— 于是整块额头被一块平板状头发挡住，
  //    probe 显示 y=1.676~1.732m（额头到颅顶）连续 6 行"头发盖脸"。
  //
  //    教训：靠 deform 里的**坐标塌缩**来"挖洞"是行不通的 ——
  //    网格是连通的，塌缩点必然和邻接顶点张出面来。
  //    额头那点覆盖，交给底层壳（buildShell 里已经有了发际线收口）就够，
  //    正面发束已在上面跳过（cz>0.55 continue），脸上不会再有多余几何。

  // ---- 长发的垂落部分：挂在头骨下方，垂到肩 ----
  if (style === 'long-straight' || style === 'long-wavy' || style === 'medium-tousled') {
    const dropLen = style === 'medium-tousled' ? headH * 0.9 : headH * 2.1;
    const wave = style === 'long-wavy' ? headW * 0.20 : headW * 0.06;
    // ⚠️ 侧垂发的中心不能放在 ±headW*0.46、半径也不能给 headH*0.24。
    //    实测 elena：中心 0.075m + 半径 0.054m = 外缘 0.129m，
    //    而颅骨半宽只有 headW*0.5 = 0.082m —— 头发比头宽 57%，就是"蘑菇头"。
    // ⚠️ 第五轮：顶点直方图（y=1.60~1.68, z>20mm）显示在 **x=±40mm 处各堆了 550+ 个顶点**，
    //    而这条正是**颧骨中线** —— 颅骨半宽 81mm，所以这堆顶点落在脸颊正中，
    //    在正视图里就是"两条发束压在两颊上"。
    //    溯源：侧垂发中心 sideX = headW*0.40 = 63mm，再被 tube 半径 sideR=35mm
    //    往内铺 → 内缘 63-35 = 28mm，正好糊到脸上。
    //
    //    改法：把侧垂发推到**颅骨外缘之外**，让它内缘刚好贴住耳前。
    //    ⚠️ 但也不能推太远：第一版取 `skullHalfW + headH*0.075`，
    //       外缘冲到 headW*0.5+0.075h+0.130h ≈ 0.146m，inspect-hair 的"侧炸"直接
    //       从 0.021H 爆到 **0.150H**（阈值 0.035）—— 变成蘑菇头。
    //       最终取：中心 = 颅骨半宽 + 半径的 30%，外缘 ≈ 半宽 + 1.3×半径，
    //       既保证内缘（半宽 - 0.7×半径）压在耳前不糊脸，又把外缘控制在发厚范围内。
    const skullHalfW = headW * 0.5;
    const sideR = headH * 0.085;
    const sideX = skullHalfW + sideR * 0.30;
    for (const s of [1, -1]) {
      if (on('drop')) parts.push({
        ...tube({
          a: V(c.x + s * sideX, c.y + headH * 0.10, c.z - headW * 0.20),
          b: V(c.x + s * (sideX + wave * 0.4), c.y + headH * 0.10 - dropLen, c.z - headW * 0.24 + wave),
          ra: sideR, rb: sideR * 0.56,
          segs: style === 'long-wavy' ? 10 : 7,
          ring: 10,
          capB: true,
          shape: (t, ang) => {
            const w = style === 'long-wavy' ? 1 + 0.12 * Math.sin(t * 7) : 1;
            return [w, 0.72 * w];
          },
        }),
        color: hair,
        bone: 'Head',
        kind: 'hair',
      });
    }
    // 后脑的一大片
    if (on('back')) parts.push({
      ...tube({
        a: V(c.x, c.y + headH * 0.16, c.z - headW * 0.44),
        b: V(c.x, c.y + headH * 0.16 - dropLen * 0.95, c.z - headW * 0.38),
        ra: headW * 0.40, rb: headW * 0.26,
        segs: 8, ring: 10, capB: true,
        shape: () => [1.15, 0.62],
      }),
      color: mix3(hair, [0, 0, 0], 0.12),
      bone: 'Head',
      kind: 'hair',
    });
  }

  return parts;
}

// ===========================================================================
// 剪影特征层（FF 风格四件套）
// ===========================================================================
// 为什么单独一层：这 4 个新角色要和上面 6 个做 A/B 横评，
// 差异必须体现在**剪影**（silhouette）上 —— 玩家在角色列表里第一眼看到的就是剪影。
// Square Enix 的角色辨识度几乎全在剪影：尖发、肩甲、长袍、兜帽、披风。
//
// ⚠️ 这一层有**两条硬规则**，违反就会毁掉前面十几轮才调好的脸：
//
//   ① 任何部件都不得进入「发际线以下 + 脸的前半球」这块区域。
//      buildHair 里那六轮调头发已经证明：一旦有几何压到脸前，
//      inspect-hair / probe-front 会立刻报出来，而且肉眼极难看。
//      所以四个特征分别指向四个**远离脸**的方向：
//        尖发 → 往上 / 往后     肩甲 → 往两侧
//        长裙 → 往下           兜帽 → 往后（兜帽是**放下**状态，脸永远露着）
//
//   ② 头发类部件的颜色只能用 preset.hair / hairHi / mix3(hair,hi,0.55)。
//      inspect-hair 的调色板是**精确最近邻匹配**，用别的颜色该顶点会被判成 other，
//      于是头发体检直接漏掉它 —— 静默失效，比报错危险得多。

function buildExtras(preset, skel) {
  const H = preset.height;
  const headH = skel.headH;
  const headW = headWidthOf(preset, headH);   // ⚠️ 必须和 buildHead 同一个口径，见该函数注释
  const o = preset.outfit;
  const x = preset.extras || {};
  const hair = preset.hair;
  const hi = preset.hairHi;
  const parts = [];
  // ⚠️ 必须和 buildHair 用**同一个头心**，否则尖发会整体偏出去
  const c = V(0, skel.headBase + headH * 0.52, 0);

  // ---- 尖发：只从颅顶往上 / 往后炸开 ----
  //
  // FF7R 的头发是 card-based（许多薄片叠成），程序化做不到薄片，
  // 就用「一根根锥刺」近似 —— 观感上同样是"一绺一绺炸开"的剪影。
  //
  // ⚠️ 两个安全边界（都是算出来的，不是拍脑袋）：
  //   · 前半球只允许 phi ≤ 0.52rad（≈30°）。再大，刺根就落到发际线以下，
  //     锥体（半径 0.042 头高）会探进 probe-front 的面部扫描带。
  //     实测前排刺根 y ≈ 头心 +0.43~0.48 头高，而扫描带上沿在头心 +0.10 头高
  //     —— 高出 0.33 头高，安全。
  //   · 后排刺的方位角锁在 63°~297°，正前方 ±63° 一根不放。
  //   · 刺长上限 0.19 头高：发尖最高落在头心 +0.71 头高，
  //     减颅顶 0.52 = 顶厚 0.19H，卡在 inspect-hair 的 0.26H 红线以内。
  if (x.spikes) {
    const R = V(headW * 0.50 * 1.06, headH * 0.52 * 1.06, headH * 0.56 * 1.06);
    const addSpike = (theta, phi, len, rad, idx) => {
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const bx = R.x * sp * Math.sin(theta);
      const by = R.y * cp;
      const bz = R.z * sp * Math.cos(theta);
      // 刺的方向 = 颅心指向外壳点，再往上掰 0.45、往后掰 0.32
      // （真尖发是往后倒的，不是笔直朝天 —— 笔直朝天就是"海胆"）
      const d = V(bx, by, bz).normalize();
      d.y += 0.45; d.z -= 0.32;
      d.normalize();
      const base = V(c.x + bx * 0.90, c.y + by * 0.90, c.z + bz * 0.90);
      const tip = base.clone().add(d.clone().multiplyScalar(len));
      parts.push({
        ...tube({
          a: base, b: tip,
          ra: headH * rad, rb: headH * 0.006,
          segs: 5, ring: 7, capB: true,
          shape: (t) => [1.0, 0.72 - 0.25 * t],
        }),
        color: idx % 3 === 0 ? mix3(hair, hi, 0.55) : hair,
        bone: 'Head',
        kind: 'hair',
      });
    };

    const nA = Math.max(3, Math.round(x.spikes * 0.6));
    const nB = Math.max(3, Math.round(x.spikes * 0.4));
    // 前排（顶冠）：绕一整圈，但 phi 只有 0.28~0.52 —— 全在颅顶
    //
    // ⚠️ 刺长怎么定的（算过再写，不是试出来的）：
    //    实测第一版取 0.115~0.19 头高，出来的顶厚只有 0.104H ——
    //    因为伪随机配对下「最长的刺」从来没落在「最高的 phi」上，
    //    实际最高点 = 0.5512·cos(0.378)·0.9 + 0.165·0.976 = 0.622 头高，
    //    减颅顶 0.52 = 0.102H，和实测 0.104 吻合。
    //    现在抬到 0.175~0.285：最高点 ≈ 0.704 → 顶厚 0.184H，
    //    仍在 inspect-hair 的 0.26H 红线内（留出 0.076 余量给后续微调）。
    for (let i = 0; i < nA; i++) {
      const theta = (i / nA) * Math.PI * 2 + 0.30;
      const phi = 0.28 + 0.24 * ((i * 0.41) % 1);
      const len = headH * (0.175 + 0.110 * ((i * 0.67) % 1));
      const rad = 0.030 + 0.016 * ((i * 0.23) % 1);   // 粗细不一，才像"一绺一绺"
      addSpike(theta, phi, len, rad, i);
    }
    // 后排（后脑勺）：方位角 63°~297°，正前方 ±63° 留空
    for (let i = 0; i < nB; i++) {
      const theta = Math.PI * (0.35 + 1.30 * (i / nB));
      const phi = 0.88 + 0.16 * ((i * 0.53) % 1);
      const len = headH * (0.135 + 0.075 * ((i * 0.29) % 1));
      addSpike(theta, phi, len, 0.036, i + nA);
    }
  }

  // ---- 长裙：从胯一直罩到脚踝上方 ----
  //
  // ⚠️ 下摆停在 0.085H（不是 0）—— 脚和小腿下半截要露出来，
  //    否则 inspect-character 的「贴地」和「总高」两项会被裙摆干扰。
  //    锥体在膝盖高度半径 ≈ 0.22m > 腿外缘 0.145m，腿是**完全藏在里面**的，
  //    所以不用删腿的几何（删了反而会在摆臂/行走动画里穿帮）。
  if (x.skirt) {
    const kk = preset.build === 'heavy' ? 1.08
      : preset.build === 'athletic' ? 1.0
      : preset.build === 'soft' ? 0.94 : 0.88;
    const hemY = 0.085 * H;
    parts.push({
      ...tube({
        a: skel.j.Hips.clone().add(V(0, -0.015 * H, 0)),
        b: V(0, hemY, -0.004 * H),
        ra: preset.hip * 0.50 * kk,
        rb: preset.hip * 0.78,
        segs: 10, ring: 24, capB: true,
        shape: (t) => [1.0 + 0.10 * Math.sin(t * Math.PI), 0.78 + 0.14 * t],
      }),
      color: o.bottom, bone: 'Hips', kind: 'clothes',
    });
    // 裙摆一圈：给下沿一点布的厚度，不然从侧面看是一张纸
    parts.push({
      ...tube({
        a: V(0, hemY + 0.012 * H, -0.004 * H),
        b: V(0, hemY - 0.006 * H, -0.004 * H),
        ra: preset.hip * 0.78, rb: preset.hip * 0.80,
        segs: 3, ring: 24,
        shape: () => [1.0, 0.86],
      }),
      color: mix3(o.bottom, o.accents, 0.45), bone: 'Hips', kind: 'clothes',
    });
  }

  // ---- 肩甲：挂在肩关节上，往两侧撑出重装剪影 ----
  if (x.pauldron) {
    for (const s of [1, -1]) {
      const S = s > 0 ? 'Left' : 'Right';
      const j = skel.j[`${S}Arm`];
      parts.push({
        ...ellipsoid({
          c: j.clone().add(V(s * 0.004 * H, 0.012 * H, 0.002 * H)),
          r: V(0.078 * H / 1.75, 0.050 * H / 1.75, 0.078 * H / 1.75),
          segs: 14, ring: 18,
        }),
        color: o.inner, bone: `${S}Arm`, kind: 'clothes',
      });
      // 肩甲下沿一圈包边（黄铜色），让盔甲有层次而不是一个光球
      parts.push({
        ...ellipsoid({
          c: j.clone().add(V(s * 0.004 * H, -0.012 * H, 0.002 * H)),
          r: V(0.070 * H / 1.75, 0.020 * H / 1.75, 0.070 * H / 1.75),
          segs: 8, ring: 18,
        }),
        color: o.accents, bone: `${S}Arm`, kind: 'clothes',
      });
    }
  }

  // ---- 兜帽（**放下**状态）：后脑一团 + 披到背上的一片 ----
  //
  // ⚠️ 这里刻意不做"戴在头上"的兜帽。
  //    戴上去的兜帽必须在额头/脸侧围一圈，而那一圈只要有任何一点落在皮肤前面，
  //    就会把整张脸框住 —— 而且因为它是 clothes 色（既不是 hair 也不是 skin），
  //    inspect-hair 的 faceBlock **检测不到**（只统计 hair），
  //    probe-front 会把它当 '?' 算进"脸"那一侧 —— 两个工具都会给出假阴性。
  //    所以做"放下的兜帽"：全部几何堆在头后，前沿最远只到 z = -0.04 头高，
  //    而脸的皮肤前沿在 z = +0.56 头高 —— 落后 0.6 个头高，绝对安全。
  if (x.hood) {
    parts.push({
      ...ellipsoid({
        c: V(0, c.y - headH * 0.06, c.z - headH * 0.34),
        r: V(headW * 0.60, headH * 0.44, headH * 0.30),
        segs: 16, ring: 20,
      }),
      color: o.outer, bone: 'Head', kind: 'clothes',
    });
    parts.push({
      ...tube({
        a: V(0, skel.j.Neck.y - 0.005 * H, -0.050 * H),
        b: V(0, skel.j.Spine1.y - 0.010 * H, -0.070 * H),
        ra: 0.070 * H / 1.75, rb: 0.105 * H / 1.75,
        segs: 8, ring: 18, capB: true,
        shape: () => [1.35, 0.55],
      }),
      color: o.outer, bone: 'Spine1', kind: 'clothes',
    });
  }

  // ---- 披风：挂在背后，垂到大腿中段 ----
  //     全在 z<0，宽度不超过肩宽，不会影响 poseRatio（肩胸区 X 跨度）
  if (x.cape) {
    parts.push({
      ...tube({
        a: V(0, skel.j.Spine2.y + 0.020 * H, -0.045 * H),
        b: V(0, 0.30 * H, -0.075 * H),
        ra: preset.shoulder * 0.40, rb: preset.shoulder * 0.52,
        segs: 10, ring: 20, capB: true,
        shape: () => [1.15, 0.30],
      }),
      color: o.accents, bone: 'Spine1', kind: 'clothes',
    });
  }

  // ---- 呆毛（アホゲ）：动漫角色最便宜也最有效的一根剪影 ----
  //
  // ⚠️ 高度上限还是 0.26 头高（inspect-hair 的顶厚红线）。
  //    这里发尖落在头心 +0.70 头高，减颅顶 0.52 → 顶厚 0.18，留 0.08 余量。
  // ⚠️ 只放一根、且偏右后方：居中一根会像天线，两根以上就是"海胆"。
  if (x.ahoge) {
    const P = (dx, dy, dz) => V(c.x + dx * headW, c.y + dy * headH, c.z + dz * headH);
    // ⚠️ 颜色只能用调色板里的**精确值**（hair 或 hairHi），不能用 mix3(hair, hi, 0.35) 这种插值色。
    //    inspect-hair 是精确最近邻匹配：mix(hair,hi,0.35) 离 mix(hair,hi,0.55) 有 0.106，
    //    超过容差就被判成 other —— 呆毛会**整根从顶厚统计里消失**（实测顶厚掉回 0.073H，
    //    和没有呆毛的角色一模一样，静默失效）。
    //    所以做成两段渐变：根部 hair（薄荷青）→ 尖 hairHi（奶油金），两色都是精确值。
    const seg = (a, b, ra, rb, col) => parts.push({
      ...tube({ a, b, ra, rb, segs: 4, ring: 8, capB: true }),
      color: col, bone: 'Head', kind: 'hair',
    });
    seg(P(0.08, 0.45, -0.04), P(0.02, 0.62, -0.10), headH * 0.026, headH * 0.019, hair);
    seg(P(0.02, 0.62, -0.10), P(-0.11, 0.70, -0.21), headH * 0.019, headH * 0.004, hi);
  }

  // ---- 头戴耳机：VTuber 最强的识别特征 ----
  //
  // 遵守本层规则 ①：耳罩在**两侧**、头梁在**头顶以上**，都不进入脸的前半球。
  // 头梁椭圆弧半轴取 0.62 头宽 / 0.66 头高，都大于颅骨的 0.50 / 0.52，
  // 所以它是"戴在头发外面"而不是埋进头里 —— 不然低模下会直接穿模。
  //
  // ⚠️ 刻意**不做**耳麦话筒臂：那根杆必须伸到嘴边，正是规则 ① 明令禁止的区域。
  if (x.headset) {
    for (const s of [1, -1]) {
      parts.push({
        ...ellipsoid({
          c: V(c.x + s * headW * 0.52, c.y - 0.02 * headH, c.z - 0.02 * headH),
          r: V(headH * 0.055, headH * 0.105, headH * 0.105), segs: 12, ring: 14,
        }),
        color: o.accents, bone: 'Head', kind: 'clothes',
      });
      // 耳罩内侧一圈深色：不然就是一个发光的球贴在耳朵上，看不出是耳机
      parts.push({
        ...ellipsoid({
          c: V(c.x + s * headW * 0.44, c.y - 0.02 * headH, c.z - 0.02 * headH),
          r: V(headH * 0.030, headH * 0.072, headH * 0.072), segs: 8, ring: 12,
        }),
        color: mix3(o.accents, [0, 0, 0], 0.55), bone: 'Head', kind: 'clothes',
      });
    }
    // 头梁：沿冠状面的一段椭圆弧（175°→5°，经过头顶 90°），用若干小 tube 拼。
    // 没有现成的 torus 原语，拼段是最省事且能过 LOD 降面的做法。
    const RX = headW * 0.62, RY = headH * 0.66;
    const STEPS = 9;
    const a0 = 175 * Math.PI / 180, a1 = 5 * Math.PI / 180;
    for (let i = 0; i < STEPS; i++) {
      const th0 = lerp(a0, a1, i / STEPS);
      const th1 = lerp(a0, a1, (i + 1) / STEPS);
      const p0 = V(c.x + RX * Math.cos(th0), c.y + RY * Math.sin(th0), c.z);
      const p1 = V(c.x + RX * Math.cos(th1), c.y + RY * Math.sin(th1), c.z);
      parts.push({
        ...tube({ a: p0, b: p1, ra: headH * 0.032, rb: headH * 0.032, segs: 2, ring: 8 }),
        color: o.accents, bone: 'Head', kind: 'clothes',
      });
    }
  }

  return parts;
}

// ===========================================================================
// Blendshape（ARKit 命名，和可爱版同一份 SHAPES）
// ===========================================================================

const SHAPES = [
  'jawOpen', 'mouthClose', 'mouthPucker', 'mouthFunnel',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthLeft', 'mouthRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'browInnerUp', 'browDownLeft', 'browDownRight',
  'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
];

function buildBlendshapes(L, pos, acc) {
  const N = pos.length / 3;
  const out = {};
  for (const s of SHAPES) out[s] = new Float32Array(N * 3);
  const c = L.center;
  const headH = L.headH;

  for (let vi = 0; vi < N; vi++) {
    const eyeTag = acc.eye[vi];

    // ---- 眼球 + 眼睑：眨眼压扁 ----
    if (eyeTag) {
      const side = eyeTag === 1 ? 'Left' : 'Right';
      const y = pos[vi * 3 + 1];
      const rel = y - L.eyeY;
      out[`eyeBlink${side}`][vi * 3 + 1] -= rel * 0.96;
      out[`eyeWide${side}`][vi * 3 + 1] += rel * 0.20;
      out[`eyeSquint${side}`][vi * 3 + 1] -= rel * 0.52;
      continue;
    }

    if (!acc.face[vi]) continue;

    const x = pos[vi * 3];
    const y = pos[vi * 3 + 1];
    const z = pos[vi * 3 + 2];
    if (z < c.z - L.skullR.z * 0.1) continue;

    const set = (name, dx, dy, dz) => {
      out[name][vi * 3] += dx;
      out[name][vi * 3 + 1] += dy;
      out[name][vi * 3 + 2] += dz;
    };

    const dMouth = Math.hypot(x - c.x, y - L.mouthY);
    const dBrowL = Math.hypot(x - (c.x + L.eyeX * 0.95), y - L.browY);
    const dBrowR = Math.hypot(x - (c.x - L.eyeX * 0.95), y - L.browY);
    const dEyeL = Math.hypot(x - (c.x + L.eyeX), y - L.eyeY);
    const dEyeR = Math.hypot(x - (c.x - L.eyeX), y - L.eyeY);

    // 下颌张开：绕颌关节旋转
    {
      const m = falloff(dMouth, L.mouthR * 2.2) * falloff(Math.max(0, L.mouthY - y), 0.075 * headH);
      if (m > 0.001) {
        const pivotY = L.mouthY + 0.020 * headH;
        const ry = y - pivotY;
        const rz = z - c.z;
        const a = 0.30 * m;
        set('jawOpen', 0,
          -ry * (1 - Math.cos(a)) - rz * Math.sin(a) * 0.32,
          -ry * Math.sin(a) * 0.32 + rz * (1 - Math.cos(a)) * 0.22);
      }
    }

    // 抿 / 噘 / 圆
    {
      const m = falloff(dMouth, L.mouthR * 1.7);
      if (m > 0.001) {
        set('mouthClose', 0, -0.010 * headH * m * (y > L.mouthY ? 1 : -0.7), -0.003 * headH * m);
        set('mouthPucker', -(x - c.x) * 0.28 * m, -(y - L.mouthY) * 0.28 * m, 0.020 * headH * m);
        set('mouthFunnel', (x - c.x) * 0.18 * m, (y - L.mouthY) * 0.24 * m, 0.011 * headH * m);
      }
    }

    // 嘴角
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const cx = c.x + sign * L.mouthW;
      const m = falloff(Math.hypot(x - cx, y - L.mouthY), L.mouthR * 1.4);
      if (m > 0.001) {
        set(`mouthSmile${side}`, sign * 0.007 * headH * m, 0.013 * headH * m, 0.002 * headH * m);
        set(`mouthFrown${side}`, -sign * 0.003 * headH * m, -0.012 * headH * m, 0);
        set(`mouth${side}`, sign * 0.013 * headH * m, 0, 0);
      }
    }

    // 眼周皮肤
    for (const [side, dv] of [['Left', dEyeL], ['Right', dEyeR]]) {
      if (dv > L.eyeR * 2.4) continue;
      const m = falloff(dv, L.eyeR * 1.6);
      set(`eyeBlink${side}`, 0, -0.017 * headH * m * (y > L.eyeY ? 1 : 0.3), -0.002 * headH * m);
      set(`eyeWide${side}`, 0, (y > L.eyeY ? 1 : -1) * 0.008 * headH * m, 0.001 * headH * m);
      set(`eyeSquint${side}`, 0, 0.006 * headH * m * (y < L.eyeY ? 1 : 0.25), 0);
    }

    // 眉
    for (const [side, dv] of [['Left', dBrowL], ['Right', dBrowR]]) {
      const m = falloff(dv, L.eyeR * 1.5);
      if (m > 0.001) {
        const sign = side === 'Left' ? 1 : -1;
        set(`browOuterUp${side}`, sign * 0.003 * headH * m, 0.011 * headH * m, 0);
        set(`browDown${side}`, sign * 0.004 * headH * m, -0.011 * headH * m, 0.002 * headH * m);
      }
    }
    {
      const m = falloff(Math.hypot(Math.abs(x - c.x) - L.eyeX * 0.32, y - L.browY), L.eyeR * 1.3);
      if (m > 0.001) set('browInnerUp', 0, 0.012 * headH * m, 0.002 * headH * m);
    }

    // 颊
    {
      const cheekX = L.eyeX * 1.30;
      const cheekY = (L.eyeY + L.mouthY) / 2;
      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        const m = falloff(Math.hypot(Math.abs(x - c.x) - cheekX, y - cheekY), L.eyeR * 1.7);
        if (m > 0.001) set(`cheekSquint${side}`, sign * 0.003 * headH * m, 0.006 * headH * m, 0.002 * headH * m);
      }
      const m = falloff(Math.hypot(Math.abs(x - c.x) - cheekX * 0.85, y - cheekY - 0.008 * headH), L.eyeR * 1.9);
      if (m > 0.001) set('cheekPuff', (x >= c.x ? 1 : -1) * 0.014 * headH * m, 0, 0.011 * headH * m);
    }
  }

  return out;
}

// ===========================================================================
// 蒙皮（和可爱版同一算法）
// ===========================================================================

function distPointSeg(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? new THREE.Vector3().subVectors(p, a).dot(ab) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return p.distanceTo(new THREE.Vector3().copy(a).addScaledVector(ab, t));
}

function computeSkin(acc, skel) {
  const N = acc.pos.length / 3;
  const idx = new Uint16Array(N * 4);
  const wt = new Float32Array(N * 4);
  const nameToId = {};
  skel.order.forEach((n, i) => (nameToId[n] = i));

  for (let i = 0; i < N; i++) {
    const boneName = acc.bone[i];
    const p = new THREE.Vector3(acc.pos[i * 3], acc.pos[i * 3 + 1], acc.pos[i * 3 + 2]);

    const can = new Set([boneName]);
    const parentName = skel.parent[boneName];
    if (parentName) can.add(parentName);
    for (const k of skel.order) {
      if (skel.parent[k] === boneName) can.add(k);
      if (parentName && skel.parent[k] === parentName) can.add(k);
    }

    const scored = [];
    for (const bn of can) {
      const [s0, s1] = skel.seg[bn];
      scored.push([bn, distPointSeg(p, skel.j[s0], skel.j[s1])]);
    }
    scored.sort((a, b) => a[1] - b[1]);
    const top = scored.slice(0, 4);
    // 权重 = 1/(d+eps)，再做 softmax 式的相对归一
    let sum = 0;
    const ws = top.map(([, d]) => {
      const w = 1 / (d + 0.008);
      sum += w;
      return w;
    });
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = k < top.length ? nameToId[top[k][0]] : 0;
      wt[i * 4 + k] = k < top.length ? ws[k] / sum : 0;
    }
  }
  return { idx, wt };
}

// ===========================================================================
// 组装 & 导出
// ===========================================================================

async function buildCharacter(name, { keepMorphs = false } = {}) {
  const preset = PRESETS[name];
  if (!preset) throw new Error('unknown preset: ' + name);

  // ⚠️ LOD 必须在**任何几何生成之前**设置：tube() / ellipsoid() 在入口处读它。
  //    放在 buildSkeleton 之后就来不及了（骨架不生成几何，但顺序写对更不容易踩坑）。
  LOD = preset.lod || 1;

  const skel = buildSkeleton(preset);
  const acc = newAcc();

  appendParts(acc, buildBody(preset, skel));
  const head = buildHead(preset, skel);
  appendParts(acc, head.parts);
  appendParts(acc, buildHair(preset, skel));
  // ⚠️ 剪影特征层要**在 blendshape 之前**追加：
  //    pos 是这一行之后才快照的，morph 的顶点索引必须和最终网格对齐。
  //    这些部件 isFace=0，buildBlendshapes 会 `if (!acc.face[vi]) continue` 跳过，
  //    所以它们不会被表情带动 —— 衣服本来也不该跟着嘴动。
  appendParts(acc, buildExtras(preset, skel));

  const geo = new THREE.BufferGeometry();
  const skin = computeSkin(acc, skel);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(acc.color, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skin.idx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skin.wt, 4));
  geo.setIndex(acc.idx);
  geo.computeVertexNormals();

  const pos = new Float32Array(acc.pos);
  const shapes = buildBlendshapes(head.L, pos, acc);

  // morph 数据先算好放在 char.shapes 里，由 extractSparseMorphs 单独落盘。
  // 除非显式要求（keepMorphs），否则**不挂到 geometry 上** ——
  // 挂上去 GLTFExporter 会把它们整份写进 glb，文件直接从 200KB 涨到 4MB。
  if (keepMorphs) {
    geo.morphAttributes.position = SHAPES.map((s) => new THREE.BufferAttribute(shapes[s], 3));
    geo.morphTargetsRelative = true;
  }

  return { geo, skel, preset, shapes, L: head.L };
}

async function exportScene(char, outFile) {
  const { geo, skel, shapes } = char;
  const scene = new THREE.Scene();

  const boneObjs = {};
  for (const name of skel.order) { const b = new THREE.Bone(); b.name = name; boneObjs[name] = b; }
  for (const name of skel.order) {
    const p = skel.parent[name];
    if (p) {
      boneObjs[p].add(boneObjs[name]);
      boneObjs[name].position.subVectors(skel.j[name], skel.j[p]);
    } else {
      scene.add(boneObjs[name]);
      boneObjs[name].position.copy(skel.j[name]);
    }
  }
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(skel.order.map((n) => boneObjs[n]));
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.FrontSide });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = 'Body';
  mesh.frustumCulled = false;
  // ⚠️ 故意**不带** morph 导出：glTF 的 morph target 必须和基础网格等长且只能 float32，
  //    11181 顶点 × 24 表情 = 3.1MB，手机上不可接受（实测 glb 直接 3.9MB）。
  //    所以 morph 走"稀疏外挂"路线，由 extractSparseMorphs() 单独产出
  //    —— 这正是 tools/autorig.mjs 对现成模型做的事，写实档是自产自销。
  void shapes;

  scene.add(mesh);
  mesh.add(boneObjs.Hips);
  mesh.bind(skeleton);

  const out = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
  fs.writeFileSync(outFile, Buffer.from(out));
  return out.byteLength;
}

// ===========================================================================
// 稀疏 morph 导出
// ===========================================================================
// 和 autorig 产出的 morph.json 是**完全同一个格式**（version 2 + shapeSlots），
// 所以 morphData.js 不需要为写实档加任何分支。
//
// 数据量对比（elena，11181 顶点）：
//   稠密：11181 × 3 × 4B × 24 = 3.1MB
//   稀疏：只有脸和眼球在动，约 2500 个顶点 → 2500 × 3 × 4B × 24 ≈ 700KB
//   再丢掉全 0 的三元组后实际约 200~400KB

function extractSparseMorphs(char) {
  const { geo, shapes } = char;
  const pos = geo.attributes.position.array;
  const N = geo.attributes.position.count;

  // 1. 找出"任何一个表情会动到"的顶点，作为稀疏索引表
  //    ⚠️ 这里**不能 break** —— 每个 shape 动的是不同的顶点群
  //    （jawOpen 动下颌、eyeBlink 动眼球和眼睑、brow 动眉毛）。
  //    只要发现某个 shape 动了就跳出，会把后面的形状全漏掉，
  //    结果稀疏表只覆盖第一个 shape 的顶点（实测只剩 11 个）。
  const moving = new Uint8Array(N);
  for (const s of SHAPES) {
    const d = shapes[s];
    for (let vi = 0; vi < N; vi++) {
      if (d[vi * 3] || d[vi * 3 + 1] || d[vi * 3 + 2]) moving[vi] = 1;
    }
  }

  const indices = [];
  const slotOf = new Int32Array(N).fill(-1);
  for (let vi = 0; vi < N; vi++) {
    if (moving[vi]) {
      slotOf[vi] = indices.length;
      indices.push([0, vi]);   // meshCount=1，所有顶点都在第 0 个 mesh
    }
  }
  if (!indices.length) return null;

  // 2. 每个 shape 只保留自己真正动到的那些顶点，并按 indices 顺序排列
  //    数值用定点整数存（位移量很小，1e-5 精度足够），能比裸浮点小一半以上。
  //    反量化在 morphology 侧做：delta = raw * 1e-5
  const Q = 1e-5;
  const deltas = {};
  const shapeSlots = {};
  for (const s of SHAPES) {
    const d = shapes[s];
    const tri = [];
    const slots = [];
    for (let vi = 0; vi < N; vi++) {
      const slot = slotOf[vi];
      if (slot < 0) continue;
      const dx = d[vi * 3], dy = d[vi * 3 + 1], dz = d[vi * 3 + 2];
      if (!dx && !dy && !dz) continue;    // 全 0 的三元组不存
      tri.push(Math.round(dx / Q), Math.round(dy / Q), Math.round(dz / Q));
      slots.push(slot);
    }
    deltas[s] = tri;
    shapeSlots[s] = slots;
  }

  void pos;
  return { version: 3, quant: Q, meshCount: 1, shapes: SHAPES, indices, shapeSlots, deltas };
}

// ===========================================================================
// main
// ===========================================================================

const args = process.argv.slice(2);
if (!args.length || args[0] === '--list') {
  console.log('可用的写实预设：');
  for (const [k, v] of Object.entries(PRESETS)) {
    console.log(`  ${k.padEnd(20)} ${v.label}  ${v.height}m / ${v.headsTall} 头身` +
                (v.lod ? `  [低模 lod ${v.lod}]` : '') + (v.style ? `  [${v.style}]` : ''));
  }
  process.exit(0);
}

fs.mkdirSync('assets/models2', { recursive: true });

for (const which of args) {
  const char = await buildCharacter(which);
  console.log('角色 ' + which + '（' + char.preset.label + '）：');
  console.log('  顶点 ' + char.geo.attributes.position.count +
              '  / 三角面 ' + (char.geo.index.count / 3));
  console.log('  骨骼 ' + char.skel.order.length + ' 根 / blendshape ' + SHAPES.length + ' 个');
  console.log('  身高 ' + char.preset.height + 'm  ' + char.preset.headsTall + ' 头身  头高 ' +
              (char.skel.headH * 100).toFixed(1) + 'cm');

  const outFile = 'assets/models2/' + which + '.glb';
  const bytes = await exportScene(char, outFile);

  // 稀疏 morph 单独出一个 json（格式和 autorig 完全一致）
  const sparse = extractSparseMorphs(char);
  let morphKB = 0;
  if (sparse) {
    const json = JSON.stringify(sparse);
    fs.writeFileSync('assets/models2/' + which + '.morph.json', json);
    morphKB = json.length / 1024;
    const moved = sparse.indices.length;
    console.log('  稀疏表情：' + moved + ' 个顶点（占 ' +
                (moved / char.geo.attributes.position.count * 100).toFixed(0) + '%）');
  }

  console.log('  ✓ ' + outFile + '  (' + (bytes / 1024).toFixed(0) + 'KB)' +
              (morphKB ? ' + morph (' + morphKB.toFixed(0) + 'KB)' : ''));
  console.log('    合计 ' + ((bytes + morphKB * 1024) / 1024).toFixed(0) + 'KB');
}
