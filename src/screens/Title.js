// 标题页 —— 启动 + 载入，独占一屏
// ---------------------------------------------------------------------------
// 为什么单独做一屏：之前一进 App 就直接甩出角色列表，用户还没反应过来
// 就要做选择；而且 store 读存档的那一下是空的，会闪。现在这一屏把"等"变成
// 有内容可看的一屏，顺便把品牌名字立住。
//
// 行为：
//   · 载入中：进度条爬到 72% 就停在那儿（真进度拿不到，假进度别走满，
//     走满了却还没进会更像卡死）
//   · store 就绪：补满 100%，出现"进入"，1.7s 后自动进下一屏
//   · 就绪后点屏幕任意处 = 立刻进，不用等

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Animated, Easing, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { UI } from '../theme';

const { width: SW } = Dimensions.get('window');

export default function Title({ ready, onEnter }) {
  const fade = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(18)).current;
  const prog = useRef(new Animated.Value(0)).current;
  const [canEnter, setCanEnter] = useState(false);

  // 回调放进 ref：不然每次父组件重渲染都会重置"自动进入"的定时器
  const enterRef = useRef(onEnter);
  enterRef.current = onEnter;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    Animated.timing(prog, {
      toValue: 0.72,
      duration: 1100,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // 进度条动的是宽度，原生驱动不支持
    }).start();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t1 = setTimeout(() => {
      Animated.timing(prog, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
      setCanEnter(true);
    }, 200);
    // 2.2s：够看清标题，又不至于让人等。真要快进，点一下屏幕就行
    const t2 = setTimeout(() => enterRef.current?.(), 2200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ready]);

  const barW = prog.interpolate({ inputRange: [0, 1], outputRange: ['8%', '100%'] });

  return (
    <Pressable
      style={styles.root}
      onPress={() => { if (canEnter) enterRef.current?.(); }}
      android_disableSound
    >
      <LinearGradient
        colors={['#0A0B10', '#171526', '#2A1B33', '#3A2140']}
        locations={[0, 0.42, 0.74, 1]}
        style={StyleSheet.absoluteFill}
      />
      {/* 中间一团柔光，别让纯色渐变压得太扁 */}
      <LinearGradient
        colors={['rgba(255,43,78,0.30)', 'rgba(255,43,78,0)']}
        locations={[0, 1]}
        style={styles.glow}
        pointerEvents="none"
      />

      <Animated.View style={[styles.center, { opacity: fade, transform: [{ translateY: lift }] }]}>
        <Text style={styles.mark}>◈</Text>
        <Text style={styles.brand}>AIVA</Text>
        <View style={styles.ruleRow}>
          <View style={styles.ruleBar} />
          <View style={styles.ruleLine} />
        </View>
        <Text style={styles.kicker}>AI COMPANION</Text>
        <Text style={styles.sub}>你的 3D 粤语 AI 伙伴</Text>
      </Animated.View>

      <View style={styles.foot}>
        <View style={styles.track}>
          <Animated.View style={[styles.fill, { width: barW }]} />
        </View>
        <Text style={styles.footText}>
          {ready ? (canEnter ? '点一下进入' : '正在唤醒她…') : '正在读取存档…'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    left: 0, right: 0, top: '18%', height: '46%',
  },
  center: { alignItems: 'center', paddingHorizontal: 28 },

  mark: { fontSize: 34, color: UI.accent, marginBottom: 6 },
  brand: {
    fontSize: 54,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 10,
    textShadowColor: 'rgba(255,43,78,0.55)',
    textShadowRadius: 22,
  },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, width: SW * 0.52 },
  ruleBar: { width: 34, height: 3, backgroundColor: UI.accent, transform: [{ skewX: '-20deg' }] },
  ruleLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.28)' },

  kicker: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 5,
    color: 'rgba(255,255,255,0.72)',
    marginTop: 14,
  },
  sub: { fontSize: 13.5, color: UI.textDim, marginTop: 8, letterSpacing: 1.2 },

  foot: { position: 'absolute', bottom: 52, left: 30, right: 30, alignItems: 'center', gap: 12 },
  track: {
    width: '62%',
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: UI.accent },
  footText: { fontSize: 11.5, color: UI.textDim, letterSpacing: 1.6, fontWeight: '600' },
});
