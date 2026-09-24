// 账号页 —— 可选登录 + 云同步
// ---------------------------------------------------------------------------
// ⚠️ 这里按云服务「默认登录 UI 契约」来：密码登录、邮箱验证码登录、注册三条路径
//    必须同时可见可达，不能图省事只做 OTP。注册还要能吃 registration_open 开关，
//    后台关了注册之后这条路要停掉而不是放行到云端再报错。
//
// ⚠️ 邮箱验证码只对**已发布的 HTTPS 域名**生效（localhost 不被支持），
//    所以本地开发时这三条路径登录不了是预期行为，不是 bug。
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { UI, inputFont } from '../theme';
import { cloud, authErrorMessage } from '../lib/cloudClient';
import { bool } from '../lib/cloudSettings';
import { syncOnLogin, pushState } from '../lib/cloudSync';
import { maskEmail } from '../lib/cloudAccount';

const ADMIN_PATH = '/admin.html';

export default function AccountView({ acc, toast }) {
  const [tab, setTab] = useState('password'); // password | otp | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('input');  // input | code | reset
  const [pending, setPending] = useState(null); // OTP 上下文
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const regOpen = bool('registration_open');
  const fail = (e) => toast(typeof e === 'string' ? e : authErrorMessage(e));

  // ---- 登录态 -------------------------------------------------------------
  if (acc.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={UI.accent} />
        <Text style={styles.note}>正在读取账号…</Text>
      </View>
    );
  }

  if (acc.session) {
    const onSync = async () => {
      setBusy(true);
      try {
        const r = await pushState();
        toast(r ? '已上传到云端 ☁️' : '没有写进去，可能没有权限');
      } catch (e) {
        toast(`同步失败：${authErrorMessage(e)}`);
      } finally { setBusy(false); setNote(''); }
    };

    return (
      <ScrollView contentContainerStyle={styles.inner}>
        <Text style={styles.subTitle}>账号</Text>
        <View style={styles.card}>
          <Row k="邮箱" v={maskEmail(acc.session.user?.email)} />
          <Row k="角色" v={acc.isAdmin ? '管理员 🛠' : '普通用户'} />
          <Row k="云同步" v="开启中" />
        </View>

        {busy && <ActivityIndicator color={UI.accent} style={{ marginVertical: 12 }} />}

        <Btn label="立即同步到云端" onPress={onSync} primary />

        {acc.isAdmin && (
          <Btn
            label="打开管理后台 🛠"
            onPress={() => {
              // 同源 -> 同一个云环境 -> 后台读到的就是这批数据。
              // 独立 access 的原因是不把后台 UI 塞进用户端主包。
              Linking.openURL(ADMIN_PATH).catch(() => toast('打不开后台链接'));
            }}
          />
        )}

        <Btn
          label="退出登录"
          danger
          onPress={async () => {
            try {
              await cloud.auth.signOut();
              toast('已退出');
            } catch (e) {
              toast(authErrorMessage(e));
            }
          }}
        />

        {!!note && <Text style={styles.note}>{note}</Text>}
      </ScrollView>
    );
  }

  // ---- 未登录 -------------------------------------------------------------
  const sendOtpForLogin = async () => {
    if (!email.includes('@')) return toast('先填邮箱');
    setBusy(true);
    try {
      const started = await cloud.auth.signInWithOtp({ email });
      if (started.error) return fail(started.error);
      setPending(started.data);
      setStep('code');
      toast('验证码已发到邮箱');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const verifyLoginCode = async () => {
    setBusy(true);
    try {
      const done = await pending.verify({ token: code });
      if (done.error) return fail(done.error);
      setCode('');
      setStep('input');
      await acc.refresh();
      await syncOnLogin();
      toast('登录成功，进度已同步 ☁️');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const signInWithPassword = async () => {
    if (!email.includes('@')) return toast('先填邮箱');
    if (!password) return toast('填一下密码');
    setBusy(true);
    try {
      const r = await cloud.auth.signInWithPassword({ email, password });
      if (r.error) return fail(r.error);
      setPassword('');
      await acc.refresh();
      await syncOnLogin();
      toast('登录成功，进度已同步 ☁️');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const startSignup = async () => {
    if (!regOpen) return toast('后台关闭了新用户注册');
    if (!email.includes('@')) return toast('先填邮箱');
    if (!password || password.length < 6) return toast('密码至少 6 位');
    setBusy(true);
    try {
      const sent = await cloud.auth.sendOtp({ email });
      if (sent.error) return fail(sent.error);
      // 已经是老用户的话不能拿副表单当注册用：中性地引导去登录，
      // 不在文案里暴露「这个邮箱注册过」（会被拿来撞号）。
      if (sent.data?.isExistingUser) return toast('这个邮箱可以直接登录');
      setPending(sent.data);
      setStep('code');
      toast('验证码已发到邮箱，填它完成注册');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const finishSignup = async () => {
    setBusy(true);
    try {
      const done = await cloud.auth.verifyOtp({
        verificationId: pending.verificationId,
        token: code,
        email,
        isExistingUser: pending.isExistingUser,
        password,
      });
      if (done.error) return fail(done.error);
      setCode(''); setPassword(''); setStep('input');
      await acc.refresh();
      await pushState();
      toast('注册成功，已自动登录');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const resetPassword = async () => {
    if (!email.includes('@')) return toast('先填邮箱');
    setBusy(true);
    try {
      const started = await cloud.auth.resetPasswordForEmail(email);
      if (started.error) return fail(started.error);
      setPending(started.data);
      setStep('reset');
      toast('验证码已发到邮箱');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const confirmNewPassword = async () => {
    if (!password || password.length < 6) return toast('新密码至少 6 位');
    setBusy(true);
    try {
      const done = await pending.updateUser({ nonce: code, password });
      if (done.error) return fail(done.error);
      setCode(''); setPassword(''); setStep('input');
      await acc.refresh();
      toast('密码已重置');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={styles.inner}>
      <View style={styles.tabs}>
        {[['password', '密码登录'], ['otp', '验证码登录'], ['signup', '注册']].map(([k, t]) => (
          <Pressable
            key={k}
            style={[styles.tab, tab === k && styles.tabOn]}
            onPress={() => { setTab(k); setStep('input'); setNote(''); }}
          >
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {step === 'input' && (
        <View style={styles.card}>
          <Field label="邮箱" value={email} onChange={setEmail} placeholder="you@example.com" keyboard="email-address" />
          {(tab !== 'otp') && (
            <Field label="密码" value={password} onChange={setPassword} secure placeholder="至少 6 位" />
          )}

          {busy
            ? <ActivityIndicator color={UI.accent} style={{ marginVertical: 10 }} />
            : (
              <>
                {tab === 'password' && <Btn label="登录" primary onPress={signInWithPassword} />}
                {tab === 'otp' && <Btn label="发送验证码" primary onPress={sendOtpForLogin} />}
                {tab === 'signup' && (
                  <Btn label={regOpen ? '发送验证码并完成注册' : '注册已关闭'} primary onPress={startSignup} />
                )}
                {tab === 'password' && (
                  <Pressable style={styles.linkBtn} onPress={resetPassword}>
                    <Text style={styles.linkText}>忘记密码？</Text>
                  </Pressable>
                )}
              </>
            )}
        </View>
      )}

      {step === 'code' && (
        <View style={styles.card}>
          <Field label="邮箱验证码" value={code} onChange={setCode} placeholder="邮件里那串数字" />
          {busy
            ? <ActivityIndicator color={UI.accent} style={{ marginVertical: 10 }} />
            : <Btn label={tab === 'signup' ? '确认注册' : '登录'} primary onPress={tab === 'signup' ? finishSignup : verifyLoginCode} />}
          <Pressable style={styles.linkBtn} onPress={() => { setStep('input'); setPending(null); }}>
            <Text style={styles.linkText}>‹ 返回修改</Text>
          </Pressable>
        </View>
      )}

      {step === 'reset' && (
        <View style={styles.card}>
          <Field label="邮箱验证码" value={code} onChange={setCode} placeholder="邮件里那串数字" />
          <Field label="新密码" value={password} onChange={setPassword} secure placeholder="至少 6 位" />
          {busy
            ? <ActivityIndicator color={UI.accent} style={{ marginVertical: 10 }} />
            : <Btn label="确认新密码" primary onPress={confirmNewPassword} />}
          <Pressable style={styles.linkBtn} onPress={() => { setStep('input'); setPending(null); }}>
            <Text style={styles.linkText}>‹ 返回</Text>
          </Pressable>
        </View>
      )}

      {!!note && <Text style={styles.note}>{note}</Text>}

      <Text style={styles.note}>
        不登录也能照常玩，数据留在这台设备。登录后才会跨设备同步
        （好感度 / 金币 / 记忆）。{'\n'}
        API 私钥无论登不登录都**只存在本机**，永远不会上传。
      </Text>
    </ScrollView>
  );
}

function Row({ k, v }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowK}>{k}</Text>
      <Text style={styles.rowV}>{v}</Text>
    </View>
  );
}

function Field({ label, value, onChange, secure, placeholder, keyboard }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={!!secure}
        autoCapitalize="none"
        keyboardType={keyboard || 'default'}
        placeholder={placeholder}
        placeholderTextColor="#8B8CA3"
      />
    </View>
  );
}

function Btn({ label, onPress, primary, danger }) {
  return (
    <Pressable
      style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger]}
      onPress={onPress}
    >
      <Text style={[styles.btnText, primary && styles.btnTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  inner: { paddingBottom: 32 },
  center: { padding: 40, alignItems: 'center', gap: 10 },
  subTitle: { fontSize: 16, fontWeight: '800', color: UI.text, marginBottom: 14 },
  note: { fontSize: 12, color: UI.textDim, lineHeight: 19, marginTop: 14 },

  tabs: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tab: {
    flex: 1, paddingVertical: 9, borderRadius: UI.radius,
    borderWidth: 1, borderColor: UI.hairline, backgroundColor: UI.surfaceHi, alignItems: 'center',
  },
  tabOn: { borderColor: UI.accentLine, backgroundColor: UI.surfaceTop },
  tabText: { fontSize: 12.5, fontWeight: '700', color: UI.textDim },
  tabTextOn: { color: UI.text },

  card: { backgroundColor: UI.surfaceHi, borderRadius: UI.radius, borderWidth: 1, borderColor: UI.hairline, padding: 14 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 11.5, fontWeight: '700', color: UI.textDim, marginBottom: 6 },
  input: {
    backgroundColor: UI.surfaceTop, borderRadius: UI.radius, paddingHorizontal: 13, paddingVertical: 11,
    fontSize: inputFont(14), color: UI.text,   // <16 会让 iOS Safari 聚焦时整页放大
  },

  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: UI.hairline },
  rowK: { fontSize: 13, color: UI.textDim, fontWeight: '700' },
  rowV: { fontSize: 13, color: UI.text, fontWeight: '700' },

  btn: {
    marginTop: 6, paddingVertical: 12, borderRadius: UI.radius,
    borderWidth: 1, borderColor: UI.hairline, backgroundColor: UI.surfaceTop, alignItems: 'center',
  },
  btnPrimary: { backgroundColor: UI.accent, borderColor: UI.accent },
  btnDanger: { borderColor: UI.danger },
  btnText: { fontSize: 14, fontWeight: '800', color: UI.text },
  btnTextPrimary: { color: '#fff' },

  linkBtn: { marginTop: 12, alignItems: 'center' },
  linkText: { fontSize: 12.5, color: UI.textDim, fontWeight: '700', textDecorationLine: 'underline' },
});
