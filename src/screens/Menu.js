// 菜单页 —— 一整页装下所有功能
// ---------------------------------------------------------------------------
// 之前这些功能是塞在主界面底部的一个抽屉里，抽屉一开就压掉半个屏幕，
// 而且礼物和记忆还得再叠一层弹层，等于三层。现在全部摊平成一页：
//   主列表 → 送礼（页内网格）/ 记忆（页内列表），用一个 view 状态切换，
//   不做页面跳转 —— 跳转会让用户失去"我在菜单里第几层"的感觉。
//
// 这一页是浮在 Home 之上的（见 App.js），不是替换掉 Home：
// 这样 3D 场景一直活着，关掉菜单不用重新解析一次 glb，
// 转过的视角也还在（所以"回正视角"这一项才有意义）。
import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, TextInput, Linking,
} from 'react-native';
import { UI, inputFont, getPersona, GIFTS, levelFromAffection, LEVEL_TITLES, affectionToNext } from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';
import { StatBar } from '../components/ui';
import { backgroundLabel } from '../backgrounds';
import { preloadState, subscribePreload } from '../lib/preload';
import { assetCacheStats } from '../lib/assetBytes';
import AccountView from '../components/AccountView';
import { useAccount } from '../lib/cloudAccount';

// 管理后台是同源的一个独立页面。同源很重要：云服务端对 Origin 做精确匹配，
// 只有同一个域名下才算同一个应用、才能读到同一份数据。
const ADMIN_PATH = '/admin.html';

function Row({ icon, label, hint, onPress }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <Text style={styles.rowLabel}>{label}</Text>
      {!!hint && <Text style={styles.rowHint} numberOfLines={1}>{hint}</Text>}
      <Text style={styles.rowChevron}>›</Text>
    </Pressable>
  );
}

