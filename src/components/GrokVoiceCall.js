import React from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, Platform,
} from 'react-native';
import { UI } from '../theme';
import { useGrokRealtimeVoice } from '../voice/grok/useGrokRealtimeVoice';
import { DEFAULT_GROK_SESSION_PATH } from '../voice/grok/constants';

function statusLabel(status) {
  switch (status) {
    case 'idle':
      return '未连接';
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '通话中';
    case 'disconnecting':
      return '挂断中…';
    case 'error':
      return '出错';
    default: {
      const _exhaustive = status;
      return _exhaustive;
    }
  }
}

/**
 * Full-screen Grok realtime call overlay (web only).
 */
export default function GrokVoiceCall({
  visible,
  onClose,
  personaName,
  sessionContext,
  sessionUrl,
  onSpeakingChange,
  onTranscript,
}) {
  const voice = useGrokRealtimeVoice({
    sessionUrl: sessionUrl || DEFAULT_GROK_SESSION_PATH,
    sessionContext,
    onSpeakingChange,
    onTranscript,
  });

  const handleClose = () => {
    voice.stop();
    onClose?.();
  };

  if (Platform.OS !== 'web') {
    return null;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Grok 实时通话</Text>
              <Text style={styles.sub}>同 {personaName} 语音对话（server VAD）</Text>
            </View>
            <Pressable onPress={handleClose} style={styles.closeBtn} accessibilityLabel="关闭">
              <Text style={styles.closeTxt}>✕</Text>
            </Pressable>
          </View>

          {voice.configMissing ? (
            <View style={styles.warnBox}>
              <Text style={styles.warnTitle}>尚未配置 xAI 语音后端</Text>
              <Text style={styles.warnBody}>
                GitHub Pages 静态站无法代你保管 API Key。请在本地用{' '}
                <Text style={styles.mono}>node dist/server.js</Text>
                {' '}启动（设置环境变量{' '}
                <Text style={styles.mono}>XAI_API_KEY</Text>
                ），或在语音设置里填写你的{' '}
                <Text style={styles.mono}>/api/voice/session</Text>
                {' '}代理地址。
              </Text>
            </View>
          ) : null}

          {!!voice.lastError && !voice.configMissing && (
            <View style={styles.errBox}>
              <Text style={styles.errText}>{voice.lastError}</Text>
            </View>
          )}

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>连接</Text>
            <Text style={[
              styles.statusVal,
              voice.status === 'connected' && styles.statusOk,
              voice.status === 'error' && styles.statusBad,
            ]}
            >
              {statusLabel(voice.status)}
            </Text>
          </View>

          {!!voice.assistantLine && (
            <Text style={styles.line} numberOfLines={3}>{voice.assistantLine}</Text>
          )}

          <Text style={styles.hint}>
            说完稍停，Grok 会自动接话。粤语优先（STT hint: yue）；若模型 TTS 只有 zh，发音可能偏普通话。
          </Text>

          <View style={styles.actions}>
            {!voice.isActive ? (
              <Pressable
                style={[styles.primaryBtn, voice.configMissing && styles.btnDisabled]}
                onPress={() => voice.start()}
                disabled={voice.configMissing}
              >
                <Text style={styles.primaryBtnText}>开始通话</Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  style={styles.secondaryBtn}
                  onPress={() => voice.setMuted(!voice.muted)}
                  disabled={voice.status !== 'connected'}
                >
                  <Text style={styles.secondaryBtnText}>{voice.muted ? '取消静音' : '静音'}</Text>
                </Pressable>
                <Pressable style={styles.dangerBtn} onPress={() => voice.stop()}>
                  <Text style={styles.primaryBtnText}>挂断</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
    padding: 16,
  },
  card: {
    backgroundColor: UI.surface,
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '800', color: '#fff' },
  sub: { fontSize: 13, color: 'rgba(255,255,255,0.65)', marginTop: 4 },
  closeBtn: { padding: 6 },
  closeTxt: { color: 'rgba(255,255,255,0.6)', fontSize: 18 },
  warnBox: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.35)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  warnTitle: { color: '#fde68a', fontWeight: '700', fontSize: 14 },
  warnBody: { color: 'rgba(253,230,138,0.92)', fontSize: 12.5, marginTop: 6, lineHeight: 18 },
  mono: { fontFamily: Platform.select({ web: 'monospace', default: undefined }) },
  errBox: {
    backgroundColor: 'rgba(244,63,94,0.12)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  errText: { color: '#fecdd3', fontSize: 13 },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  statusLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
  statusVal: { color: '#fff', fontWeight: '600', fontSize: 13 },
  statusOk: { color: '#6ee7b7' },
  statusBad: { color: '#fda4af' },
  line: { color: 'rgba(255,255,255,0.88)', fontSize: 14, marginBottom: 8 },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 11.5, lineHeight: 16, marginBottom: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  primaryBtn: {
    flex: 1,
    backgroundColor: UI.accent,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  secondaryBtnText: { color: '#fff', fontSize: 14 },
  dangerBtn: {
    flex: 1,
    backgroundColor: 'rgba(80,80,90,0.95)',
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.45 },
});
