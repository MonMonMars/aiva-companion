// 设置：接大模型 + 数据管理
// ---------------------------------------------------------------------------
// Key 只落在你本机的 AsyncStorage 里，不上传、不写进代码、不进 git。

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Alert, Platform } from 'react-native';
import { PROVIDERS, UI, inputFont } from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';
import { GlassCard, PrimaryButton, Empty } from '../components/ui';
import { requestCompletion } from '../llm';

export default function Settings({ personaId, onBack, onSwitchPersona, onVoice }) {
  const snap = useStore();
  const cfg = snap.config || {};
  // 当前选中供应商的说明（免费档的注意事项都写在 note 里，得让用户看得见）
  const activeProvider = PROVIDERS.find((p) => p.id === (cfg.provider || 'deepseek'));
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
    // ⚠️ 切到免 Key 供应商时必须把 apiKey 清空：留着上一个供应商的 Key，
    //    它会被当成 Bearer 头发给一个完全不相干的域名 —— 白白泄漏。
    if (p.keyless) setApiKey('');
    S.updateConfig({
      provider: p.id,
      baseUrl: p.baseUrl,
      model: p.model,
      keyless: !!p.keyless,
      ...(p.keyless ? { apiKey: '' } : null),
    });
  };

  const test = async () => {
    setTesting(true);
    const r = await requestCompletion({
      config: {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
        keyless: Boolean((snap.config || {}).keyless),
      },
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
          全部走 OpenAI 兼容格式。想先免费试：选「Pollinations 免Key」一个 Key 都不用填；
          想要更聪明又稳定：选「Gemini 免费」，去 Google AI Studio 免费领一个 Key（免信用卡）。
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

        {activeProvider?.note ? (
          <Text style={styles.providerNote}>{activeProvider.note}</Text>
        ) : null}

        <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.deepseek.com/v1" />
        <Field label="模型名" value={model} onChange={setModel} placeholder="deepseek-chat" />
        <Field
          label={cfg.keyless ? 'API Key（本供应商免 Key，留空即可）' : 'API Key'}
          value={apiKey}
          onChange={setApiKey}
          placeholder={cfg.keyless ? '不用填' : 'sk-...'}
          secure
        />

        <View style={styles.rowBtns}>
          <PrimaryButton title={testing ? '测试中…' : '测试连接'} icon="🔌" color="#5A6B8C" onPress={test} compact />
          <PrimaryButton title="保存" icon="💾" color={UI.ok} onPress={save} compact />
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
          <Text style={[styles.linkText, { color: UI.danger }]}>重置全部数据</Text>
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
  backText: { fontSize: 32, color: UI.text, fontWeight: '300', lineHeight: 34 },
  title: { fontSize: 17, fontWeight: '800', color: UI.text },

  sectionTitle: { fontSize: 15.5, fontWeight: '800', color: UI.text, marginBottom: 4 },
  sectionNote: { fontSize: 12, color: UI.textDim, lineHeight: 18, marginBottom: 12 },

  providerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  provider: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: UI.hairline,
    backgroundColor: UI.surfaceHi,
  },
  providerActive: { backgroundColor: UI.accent },
  providerText: { fontSize: 12.5, fontWeight: '700', color: UI.textDim },
  providerTextActive: { color: '#fff' },
  providerNote: {
    fontSize: 11.5,
    color: UI.textDim,
    lineHeight: 17,
    marginBottom: 12,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: UI.accent,
  },

  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: UI.textDim, marginBottom: 6 },
  fieldInput: {
    backgroundColor: UI.surfaceTop,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: Platform.select({ ios: 12, default: 10 }),
    fontSize: inputFont(14),   // <16 会让 iOS Safari 聚焦时整页放大
    color: UI.text,
  },
  rowBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },

  link: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: UI.hairline,
  },
  linkText: { fontSize: 14.5, fontWeight: '600', color: UI.text },
  linkArrow: { fontSize: 20, color: '#C6B8C6' },

  foot: { fontSize: 12, color: UI.textDim, lineHeight: 19, marginTop: 16 },
});
