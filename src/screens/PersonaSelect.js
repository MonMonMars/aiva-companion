// 选人格
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { PERSONAS, UI, levelFromAffection, LEVEL_TITLES } from '../theme';
import { useStore } from '../useStore';
import { selectPersona } from '../store';
import { shadeColor } from '../components/ui';

const { width } = Dimensions.get('window');

export default function PersonaSelect({ onDone }) {
  const snap = useStore();

  const choose = (id) => {
    selectPersona(id);
    onDone?.(id);
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.inner} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Text style={styles.kicker}>AI COMPANION</Text>
        <Text style={styles.title}>今天想陪在谁身边？</Text>
        <Text style={styles.sub}>人选可以随时切换，各自的感情进度互不影响。</Text>
      </View>

      {PERSONAS.map((p) => {
        const rel = snap.personaId === p.id;
        const lv = levelFromAffection(
          (typeof snap.affection === 'number' && rel) ? snap.affection : 0
        );
        return (
          <Pressable
            key={p.id}
            onPress={() => choose(p.id)}
            style={({ pressed }) => [styles.cardWrap, pressed && { transform: [{ scale: 0.985 }] }]}
          >
            <LinearGradient colors={p.colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.bigEmoji}>{p.emoji}</Text>
                <View style={styles.cardHead}>
                  <Text style={styles.name}>{p.name}</Text>
                  <Text style={styles.role}>{p.role}</Text>
                </View>
                <View style={[styles.chip, { backgroundColor: 'rgba(255,255,255,0.75)' }]}>
                  <Text style={[styles.chipText, { color: p.colors.deep }]}>
                    {rel ? LEVEL_TITLES[lv - 1] : '未开始'}
                  </Text>
                </View>
              </View>

              <Text style={styles.tagline}>{p.tagline}</Text>

              <View style={styles.cardFoot}>
                <Text style={styles.footText}>{rel ? '继续这段关系 →' : '开始相处 →'}</Text>
              </View>
            </LinearGradient>
          </Pressable>
        );
      })}

      <Text style={styles.footNote}>
        提示：所有对话数据只存在你这台设备上，不会上传。{'\n'}
        想接真实大模型，进 App 后在右上角齿轮里填 Key。
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg },
  inner: { padding: 20, paddingTop: 56, paddingBottom: 40 },
  header: { marginBottom: 22 },
  kicker: {
    fontSize: 11,
    letterSpacing: 3,
    fontWeight: '800',
    color: '#C79BB2',
    marginBottom: 8,
  },
  title: { fontSize: 27, fontWeight: '800', color: UI.text, letterSpacing: 0.2 },
  sub: { fontSize: 13.5, color: UI.textDim, marginTop: 8, lineHeight: 20 },

  cardWrap: { marginBottom: 16, borderRadius: 26, overflow: 'hidden' },
  card: { padding: 18, borderRadius: 26 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bigEmoji: { fontSize: 38 },
  cardHead: { flex: 1 },
  name: { fontSize: 21, fontWeight: '800', color: '#3A2C3D' },
  role: { fontSize: 12.5, color: 'rgba(58,44,61,0.62)', marginTop: 2, fontWeight: '600' },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  chipText: { fontSize: 11.5, fontWeight: '800' },
  tagline: {
    fontSize: 13.5,
    color: 'rgba(58,44,61,0.72)',
    lineHeight: 21,
    marginTop: 14,
    marginBottom: 14,
  },
  cardFoot: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.65)',
    paddingTop: 11,
  },
  footText: { fontSize: 13.5, fontWeight: '800', color: '#3A2C3D' },

  footNote: {
    fontSize: 12,
    color: UI.textDim,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 10,
  },
});
