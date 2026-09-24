// 圆形进度条 —— 原生端（iOS / Android）版
// ---------------------------------------------------------------------------
// 项目里没装 react-native-svg，所以原生端不能画真弧。
// 这里用一圈"刻度"拼出环形进度：24 根小竖条沿圆周排开，
// 走完多少比例就点亮多少根。视觉上是个虚线环，比没有强，
// 也不引入新依赖（web 端走 ProgressRing.web.js，那边是真弧）。
//
// 排布用的是 RN 唯一靠谱的组合：先 rotate 再 translateY，
// 于是竖条会沿着自己旋转后的"上方向"被推出去 —— 天然径向，不需要 transform-origin。

import React from 'react';
import { View } from 'react-native';

const TICKS = 24;

export default function ProgressRing({
  size = 30,
  stroke = 3,
  progress = 0,
  color = '#FF2B4E',
  track = 'rgba(255,255,255,0.20)',
}) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const r = size / 2 - stroke / 2;
  const tickW = 2;
  const tickH = stroke + 1;
  const lit = Math.round(p * TICKS);

  const ticks = [];
  for (let i = 0; i < TICKS; i++) {
    ticks.push(
      <View
        key={i}
        style={{
          position: 'absolute',
          left: (size - tickW) / 2,
          top: (size - tickH) / 2,
          width: tickW,
          height: tickH,
          borderRadius: tickW / 2,
          backgroundColor: i < lit ? color : 'transparent',
          transform: [{ rotate: `${(360 / TICKS) * i}deg` }, { translateY: -r }],
        }}
      />
    );
  }

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: stroke / 2,
          top: stroke / 2,
          width: size - stroke,
          height: size - stroke,
          borderRadius: (size - stroke) / 2,
          borderWidth: stroke,
          borderColor: track,
        }}
      />
      {ticks}
    </View>
  );
}
