import './src/bootGuard'; // 必须第一个 import：先于任何可能崩的模块装上全局兜底
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ErrorBoundary } from './src/ErrorBoundary';
import Title from './src/screens/Title';
import PersonaSelect from './src/screens/PersonaSelect';
import Home from './src/screens/Home';
import Menu from './src/screens/Menu';
import PreloadBadge from './src/components/PreloadBadge';
import Chat from './src/screens/Chat';
import Settings from './src/screens/Settings';
import VoiceSettings from './src/screens/VoiceSettings';
import { loadStore, getSnapshot, subscribe, selectPersona } from './src/store';
import { UI } from './src/theme';
import { loadSettings, bool, refreshSettings } from './src/lib/cloudSettings';
import { installKeysFromLink } from './src/lib/keyLink';
import { detectCountry, applyRegionDefault } from './src/lib/region';

export default function App() {
  // 包一层错误边界：任何子页面渲染崩溃都变成"可读错误面板"而非白屏
  return (
    <ErrorBoundary>
      <AppBody />
    </ErrorBoundary>
  );
}

function AppBody() {
  const [ready, setReady] = useState(false);
  const [snap, setSnap] = useState(null);
  const [comeback, setComeback] = useState(null);
  // title → select → home；menu / select(换人) / chat / settings / voice 都是
  // 压在 home 之上的浮层，不是替换掉 home
  const [screen, setScreen] = useState('title');
  // 从链接装好 Key 之后闪一条提示；没有可装的东西时是 null
  const [keyBanner, setKeyBanner] = useState(null);

  // 3D 的 ref 由这里持有：菜单页要能"回正视角"，而 3D 活在 Home 里
  const avatarRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 顺序有讲究：**先**拉云端开关再读存档。
      // 因为初始金币、衰减速率这些已经改成后台下发了（见 store.js 的 checkInReward/decayRates），
      // 反过来的话首局拿到的是兜底值，后台改了也白改。
      await loadSettings();
      const { snapshot, comeback: info } = await loadStore();
      if (!alive) return;

      // 面向全世界，所以先弄清"这个人的网络出口在哪个国家"再决定听写用哪家 ——
      // Google 的可用地区名单里没有中国内地/香港/澳门，EEA/瑞士/英国又禁止
      // 对这些地方的用户用免费层。只救火不升级，见 region.js 里的说明。
      // 结果缓存 7 天，所以只有第一次（或换国家）才真的发一次请求。
      // 整个探测自带 2.4 秒上限，失败也只是"不知道在哪"，不会卡住启动。
      await detectCountry();

      // ⚠️ 必须在 loadStore 之后：存档加载会用硬盘旧值覆盖内存，装早了会被冲掉
      const applied = installKeysFromLink();
      applyRegionDefault();
      if (applied.length) setKeyBanner(applied);
      setSnap(snapshot);
      setComeback(info);
      setReady(true);
    })();
    const unsub = subscribe(() => setSnap(getSnapshot()));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // 装 Key 的提示闪几秒就自己消失，不用用户去点
  useEffect(() => {
    if (!keyBanner) return undefined;
    const t = setTimeout(() => setKeyBanner(null), 4500);
    return () => clearTimeout(t);
  }, [keyBanner]);

  // 载入中：标题页一直显示（它自己带进度条），别闪一个空白的 loading
  if (!ready || !snap) {
    return <Title ready={false} />;
  }

  // 维护模式：后台一开所有客户端都停在这里，不再解析 3D 模型省流量。
  // 开关是每帧读的 bool()，后台关掉后用户点「重试」即可重新进来。
  if (bool('maintenance_mode')) {
    return <Maintenance />;
  }

  const personaId = snap.personaId;

  // 标题页：store 读完后再停留一拍，然后自己决定去哪
  if (screen === 'title') {
    return (
      <>
        <Title
          ready
          onEnter={() => setScreen(personaId ? 'home' : 'select')}
        />
        {!!keyBanner && <KeyBanner keys={keyBanner} />}
      </>
    );
  }

  // 首次启动：还没有人，先选人（这一屏是独立的，下面没有 home）
  if (!personaId) {
    return (
      <>
        <PersonaSelect
          onDone={(id) => { if (id) selectPersona(id); setScreen('home'); }}
        />
        {!!keyBanner && <KeyBanner keys={keyBanner} />}
        <StatusBar style="light" />
      </>
    );
  }

  const goHome = () => setScreen('home');

  return (
    <>
      {/* Home 一直在底下活着：浮层盖住它但不会卸载，
          这样 3D 场景不用重新解析一次 glb，转过的视角也还在 */}
      <Home
        personaId={personaId}
        comeback={comeback}
        avatarRef={avatarRef}
        onMenu={() => setScreen('menu')}
        onSwitch={() => setScreen('select')}
      />

      {screen === 'select' && (
        <Overlay>
          <PersonaSelect
            switching
            onBack={goHome}
            onDone={(id) => { if (id) selectPersona(id); goHome(); }}
          />
        </Overlay>
      )}

      {screen === 'menu' && (
        <Overlay>
          <Menu
            personaId={personaId}
            onBack={goHome}
            onChat={() => setScreen('chat')}
            onSettings={() => setScreen('settings')}
            onVoice={() => setScreen('voice')}
            onSwitch={() => setScreen('select')}
            onResetCamera={() => avatarRef.current?.resetCamera?.()}
          />
        </Overlay>
      )}

      {screen === 'chat' && (
        <Overlay>
          <Chat personaId={personaId} onBack={goHome} />
        </Overlay>
      )}

      {screen === 'settings' && (
        <Overlay>
          <Settings
            personaId={personaId}
            onBack={goHome}
            onSwitchPersona={() => setScreen('select')}
            onVoice={() => setScreen('voice')}
          />
        </Overlay>
      )}

      {screen === 'voice' && (
        <Overlay>
          {/* 返回键在 VoiceSettings 自己的顶栏里（和设置页一致），
              这里不再叠一个浮动的 —— 浮动那个会压住标题。 */}
          <VoiceSettings personaId={personaId} onBack={() => setScreen('settings')} />
        </Overlay>
      )}

      {!!keyBanner && <KeyBanner keys={keyBanner} />}

      {/* 角落那个小圆环进度器：加载模型 / 后台预热时自己冒出来，跑完自己淡出。
          放最后一个 = 画在所有浮层之上；它内部 pointerEvents="none"，不会挡点击。 */}
      <PreloadBadge />

      <StatusBar style="light" />
    </>
  );
}

