// 角色选择页 —— 同时选「人」和「舞台」，首次启动和之后换人都走这一页
// ---------------------------------------------------------------------------
// 这一屏是用户做「6 个老角色 vs 4 个 FF 风 + 1 个 VTuber」对比的主战场，
// 所以刻意压暗、压中性：底色和卡片全部去色，亮度只留给「人格身份色」那条
// 4px 竖条和 3D 角色本身。这样 11 个角色放在一起才比得出来——
// 如果每张卡自带一大块彩色渐变，眼睛看到的是卡片，不是角色。
//
// 两个 tab：
//   角色 —— 按档位分组的卡片列表
//   背景 —— 9 档舞台预设，顶部有实时预览（跟着已选的人走）
// 底部常驻一条 CTA：首次是"开始相处"，之后换人是"换成 XX"。
// 选人是"单选高亮 + 底部确认"，不是"点一下立刻跳走"——
// 换人是个要后悔的动作，得让人看清楚再按。
//
// 分层手段（按 P5 的优先级顺序，不是靠叠更多卡片）：
//   ① 当前选中 → 强调色描边 + 更亮的面板 + 左侧 4px 身份色竖条
//   ② 未开始   → 语义色 locked 的状态片 + 中性灰文案
//   ③ 入场动线 → 逐张 42ms 错开上浮，眼睛被带到第一张，然后顺着往下读
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Animated, Image,
  Platform, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { UI, TIERS, personasByTier, levelFromAffection, LEVEL_TITLES, getPersona, PERSONAS } from '../theme';
import { useStore } from '../useStore';
import { updateConfig } from '../store';
import { Kicker, SectionHead, StatusChip } from '../components/ui';
import AvatarPreview from '../components/AvatarPreview';
import { getPose } from '../anim/idlePoses';
import { BACKGROUNDS, resolveBackground, backgroundLabel } from '../backgrounds';
import { pickImage } from '../pickImage';

// 入场动线：透明度 + 位移一起给，只给透明度眼睛抓不到方向
function useEntrance(delay = 0) {
  const v = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 260, delay, useNativeDriver: true }).start();
  }, [v, delay]);
  return v;
}

