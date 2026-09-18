// 复用 UI 件：玻璃卡、进度条、按钮
import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal, ScrollView, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { UI } from '../theme';

export function GlassCard({ children, style, solid }) {
  return (
    <View
      style={[
        styles.card,
        solid && { backgroundColor: UI.cardSolid },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export const Pill = ({ children }) => <View style={styles.pill}>{children}</View>;

export function PrimaryButton({ title, onPress, color = '#FF6F9C', disabled, icon, compact }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.btnWrap,
        disabled && { opacity: 0.42 },
        pressed && !disabled && { transform: [{ scale: 0.96 }] },
      ]}
    >
      <LinearGradient
        colors={[color, shadeColor(color, -18)]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.btn, compact && styles.btnCompact]}
      >
        {!!icon && <Text style={styles.btnIcon}>{icon}</Text>}
        <Text style={styles.btnText}>{title}</Text>
      </LinearGradient>
    </Pressable>
  );
}

export function StatBar({ label, value, max = 100, color, right, emoji }) {
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <View style={styles.statRow}>
      <View style={styles.statHead}>
        <Text style={styles.statLabel}>{emoji ? `${emoji} ` : ''}{label}</Text>
        <Text style={styles.statValue}>{right ?? `${Math.round(value)} / ${max}`}</Text>
      </View>
      <View style={styles.track}>
        <LinearGradient
          colors={[shadeColor(color, 22), color]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.fill, { width: `${Math.max(2, pct * 100)}%` }]}
        />
      </View>
    </View>
  );
}

export function BottomSheet({ visible, onClose, title, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetGrip} />
        <Text style={styles.sheetTitle}>{title}</Text>
        <ScrollView style={styles.sheetBody} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function Empty({ text, emoji = '🌱' }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>{emoji}</Text>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// 简单的颜色明暗调整，避免为了 tween 再引一个颜色库
export function shadeColor(hex, percent) {
  const str = String(hex).replace('#', '');
  const num = parseInt(str, 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = ((num >> 8) & 0x00ff) + amt;
  const B = (num & 0x0000ff) + amt;
  return (
    '#' +
    (0x1000000 +
      (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
      (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 +
      (B < 255 ? (B < 1 ? 0 : B) : 255)
    )
      .toString(16)
      .slice(1)
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: UI.card,
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: UI.border,
    shadowColor: UI.shadow,
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  btnWrap: { borderRadius: 16, overflow: 'hidden' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 16,
    gap: 8,
  },
  btnCompact: { paddingVertical: 10, paddingHorizontal: 14 },
  btnIcon: { fontSize: 16 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },

  statRow: { marginBottom: 12 },
  statHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  statLabel: { fontSize: 12.5, color: UI.textDim, fontWeight: '600' },
  statValue: { fontSize: 12, color: UI.textDim, fontWeight: '700' },
  track: {
    height: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.055)',
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 999 },

  overlay: { flex: 1, backgroundColor: 'rgba(40,25,40,0.28)' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: Platform.select({ ios: 34, default: 20 }),
    maxHeight: '76%',
  },
  sheetGrip: {
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#E6DCE6',
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: UI.text, marginBottom: 12 },
  sheetBody: { flexGrow: 0 },

  empty: { alignItems: 'center', paddingVertical: 34, gap: 8 },
  emptyEmoji: { fontSize: 34 },
  emptyText: { fontSize: 13, color: UI.textDim },
});
