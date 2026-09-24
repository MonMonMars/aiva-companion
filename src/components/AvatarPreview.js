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

  return (
    <View style={[styles.box, { transform: [{ scale }] }]}>
      {/* 后发（在身体后面，所以先画） */}
      <Part
        color={hairDark}
        radius={14}
        style={{ left: 22, top: 30, width: 52, height: backBottom - 30 }}
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

      {/* 前发：盖住上半个头，下面露额头 */}
      <Part color={hair} radius={24} style={{ left: 23, top: 19, width: 50, height: 34 }} />
      {/* 刘海：短发/中发压低一点，长发分缝露额头 */}
      <Part
        color={hair}
        radius={10}
        style={{
          left: isLong ? 28 : 23,
          top: 40,
          width: isLong ? 40 : 50,
          height: isLong ? 10 : 16,
        }}
      />

      {/* 双马尾 */}
      {isTwinTail && (
        <>
          <Part color={hair} radius={11} style={{ left: 11, top: 38, width: 16, height: 40 }} />
          <Part color={hair} radius={11} style={{ left: 69, top: 38, width: 16, height: 40 }} />
          <Part color={hairDark} radius={5} style={{ left: 14, top: 32, width: 10, height: 10 }} />
          <Part color={hairDark} radius={5} style={{ left: 72, top: 32, width: 10, height: 10 }} />
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

      {/* 眼睛 */}
      <Part color={eyes} radius={3} style={{ left: 35, top: 48, width: 6, height: 8 }} />
      <Part color={eyes} radius={3} style={{ left: 55, top: 48, width: 6, height: 8 }} />
      {/* 眼里的高光：一小点白，人物立刻"活"了 */}
      <Part color="#FFFFFF" radius={1.5} style={{ left: 36, top: 49, width: 3, height: 3 }} />
      <Part color="#FFFFFF" radius={1.5} style={{ left: 56, top: 49, width: 3, height: 3 }} />

      {/* 腮红 */}
      <Part color={blush} radius={4} opacity={0.75} style={{ left: 29, top: 57, width: 11, height: 6 }} />
      <Part color={blush} radius={4} opacity={0.75} style={{ left: 56, top: 57, width: 11, height: 6 }} />

      {/* 嘴 */}
      <Part color="#B4726C" radius={2} style={{ left: 45, top: 61, width: 6, height: 3 }} />

      {/* 眼镜（秘书）：两条细边 + 一道横梁 */}
      {isGlasses && (
        <>
          <Part color="#3A3F4B" radius={3} style={{ left: 31, top: 45, width: 14, height: 12, borderWidth: 1.6, borderColor: '#3A3F4B', backgroundColor: 'transparent' }} />
          <Part color="#3A3F4B" radius={3} style={{ left: 51, top: 45, width: 14, height: 12, borderWidth: 1.6, borderColor: '#3A3F4B', backgroundColor: 'transparent' }} />
          <Part color="#3A3F4B" radius={1} style={{ left: 45, top: 50, width: 6, height: 1.6 }} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 96, height: 150 },
});
