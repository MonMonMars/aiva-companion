// 麦克风按钮 —— 交互照着 ChatGPT 高级语音模式那一套来的
// ---------------------------------------------------------------------------
// 状态机：idle → recording(录音中) → thinking(在想) → speaking(在说)
// 说话中点一下 = 打断；录音中点一下 = 发送。别让用户多一个按钮要理解。

import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated, Easing } from 'react-native';
import * as Haptics from 'expo-haptics';
import { UI } from '../theme';

const STATE_META = {
  idle: { ring: '#C9A9BD', core: '#FFFFFF', label: '点一下说话', icon: '🎙️' },
  recording: { ring: '#FF6F9C', core: '#FFE3EE', label: '正在听… 点一下发送', icon: '⬛' },
  thinking: { ring: '#B79BC9', core: '#F3ECF8', label: '在想…', icon: '✳️' },
  speaking: { ring: '#8FC8E8', core: '#E4F2FB', label: '点一下打断', icon: '⏸️' },
};

export default function VoiceMic({ session, state, level, onPress, disabled, size = 96 }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const ring = STATE_META[state] || STATE_META.idle;
  const isActive = state === 'recording' || state === 'speaking';

  useEffect(() => {
    let anim;
    if (isActive) {
      anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1 + Math.min(0.35, (level || 0) * 0.5),
            duration: 220,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 260,
            easing: Easing.in(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
    } else {
      pulse.setValue(1);
    }
    return () => anim?.stop();
  }, [isActive, level]);

  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 3,
          borderColor: ring.ring,
          backgroundColor: ring.core,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ scale: pulse }],
          shadowColor: ring.ring,
          shadowOpacity: isActive ? 0.55 : 0.25,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 6 },
        }}
      >
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onPress?.();
          }}
          disabled={disabled}
          style={({ pressed }) => ({
            width: size - 6,
            height: size - 6,
            borderRadius: (size - 6) / 2,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontSize: size * 0.32 }}>{ring.icon}</Text>
        </Pressable>
      </Animated.View>
      <Text style={{ color: UI.textDim, fontSize: 13, fontWeight: '600' }}>{ring.label}</Text>
    </View>
  );
}
