// 设置：接大模型 + 数据管理
// ---------------------------------------------------------------------------
// Key 只落在你本机的 AsyncStorage 里，不上传、不写进代码、不进 git。

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Alert, Platform } from 'react-native';
import { PROVIDERS, UI } from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';
import { GlassCard, PrimaryButton, Empty } from '../components/ui';
import { requestCompletion } from '../llm';

export default function Settings({ personaId, onBack, onSwitchPersona, onVoice }) {
  const snap = useStore();
  const cfg = snap.config || {};
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl || '');
  const [model, setModel] = useState(cfg.model || '');
  const [apiKey, setApiKey] = useState(cfg.apiKey || '');
  const [testing, setTesting] = useState(false);

  const save = () => {
    S.updateConfig({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() });
    Alert.alert('已保存', 'Key 只存在本机，不会上传。');
  };

  const pickProvider = (p) => {
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    S.updateConfig({ provider: p.id, baseUrl: p.baseUrl, model: p.model });
  };

  const test = async () => {
    setTesting(true);
    const r = await requestCompletion({
      config: { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() },
      messages: [
        { role: 'system', content: '你是测试助手。' },
        { role: 'user', content: '只回复两个字：正常' },
      ],
      temperature: 0.1,
    });
    setTesting(false);
    if (r.ok) Alert.alert('连接成功 ✅', `模型回复：${r.content}`);
    else Alert.alert('连接失败', r.error);
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.inner} showsVerticalScrollIndicator={false}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>设置</Text>
        <View style={{ width: 36 }} />
      </View>

      <GlassCard>
        <Text style={styles.sectionTitle}>大模型接口</Text>
        <Text style={styles.sectionNote}>
          全部走 OpenAI 兼容格式。选一个供应商，填好 Key 就能用真模型对话。
        </Text>

        <View style={styles.providerRow}>
          {PROVIDERS.map((p) => {
            const active = (cfg.provider || 'deepseek') === p.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => pickProvider(p)}
                style={[styles.provider, active && styles.providerActive]}
              >
                <Text style={[styles.providerText, active && styles.providerTextActive]}>{p.name}</Text>
              </Pressable>
            );
          })}
        </View>

        <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.deepseek.com/v1" />
        <Field label="模型名" value={model} onChange={setModel} placeholder="deepseek-chat" />
        <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="sk-..." secure />

        <View style={styles.rowBtns}>
          <PrimaryButton title={testing ? '测试中…' : '测试连接'} icon="🔌" color="#5A6B8C" onPress={test} compact />
          <PrimaryButton title="保存" icon="💾" color="#3FA372" onPress={save} compact />
        </View>
      </GlassCard>

      <GlassCard style={{ marginTop: 14 }}>
        <Text style={styles.sectionTitle}>说话与联网</Text>
        <Text style={styles.sectionNote}>
          让角色真的开口说话：选语音服务商、挑音色、决定说粤语还是普通话还是英语，
          再配上联网搜索查天气新闻。
        </Text>
        <View style={styles.rowBtns}>
          <PrimaryButton title="说话 · 联网设置" icon="🎙️" color="#FF6F9C" onPress={onVoice} compact />
        </View>
      </GlassCard>

      <GlassCard style={{ marginTop: 14 }}>
        <Text style={styles.sectionTitle}>版权与合规</Text>
        <Text style={styles.sectionNote}>
          本项目的代码、界面元素、生成的语音与音乐全部由程序在本地合成，没有使用任何第三方的受版权保护素材；
          内置儿歌的旋律均取自公共领域曲目。
        </Text>
        <Text style={styles.sectionNote}>
          需要注意：assets/models 里的三个 3D 模型是从第三方图库下载的，其商用授权未经确认。
          正式上架前建议替换成自行制作、或明确标注 CC0 / 可商用授权的模型。
          详见 README.md 的《版权与合规》一节。
        </Text>
      </GlassCard>

      <GlassCard style={{ marginTop: 14 }}>
        <Text style={styles.sectionTitle}>数据</Text>
        <Pressable style={styles.link} onPress={onSwitchPersona}>
          <Text style={styles.linkText}>换一个伙伴</Text>
          <Text style={styles.linkArrow}>›</Text>
        </Pressable>
        <Pressable
          style={styles.link}
          onPress={() => {
            S.clearHistory(personaId);
            Alert.alert('已清空', '聊天记录清了，好感度保留。');
          }}
        >
          <Text style={styles.linkText}>清空聊天记录</Text>
          <Text style={styles.linkArrow}>›</Text>
        </Pressable>
        <Pressable
          style={styles.link}
          onPress={() =>
            Alert.alert('重置全部数据？', '好感度、记忆、金币都会归零，无法恢复。', [
              { text: '取消', style: 'cancel' },
              { text: '确认重置', style: 'destructive', onPress: () => S.resetAll() },
            ])
          }
        >
          <Text style={[styles.linkText, { color: '#D4648C' }]}>重置全部数据</Text>
          <Text style={styles.linkArrow}>›</Text>
        </Pressable>
      </GlassCard>

      <Text style={styles.foot}>
        提示：iOS 安装包必须在 macOS + Xcode 或 Expo 云构建上产出；Android 可以在这台机器上直接打包。
        具体命令看项目根目录 README。
      </Text>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function Field({ label, value, onChange, placeholder, secure }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#B6A9B8"
        secureTextEntry={!!secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg },
  inner: { padding: 18, paddingTop: 44 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 32, color: '#3A2C3D', fontWeight: '300', lineHeight: 34 },
  title: { fontSize: 17, fontWeight: '800', color: UI.text },

  sectionTitle: { fontSize: 15.5, fontWeight: '800', color: UI.text, marginBottom: 4 },
  sectionNote: { fontSize: 12, color: UI.textDim, lineHeight: 18, marginBottom: 12 },

  providerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  provider: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.045)',
  },
  providerActive: { backgroundColor: '#3A2C3D' },
  providerText: { fontSize: 12.5, fontWeight: '700', color: UI.textDim },
  providerTextActive: { color: '#fff' },

  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: UI.textDim, marginBottom: 6 },
  fieldInput: {
    backgroundColor: '#F7F3F7',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: Platform.select({ ios: 12, default: 10 }),
    fontSize: 14,
    color: UI.text,
  },
  rowBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },

  link: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: '#F1ECF1',
  },
  linkText: { fontSize: 14.5, fontWeight: '600', color: UI.text },
  linkArrow: { fontSize: 20, color: '#C6B8C6' },

  foot: { fontSize: 12, color: UI.textDim, lineHeight: 19, marginTop: 16 },
});