function PersonaCard({ p, rel, affection, onChoose, delay }) {
  const a = useEntrance(delay);
  const lv = levelFromAffection(typeof affection === 'number' ? affection : 0);

  return (
    <Animated.View
      style={[
        styles.cardAnim,
        {
          opacity: a,
          transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      <Pressable
        onPress={() => onChoose(p.id)}
        style={({ pressed }) => [styles.card, rel && styles.cardRel, pressed && styles.cardPressed]}
      >
        {/* 身份色竖条：整屏唯一允许出现「人格色」的地方 */}
        <View style={[styles.idBar, { backgroundColor: p.colors.primary }]} />

        <View style={styles.cardBody}>
          <View style={styles.cardTop}>
            <Text style={styles.bigEmoji}>{p.emoji}</Text>
            <View style={styles.cardHead}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.role}>{p.role}</Text>
            </View>
            {/* 状态语义化：进行中 = accent，未开始 = locked，不用两套自定义色 */}
            <StatusChip tone={rel ? 'accent' : 'locked'}>
              {rel ? LEVEL_TITLES[lv - 1] : '未开始'}
            </StatusChip>
          </View>

          <View style={styles.cardRule} />

          <Text style={styles.tagline}>{p.tagline}</Text>

          <View style={styles.cardFoot}>
            <Text style={styles.footText}>{rel ? '继续这段关系' : '开始相处'}</Text>
            <Text style={[styles.footArrow, !rel && styles.footArrowDim]}>—▸</Text>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

/**
 * @param {object}   props
 * @param {(id:string)=>void} props.onDone   点底部 CTA
 * @param {()=>void} props.onBack           换人模式下左上角返回（首次启动没有）
 * @param {boolean}  props.switching        是不是"之后换人"（决定文案和返回键）
 */
export default function PersonaSelect({ onDone, onBack, switching }) {
  const snap = useStore();
  const [tab, setTab] = useState('character');
  // 默认先落在第一位上：不然用户一个都没点就按 CTA 会进不去，
  // 与其禁用按钮，不如给个能看见的默认项
  const [pickId, setPickId] = useState(snap.personaId || PERSONAS[0].id);

  const bgId = snap.config?.bgId || 'auto';
  const bgImage = snap.config?.bgImage || '';

  // 预览用的是"正在选的人"，不是已经存下来的那个 —— 不然点了卡片看不到变化
  const previewPersona = useMemo(
    () => getPersona(pickId || snap.personaId),
    [pickId, snap.personaId]
  );
  const previewColors = resolveBackground(bgId, previewPersona);

  // 角色 tab 的预览用**她自己的**默认舞台（persona.bgId），不是全局选的那一个。
  // 否则 18 个人站同一块背景上，"每个角色有自己的世界"在选人的那一刻根本看不见。
  const personaBgId = previewPersona?.bgId || 'auto';
  const charColors = resolveBackground(personaBgId, previewPersona);
  const charBgLabel = backgroundLabel(personaBgId);
  // 签名待机姿势：让她"站着的样子"也成为可比较的一项
  const sigPose = getPose(previewPersona?.idlePose);

  // ⚠️ 点卡片只改「待选项」，绝不落档 —— 落档交给底部 CTA。
  //    以前这里会立刻 selectPersona(id)，结果首次启动一点卡片，App.js 的
  //    `if (!personaId)` 就不再成立，这一屏当场从「首次选人」变形成
  //    「换人浮层」：标题变「换成谁？」、多出一个返回键、底下还压着 Home。
  //    用户只是想先看看卡片，却像已经确认了一样。
  const choose = (id) => setPickId(id);

  // 确认选人时把她的默认舞台一起带上 —— 但**只在你还没自己挑过舞台**的时候。
  // 用户主动选过的舞台优先级更高：换人不该把人家挑的背景冲掉，
  // 否则"我明明选了夜色霓虹，换个角色就变书房"会被当成 bug。
  const confirm = () => {
    if (bgId === 'auto' && previewPersona?.bgId && previewPersona.bgId !== 'auto') {
      updateConfig({ bgId: previewPersona.bgId, bgImage: '' });
    }
    onDone?.(pickId);
  };

  const pickBg = (b) => {
    if (b.id === 'custom') {
      const ok = pickImage((f) => updateConfig({ bgId: 'custom', bgImage: f.uri }));
      if (!ok && Platform.OS !== 'web') Alert.alert('暂不支持', '上传背景图目前只在网页端可用。');
      return;
    }
    updateConfig({ bgId: b.id, bgImage: '' });
  };

  // 按档位分组渲染；分组是"展示层"的事，PERSONAS 本身仍是一维数组，
  // 所以 getPersona / 好感度 / 存档那些逻辑一行都不用改。
  const groups = TIERS
    .map((t) => ({ ...t, list: personasByTier(t.id) }))
    .filter((g) => g.list.length > 0);

  const ctaName = previewPersona?.name || '她';

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.inner}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Kicker>AI COMPANION</Kicker>
          <Text style={styles.title}>{switching ? '换成谁？' : '今天想陪在谁身边？'}</Text>
          <Text style={styles.sub}>
            {switching
              ? `${PERSONAS.length} 位全部开放，各自的感情进度互不影响，随时可以换回来。`
              : `${PERSONAS.length} 位全部开放，人选和舞台都能随时换，感情进度互不影响。`}
          </Text>
        </View>

        {/* 两个 tab：人和舞台是同一次选择的两半，别分到两个页面去 */}
        <View style={styles.tabs}>
          {[['character', '角色'], ['background', '背景']].map(([k, label]) => (
            <Pressable
              key={k}
              style={[styles.tab, tab === k && styles.tabOn]}
              onPress={() => setTab(k)}
            >
              <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</Text>
            </Pressable>
          ))}
          <View style={styles.tabHint}>
            <Text style={styles.tabHintText}>舞台 · {backgroundLabel(bgId)}</Text>
          </View>
        </View>

        {tab === 'character' ? (
          <>
            {/* 角色预览：她本人 + 她自己的默认舞台。
                点下面任意一张卡片这块就跟着变，不用先按确认 ——
                选人是个要看清楚再决定的动作。 */}
            <View style={styles.hero}>
              <LinearGradient
                colors={charColors}
                locations={[0, 0.34, 0.72, 1]}
                style={StyleSheet.absoluteFillObject}
              />
              <View style={styles.heroInner}>
                <AvatarPreview persona={previewPersona} scale={1.15} />
                <View style={styles.heroText}>
                  <Text style={styles.heroName}>{previewPersona?.name}</Text>
                  <Text style={styles.heroMeta}>
                    {previewPersona?.emoji} {previewPersona?.role}
                  </Text>
                  <Text style={styles.heroMeta}>默认舞台 · {charBgLabel}</Text>
                  {!!sigPose && <Text style={styles.heroMeta}>待机 · {sigPose.name}</Text>}
                </View>
              </View>
            </View>

            {/* 示例对白：音色和性格终究是"听"出来的，但在能听之前先让人读到 */}
            <View style={styles.sampleBox}>
              <Text style={styles.sampleKicker}>她会这么说话</Text>
              {(previewPersona?.sample || []).map((s, i) => (
                <Text key={i} style={styles.sampleLine}>「{s}」</Text>
              ))}
            </View>

            {groups.map((g, gi) => (
            <View key={g.id} style={styles.group}>
              <SectionHead
                kicker={String(g.id).toUpperCase()}
                title={g.label}
                meta={`${g.list.length} 位`}
              />
              <Text style={styles.tierSub}>{g.sub}</Text>

              {g.list.map((p, i) => (
                <PersonaCard
                  key={p.id}
                  p={p}
                  rel={pickId === p.id}
                  affection={snap.personaId === p.id ? snap.affection : 0}
                  delay={40 + (gi * 6 + i) * 42}
                  onChoose={choose}
                />
              ))}
            </View>
            ))}
          </>
        ) : (
          <View style={styles.group}>
            {/* 实时预览：切背景的时候能立刻看到"她的舞台"变成什么样 */}
            <View style={styles.preview}>
              {bgImage ? (
                <Image source={{ uri: bgImage }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
              ) : (
                <LinearGradient
                  colors={previewColors}
                  locations={[0, 0.34, 0.72, 1]}
                  style={StyleSheet.absoluteFillObject}
                />
              )}
              <View style={styles.previewInner}>
                {/* 这里也要是"人站在舞台上"的效果 —— 光一个 emoji 看不出
                    换了背景之后她到底置身何处。 */}
                <AvatarPreview persona={previewPersona} scale={1.05} />
                <Text style={styles.previewName}>{previewPersona?.name}</Text>
                <Text style={styles.previewBg}>{backgroundLabel(bgId)}</Text>
              </View>
            </View>

            <SectionHead kicker="STAGE" title="舞台" meta={`${BACKGROUNDS.length} 档`} />
            <View style={styles.bgGrid}>
              {BACKGROUNDS.map((b) => {
                const on = bgId === b.id;
                // auto / custom 没有渐变色标：auto 用当前角色配色预览，custom 用中性灰
                const swatch = b.colors
                  || (b.id === 'auto' ? resolveBackground('auto', previewPersona) : ['#3A3D4E', '#5A5E72', '#8B8CA3', '#D7D8E3']);
                return (
                  <Pressable
                    key={b.id}
                    style={[styles.bgCard, on && styles.bgCardOn]}
                    onPress={() => pickBg(b)}
                  >
                    <LinearGradient
                      colors={swatch}
                      locations={[0, 0.34, 0.72, 1]}
                      style={styles.bgSwatch}
                    />
                    <Text style={styles.bgName} numberOfLines={1}>{b.emoji} {b.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.bgNote}>
              「跟随角色」会用这个角色自己的配色当背景。自定义图片存在你这台设备上。
            </Text>
          </View>
        )}

        <View style={{ height: 12 }} />
      </ScrollView>

      {/* 底部常驻 CTA：换人是要确认的动作，不能点一下卡片就跳走 */}
      <View style={styles.ctaBar}>
        {!!switching && (
          <Pressable style={styles.ctaBack} onPress={onBack}>
            <Text style={styles.ctaBackText}>‹ 返回</Text>
          </Pressable>
        )}
        <Pressable style={styles.cta} onPress={confirm}>
          <Text style={styles.ctaText}>
            {switching ? `换成 ${ctaName}` : `开始相处 · ${ctaName}`}
          </Text>
          <Text style={styles.ctaArrow}>—▸</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg },
  scroll: { flex: 1 },
  inner: { padding: 20, paddingTop: 52, paddingBottom: 24 },
  header: { marginBottom: 20 },

  title: { fontSize: 27, fontWeight: '800', color: UI.text, letterSpacing: 0.2, marginTop: 10 },
  sub: { fontSize: 13.5, color: UI.textDim, marginTop: 8, lineHeight: 20 },

  tabs: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  tab: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    backgroundColor: UI.surfaceHi,
  },
  tabOn: { borderColor: UI.accent, backgroundColor: UI.accentSoft },
  tabText: { fontSize: 13, fontWeight: '800', color: UI.textDim, letterSpacing: 0.8 },
  tabTextOn: { color: UI.text },
  tabHint: { flex: 1, alignItems: 'flex-end' },
  tabHintText: { fontSize: 11.5, color: UI.textDim, fontWeight: '700' },

  group: { marginBottom: 8 },
  tierSub: { fontSize: 12, color: UI.textDim, fontWeight: '600', marginBottom: 12 },

  cardAnim: { marginBottom: 12 },
  card: {
    flexDirection: 'row',
    backgroundColor: UI.surface,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    overflow: 'hidden',
  },
  cardRel: { backgroundColor: UI.surfaceHi, borderColor: UI.accentLine },
  cardPressed: { transform: [{ scale: 0.985 }] },

  idBar: { width: 4, alignSelf: 'stretch' },
  cardBody: { flex: 1, padding: 15, minWidth: 0 },

  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardHead: { flex: 1, minWidth: 0 },
  bigEmoji: { fontSize: 32 },
  name: { fontSize: 19, fontWeight: '800', color: UI.text, letterSpacing: 0.3 },
  role: { fontSize: 12, color: UI.textDim, marginTop: 2, fontWeight: '600' },

  cardRule: { height: 1, backgroundColor: UI.hairline, marginVertical: 12 },

  tagline: { fontSize: 13, color: UI.textMid, lineHeight: 20 },

  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  footText: { fontSize: 12.5, fontWeight: '800', color: UI.textMid, letterSpacing: 0.8 },
  footArrow: { fontSize: 13, fontWeight: '800', color: UI.accent },
  footArrowDim: { color: UI.locked },

  // 角色预览（人 + 她自己的舞台）
  hero: {
    height: 208,
    borderRadius: UI.radius,
    overflow: 'hidden',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  heroInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 18,
  },
  heroText: { flex: 1, minWidth: 0, gap: 3 },
  heroName: {
    fontSize: 24,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 8,
  },
  heroMeta: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.9)',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },

  sampleBox: {
    backgroundColor: UI.surfaceHi,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    padding: 14,
    marginBottom: 20,
    gap: 6,
  },
  sampleKicker: { fontSize: 11, fontWeight: '800', color: UI.textDim, letterSpacing: 1 },
  sampleLine: { fontSize: 13.5, color: UI.text, lineHeight: 21 },

  // 背景预览
  preview: {
    // 人物 150×1.05 ≈ 158，加名字和舞台名再留点余量
    height: 232,
    borderRadius: UI.radius,
    overflow: 'hidden',
    marginBottom: 18,
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  previewInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  previewName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 8,
  },
  previewBg: {
    fontSize: 11.5,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.86)',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 6,
  },

  bgGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bgCard: {
    width: '31.5%',
    backgroundColor: UI.surfaceHi,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    padding: 8,
    alignItems: 'center',
    gap: 6,
  },
  bgCardOn: { borderColor: UI.accent, borderWidth: 2 },
  bgSwatch: { width: '100%', height: 52, borderRadius: 2 },
  bgName: { fontSize: 11, fontWeight: '700', color: UI.textDim },
  bgNote: { fontSize: 11.5, color: UI.textDim, lineHeight: 18, marginTop: 12 },

  // 底部 CTA
  ctaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: UI.hairline,
    backgroundColor: UI.surface,
  },
  ctaBack: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  ctaBackText: { fontSize: 13, fontWeight: '700', color: UI.textDim },
  cta: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    borderRadius: UI.radius,
    backgroundColor: UI.accent,
  },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.6 },
  ctaArrow: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
