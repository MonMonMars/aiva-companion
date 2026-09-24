// 圆形进度条 —— Web 版
// ---------------------------------------------------------------------------
// 为什么这里是裸 <svg>/<path> 而不是 RN 组件：这是 .web.js，
// 只有 web 打包会选它，而 web 上 React DOM 会把小写标签原样渲染成真 SVG 元素。
// 于是进度弧是**真的弧**（抗锯齿、任意角度、端点圆头），
// 不用像原生端那样拿一圈小刻度去凑（见 ProgressRing.js）。
//
// 360° 一个 path 画不出来（起点终点重合会让浏览器认为弧长为 0），
// 所以满圈时拆成两段半圆。

import React from 'react';

/**
 * 从 12 点方向顺时针画到 progress 比例的弧。
 * @param {number} cx 圆心 x
 * @param {number} cy 圆心 y
 * @param {number} r  半径
 * @param {number} p  进度 0~1
 */
function arcPath(cx, cy, r, p) {
  if (p <= 0) return '';
  if (p >= 1) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`;
  }
  // -90° = 12 点方向；sweep=1 顺时针
  const a = -Math.PI / 2 + p * Math.PI * 2;
  const x = cx + r * Math.cos(a);
  const y = cy + r * Math.sin(a);
  return `M ${cx} ${cy - r} A ${r} ${r} 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

export default function ProgressRing({
  size = 30,
  stroke = 3,
  progress = 0,
  color = '#FF2B4E',
  track = 'rgba(255,255,255,0.20)',
}) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const c = size / 2;
  const r = (size - stroke) / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block' }}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {p > 0 && (
        <path
          d={arcPath(c, c, r, p)}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
