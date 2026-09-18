import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import PersonaSelect from './src/screens/PersonaSelect';
import Home from './src/screens/Home';
import Chat from './src/screens/Chat';
import Settings from './src/screens/Settings';
import VoiceSettings from './src/screens/VoiceSettings';
import { loadStore, getSnapshot, subscribe } from './src/store';

export default function App() {
  const [ready, setReady] = useState(false);
  const [snap, setSnap] = useState(null);
  const [screen, setScreen] = useState('select');
  const [comeback, setComeback] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { snapshot, comeback: info } = await loadStore();
      if (!alive) return;
      setSnap(snapshot);
      setComeback(info);
      setScreen(snapshot.personaId ? 'home' : 'select');
      setReady(true);
    })();
    const unsub = subscribe(() => setSnap(getSnapshot()));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  if (!ready || !snap) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#FF6F9C" />
        <Text style={styles.loadingText}>正在唤醒她…</Text>
      </View>
    );
  }

  const personaId = snap.personaId;

  if (screen === 'select') {
    return (
      <>
        <PersonaSelect onDone={() => setScreen('home')} />
        <StatusBar style="dark" />
      </>
    );
  }

  if (screen === 'chat') {
    return (
      <>
        <Chat personaId={personaId} onBack={() => setScreen('home')} />
        <StatusBar style="dark" />
      </>
    );
  }

  if (screen === 'settings') {
    return (
      <>
        <Settings
          personaId={personaId}
          onBack={() => setScreen('home')}
          onSwitchPersona={() => setScreen('select')}
          onVoice={() => setScreen('voice')}
        />
        <StatusBar style="dark" />
      </>
    );
  }

  // 说话 / 联网 / 语言 / 儿童模式
  if (screen === 'voice') {
    return (
      <>
        <VoiceSettings personaId={personaId} />
        <Pressable style={styles.voiceBack} onPress={() => setScreen('settings')}>
          <Text style={styles.voiceBackText}>‹ 返回</Text>
        </Pressable>
        <StatusBar style="dark" />
      </>
    );
  }

  return (
    <>
      <Home
        personaId={personaId}
        comeback={comeback}
        onChat={() => setScreen('chat')}
        onSettings={() => setScreen('settings')}
      />
      <StatusBar style="dark" />
    </>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#FFF7FB' },
  loadingText: { fontSize: 13, color: '#9A8B9D' },
  voiceBack: {
    position: 'absolute', top: 42, right: 18,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  voiceBackText: { fontSize: 13, fontWeight: '700', color: '#3A2C3D' },
});
