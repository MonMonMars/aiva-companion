// 复用 UI 件 —— 按日本 AAA（Atlus / P5）规范重写
// ---------------------------------------------------------------------------
// 三条和旧版的本质差别，改样式前先看懂：
//
//  · 面板是「实色 + 硬边 + 可选左侧强调条」，不再是 rgba(255,255,255,0.72)
//    的大面积半透明。P5 靠角度和对比度分层，不靠再叠一层玻璃。
//  · 分区用 Rule（引导线）：「一截斜切的短横杠 + 一条细线」，
//    既切了视觉区块，又给出阅读方向。
//  · 按钮/标签一律一次点击生效，拉丁文本全大写 + 字距拉开。
//
// ⚠️ RN 没有 clip-path，做斜切只能靠 transform: skewX。
//    所以 skew 只作用在「装饰用的短横杠」上，绝不作用在文字上——
//    文字被 skew 会糊，而且我没法用眼睛验收（截图我看不了）。
import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal, ScrollView, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { UI } from '../theme';

// ── 面板 ─────────────────────────────────────────────────────────────────
// accentBar: 左侧 3px 强调条（用于「当前选中 / 需要注意」）
export function Panel({ children, style, solid, accentBar }) {
  return (
    <View style={[styles.panel, solid && styles.panelSolid, accentBar && styles.panelAccent, style]}>
      {children}
    </View>
  );
}
// 旧名兼容：4 个老屏幕还在 import GlassCard
export const GlassCard = Panel;

export const Pill = ({ children }) => <View style={styles.pill}>{children}</View>;

// ── 引导线：短横杠 + 细线 ────────────────────────────────────────────────
export function Rule({ color = UI.rule, accent = true, barColor = UI.accent, style }) {
  return (
    <View style={[styles.ruleRow, style]}>
      {!!accent && <View style={[styles.ruleBar, { backgroundColor: barColor }]} />}
      <View style={[styles.ruleLine, { backgroundColor: color }]} />
    </View>
  );
}

// ── 全大写小标（P5 的 "kicker"）─────────────────────────────────────────
export function Kicker({ children, color = UI.accent, style }) {
  return <Text style={[styles.kicker, { color }, style]}>{String(children).toUpperCase()}</Text>;
}

// ── 分区头：kicker + 标题 + 右侧元信息 + 引导线 ──────────────────────────
export function SectionHead({ kicker, title, meta, rule = true }) {
  return (
    <View style={styles.secHead}>
      {!!kicker && <Kicker>{kicker}</Kicker>}
      <View style={styles.secRow}>
        <Text style={styles.secTitle}>{title}</Text>
        {!!meta && <Text style={styles.secMeta}>{meta}</Text>}
      </View>
      {!!rule && <Rule />}
    </View>
  );
}

// ── 主按钮：一次点击生效，按下给位移（不只是缩放）─────────────────────────
export function ActionButton({ title, onPress, color, disabled, icon, compact, outline }) {
  const c = color || UI.accent;
  const inner = (
    <>
      {!!icon && <Text style={styles.btnIcon}>{icon}</Text>}
      <Text style={[styles.btnText, outline && { color: c }]}>{title}</Text>
    </>
  );
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.btnWrap,
        disabled && { opacity: 0.38 },
        pressed && !disabled && styles.btnPressed,
      ]}
    >
      {outline ? (
        <View style={[styles.btn, compact && styles.btnCompact, { borderWidth: 1, borderColor: c }]}>
          {inner}
        </View>
      ) : (
        <LinearGradient
          colors={[c, shadeColor(c, -20)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.btn, compact && styles.btnCompact]}
        >
          {inner}
        </LinearGradient>
      )}
    </Pressable>
  );
}
// 旧名兼容
export const PrimaryButton = ActionButton;

// ── 状态片：语义色全局唯一，用 tone 取色，不传裸色值 ──────────────────────
export function StatusChip({ children, tone = 'locked', style }) {
  const c =
    tone === 'ok' ? UI.ok
      : tone === 'warn' ? UI.warn
        : tone === 'danger' ? UI.danger
          : tone === 'accent' ? UI.accent
            : UI.locked;
  return (
    <View style={[styles.chip, { borderColor: c }, style]}>
      <View style={[styles.chipBar, { backgroundColor: c }]} />
      <Text style={[styles.chipText, { color: c }]}>{children}</Text>
    </View>
  );
}

