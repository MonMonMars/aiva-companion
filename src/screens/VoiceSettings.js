// 语音 / 联网 / 语言 / 儿童模式 的设置
// ---------------------------------------------------------------------------
// 三大块 Key 都在这里填。全部只写进本机 AsyncStorage，
// 既不进代码也不进 git —— 换手机时不会跟着走，这是故意的安全设计。

import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, Switch, Alert, ActivityIndicator } from 'react-native';
import { GlassCard, PrimaryButton, UI } from '../components/ui';
import { useStore } from '../useStore';
import * as S from '../store';
import {
  TTS_PROVIDERS, STT_PROVIDERS, SEARCH_PROVIDERS, SPOKEN_LANGS,
  findTTS, findSTT, findSearch,
} from '../config/providers';
import { SPEECH } from '../theme';

function Row({ label, children, note }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={st.label}>{label}</Text>
      {children}
      {!!note && <Text style={st.note}>{note}</Text>}
    </View>
  );
}

function Field({ value, onChange, placeholder, secure, mono }) {  return (
    <TextInput
      value={value || ''}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor="#BCA9C0"
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
      style={[st.input, mono && st.inputMono]}
    />
  );
}

/** 横向滑动的胶囊选择器 */
function Chips({ options, value, onPick, renderLabel }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -2 }}>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 2, paddingVertical: 4 }}>
        {options.map((o) => {
          const active = o.id === value;
          return (
            <Pressable
              key={o.id}
              onPress={() => onPick(o.id)}
              style={[st.chip, active && st.chipOn]}
            >
              <Text style={[st.chipText, active && st.chipTextOn]}>
                {renderLabel ? renderLabel(o) : (o.label || o.name || o.id)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

export default function VoiceSettings({ personaId }) {
  const snap = useStore();
  const cfg = snap.config || {};
  const v = cfg.voice || {};
  const personaCfg = SPEECH[personaId] || SPEECH.girlfriend;

  const tts = findTTS(v.ttsProvider);
  const stt = findSTT(v.sttProvider);
  const search = findSearch(v.searchProvider);

  const setV = (patch) => S.updateConfig({ voice: { ...v, ...patch } });
  const setTop = (patch) => S.updateConfig(patch);

  const [testing, setTesting] = useState(false);

  async function testVoice() {
    setTesting(true);
    try {
      // 真跑一次合成，而不是只 ping 一下 —— 只有真的发出去才知道音色/权限对不对
      const { synthesizeSegment } = await import('../voice/tts');
      const base = await import('../theme').then((m) => m.resolveVoice(personaId, v.ttsProvider, cfg.spokenLang));
      const clip = await synthesizeSegment({
        text: cfg.spokenLang === 'zh-HK' ? '你好呀，我系你嘅好拍档。'
          : cfg.spokenLang === 'en-US' ? 'Hey there, how are you doing?'
            : '你好呀，今天过得怎么样？',
        emotion: 'excited',
        cfg: {
          provider: v.ttsProvider,
          voice: v.ttsVoice || base.voice,
          speed: v.ttsSpeed ?? base.speed,
          ttsModel: v.ttsModel || tts.defaultModel,
          locale: base.locale,
          allowStyle: base.allowStyle,
          personInstruction: base.personInstruction,
          keys: { openaiKey: v.openaiKey, azureKey: v.azureKey, azureRegion: v.azureRegion, elevenKey: v.elevenKey },
        },
      });
      const { Audio } = await import('expo-av');
      const bytes = new Uint8Array(clip.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const b64 = globalThis.btoa ? globalThis.btoa(bin) : '';
      const { sound } = await Audio.Sound.createAsync({ uri: `data:audio/mpeg;base64,${b64}` }, { shouldPlay: true });
      sound.setOnPlaybackStatusUpdate(async (s) => { if (s?.didJustFinish) await sound.unloadAsync(); });
      Alert.alert('成功', '听到声音了吗？如果没声音，检查一下 Key 和区域有没有填对。');
    } catch (e) {
      Alert.alert('语音合成失败', String(e?.message || e).slice(0, 300));
    } finally {
      setTesting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, padding: 18 }} keyboardShouldPersistTaps="handled">
      <Text style={st.h1}>说话 · 联网</Text>
      <Text style={st.sub}>
        这些 Key 只存在你手机里，不会上传。当前角色：{personaCfg.label}
      </Text>

      {/* ---------------- 语言 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>🗣 说什么语言</Text>
        <Row label="语言" note="粤语建议配 Azure —— OpenAI 说粤语会有普通话口音">
          <Chips options={SPOKEN_LANGS} value={cfg.spokenLang || 'auto'} onPick={(id) => setTop({ spokenLang: id })} />
        </Row>
        <Row label="听写语言">
          <Chips options={stt.langs} value={v.sttLanguage || 'auto'} onPick={(id) => setV({ sttLanguage: id })} />
        </Row>
      </GlassCard>

      {/* ---------------- 说话声音 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>🔊 谁的声音</Text>
        <Row label="服务商" note={tts.note}>
          <Chips options={TTS_PROVIDERS} value={v.ttsProvider} onPick={(id) => setV({ ttsProvider: id, ttsVoice: '' })} />
        </Row>
        <Row label="音色">
          <Chips
            options={tts.voices}
            value={v.ttsVoice || tts.defaultVoice}
            onPick={(id) => setV({ ttsVoice: id })}
          />
        </Row>
        {tts.keyFields.map((f) => (
          <Row key={f.key} label={f.label}>
            <Field
              value={v[f.key]}
              onChange={(t) => setV({ [f.key]: t.trim() })}
              placeholder={f.placeholder}
              secure={f.key !== 'azureRegion'}
              mono
            />
          </Row>
        ))}
        <PrimaryButton
          title={testing ? '正在合成…' : '试听一句'}
          icon="▶️"
          color="#3FA372"
          compact
          onPress={testVoice}
          disabled={testing}
        />
        {testing && <ActivityIndicator style={{ marginTop: 8 }} />}
      </GlassCard>

      {/* ---------------- 耳朵 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>👂 怎么听懂你</Text>
        <Row label="服务商" note={stt.note}>
          <Chips options={STT_PROVIDERS} value={v.sttProvider} onPick={(id) => setV({ sttProvider: id })} />
        </Row>
        {stt.keyFields.map((f) => (
          <Row key={f.key} label={f.label}>
            <Field
              value={v[f.key]}
              onChange={(t) => setV({ [f.key]: t.trim() })}
              placeholder={f.placeholder}
              secure={f.key !== 'azureRegion'}
              mono
            />
          </Row>
        ))}
      </GlassCard>

      {/* ---------------- 联网 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>🌐 联网查东西</Text>
        <Row label="搜索引擎" note="天气不需要这个 —— 走的是免费的 Open-Meteo">
          <Chips options={SEARCH_PROVIDERS} value={v.searchProvider} onPick={(id) => setV({ searchProvider: id })} />
        </Row>
        {search.keyFields.map((f) => (
          <Row key={f.key} label={f.label}>
            <Field value={v[f.key]} onChange={(t) => setV({ [f.key]: t.trim() })} placeholder={f.placeholder} secure mono />
          </Row>
        ))}
        <Row label="默认城市" note="问「天气怎么样」时查哪里">
          <Field value={v.defaultCity} onChange={(t) => setV({ defaultCity: t })} placeholder="例如：香港 / 东京" />
        </Row>
      </GlassCard>

      {/* ---------------- 小孩模式 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>🧒 儿童模式</Text>
        <View style={st.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.label}>给小朋友的讲法</Text>
            <Text style={st.note}>
              句子更短、多用比喻、严格过滤内容。关掉就是成人模式。
            </Text>
          </View>
          <Switch
            value={!!cfg.kidMode}
            onValueChange={(on) => setTop({ kidMode: on })}
            trackColor={{ false: '#DDD3DC', true: '#FF9FBE' }}
          />
        </View>
      </GlassCard>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// RN 里没有统一的跨平台等宽字体名，'monospace' 是两端都认的安全选择
const MONO = 'monospace';

const st = {
  h1: { fontSize: 22, fontWeight: '800', color: UI.text, marginBottom: 4, marginTop: 30 },
  sub: { fontSize: 12.5, color: UI.textDim, marginBottom: 18, lineHeight: 18 },
  card: { marginBottom: 14, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: UI.text, marginBottom: 12 },
  label: { fontSize: 12.5, fontWeight: '700', color: UI.text, marginBottom: 7 },
  note: { fontSize: 11.5, color: UI.textDim, lineHeight: 16, marginTop: 6 },
  input: {
    backgroundColor: '#F6F1F5',
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 13.5,
    color: UI.text,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  inputMono: { fontFamily: MONO },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: '#F1EBF0',
  },
  chipOn: { backgroundColor: '#FF6F9C' },
  chipText: { fontSize: 12.5, fontWeight: '700', color: UI.text },
  chipTextOn: { color: '#FFFFFF' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
};

