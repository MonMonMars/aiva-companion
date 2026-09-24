// 角色预览图（2D 立绘风格）
// ---------------------------------------------------------------------------
// 选角页要在**不加载任何 GLB** 的前提下，让人一眼看出"这个角色长什么样"。
// 真实的 3D 模型在 assets/models2/ 里，但每个都是几百 KB 的 glb ——
// 在选角页点一张卡就拉一个模型，切换一次卡一次，移动端直接卡死。
//
// 所以这里用 persona.avatar 里**本来就有的**配色（皮肤 / 头发 / 上衣 / 下装 /
// 鞋 / 瞳色 / 腮红）和发型 style 画一个扁平小人。它不追求和 3D 一模一样，
// 但 18 个角色放在一起足够分辨：发型轮廓 + 服装配色 + 瞳色都是各自的。
//
// 只用 View，不用任何图片资源 —— web 和 native 都能跑，也不增加包体。
//
// ⚠️ 新增发型：在 theme.js 里给 persona.avatar.style 起新名字时，
//    记得来这里补一档，否则会掉到 'short-crop' 的默认轮廓上，
//    看起来就像"新角色和别人撞发型了"。
import React from 'react';
import { View, StyleSheet } from 'react-native';

// 发型分组：只影响"轮廓"，配色一律走 avatar.hair / hairDark
const LONG = new Set(['long-straight', 'long-wavy', 'glasses']);
const MEDIUM = new Set(['medium-tousled', 'short-swept']);
// 其余（short-crop / spike / twin-tail 等）走短发轮廓，另加配件

/** 单个部件：绝对定位 + 可选圆角/旋转 */
function Part({ style, color, radius, rotate, opacity }) {
  return (
    <View
      // ⚠️ 这里别用 absoluteFillObject：它会连 right/bottom 一起设成 0，
      //    再传 width/height 进去就是 left+right+width 三者打架，
      //     Yoga 在不同平台上的取舍还不一样。只给 position 就够了。
      style={[
        { position: 'absolute', backgroundColor: color, borderRadius: radius ?? 0, opacity: opacity ?? 1 },
        style,
        rotate ? { transform: [{ rotate }] } : null,
      ]}
    />
  );
}

/**
 * @param {object} props
 * @param {object} props.persona  theme.js 的 PERSONAS 条目
 * @param {number} [props.scale]  整体缩放（默认 1 → 96×150）
 */
