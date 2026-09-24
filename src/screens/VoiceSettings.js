// 语音 / 联网 / 语言 / 儿童模式 的设置
// ---------------------------------------------------------------------------
// 三大块 Key 都在这里填。全部只写进本机 AsyncStorage，
// 既不进代码也不进 git —— 换手机时不会跟着走，这是故意的安全设计。

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, Switch, Alert, ActivityIndicator } from 'react-native';
import { GlassCard, PrimaryButton } from '../components/ui';
import { useStore } from '../useStore';
import * as S from '../store';
import {
  TTS_PROVIDERS, STT_PROVIDERS, SEARCH_PROVIDERS, SPOKEN_LANGS,
  findTTS, findSTT, findSearch,
} from '../config/providers';
import { SPEECH, UI, inputFont } from '../theme';
import {
  detectCountry, regionAdvice, sttStatus, sttUsable, orderForCountry, bestSttFor,
} from '../lib/region';
import { previewTts } from '../voice/webSpeak';

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

export default function VoiceSettings({ personaId, onBack }) {
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
  const [checking, setChecking] = useState(false);

  // 系统嗓音 —— 进这一页时才真去问设备装了哪些。
  // 为什么不能写死一串「常见粤语嗓音 ID」当选项：iOS 源码是
  //   utterance.voice = AVSpeechSynthesisVoice(identifier: voice)
  //   guard utterance.voice != nil else { throw InvalidVoiceException }
  // 传一个这台设备上不存在的 identifier 会**直接抛异常**，不是降级。
  // 所以只能运行时枚举，或者在拿不到的时候干脆不传 voice。
  const [nativeVoices, setNativeVoices] = useState([]);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeErr, setNativeErr] = useState('');

  const isNative = v.ttsProvider === 'native';

  async function loadNativeVoices(force) {
    setNativeLoading(true);
    setNativeErr('');
    try {
      const { listNativeVoices } = await import('../voice/nativeSpeech');
      const list = (await listNativeVoices(!!force)) || [];
      setNativeVoices(list);
      if (!list.length) {
        setNativeErr('这台设备没上报任何嗓音。多半是系统还没下载语音包 —— 会退回默认嗓音，不会没声音。');
      }
    } catch (e) {
      setNativeVoices([]);
      setNativeErr('读不到设备嗓音列表：' + String(e?.message || e).slice(0, 140));
    } finally {
      setNativeLoading(false);
    }
  }

  useEffect(() => {
    if (!isNative) return;
    let alive = true;
    (async () => {
      setNativeLoading(true);
      try {
        const { listNativeVoices } = await import('../voice/nativeSpeech');
        const list = (await listNativeVoices(false)) || [];
        if (alive) {
          setNativeVoices(list);
          setNativeErr(list.length ? '' : '这台设备没上报任何嗓音。多半是系统还没下载语音包 —— 会退回默认嗓音。');
        }
      } catch (e) {
        if (alive) { setNativeVoices([]); setNativeErr('读不到设备嗓音列表：' + String(e?.message || e).slice(0, 140)); }
      } finally {
        if (alive) setNativeLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [isNative]);

  // 我在哪个国家？—— 决定了下面「怎么听懂你」该推荐谁。
  // App 启动时已经探过一次并缓存 7 天，这里基本是秒回。
  const [cc, setCc] = useState('');
  useEffect(() => {
    let alive = true;
    detectCountry().then((c) => { if (alive) setCc(c || ''); });
    return () => { alive = false; };
  }, []);

  const advice = regionAdvice(cc);
  const sttList = orderForCountry(STT_PROVIDERS, cc);
  const curStatus = sttStatus(cc, v.sttProvider);
  const curBad = curStatus.level === 'blocked' || curStatus.level === 'nofree';
  const best = bestSttFor(cc);

  // 选听写服务商：这家在这个国家用不了的话，先讲清楚再让他决定。
  // 不强行拦 —— 他可能挂着代理，也可能就是想试试。
  function pickStt(id) {
    const s = sttStatus(cc, id);
    if ((s.level === 'blocked' || s.level === 'nofree') && id !== v.sttProvider) {
      Alert.alert(
        '这里可能用不了',
        s.msg + '\n\n仍然要选它吗？（比如你挂着代理、或只是想试试）',
        [
          { text: '算了', style: 'cancel' },
          { text: '照选', onPress: () => setV({ sttProvider: id }) },
        ]
      );
      return;
    }
    setV({ sttProvider: id });
  }

  // 空跑一次自检：不录音、不花钱。最要紧的用途是验「地区放不放行」——
  // Gemini 免费 API 看你手机的网络出口在不在 Google 的地区名单里，
  // 不在的话点麦只会拿到一句英文 400，用户根本看不懂。
  async function testEars() {
    setChecking(true);
    try {
      const { checkSttProvider } = await import('../voice/stt');
      const r = await checkSttProvider({
        provider: v.sttProvider,
        keys: {
          geminiKey: v.geminiKey, elevenKey: v.elevenKey, groqKey: v.groqKey,
          openaiKey: v.openaiKey, siliconKey: v.siliconKey,
          azureKey: v.azureKey, azureRegion: v.azureRegion,
        },
      });
      Alert.alert(r.ok ? '听得见 ✓' : r.ok === null ? '这项要真说一句' : '听不见 ✗', r.msg);
    } catch (e) {
      Alert.alert('自检失败', String(e?.message || e).slice(0, 300));
    } finally {
      setChecking(false);
    }
  }

  async function testVoice() {
    setTesting(true);
    try {
      // 免 Key 的通道都不联网、不需要任何 Key，但走的是两套完全不同的引擎：
      //   · native → 手机自带引擎（expo-speech），原生端专用
      //   · edge / espeak → 浏览器 SpeechSynthesis / WASM，Web 端专用
      const provider = v.ttsProvider;
      if (provider === 'native') {
        const { speakNative } = await import('../voice/nativeSpeech');
        const lang = !cfg.spokenLang || cfg.spokenLang === 'auto' ? 'zh-HK' : cfg.spokenLang;
        await speakNative(
          lang === 'zh-HK' ? '你好呀，我系你嘅好拍档。'
            : lang === 'en-US' ? 'Hey there, how are you doing?'
              : '你好呀，今天过得怎么样？',
          { locale: lang, emotion: 'excited', speed: v.ttsSpeed ?? 1, voice: v.ttsVoice || '' },
        );
        Alert.alert('成功', '听到声音了吗？（系统嗓音用手机自带引擎朗读，不需要任何 Key）');
        return;
      }
      if (provider === 'edge' || provider === 'espeak') {
        await previewTts({
          provider,
          lang: cfg.spokenLang || 'zh-HK',
          text: cfg.spokenLang === 'zh-HK' ? '你好呀，我系你嘅好拍档。'
            : cfg.spokenLang === 'en-US' ? 'Hey there, how are you doing?'
              : '你好呀，今天过得怎么样？',
          speed: v.ttsSpeed ?? 1,
        });
        Alert.alert('成功', '听到声音了吗？（Edge / eSpeak 走浏览器本地合成，不需要任何 Key）');
        return;
      }

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

  // 系统嗓音的选项表。iOS 一台机器上常报 60+ 个嗓音，全列出来横向滑到手酸，
  // 所以：当前语言精确命中的排最前，同语言的其它地区变体其次，剩下的按名字排，
  // 截到 24 个。已经选中的那个即使被截掉也要补回来 —— 否则选中项会"消失"。
  const nativeOptions = (() => {
    const AUTO = { id: '', label: '自动（按语言挑设备嗓音）' };
    const lang = !cfg.spokenLang || cfg.spokenLang === 'auto' ? 'zh-HK' : cfg.spokenLang;
    const want = String(lang).toLowerCase();
    const base = want.split('-')[0];
    const rank = (s) => (s === want ? 0 : s.startsWith(base) ? 1 : 2);

    const picked = nativeVoices
      .filter((x) => x && x.identifier)
      .map((x) => ({ id: x.identifier, name: x.name || x.identifier, lang: String(x.language || '') }))
      .sort((a, b) => {
        const d = rank(a.lang.toLowerCase()) - rank(b.lang.toLowerCase());
        return d !== 0 ? d : a.name.localeCompare(b.name);
      });

    const top = picked.slice(0, 24).map((x) => ({ id: x.id, label: `${x.name} · ${x.lang}` }));
    const cur = v.ttsVoice;
    if (cur && !top.some((o) => o.id === cur)) {
      const hit = picked.find((x) => x.id === cur);
      if (hit) top.push({ id: hit.id, label: `${hit.name} · ${hit.lang}` });
    }
    return [AUTO, ...top];
  })();

  return (
    <ScrollView style={{ flex: 1, padding: 18 }} keyboardShouldPersistTaps="handled">
      {/* 返回键放在页面自己的顶栏里，和「设置 / 聊天记录」一致。
          ⚠️ 别再改回 App.js 里那个绝对定位的浮动返回键：
             它压在标题「说话 · 联网」的右半边上（实测交集 34×19px），
             标题一长就跟返回键叠字。 */}
      <View style={st.topBar}>
        <Pressable onPress={onBack} style={st.back} accessibilityRole="button">
          <Text style={st.backText}>‹</Text>
        </Pressable>
        <Text style={st.h1}>说话 · 联网</Text>
        <View style={{ width: 36 }} />
      </View>
      <Text style={st.sub}>
        这些 Key 只存在你手机里，不会上传。当前角色：{personaCfg.label}
      </Text>

      {/* ---------------- 语言 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>🗣 说什么语言</Text>
        <Row label="语言" note="粤语不想填 Key 就选「Edge（浏览器自带微软神经嗓音）」或「eSpeak（离线机械音）」；OpenAI 说粤语会有普通话口音。">
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
        <Row
          label="音色"
          note={isNative
            ? (nativeLoading
              ? '正在问这台设备装了哪些嗓音…'
              : (nativeErr || `设备上报了 ${nativeVoices.length} 个嗓音，已按当前语言排序。选「自动」最稳 —— 让 App 自己按语言挑。`))
            : undefined}
        >
          {isNative && (
            <Pressable onPress={() => loadNativeVoices(true)} disabled={nativeLoading} style={st.miniBtn}>
              <Text style={st.miniBtnText}>{nativeLoading ? '扫描中…' : '↻ 重新扫描设备嗓音'}</Text>
            </Pressable>
          )}
          <Chips
            options={isNative ? nativeOptions : tts.voices}
            value={isNative ? (v.ttsVoice || '') : (v.ttsVoice || tts.defaultVoice)}
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
          color={UI.ok}
          compact
          onPress={testVoice}
          disabled={testing}
        />
        {testing && <ActivityIndicator style={{ marginTop: 8 }} />}
      </GlassCard>

      {/* ---------------- 耳朵 ---------------- */}
      <GlassCard style={st.card}>
        <Text style={st.cardTitle}>👂 怎么听懂你</Text>

        {/* 地区提示：这个 App 面向全世界，而各家云服务的可用地区不一样。
            先把"你在哪、这里哪家能用"摆出来，再让人去选，别让他对着 400 发呆。 */}
        <View style={st.geoBox}>
          <Text style={st.geoLine}>🌏 {advice.line || '正在判断你所在的国家…'}</Text>
          {!!advice.warn && <Text style={st.note}>{advice.warn}</Text>}
          {curBad && (
            <Text style={st.warnLine}>
              ⚠️ 你现在选的「{stt.short || stt.name}」在这里用不了：{curStatus.msg}
            </Text>
          )}
          {!curBad && cc && best !== v.sttProvider && sttUsable(cc, best) && (
            <PrimaryButton
              title={'改用 ' + (findSTT(best).short || best)}
              icon="👍"
              color={UI.ok}
              compact
              onPress={() => setV({ sttProvider: best })}
            />
          )}
        </View>

        <Row label="服务商" note={stt.note}>
          <Chips
            options={sttList}
            value={v.sttProvider}
            onPick={pickStt}
            renderLabel={(o) => {
              const s = sttStatus(cc, o.id);
              const mark = s.level === 'blocked' ? ' ⛔' : s.level === 'nofree' ? ' ⚠️' : '';
              return (o.short || o.name) + mark;
            }}
          />
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
        <PrimaryButton
          title={checking ? '正在检查…' : '检查这家通不通'}
          icon="🩺"
          color={UI.accent}
          compact
          onPress={testEars}
          disabled={checking}
        />
        {checking && <ActivityIndicator style={{ marginTop: 8 }} />}
        <Text style={st.note}>
          不录音、不花钱，只问一句「Key 有效吗、地区放行吗」。
          各家按你手机的**网络出口地区**放行：Google 名单里没有中国内地/香港/澳门，
          欧洲经济区/瑞士/英国又规定只能用付费服务 —— 这些地方用 ElevenLabs 最稳。
        </Text>
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
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 26, marginBottom: 2,
  },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 32, color: UI.text, fontWeight: '300', lineHeight: 34 },
  h1: { fontSize: 22, fontWeight: '800', color: UI.text, marginBottom: 4 },
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
    fontSize: inputFont(13.5),   // <16 会让 iOS Safari 聚焦时整页放大
    color: UI.text,
    borderWidth: 1,
    borderColor: UI.hairline,
  },
  inputMono: { fontFamily: MONO },
  geoBox: {
    backgroundColor: '#F2F7FB',
    borderWidth: 1, borderColor: '#D6E4F0',
    borderRadius: 12, padding: 12, marginBottom: 14,
  },
  geoLine: { fontSize: 12.5, fontWeight: '700', color: UI.text, lineHeight: 18 },
  warnLine: { fontSize: 11.5, color: '#C0392B', lineHeight: 16, marginTop: 6, fontWeight: '600' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: UI.radius,
    borderWidth: 1, borderColor: UI.hairline,
    backgroundColor: UI.surfaceTop,
  },
  chipOn: { backgroundColor: UI.accent, borderColor: UI.accent },
  chipText: { fontSize: 12.5, fontWeight: '700', color: UI.text },
  chipTextOn: { color: '#FFFFFF' },
  miniBtn: {
    alignSelf: 'flex-start', marginBottom: 8,
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: 10,
    backgroundColor: '#F0EAF2', borderWidth: 1, borderColor: UI.hairline,
  },
  miniBtnText: { fontSize: 11.5, fontWeight: '700', color: UI.textDim },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
};

