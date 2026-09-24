// 全局错误边界：任何渲染期崩溃都不再变成"白屏"，而是显示可读的错误信息，
// 这样用户能直接把错误文字发回来定位。同时兜底抓不在 React 树里的异步异常
// （动画循环 / 模型加载 / Promise rejection）。
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { UI } from './theme';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      window.__lastError = error?.stack || error?.message || String(error);
    } catch {}
    console.error('[ErrorBoundary] 捕获到渲染异常：', error, info);
  }

  componentDidMount() {
    this._onErr = (e) =>
      this._surface(e?.error?.stack || e?.error?.message || e?.message || String(e));
    this._onRej = (e) =>
      this._surface(e?.reason?.stack || e?.reason?.message || String(e?.reason));
    window.addEventListener('error', this._onErr);
    window.addEventListener('unhandledrejection', this._onRej);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this._onErr);
    window.removeEventListener('unhandledrejection', this._onRej);
  }

  _surface(msg) {
    if (!msg || this.state.error) return;
    this.setState({ error: new Error(msg) });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const msg = error?.stack || error?.message || String(error);
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>⚠️ 应用出错了</Text>
        <Text style={styles.sub}>
          不是你的问题，是前端崩了一处。把下面这段发给我，我就能定位。
        </Text>
        <ScrollView style={styles.box}>
          <Text style={styles.code} selectable={true}>{msg}</Text>
        </ScrollView>
        <Pressable style={styles.btn} onPress={() => this.setState({ error: null })}>
          <Text style={styles.btnText}>重试</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1, padding: 24, backgroundColor: UI.bg,
    alignItems: 'center', justifyContent: 'center', gap: 14,
  },
  title: { fontSize: 20, fontWeight: '800', color: '#FF8A8A' },
  sub: { fontSize: 13, color: UI.textDim, textAlign: 'center', lineHeight: 20 },
  box: { maxHeight: 280, width: '100%', backgroundColor: '#1b1320', borderRadius: 12, padding: 12 },
  code: { fontSize: 11, color: '#FFB4B4', fontFamily: 'monospace', lineHeight: 16 },
  btn: { marginTop: 6, paddingHorizontal: 28, paddingVertical: 10, borderRadius: 999, backgroundColor: '#FF6F9C' },
  btnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
