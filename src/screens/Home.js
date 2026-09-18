// 主界面：3D 互动舞台 + 养成面板
// ---------------------------------------------------------------------------
// 触摸判定用的是「分区」而不是射线检测：舞台上半部分算头部（摸头），下部算身体（戳）。
// 射线检测精度更高，但依赖平台触摸事件细节，分区方案在 iOS / Android / Web 上表现一致，
// 也更好调。想要更精细的区域，改 HEAD_ZONE 即可。

import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput,
  Platform, ActivityIndicator, Alert, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Avatar3D from '../components/Avatar3D';
import VoiceMic from '../components/VoiceMic';
import { useVoice } from '../useVoice';
import { GlassCard, PrimaryButton, StatBar, BottomSheet, shadeColor } from '../components/ui';
import { getPersona, pick, GIFTS, UI, levelFromAffection, LEVEL_TITLES, affectionToNext } from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';

const HEAD_ZONE = 0.44;   // 舞台顶部 44% 视为头部
const PET_COOLDOWN = 190; // ms，滑动抚摸的最小间隔
const PET_DIST = 16;      // px，滑动多少距离算一次抚摸

const { width: SW } = Dimensions.get('window');

export default function Home({ personaId, onChat, onSettings, comeback }) {
  const snap = useStore();
  const persona = useMemo(() => getPersona(personaId), [personaId]);

  const avatarRef = useRef(null);
  const touchRef = useRef({ x: 0, y: 0, t: 0, active: false, moved: false });

  const [bubble, setBubble] = useState('');
  const [glFailed, setGlFailed] = useState(false);
  const [sheet, setSheet] = useState(null); // 'gift' | 'memory' | null
  const [memText, setMemText] = useState('');
  const [floaters, setFloaters] = useState([]); // "+5 亲密" 飘字

  const voice = useVoice({
    personaId,
    snap,
    history: snap.history || [],
    kidMode: !!snap.config?.kidMode,
    lang: snap.config?.spokenLang || 'auto',
  });

  // 三个 Key 里有一个能通就能说话。没有的话 UI 要明说原因，而不是让用户对着按钮干点。
  const voiceCfgReady = useMemo(() => {
    const v = snap.config?.voice || {};
    return !!(v.openaiKey || (v.azureKey && v.azureRegion) || v.elevenKey);
  }, [snap.config]);

  const level = levelFromAffection(snap.affection);
  const levelTitle = LEVEL_TITLES[level - 1] || '陌生';
  const nextInfo = affectionToNext(snap.affection);

  // 进场：打招呼 / 久别重逢
  useEffect(() => {
    const t = setTimeout(() => {
      if (comeback?.isLongAbsence) setBubble(pick(persona.voice.lowMood));
      else setBubble(persona.greet);
    }, 350);
    return () => clearTimeout(t);
  }, [personaId]);

  // 闲聊：长时间没互动她会自己开口
  useEffect(() => {
    const iv = setInterval(() => {
      if (Date.now() - touchRef.current.t < 25000) return;
      setBubble(pick(persona.voice.idle));
    }, 26000);
    return () => clearInterval(iv);
  }, [personaId]);

  // 升级演出
  const prevLevel = useRef(level);
  useEffect(() => {
    if (level > prevLevel.current) {
      avatarRef.current?.react('levelup');
      setBubble(pick(persona.voice.levelUp));
      pushFloater(`升级！${LEVEL_TITLES[level - 1]}`, persona.colors.primary);
    }
    prevLevel.current = level;
  }, [level]);

  const pushFloater = (text, color) => {
    const id = Date.now() + Math.random();
    setFloaters((f) => [...f, { id, text, color }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 1400);
  };

  const haptic = (style) => {
    if (Platform.OS === 'web') return;
    try {
      Haptics.impactAsync(style || Haptics.ImpactFeedbackStyle.Light);
    } catch (_) {}
  };

  const doReaction = (kind, intensity = 1) => {
    avatarRef.current?.react(kind === 'pet' ? 'pet' : 'poke');
    haptic(kind === 'pet' ? Haptics.ImpactFeedbackStyle.Soft : Haptics.ImpactFeedbackStyle.Rigid);

    if (kind === 'pet') {
      const r = S.pet(intensity);
      if (!r.ok) {
        setBubble(r.line);
        pushFloater('精力不足', '#B9A0B4');
        return;
      }
      pushFloater(`+${Math.round(r.gain)} 亲密 💕`, persona.colors.primary);
      if (Math.random() < 0.38) setBubble(pick(persona.voice.pet));
    } else {
      const r = S.poke();
      setBubble(r.line);
    }
  };

  // --- 触摸分区处理 ---------------------------------------------------------
  const onGrant = (e) => {
    touchRef.current.active = true;
    const { locationX, locationY, target } = e.nativeEvent;
    const w = layout.w || SW;
    const h = layout.h || SW;
    const nx = ((locationX ?? 0) / w) * 2 - 1;
    const ny = ((locationY ?? 0) / h) * 2 - 1;
    avatarRef.current?.setLookTarget(nx, -ny);

    const isHead = (locationY ?? 0) < h * HEAD_ZONE;
    touchRef.current.x = locationX ?? 0;
    touchRef.current.y = locationY ?? 0;
    touchRef.current.t = Date.now();
    touchRef.current.moved = false;
    doReaction(isHead ? 'pet' : 'poke', 1);
  };

  const onMove = (e) => {
    if (!touchRef.current.active) return;
    const { locationX, locationY } = e.nativeEvent;
    const w = layout.w || SW;
    const h = layout.h || SW;
    avatarRef.current?.setLookTarget(((locationX ?? 0) / w) * 2 - 1, -(((locationY ?? 0) / h) * 2 - 1));

    const dx = (locationX ?? 0) - touchRef.current.x;
    const dy = (locationY ?? 0) - touchRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const now = Date.now();

    if (dist > PET_DIST && now - touchRef.current.t > PET_COOLDOWN) {
      touchRef.current.x = locationX ?? 0;
      touchRef.current.y = locationY ?? 0;
      touchRef.current.t = now;
      touchRef.current.moved = true;
      doReaction('pet', Math.min(1.6, 0.7 + dist / 90));
    }
  };

  const onRelease = () => {
    touchRef.current.active = false;
    avatarRef.current?.setLookTarget(0, 0);
  };

  // --- 其他动作 -------------------------------------------------------------
  const onGift = (gift) => {
    const r = S.sendGift(gift.id);
    if (!r.ok) {
      Alert.alert('金币不够', `还差一点点，多陪她说说话就有啦。`);
      return;
    }
    avatarRef.current?.react('gift');
    haptic(Haptics.ImpactFeedbackStyle.Heavy);
    setBubble(r.line);
    pushFloater(`+${gift.affection} 亲密 🎁`, persona.colors.deep);
    setSheet(null);
  };

  const onCheckIn = () => {
    const r = S.dailyCheckIn();
    if (!r.ok) {
      setBubble('今天已经领过啦，明天再来。');
      return;
    }
    pushFloater(`+${r.coins} 金币 🪙`, '#E0A22C');
    setBubble('今天的份。别省着花。');
  };

  const addMemory = () => {
    const r = S.remember(memText);
    if (r.ok) {
      setMemText('');
      pushFloater('记住了 📝', persona.colors.primary);
    }
  };

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[...persona.colors.gradient, '#FFFFFF']}
        locations={[0, 0.34, 0.72, 1]}
        style={StyleSheet.absoluteFill}
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 顶栏 */}
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hi}>{persona.name}</Text>
            <Text style={styles.hiSub}>
              {persona.role} · LV.{level} {levelTitle} · 第 {snap.days} 天
            </Text>
          </View>
          <Pressable style={styles.coinBadge} onPress={onCheckIn}>
            <Text style={styles.coinText}>🪙 {snap.coins}</Text>
          </Pressable>
          <Pressable style={styles.gear} onPress={onSettings}>
            <Text style={styles.gearText}>⚙️</Text>
          </Pressable>
        </View>

        {/* 3D 舞台 */}
        <View
          style={styles.stage}
          onLayout={(e) => {
            layout.w = e.nativeEvent.layout.width;
            layout.h = e.nativeEvent.layout.height;
          }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={onRelease}
        >
          {glFailed ? (
            <View style={styles.fallback}>
              <Text style={styles.fallbackEmoji}>{persona.emoji}</Text>
              <Text style={styles.fallbackNote}>当前设备不支持 WebGL2，已降级显示</Text>
            </View>
          ) : (
            <Avatar3D ref={avatarRef} personaId={personaId} onError={() => setGlFailed(true)} />
          )}

          {/* 飘字 */}
          <View style={styles.floaterLayer} pointerEvents="none">
            {floaters.map((f) => (
              <Text key={f.id} style={[styles.floater, { color: f.color }]}>
                {f.text}
              </Text>
            ))}
          </View>

          <View style={styles.zoneHint} pointerEvents="none">
            <Text style={styles.zoneHintText}>上半 · 摸头　｜　下半 · 戳一下</Text>
          </View>
        </View>

        {/* 台词泡 —— 说话时优先显示角色正在念的这句 */}
        <View style={styles.bubbleWrap}>
          <GlassCard style={styles.bubble}>
            <Text style={styles.bubbleText}>
              {voice.state === 'idle' ? bubble || '…' : subtitle || bubble || '…'}
            </Text>
          </GlassCard>
        </View>

        {/* 语音对话：麦克风 + 字幕 */}
        <GlassCard style={styles.voiceCard}>
          <VoiceMic session={null} state={voice.state} level={voice.level} size={82} onPress={voice.toggle} />
          <View style={{ flex: 1, marginLeft: 14, gap: 4 }}>
            <Text style={styles.voiceTitle}>
              {voice.state === 'recording' ? '我在听，说完点一下右边的圆'
                : voice.state === 'thinking' ? '在想…'
                  : voice.state === 'speaking' ? '开口就能打断我'
                    : '按一下，像打电话那样说话'}
            </Text>
            {voice.error ? (
              <Text style={styles.voiceErr} numberOfLines={2}>{voice.error}</Text>
            ) : (
              <Text style={styles.voiceHint} numberOfLines={2}>
                {voiceCfgReady
                  ? '支持粤语 · 普通话 · 英语　·　会笑会唱歌会查资料'
                  : '还没配语音 Key —— 去右上角齿轮里填，就能开口说话'}
              </Text>
            )}
          </View>
          {(voice.state === 'speaking' || voice.state === 'thinking') && (
            <Pressable onPress={voice.cancel} style={styles.stopBtn}>
              <Text style={styles.stopBtnText}>停止</Text>
            </Pressable>
          )}
        </GlassCard>

        {/* 养成面板 */}
        <GlassCard style={styles.panel}>
          <StatBar
            emoji="💞"
            label="亲密"
            value={nextInfo.pct * 100}
            color={persona.colors.primary}
            right={level >= LEVEL_TITLES.length ? 'MAX' : `LV.${level} → ${Math.ceil(nextInfo.need)}`}
          />
          <StatBar emoji="🌤" label="心情" value={snap.mood} color={persona.colors.deep} right={`${Math.round(snap.mood)}%`} />
          <StatBar emoji="⚡️" label="精力" value={snap.energy} color="#F0A32E" right={`${Math.round(snap.energy)}%`} />
          <Text style={styles.panelNote}>
            离开太久她会想你、心情会掉 —— 常回来看看。精力会随时间自动恢复。
          </Text>
        </GlassCard>

        {/* 动作 */}
        <View style={styles.actions}>
          <PrimaryButton title="聊天" icon="💬" color={persona.colors.primary} onPress={onChat} />
          <PrimaryButton title="礼物" icon="🎁" color="#7A5FCC" onPress={() => setSheet('gift')} />
        </View>
        <View style={styles.actions}>
          <PrimaryButton title="签到" icon="✅" color="#3FA372" onPress={onCheckIn} compact />
          <PrimaryButton title="她的记忆" icon="📓" color="#5A6B8C" onPress={() => setSheet('memory')} compact />
        </View>

        <Text style={styles.footNote}>
          摸 {snap.totalPets} 次　·　聊 {snap.totalChats} 轮
        </Text>
        <View style={{ height: 30 }} />
      </ScrollView>

      {/* 礼物 */}
      <BottomSheet visible={sheet === 'gift'} onClose={() => setSheet(null)} title={`送 ${persona.name} 礼物　🪙 ${snap.coins}`}>
        <View style={styles.giftGrid}>
          {GIFTS.map((g) => {
            const afford = snap.coins >= g.price;
            const owned = snap.giftCount[g.id] || 0;
            return (
              <Pressable
                key={g.id}
                onPress={() => onGift(g)}
                style={[styles.giftCard, !afford && { opacity: 0.45 }]}
              >
                <Text style={styles.giftEmoji}>{g.emoji}</Text>
                <Text style={styles.giftName}>{g.name}</Text>
                <Text style={styles.giftMeta}>🪙 {g.price}</Text>
                <Text style={styles.giftMeta}>+{g.affection} 亲密</Text>
                {!!owned && <Text style={styles.giftOwned}>已送 {owned}</Text>}
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.sheetNote}>金币来源：抚摸 +1、每聊一轮 +2、每日签到 +25。</Text>
      </BottomSheet>

      {/* 记忆 */}
      <BottomSheet visible={sheet === 'memory'} onClose={() => setSheet(null)} title={`${persona.name}记得的事`}>
        {snap.memory.length === 0 ? (
          <Text style={styles.sheetNote}>还没有。聊天时告诉她你的喜好，或直接写一条。</Text>
        ) : (
          snap.memory.slice().reverse().map((m) => (
            <View key={m.ts} style={styles.memRow}>
              <Text style={styles.memText}>· {m.text}</Text>
              <Pressable onPress={() => S.forgetMemory(m.ts)}>
                <Text style={styles.memDel}>删除</Text>
              </Pressable>
            </View>
          ))
        )}
        <View style={styles.memInputRow}>
          <TextInput
            style={styles.memInput}
            value={memText}
            onChangeText={setMemText}
            placeholder="例：喜欢喝美式，不加糖"
            placeholderTextColor="#B6A9B8"
          />
          <Pressable style={styles.memAdd} onPress={addMemory}>
            <Text style={styles.memAddText}>记下</Text>
          </Pressable>
        </View>
        <Text style={styles.sheetNote}>这些条目会被拼进 system prompt，她会一直记得。</Text>
      </BottomSheet>
    </View>
  );
}

// 舞台尺寸缓存（不想为此触发重渲染，所以放模块级）
const layout = { w: 0, h: 0 };

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 18, paddingTop: 44 },

  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  hi: { fontSize: 22, fontWeight: '800', color: '#3A2C3D' },
  hiSub: { fontSize: 12.5, color: 'rgba(58,44,61,0.6)', marginTop: 3, fontWeight: '600' },
  coinBadge: {
    backgroundColor: 'rgba(255,255,255,0.82)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  coinText: { fontSize: 13, fontWeight: '800', color: '#8A6A2E' },
  gear: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.82)',
    alignItems: 'center', justifyContent: 'center',
  },
  gearText: { fontSize: 17 },

  stage: {
    height: Math.min(SW * 1.18, 430),
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  fallbackEmoji: { fontSize: 76 },
  fallbackNote: { fontSize: 12, color: UI.textDim },

  floaterLayer: { position: 'absolute', left: 0, right: 0, top: '18%', alignItems: 'center', gap: 6 },
  floater: {
    fontSize: 16,
    fontWeight: '800',
    textShadowColor: 'rgba(255,255,255,0.9)',
    textShadowRadius: 8,
  },
  zoneHint: { position: 'absolute', bottom: 10, left: 0, right: 0, alignItems: 'center' },
  zoneHintText: { fontSize: 11.5, color: 'rgba(58,44,61,0.45)', fontWeight: '600' },

  bubbleWrap: { marginTop: 12 },
  bubble: { paddingVertical: 13, paddingHorizontal: 16 },
  bubbleText: { fontSize: 14.5, lineHeight: 22, color: UI.text },

  voiceCard: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  voiceTitle: { fontSize: 13.5, fontWeight: '700', color: UI.text },
  voiceHint: { fontSize: 11.5, color: UI.textDim, lineHeight: 16 },
  voiceErr: { fontSize: 11.5, color: '#C0392B', lineHeight: 16 },
  stopBtn: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  stopBtnText: { fontSize: 12, fontWeight: '700', color: UI.textDim },

  panel: { marginTop: 14 },
  panelNote: { fontSize: 11.5, color: UI.textDim, lineHeight: 18, marginTop: 4 },

  actions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  footNote: { textAlign: 'center', fontSize: 12, color: UI.textDim, marginTop: 14 },

  giftGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  giftCard: {
    width: (SW - 36 - 12 - 36) / 2,
    backgroundColor: '#F7F3F7',
    borderRadius: 18,
    padding: 14,
    alignItems: 'center',
    gap: 3,
  },
  giftEmoji: { fontSize: 32 },
  giftName: { fontSize: 13.5, fontWeight: '800', color: UI.text },
  giftMeta: { fontSize: 11.5, color: UI.textDim, fontWeight: '600' },
  giftOwned: { fontSize: 11, color: '#3FA372', fontWeight: '700', marginTop: 2 },

  sheetNote: { fontSize: 12, color: UI.textDim, lineHeight: 19, marginTop: 12, marginBottom: 6 },
  memRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#F1ECF1',
  },
  memText: { fontSize: 13.5, color: UI.text, flex: 1 },
  memDel: { fontSize: 12, color: '#D4648C', fontWeight: '700', paddingLeft: 10 },
  memInputRow: { flexDirection: 'row', gap: 10, marginTop: 14, marginBottom: 4 },
  memInput: {
    flex: 1,
    backgroundColor: '#F7F3F7',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: UI.text,
  },
  memAdd: {
    backgroundColor: '#3A2C3D',
    borderRadius: 14,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  memAddText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