export default function AvatarPreview({ persona, scale = 1 }) {
  const a = persona?.avatar || {};
  const skin = a.skin || '#F2D3BC';
  const hair = a.hair || '#4A3A30';
  const hairDark = a.hairDark || hair;
  const top = a.top || '#B9C4D6';
  const bottom = a.bottom || '#4A5570';
  const shoes = a.shoes || '#2A2A30';
  const eyes = a.eyes || '#3A2C24';
  const blush = a.blush || '#EFA79A';
  const style = a.style || 'short-crop';

  const isLong = LONG.has(style);
  const isMedium = MEDIUM.has(style);
  const isTwinTail = style === 'twin-tail';
  const isSpike = style === 'spike';
  const isGlasses = style === 'glasses';

  // 后发长度：长发拖到肩下，中发到脖子，短发只在脑后一圈
  const backBottom = isLong ? 112 : isMedium ? 78 : 66;
  const backTop = isLong ? 34 : isMedium ? 36 : 33;

  return (
    <View style={[styles.box, { transform: [{ scale }] }]}>
      {/* 后发（在身体后面，所以先画）
          ⚠️ 别让它比头更宽：头是 left 23 / width 50 / radius 25。
          后发原本 left 22 / width 52 / radius 14 —— 比头宽 2px 且圆角小一半，
          于是从头两侧各露出一小块方角（小柔的深粉"方耳朵"就是这么来的）。
          现在 left 27 / width 42，配 radius 16 收进去，只在头下缘和两肩下垂出来。 */}
      <Part
        color={hairDark}
        radius={16}
        style={{ left: 27, top: backTop, width: 42, height: backBottom - backTop }}
      />

      {/* 腿 / 下装 */}
      <Part color={bottom} radius={9} style={{ left: 35, top: 100, width: 26, height: 40 }} />
      {/* 鞋 */}
      <Part color={shoes} radius={3} style={{ left: 35, top: 138, width: 11, height: 8 }} />
      <Part color={shoes} radius={3} style={{ left: 50, top: 138, width: 11, height: 8 }} />

      {/* 上衣 */}
      <Part color={top} radius={12} style={{ left: 30, top: 68, width: 36, height: 40 }} />
      {/* 手臂：贴着身体两侧，稍微外张一点，免得像根柱子 */}
      <Part color={top} radius={6} style={{ left: 24, top: 72, width: 9, height: 30 }} />
      <Part color={top} radius={6} style={{ left: 63, top: 72, width: 9, height: 30 }} />
      {/* 颈 */}
      <Part color={skin} radius={4} style={{ left: 43, top: 62, width: 10, height: 10 }} />

      {/* 头 */}
      <Part color={skin} radius={25} style={{ left: 23, top: 21, width: 50, height: 50 }} />

      {/* 前发：盖住上半个头（不覆盖整头），下缘就是脸的上边界。
          ⚠️ 这里踩过四次坑，值得记全，全是"用矩形硬拼圆形"造成的：
             ① 原设计是 50×34 / radius 24 —— 宽 50 高 34 时 RN 把圆角
                夹到 17，它不是半圆而是个圆角方块，糊在脸上成了"粉色方脸"。
             ② 去掉刘海、高度改 39，仍是矩形，问题照旧。
             ③ 改成和头同尺寸（50×50 / radius 25）+ 48×48 开窗 —— 开窗
                只比头小 2px，等于把整颗头刷成皮肤色，粉发和双马尾全没了。
             ④ 开窗收到 40×42 后，头上白色占比依然过大：头本身是米白
                (#FFE1D2)，只在顶上留 11px 粉色发际线，远看还是一颗白球。
          现在定稿：前发就是**头上半部分**（50×30，圆角只在顶部，
          下缘平直当作发际线），脸部由头本身充当 —— 不再挖洞，
          少一层 draw 就少一次"盖错东西"的机会。
          下面五官坐标全部按"脸上可见区域 y 49→71"排。 */}
      <Part color={hair} radius={22} style={{ left: 23, top: 19, width: 50, height: 30 }} />

      {/* 双马尾：从头两侧（x 23/73 之外）垂下去，起点贴着发际线所在高度 */}
      {isTwinTail && (
        <>
          <Part color={hair} radius={11} style={{ left: 11, top: 40, width: 15, height: 42 }} />
          <Part color={hair} radius={11} style={{ left: 70, top: 40, width: 15, height: 42 }} />
          {/* 发绳：深色小结点，位置压在马尾上端 */}
          <Part color={hairDark} radius={4} style={{ left: 13, top: 37, width: 11, height: 9 }} />
          <Part color={hairDark} radius={4} style={{ left: 72, top: 37, width: 11, height: 9 }} />
        </>
      )}

      {/* 刺发：用旋转的小方块近似尖刺（RN 里画三角形要引三方库，不值得） */}
      {isSpike && (
        <>
          <Part color={hairDark} radius={2} rotate="22deg" style={{ left: 30, top: 8, width: 9, height: 14 }} />
          <Part color={hairDark} radius={2} rotate="-14deg" style={{ left: 42, top: 4, width: 9, height: 16 }} />
          <Part color={hairDark} radius={2} rotate="30deg" style={{ left: 55, top: 10, width: 9, height: 13 }} />
        </>
      )}

      {/* 五官统一排布在"脸"上：可见区域是 y 49→71、x 30→66（头是 23→73）。
          眼在 y 52、腮红 y 59、嘴 y 64，往下留出下巴。 */}
      {/* 眼睛 */}
      <Part color={eyes} radius={3} style={{ left: 36, top: 52, width: 6, height: 8 }} />
      <Part color={eyes} radius={3} style={{ left: 54, top: 52, width: 6, height: 8 }} />
      {/* 眼里的高光：一小点白，人物立刻"活"了 */}
      <Part color="#FFFFFF" radius={1.5} style={{ left: 37, top: 53, width: 3, height: 3 }} />
      <Part color="#FFFFFF" radius={1.5} style={{ left: 55, top: 53, width: 3, height: 3 }} />

      {/* 腮红：贴在脸颊两侧、在眼睛之下（嘴占 left 44→52，别撞上） */}
      <Part color={blush} radius={4} opacity={0.68} style={{ left: 30, top: 59, width: 9, height: 5 }} />
      <Part color={blush} radius={4} opacity={0.68} style={{ left: 57, top: 59, width: 9, height: 5 }} />

      {/* 嘴 */}
      <Part color="#B4726C" radius={2} style={{ left: 44, top: 64, width: 8, height: 3 }} />

      {/* 眼镜（秘书）：两条细边 + 一道横梁 */}
      {isGlasses && (
        <>
          <Part color="#3A3F4B" radius={3} style={{ left: 32, top: 49, width: 14, height: 12, borderWidth: 1.6, borderColor: '#3A3F4B', backgroundColor: 'transparent' }} />
          <Part color="#3A3F4B" radius={3} style={{ left: 50, top: 49, width: 14, height: 12, borderWidth: 1.6, borderColor: '#3A3F4B', backgroundColor: 'transparent' }} />
          <Part color="#3A3F4B" radius={1} style={{ left: 45, top: 54, width: 6, height: 1.6 }} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 96, height: 150 },
});
