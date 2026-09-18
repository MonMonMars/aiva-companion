// 聊天页
// ---------------------------------------------------------------------------
// 回复一律「整段返回 + 打字机效果」渲染：RN 的 fetch 流式支持不稳，
// 但用户看到的效果和流式完全一样。

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, Pressable,
  KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { getPersona, UI, levelFromAffection, LEVEL_TITLES } from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';
import { buildMessages, requestCompletion, localReply, extractMemory } from '../llm';

export default function Chat({ personaId, onBack }) {
  const snap = useStore();
  const persona = useMemo(() => getPersona(personaId), [personaId]);
  const listRef = useRef(null);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState('');   // 打字机中间态
  const [notice, setNotice] = useState(null);

  const configured = Boolean(snap.config?.apiKey && snap.config?.baseUrl);
  const level = levelFromAffection(snap.affection);

  // 首屏打招呼
  useEffect(() => {
    const history = S.getHistory(personaId);
    if (history.length === 0) {
      S.appendMessage(personaId, { role: 'assistant', content: persona.greet, ts: Date.now() });
    }
  }, [personaId]);

  const messages = useMemo(() => S.getHistory(personaId), [personaId, snap]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    Keyboard.dismiss();
    setBusy(true);

    S.appendMessage(personaId, { role: 'user', content: text, ts: Date.now() });

    // 顺手记下用户透露的信息
    const mem = extractMemory(text);
    if (mem) S.remember(mem);

    const history = S.getHistory(personaId);
    const messagesToSend = buildMessages(personaId, snap, history, text);

    let reply = null;
    if (configured) {
      const r = await requestCompletion({ config: snap.config, messages: messagesToSend });
      if (r.ok) {
        reply = r.content;
      } else {
        setNotice(`模型没连上：${r.error}　（先用离线人格顶着）`);
        reply = localReply(personaId, text);
      }
    } else {
      reply = localReply(personaId, text);
    }

    // 打字机
    let acc = '';
    const step = Math.max(1, Math.ceil(reply.length / 55));
    for (let i = 0; i < reply.length; i += step) {
      acc = reply.slice(0, i + step);
      setTyping(acc);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 24));
    }
    setTyping('');
    S.appendMessage(personaId, { role: 'assistant', content: reply, ts: Date.now() });
    S.rewardChat();
    setBusy(false);
  };

  const renderItem = ({ item }) => {
    const mine = item.role === 'user';
    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        {!mine && <Text style={styles.avatar}>{persona.emoji}</Text>}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
          <Text style={[styles.msgText, mine && styles.msgTextMine]}>{item.content}</Text>
        </View>
      </View>
    );
  };

  const data = [...messages, ...(typing ? [{ role: 'assistant', content: typing, id: 'typing' }] : [])];

  return (
    <LinearGradient colors={[...persona.colors.gradient, '#FFFFFF']} locations={[0, 0.22, 0.6, 1]} style={styles.root}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.name}>{persona.name}</Text>
          <Text style={styles.sub}>
            {configured ? '在线 · 真实模型' : '离线人格 · 未接 Key'}
          </Text>
        </View>
        <View style={styles.lvChip}>
          <Text style={styles.lvText}>LV.{level}</Text>
        </View>
      </View>

      {!!notice && (
        <Pressable style={styles.notice} onPress={() => setNotice(null)}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(item, i) => String(item.ts ?? item.id ?? i)}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
      />

      {!configured && (
        <Text style={styles.hint}>
          现在是离线人格（内置台词）。想要真正的对话，去右上角齿轮填一个 Key。
        </Text>
      )}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={`和 ${persona.name} 说点什么…`}
            placeholderTextColor="#B6A9B8"
            multiline
            maxLength={500}
            editable={!busy}
          />
          <Pressable
            onPress={send}
            disabled={busy || !input.trim()}
            style={({ pressed }) => [styles.send, (busy || !input.trim()) && { opacity: 0.4 }, pressed && { transform: [{ scale: 0.94 }] }]}
          >
            <Text style={styles.sendText}>{busy ? '…' : '发送'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 46,
    paddingBottom: 10,
    gap: 10,
  },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 32, color: '#3A2C3D', fontWeight: '300', lineHeight: 34 },
  name: { fontSize: 17, fontWeight: '800', color: '#3A2C3D' },
  sub: { fontSize: 11, color: 'rgba(58,44,61,0.55)', marginTop: 2, fontWeight: '600' },
  lvChip: {
    backgroundColor: 'rgba(255,255,255,0.8)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  lvText: { fontSize: 11.5, fontWeight: '800', color: '#8C6A7C' },

  notice: {
    marginHorizontal: 14,
    marginBottom: 8,
    backgroundColor: 'rgba(255,236,240,0.92)',
    borderRadius: 14,
    padding: 10,
  },
  noticeText: { fontSize: 11.5, color: '#B0405F', lineHeight: 17 },

  list: { paddingHorizontal: 14, paddingBottom: 10 },
  row: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end', gap: 8 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  avatar: { fontSize: 22, marginBottom: 2 },
  bubble: { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine: { backgroundColor: '#FF6F9C', borderBottomRightRadius: 5 },
  bubbleTheirs: { backgroundColor: 'rgba(255,255,255,0.9)', borderBottomLeftRadius: 5 },
  msgText: { fontSize: 14.5, lineHeight: 21, color: '#3A2C3D' },
  msgTextMine: { color: '#fff' },

  hint: { fontSize: 11.5, color: 'rgba(58,44,61,0.5)', textAlign: 'center', paddingHorizontal: 20, paddingBottom: 6 },

  inputRow: { flexDirection: 'row', gap: 10, padding: 14, alignItems: 'flex-end' },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 18,
    paddingHorizontal: 15,
    paddingVertical: 11,
    fontSize: 15,
    color: UI.text,
    maxHeight: 100,
  },
  send: {
    backgroundColor: '#3A2C3D',
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