export default function Menu({
  personaId, onBack, onChat, onSettings, onVoice, onSwitch, onResetCamera,
}) {
  const snap = useStore();
  const persona = getPersona(personaId);
  const acc = useAccount();
  const [view, setView] = useState('main'); // 'main' | 'gift' | 'memory' | 'account'
  const [memText, setMemText] = useState('');
  const [toast, setToast] = useState('');
  // 后台预热进度：菜单页底部那行"后台预热 7/18"就靠它。
  // ⚠️ 这一行删了会直接 ReferenceError → 整个菜单页变成"应用出错了"。
  const [pre, setPre] = useState(preloadState);
  useEffect(() => subscribePreload(setPre), []);

  const level = levelFromAffection(snap.affection);
  const levelTitle = LEVEL_TITLES[level - 1] || '陌生';
  const nextInfo = affectionToNext(snap.affection);

  const flash = (text) => {
    setToast(text);
    setTimeout(() => setToast(''), 1800);
  };

  const onGift = (gift) => {
    const r = S.sendGift(gift.id);
    if (!r.ok) { flash('金币不够，多陪她说说话就有啦'); return; }
    flash(`送出 ${gift.name}　+${gift.affection} 亲密 🎁`);
  };

  const onCheckIn = () => {
    const r = S.dailyCheckIn();
    flash(r.ok ? `签到 +${r.coins} 金币 🪙` : '今天已经领过啦，明天再来');
  };

  const addMemory = () => {
    const r = S.remember(memText);
    if (r.ok) { setMemText(''); flash('记住了 📝'); }
  };

  return (
    <View style={styles.root}>
      {/* 头部：身份 + 状态条 + 返回 */}
      <View style={styles.head}>
        <Pressable style={styles.backBtn} onPress={() => (view === 'main' ? onBack?.() : setView('main'))}>
          <Text style={styles.backText}>‹ {view === 'main' ? '关闭' : '返回'}</Text>
        </Pressable>
        <View style={styles.headMid}>
          <Text style={styles.headName} numberOfLines={1}>{persona.name}</Text>
          <Text style={styles.headMeta} numberOfLines={1}>
            {`LV.${level} ${levelTitle} · 🪙 ${snap.coins} · 💞 ${Math.round(snap.affection)}`}
          </Text>
        </View>
        <View style={styles.backBtnPlain}>
          <Text style={styles.headStage} numberOfLines={1}>{backgroundLabel(snap.config?.bgId)}</Text>
        </View>
      </View>

      {!!toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner} showsVerticalScrollIndicator={false}>
        {view === 'main' && (
          <>
            {/* ★ 顶部必须给 PreloadBadge（absolute left:14 top:104，App.js 挂在所有浮层之上）
                留出净空，否则"亲密"这一行的标签会被那个小圆环压住。
                13(左边距) + 圆环 60 高 + 7*2 内边距 ≈ 88，取 96 留点余量。 */}
            <View style={{ height: 96 }} />
            <StatBar
              emoji="💞"
              label="亲密"
              value={nextInfo.pct * 100}
              color={persona.colors.primary}
              right={level >= LEVEL_TITLES.length ? 'MAX' : `LV.${level} → ${Math.ceil(nextInfo.need)}`}
            />
            <StatBar emoji="🌤" label="心情" value={snap.mood} color={persona.colors.deep} right={`${Math.round(snap.mood)}%`} />
            <StatBar emoji="⚡️" label="精力" value={snap.energy} color={UI.warn} right={`${Math.round(snap.energy)}%`} />

            <View style={styles.list}>
              <Row icon="🎭" label="换角色 / 换舞台" hint={`${persona.name} · ${backgroundLabel(snap.config?.bgId)}`} onPress={onSwitch} />
              <Row icon="💬" label="聊天记录" hint="看完整对话" onPress={onChat} />
              <Row icon="🎤" label="语音设置" hint="粤语 / 音色 / 联网" onPress={onVoice} />
              <Row icon="🎁" label="送礼物" hint={`🪙 ${snap.coins}`} onPress={() => setView('gift')} />
              <Row icon="📓" label="她的记忆" hint={`${snap.memory.length} 条`} onPress={() => setView('memory')} />
              <Row icon="✅" label="每日签到" hint={`+${S.checkInReward().coins} 🪙`} onPress={onCheckIn} />
              <Row
                icon="☁️"
                label="账号 · 云同步"
                hint={acc.loading ? '读取中…' : acc.session ? '已登录' : '未登录'}
                onPress={() => setView('account')}
              />
              {/* 管理后台入口只对管理员显示。
                  ⚠️ 这个判断只是「要不要亮出来」，不是安全边界：
                  真正拦住非管理员写开关的是 app_settings 表上的 RLS 策略。
                  就算有人改本地 state 把自己标成 admin，点进去也只能看不能写。 */}
              {acc.isAdmin && (
                <Row
                  icon="🛠"
                  label="管理后台"
                  hint="全局数值开关"
                  onPress={() => { Linking.openURL(ADMIN_PATH).catch(() => {}); }}
                />
              )}
              <Row icon="⟲" label="回正视角" hint="镜头转乱了就点这个" onPress={() => { onResetCamera?.(); flash('视角已回正 ⟲'); }} />
              <Row icon="⚙️" label="设置" hint="模型 / Key / 儿童模式" onPress={onSettings} />
            </View>

            <Text style={styles.note}>
              玩法：摸她的头 / 戳一下 / 空白处拖动转视角 / 双指缩放平移。{'\n'}
              {`摸 ${snap.totalPets} 次　·　聊 ${snap.totalChats} 轮　·　所有对话只存在你这台设备上`}
            </Text>

            {/* 后台预热：让她自己说清楚"我在忙什么"，别让人以为卡住了 */}
            <Text style={styles.preloadNote}>
              {pre.phase === 'done'
                ? `后台预热完成 · ${pre.total} 项就绪 · 已缓存 ${(assetCacheStats().bytes / 1048576).toFixed(1)}MB，换角色即刻生效`
                : `后台预热中 ${pre.done}/${pre.total}${pre.label ? `　·　${pre.label}` : ''}`}
            </Text>
          </>
        )}

        {view === 'gift' && (
          <>
            <Text style={styles.subTitle}>送 {persona.name} 礼物　🪙 {snap.coins}</Text>
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
            <Text style={styles.note}>金币来源：抚摸 +1、每聊一轮 +2、每日签到 +25。</Text>
          </>
        )}

        {view === 'memory' && (
          <>
            <Text style={styles.subTitle}>{persona.name}记得的事</Text>
            {snap.memory.length === 0 ? (
              <Text style={styles.note}>还没有。聊天时告诉她你的喜好，或直接写一条。</Text>
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
                placeholderTextColor="#8B8CA3"
              />
              <Pressable style={styles.memAdd} onPress={addMemory}>
                <Text style={styles.memAddText}>记下</Text>
              </Pressable>
            </View>
            <Text style={styles.note}>这些条目会被拼进 system prompt，她会一直记得。</Text>
          </>
        )}

        {view === 'account' && <AccountView acc={acc} toast={flash} />}

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 46,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: UI.hairline,
  },
  backBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    backgroundColor: UI.surfaceHi,
  },
  backText: { fontSize: 13, fontWeight: '700', color: UI.text },
  // ⚠️ minWidth: 0 不能省：这格是 flex:1，没它的话窄屏上副标题会把左右两头顶出去
  headMid: { flex: 1, minWidth: 0, alignItems: 'center' },
  headName: { fontSize: 15, fontWeight: '800', color: UI.text },
  headMeta: { fontSize: 11, color: UI.textDim, fontWeight: '700', marginTop: 2 },
  backBtnPlain: { width: 74, flexShrink: 0, alignItems: 'flex-end' },
  headStage: { fontSize: 11.5, color: UI.textDim, fontWeight: '700' },

  toast: {
    position: 'absolute',
    // ⚠️ 别贴着 96：头部整块是 98px 高（46 上边距 + 名字/副标题 + 12 下边距 + 1 分隔线），
    //    96 会让吐司压在分隔线上。106 才是"完全落在正文区里"。
    top: 106,
    left: 20,
    right: 20,
    alignItems: 'center',
    zIndex: 5,
  },
  toastText: {
    backgroundColor: 'rgba(20,21,31,0.94)',
    borderWidth: 1,
    borderColor: UI.accentLine,
    borderRadius: UI.radius,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 13,
    fontWeight: '700',
    color: UI.text,
    overflow: 'hidden',
  },

  body: { flex: 1 },
  bodyInner: { padding: 20, paddingBottom: 40 },

  list: { marginTop: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: UI.hairline,
  },
  rowIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  rowLabel: { fontSize: 14.5, fontWeight: '700', color: UI.text, flexShrink: 0 },
  rowHint: { flex: 1, fontSize: 11.5, color: UI.textDim, textAlign: 'right' },
  rowChevron: { fontSize: 16, color: UI.locked, fontWeight: '700' },

  subTitle: { fontSize: 16, fontWeight: '800', color: UI.text, marginBottom: 14 },
  note: { fontSize: 12, color: UI.textDim, lineHeight: 19, marginTop: 14 },
  // 菜单页底部那行"后台预热 7/18"。⚠️ 别删：Menu.js 里 styles.preloadNote 在用，
  //    删了 RNW 会拿到 undefined → 这行文字变成没样式的裸文本。
  preloadNote: { fontSize: 11.5, color: UI.textDim, lineHeight: 17, marginTop: 10 },

  giftGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  giftCard: {
    width: '47%',
    backgroundColor: UI.surfaceHi,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    padding: 14,
    alignItems: 'center',
    gap: 3,
  },
  giftEmoji: { fontSize: 32 },
  giftName: { fontSize: 13.5, fontWeight: '800', color: UI.text },
  giftMeta: { fontSize: 11.5, color: UI.textDim, fontWeight: '600' },
  giftOwned: { fontSize: 11, color: UI.ok, fontWeight: '700', marginTop: 2 },

  memRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: UI.hairline,
  },
  memText: { fontSize: 13.5, color: UI.text, flex: 1 },
  memDel: { fontSize: 12, color: UI.danger, fontWeight: '700', paddingLeft: 10 },
  memInputRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  memInput: {
    flex: 1,
    backgroundColor: UI.surfaceTop,
    borderRadius: UI.radius,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: inputFont(14),   // <16 会让 iOS Safari 聚焦时整页放大
    color: UI.text,
  },
  memAdd: {
    backgroundColor: UI.accent,
    borderRadius: UI.radius,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  memAddText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