/** 浮层容器：铺满、不透明背景由各页自己给，压在 Home 之上 */
function Overlay({ children }) {
  return <View style={StyleSheet.absoluteFill}>{children}</View>;
}

// 片段参数 → 人话。没列进来的会退化成显示参数名本身，所以新增 MAP 时记得同步这里
const KEY_LABEL = {
  gm: '粤语听觉（Gemini · 免费额度最大）',
  sk: '粤语听觉（硅基流动）',
  ek: '粤语听觉 + 嗓子（ElevenLabs）',
  gk: '粤语听觉（Groq）',
  ok: '嗓子（OpenAI）',
  ak: '微软语音 Key',
  ar: '微软语音区域',
  lk: '大模型',
  tv: '联网搜索（Tavily）',
};

/** 「Key 已装好」的浮动提示。pointerEvents none，绝不影响点任何按钮 */
function KeyBanner({ keys }) {
  return (
    <View style={st.keyBanner} pointerEvents="none">
      <Text style={st.keyBannerText}>
        ✓ 已装好：{keys.map((k) => KEY_LABEL[k] || k).join('、')}
      </Text>
      <Text style={st.keyBannerHint}>Key 只存在这台设备上，地址栏已清干净</Text>
    </View>
  );
}

const st = StyleSheet.create({
  keyBanner: {
    position: 'absolute', left: 16, right: 16, top: 56, zIndex: 9999,
    alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(120,255,180,0.35)',
    backgroundColor: 'rgba(20,44,32,0.94)',
  },
  keyBannerText: { fontSize: 13.5, fontWeight: '800', color: '#B9FFD4', textAlign: 'center' },
  keyBannerHint: { fontSize: 11, color: 'rgba(185,255,212,0.6)', marginTop: 4, textAlign: 'center' },
});

/** 维护模式的整页提示。开关关掉后点重试重新拉取一次即可。 */
function Maintenance() {
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.maintainRoot}>
      <View>
        <Text style={styles.maintainEmoji}>🛠</Text>
        <Text style={styles.maintainTitle}>维护中</Text>
        <Text style={styles.maintainBody}>
          她正在整理房间，过一会儿就回来。{'\n'}
          你的聊天记录和养成进度都好好的，不会丢。
        </Text>
        <Pressable
          style={styles.maintainBtn}
          onPress={async () => {
            setBusy(true);
            try { await refreshSettings(); } catch (e) { /* 拉不到就保持现状 */ }
            setBusy(false);
          }}
        >
          <Text style={styles.maintainBtnText}>{busy ? '检查中…' : '重试'}</Text>
        </Pressable>
      </View>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  maintainRoot: {
    flex: 1, backgroundColor: UI.bg, alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  maintainEmoji: { fontSize: 52, textAlign: 'center', marginBottom: 18 },
  maintainTitle: { fontSize: 22, fontWeight: '800', color: UI.text, textAlign: 'center' },
  maintainBody: { fontSize: 13.5, color: UI.textDim, lineHeight: 22, textAlign: 'center', marginTop: 12 },
  maintainBtn: {
    marginTop: 26, alignSelf: 'center', paddingHorizontal: 26, paddingVertical: 12,
    borderRadius: UI.radius, borderWidth: 1, borderColor: UI.hairline, backgroundColor: UI.surfaceHi,
  },
  maintainBtnText: { fontSize: 14, fontWeight: '800', color: UI.text },
});
