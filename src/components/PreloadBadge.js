// 角落里那个小小的圆形进度器
// ---------------------------------------------------------------------------
// 需求："一个很小的圆环 + 百分比 + 一条进度条，放在屏幕上不挡事的地方"。
//
// 三条硬约束，改之前先读：
//   a) pointerEvents="none" —— 整个组件不接收任何触摸。
//      它浮在最上层，少了这行就会把底下那一块（通常是输入框或卡片）的点击全吃掉，
//      而且这种"某个角落点不动"的 bug 极难归因。
//   b) 位置固定在左下角、贴着输入条上方：屏幕上唯一一块既没按钮也没文字的地方。
//   c) 跑完就淡出并从组件树上摘掉（不是留一个透明节点），
//      否则它一直在那儿，后面排查命中测试时会误导人。
//
// 进度来源只有一个：src/lib/preload.js 的队列。
// 主模型加载、后台预热、换角色时重新加载模型 —— 都会自己冒出来，不需要各处手动控制显隐。

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { preloadState, subscribePreload } from '../lib/preload';
import { UI } from '../theme';
import ProgressRing from './ProgressRing';

const RING = 30;
const BAR_W = 30;

export default function PreloadBadge() {
  const [st, setSt] = useState(preloadState);
  const [visible, setVisible] = useState(false);
  const op = useRef(new Animated.Value(0)).current;

  // 显示中的百分比：和真实进度之间做 350ms 缓动。
  // 不然 18 个任务会让它一格一格跳（每格 5.5%），看着很廉价。
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => subscribePreload(setSt), []);

  const total = st.total || 0;
  const target = total > 0 ? Math.round(((st.done || 0) / total) * 100) : 0;
  const active = total > 0 && st.phase !== 'done';

  useEffect(() => {
    let t = 0;
    if (active) {
      setVisible(true);
      Animated.timing(op, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(op, {
        toValue: 0, duration: 480, easing: Easing.out(Easing.quad), useNativeDriver: true,
      }).start();
      // 兜底：有些 webview 不触发动画回调，靠超时也要把它摘掉
      t = setTimeout(() => setVisible(false), 700);
    }
    return () => clearTimeout(t);
  }, [active, op]);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return undefined;
    let raf = 0;
    const t0 = Date.now();
    const step = () => {
      const k = Math.min(1, (Date.now() - t0) / 350);
      const v = from + (target - from) * k;
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  if (!visible) return null;

  const pct = Math.max(0, Math.min(100, Math.round(shown)));

  return (
    <Animated.View
      nativeID="aiva-preload-badge"
      style={[styles.wrap, { opacity: op }]}
      pointerEvents="none"
    >
      <View style={styles.ringBox}>
        <ProgressRing size={RING} stroke={3} progress={pct / 100} color={UI.accent} />
        {/* 数字和 % 号用嵌套 Text 排成一行，整体居中压在圆环正中；
            分成两个绝对定位的元素就得靠魔法偏移量对齐，改字号就崩。 */}
        <Text style={styles.pct} numberOfLines={1}>
          {pct}
          <Text style={styles.pctSign}>%</Text>
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: Math.max(2, (BAR_W * pct) / 100) }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 14,
    // ⚠️ 原来是 bottom:92（左下角），但"她说的话"和最近几轮对话也是 absolute bottom:92，
    //    两者会叠在一起 —— 聊天文字一长就被这个小圆环压住。
    //    改到左上角、顶栏下方：那一带只有 3D 舞台，最不碍事。
    top: 104,
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 7,
    borderRadius: 13,
    backgroundColor: 'rgba(10,12,20,0.52)',
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  ringBox: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: RING,
    lineHeight: RING,    // 行高 = 容器高 → 天然垂直居中（web / Android 都成立）
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '800',
    color: UI.text,
    letterSpacing: -0.4,
  },
  pctSign: {
    fontSize: 7,
    fontWeight: '700',
    color: UI.textDim,
    letterSpacing: 0,
  },
  barTrack: {
    width: BAR_W,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.20)',
    overflow: 'hidden',
  },
  barFill: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: UI.accent,
  },
});