export function StatBar({ label, value, max = 100, color, right, emoji }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const c = color || UI.accent;
  return (
    <View style={styles.statRow}>
      <View style={styles.statHead}>
        <Text style={styles.statLabel}>{emoji ? `${emoji} ` : ''}{label}</Text>
        <Text style={styles.statValue}>{right ?? `${Math.round(value)} / ${max}`}</Text>
      </View>
      {/* 轨道用"填充色的 12% 浓度"，而不是固定的白色半透明 ——
          白线在深色面板上会亮过填充本身，喧宾夺主（见 withAlpha 的注释）。 */}
      <View style={[styles.track, { backgroundColor: withAlpha(c, 0.13) }]}>
        <LinearGradient
          colors={[shadeColor(c, 18), c]}
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

/**
 * 把一个可能写死的十六进制色变成"指定透明度"的 rgba。
 * 只认 #RGB / #RRGGBB，其它形式（已经是 rgba / 颜色名 / undefined）原样返回 ——
 * 这样调用方可以无脑传 persona.colors.primary，碰到脏值也不会把样式写坏。
 *
 * 为什么要它：这条分隔线原本写的是 'rgba(255,255,255,0.12)'（纯白 12%），
 * 在 #14151F 的深色面板上等于把亮度抬到 1.2 倍，于是不管本来的强调色是什么，
 * 看上去都是一条白色横杠 —— 每条 StatBar 底下都拖着一条，很脏。
 */
function withAlpha(hex, a) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

const styles = StyleSheet.create({
  // 面板：实色 + 硬边，圆角只给 3px
  panel: {
    backgroundColor: UI.surface,
    borderRadius: UI.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  panelSolid: { backgroundColor: UI.surfaceHi },
  panelAccent: { borderLeftWidth: 3, borderLeftColor: UI.accent },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    backgroundColor: UI.surfaceHi,
  },

  // 引导线
  ruleRow: { flexDirection: 'row', alignItems: 'center', height: 10, gap: 7 },
  ruleBar: { width: 30, height: 3, transform: [{ skewX: '-20deg' }] },
  ruleLine: { flex: 1, height: 1 },

  kicker: { fontSize: 10.5, letterSpacing: 3.2, fontWeight: '800' },

  secHead: { marginBottom: 10 },
  secRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  secTitle: { fontSize: 17, fontWeight: '800', color: UI.text, letterSpacing: 0.2, flexShrink: 1 },
  secMeta: { fontSize: 11.5, fontWeight: '700', color: UI.textDim, flexShrink: 0 },

  btnWrap: { borderRadius: UI.radius, overflow: 'hidden' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderRadius: UI.radius,
    gap: 8,
  },
  btnCompact: { paddingVertical: 9, paddingHorizontal: 14 },
  btnPressed: { transform: [{ scale: 0.97 }, { translateY: 1 }] },
  btnIcon: { fontSize: 15 },
  btnText: { color: '#fff', fontSize: 14.5, fontWeight: '800', letterSpacing: 0.8 },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: UI.radius,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  chipBar: { width: 3, height: 10, transform: [{ skewX: '-18deg' }] },
  chipText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },

  statRow: { marginBottom: 12 },
  statHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 },
  statLabel: { fontSize: 11, color: UI.textDim, fontWeight: '700', letterSpacing: 0.6 },
  statValue: { fontSize: 11, color: UI.textMid, fontWeight: '800' },
  track: {
    height: 6,
    borderRadius: 1,
    // 具体的底色由 StatBar 按「填充色的低浓度版」内联给（见 withAlpha）。
    // 这里只留一个兜底，避免有人单独引用 styles.track 时没有背景。
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  fill: { height: '100%' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)' },
  sheet: {
    backgroundColor: UI.surface,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderTopWidth: 2,
    borderTopColor: UI.accent,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: Platform.select({ ios: 34, default: 20 }),
    maxHeight: '76%',
  },
  sheetGrip: {
    width: 46,
    height: 3,
    backgroundColor: UI.accent,
    transform: [{ skewX: '-20deg' }],
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: UI.text, marginBottom: 12, letterSpacing: 0.2 },
  sheetBody: { flexGrow: 0 },

  empty: { alignItems: 'center', paddingVertical: 34, gap: 8 },
  emptyEmoji: { fontSize: 34 },
  emptyText: { fontSize: 13, color: UI.textDim },
});
