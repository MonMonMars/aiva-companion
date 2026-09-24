// 主界面：3D 互动舞台 + 养成面板
// ---------------------------------------------------------------------------
// 手势分三种，靠"按下那一刻有没有戳中模型"和"手指数量"区分：
//   单指 + 戳中模型 → 戳她（头=摸头，身子=戳），划动变抚摸，会出声
//   单指 + 空背景   → 绕着她转视角（orbit）
//   双指            → 捏合缩放 + 上下平移画面
//
// 判定"戳没戳中"用的是 3D 射线检测（Avatar3D.hitTest），不是按屏幕分区 ——
// 分区方案在用户转了视角之后就完全对不上了，射线不会。
//
// ⚠️ 多点触控只能从 nativeEvent.touches 里拿：locationX/Y 永远只有第一根手指。
//    某些平台/版本不吐 touches，下面做了降级（退化成单指），不会崩。

import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, Image,
  Platform, ActivityIndicator, Alert, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Avatar3D from '../components/Avatar3D';
import { useVoice } from '../useVoice';
import {
  getPersona, pick, UI, inputFont,
  levelFromAffection, LEVEL_TITLES,
} from '../theme';
import { useStore } from '../useStore';
import * as S from '../store';
import { personaLine } from '../voice/cantonese';
import { resolveBackground } from '../backgrounds';
import { pickImage } from '../pickImage';
import { markInteractive } from '../lib/preload';
import { chatWithTools } from '../chatEngine';
import { stripEmotionTags } from '../voice/tts';
import { scheduleReminder } from '../services/reminders';

const TAP_MOVE = 10;      // px，单指最多划这么多才算「点」(tap)，超过就当「划」(scroll/转视角)

const { width: SW } = Dimensions.get('window');

/**
 * 主界面只有三样东西：全屏的她、一条输入条、顶栏两个入口。
 * 送礼 / 记忆 / 签到 / 设置 / 换人换背景全部搬到菜单页和角色选择页去了。
 *
 * @param {object} props
 * @param {()=>void} props.onMenu   右上角 ☰ → 菜单页
 * @param {()=>void} props.onSwitch 左上角名字 → 角色/舞台选择页
 * @param {object}   props.avatarRef 由 App 持有：菜单页要能"回正视角"，
 *                   所以 3D 的 ref 不能只活在 Home 里
 */
export default function Home({ personaId, onChat, onMenu, onSwitch, comeback, avatarRef: avatarRefProp }) {
  const snap = useStore();
  const persona = useMemo(() => getPersona(personaId), [personaId]);

  // 首屏就绪：输入框和"她说的话"这两样已经画出来了。
  // 这一句是渐进加载的闸门 —— 在这之前，3D 模型解析 / 后台预热一律不跑
  // （见 src/lib/preload.js）。放在 requestAnimationFrame 里是为了确保
  // 真的是"画完之后"，而不是 effect 一开始。
  useEffect(() => {
    let raf = 0;
    let t = 0;
    raf = requestAnimationFrame(() => { t = setTimeout(markInteractive, 0); });
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, []);

  const ownAvatarRef = useRef(null);
  const avatarRef = avatarRefProp || ownAvatarRef;
  const touchRef = useRef({ x: 0, y: 0, t: 0, active: false, moved: false });
  const stageRef = useRef(null);

  const [bubble, setBubble] = useState('');
  const [glFailed, setGlFailed] = useState(false);
  const [floaters, setFloaters] = useState([]); // "+5 亲密" 飘字

  const voice = useVoice({
    personaId,
    snap,
    history: snap.history || [],
    kidMode: !!snap.config?.kidMode,
    lang: snap.config?.spokenLang || 'auto',
    // 传进去让"开始播某段音频"能同步驱动 3D 角色的口型
    avatarRef,
  });

  // 三个 Key 里有一个能通就能说话。没有的话 UI 要明说原因，而不是让用户对着按钮干点。
  const voiceCfgReady = useMemo(() => {
    const v = snap.config?.voice || {};
    return !!(v.openaiKey || (v.azureKey && v.azureRegion) || v.elevenKey);
  }, [snap.config]);

  const level = levelFromAffection(snap.affection);
  const levelTitle = LEVEL_TITLES[level - 1] || '陌生';

  // 粤语模式下，"打招呼 / 自己开口 / 被摸"这些台词都要走粤语库 ——
  // 之前这里直接用 persona.voice.*（普通话兜底），结果是
  // "戳一下讲粤语、打招呼讲普通话"的撕裂感。personaLine 没写粤语时会自己退回普通话，
  // 所以这样改不会让任何角色没台词。
  const lang = snap.config?.spokenLang || 'zh-HK';

  // 进场：打招呼 / 久别重逢
  useEffect(() => {
    const t = setTimeout(() => {
      if (comeback?.isLongAbsence) setBubble(personaLine(persona, 'lowMood', lang) || pick(persona.voice.lowMood));
      else setBubble(personaLine(persona, 'greet', lang) || persona.greet);
    }, 350);
    return () => clearTimeout(t);
  }, [personaId]);

  // 闲聊：长时间没互动她会自己开口。
  // 一半概率连声音一起出 —— 只出字幕的话，"她会自己找我讲话"这件事感不到温度。
  useEffect(() => {
    const iv = setInterval(() => {
      if (Date.now() - touchRef.current.t < 25000) return;
      const line = personaLine(persona, 'idle', lang);
      setBubble(line);
      if (line && Math.random() < 0.5) voice.say(line);
    }, 26000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  // 升级：保持等级在后台累计，但**不弹任何升级提示**（Simon：摸头时不要显示升级）。
  // 只保留角色一个小动作反应；飘字 / 台词气泡一律不弹。
  const prevLevel = useRef(level);
  useEffect(() => {
    if (level > prevLevel.current) {
      avatarRef.current?.react('levelup');
    }
    prevLevel.current = level;
  }, [level]);

  // 待机姿势跟着 App 状态走：
  //   模型还没挂上 → load（安静等着，幅度最小）
  //   等大模型回包 / 在听你说话 → think
  //   其余 → idle（站着发呆，会自己换姿势）
  // 骨架是异步绑上来的（glb 要解析），所以这里轮询一下再切状态。
  const modelReadyRef = useRef(false);
  useEffect(() => {
    avatarRef.current?.setPoseState?.('load');
    let n = 0;
    const iv = setInterval(() => {
      n++;
      // 最多等 ~8s，等不到也照常用程序化角色站着
      if (avatarRef.current?.hasRig?.() || n > 26) {
        clearInterval(iv);
        modelReadyRef.current = true;
        avatarRef.current?.setPoseState?.(
          voice.state === 'thinking' || voice.state === 'recording' ? 'think' : 'idle'
        );
      }
    }, 300);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  // speaking → 'speak'：说话时换一套"边说边点头 / 比手势"的小动作池，
  // 比一直用 idle 那套大动作自然得多（idle 的动作幅度是按"发呆"调的，
  // 说话时做伸懒腰那种动作非常出戏）。
  useEffect(() => {
    if (!modelReadyRef.current) return;
    avatarRef.current?.setPoseState?.(
      voice.state === 'speaking' ? 'speak'
        : (voice.state === 'thinking' || voice.state === 'recording') ? 'think' : 'idle'
    );
  }, [voice.state]);

  const pushFloater = (text, color) => {
    const id = Date.now() + Math.random();
    setFloaters((f) => [...f, { id, text, color }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 1400);
  };

  const haptic = (style) => {
    if (Platform.OS === 'web') return;
    try {
      Haptics.impactAsync(style || Haptics.ImpactFeedbackStyle.Light);
    } catch (_) {}
  };

  // --- 手势：单指点 = 戳/摸，单指划 = 转视角，双指 = 缩放平移 -----------------------------
  const gesRef = useRef({
    mode: null,        // 'body'（命中身体、等松手判断 tap）| 'orbit' | 'pinch'
    part: null,        // hitTest 命中的部位：'head' | 'body'
    startX: 0, startY: 0,
    lastDist: 0,
    lastCenterY: 0,
  });
  const [camMoved, setCamMoved] = useState(false);

  /** 拿到这一刻所有手指。没有 touches 就退化成单指（某些平台不吐多点数据） */
  const touchList = (e) => {
    const ne = e.nativeEvent || {};
    if (Array.isArray(ne.touches) && ne.touches.length) {
      return ne.touches.map((t) => ({ x: t.locationX ?? 0, y: t.locationY ?? 0 }));
    }
    return [{ x: ne.locationX ?? 0, y: ne.locationY ?? 0 }];
  };
  const ndcX = (x) => (x / (layout.w || SW)) * 2 - 1;
  const ndcY = (y) => -(((y / (layout.h || SW)) * 2 - 1));   // WebGL 的 NDC 向上为正
  const lookAt = (x, y) => avatarRef.current?.setLookTarget?.(ndcX(x), ndcY(y));
  const pinchDist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

  /** 戳中模型：给反应姿势 + 台词 + 出声 */
  const pokeAt = (part) => {
    const isHead = part === 'head';
    // 抢占播一个反应姿势（被戳一激灵 / 被摸往你这边靠）
    avatarRef.current?.playPose?.(isHead ? 'pet-lean' : 'startle');
    avatarRef.current?.react?.(isHead ? 'pet' : 'poke');
    haptic(isHead ? Haptics.ImpactFeedbackStyle.Soft : Haptics.ImpactFeedbackStyle.Rigid);

    if (isHead) {
      const r = S.pet(1);
      if (!r.ok) {
        setBubble(r.line);
        pushFloater('精力不足', '#B9A0B4');
        return;
      }
      // 不再弹出「+X 亲密」—— 摸头只保留出声 + 台词 + 反应姿势
      // 粤语模式下念粤语台词（气泡和出声用同一句，不然字幕和声音对不上）
      const petLine = personaLine(persona, 'pet', lang);
      if (Math.random() < 0.38) setBubble(petLine);
      // 摸头是连续动作，不能每一下都出声，三分之一的概率才开口
      if (Math.random() < 0.34) voice.say(petLine);
    } else {
      const r = S.poke();
      setBubble(r.line);
      // 戳是离散动作，每次都出声
      voice.say(r.line);
    }
  };

  const onGrant = (e) => {
    const pts = touchList(e);
    const p = pts[0];
    if (!p) return;

    touchRef.current.active = true;
    touchRef.current.x = p.x;
    touchRef.current.y = p.y;
    touchRef.current.t = Date.now();
    touchRef.current.moved = false;
    lookAt(p.x, p.y);

    if (pts.length >= 2) {
      // 双指：捏合缩放 + 上下平移
      gesRef.current.mode = 'pinch';
      gesRef.current.lastDist = pinchDist(pts[0], pts[1]);
      gesRef.current.lastCenterY = (pts[0].y + pts[1].y) / 2;
      return;
    }

    // 单指：先问 3D 场景"这一下戳中身体了吗"。
    // ⚠️ 不立刻戳 —— 要等松手时判断这是「点（tap）」还是「划（scroll/拖动）」。
    //    tap = 戳/摸；划 = 转视角（Simon：tap on the body is poke / scroll on the body is rotate）。
    const hit = avatarRef.current?.hitTest?.(ndcX(p.x), ndcY(p.y));
    gesRef.current.startX = p.x;
    gesRef.current.startY = p.y;
    if (hit) {
      gesRef.current.mode = 'body';
      gesRef.current.part = hit.part;
    } else {
      gesRef.current.mode = 'orbit';
    }
  };

  const onMove = (e) => {
    if (!touchRef.current.active) return;
    const pts = touchList(e);
    const p = pts[0];
    if (!p) return;
    const h = layout.h || SW;
    lookAt(p.x, p.y);

    if (pts.length >= 2) {
      // 单指中途变双指：先重新取基准，别把上一帧的距离带进来（会瞬移）
      if (gesRef.current.mode !== 'pinch') {
        gesRef.current.mode = 'pinch';
        gesRef.current.lastDist = pinchDist(pts[0], pts[1]);
        gesRef.current.lastCenterY = (pts[0].y + pts[1].y) / 2;
        return;
      }
      const d = pinchDist(pts[0], pts[1]);
      const cy = (pts[0].y + pts[1].y) / 2;
      if (gesRef.current.lastDist > 1 && d > 1) {
        avatarRef.current?.zoomBy?.(gesRef.current.lastDist / d);
      }
      avatarRef.current?.panByPixels?.(cy - gesRef.current.lastCenterY, h);
      gesRef.current.lastDist = d;
      gesRef.current.lastCenterY = cy;
      return;
    }

    // 单指：命中身体后若划动超过「点」的阈值，就当成划动 → 转视角
    if (gesRef.current.mode === 'body') {
      const movedDist = Math.hypot(p.x - gesRef.current.startX, p.y - gesRef.current.startY);
      if (movedDist > TAP_MOVE) {
        gesRef.current.mode = 'orbit';
        touchRef.current.x = p.x;   // 重置基准，避免第一帧转视角跳一下
        touchRef.current.y = p.y;
        touchRef.current.moved = true;
      } else {
        return;                     // 还在阈值内，先不动作，等松手判断 tap
      }
    }

    if (gesRef.current.mode === 'orbit') {
      // 划动 = 转视角（空白背景或身体上划都算转）
      avatarRef.current?.orbitByPixels?.(p.x - touchRef.current.x, p.y - touchRef.current.y, h);
      touchRef.current.x = p.x;
      touchRef.current.y = p.y;
      touchRef.current.moved = true;
    }
  };

  const onRelease = () => {
    // 单指「点」中身体且全程没划动 = 一次戳/摸
    if (gesRef.current.mode === 'body' && !touchRef.current.moved) {
      pokeAt(gesRef.current.part);
    }
    gesRef.current.mode = null;
    gesRef.current.part = null;
    touchRef.current.active = false;
    avatarRef.current?.setLookTarget?.(0, 0);
    // 视角被转过了才显示"回正"按钮，没转过就别碍事
    setCamMoved(!!avatarRef.current?.cameraMoved?.());
  };

  // 桌面滚轮：在角色身上滚动 = 转视角（Simon：scroll on the body is rotate）。
  // 触控板双指捏合会带 ctrlKey，那种情况当缩放处理。
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof el.addEventListener !== 'function') return;
    const onWheel = (e) => {
      e.preventDefault();
      const h = layout.h || SW;
      if (e.ctrlKey) {
        avatarRef.current?.zoomBy?.(Math.exp(-e.deltaY * 0.0015));
      } else {
        avatarRef.current?.orbitByPixels?.(e.deltaX, e.deltaY, h);
        setCamMoved(true);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // -------------------------------------------------------------------------
  // Grok 式前台：屏幕上只留「角色 + 一条输入条」，其余全部收进菜单页
  // -------------------------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attach, setAttach] = useState(null); // { name, uri }

  /** 📎：把一张图贴进这条消息一起发出去（换背景在角色选择页里做） */
  const onPickFile = () => {
    const ok = pickImage((f) => setAttach({ name: f.name, uri: f.uri }));
    if (!ok) Alert.alert('暂不支持', '上传图片目前只在网页端可用。');
  };

  const canSend = !sending && (!!draft.trim() || !!attach);

  /** 输入条发送：走和大模型同一条链路，回包直接念出来 */
  const onSend = async () => {
    if (!canSend) return;
    const typed = draft.trim();
    const payload = attach ? `${typed ? `${typed} ` : ''}[图片] ${attach.name}` : typed;
    setDraft('');
    setAttach(null);
    setSending(true);
    setBubble('…');
    try {
      const cfg = snap.config || {};
      const res = await chatWithTools({
        config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        personaId,
        snap,
        history: S.getHistory(personaId),
        userText: payload,
        kidMode: !!cfg.kidMode,
        lang: cfg.spokenLang || 'zh-HK',
        ctx: {
          search: { provider: cfg.voice?.searchProvider || 'none', keys: cfg.voice || {} },
          city: cfg.voice?.defaultCity || '',
          onRemember: (fact) => S.remember(fact),
          onReminder: async (title, mins) => scheduleReminder(title, mins),
          onSong: async () => '我们一起唱！',
          // 让角色真的动起来：跳舞 / 功夫 / 翻滚 / 坐下，由模型自己决定什么时候用
          onMotion: (kind) => companionRef.current?.playMotion(kind),
        },
      });
      const raw = res && res.ok && res.raw ? res.raw : '嗯…我这边没接上，你再说一次？';
      S.appendMessage(personaId, { role: 'user', content: payload, ts: Date.now() });
      S.appendMessage(personaId, { role: 'assistant', content: stripEmotionTags(raw), ts: Date.now() });
      S.rewardChat();
      setBubble(stripEmotionTags(raw));
      voice.say(raw, { force: true });
    } catch (e) {
      setBubble('刚才没接上，再说一次？');
    } finally {
      setSending(false);
    }
  };

  // 能当陪伴角色的才列出来：模型商条目（deepseek/kimi…）没有 voice，
  // 选了会在 pick(persona.voice.idle) 那一行直接崩。
  const bgColors = resolveBackground(snap.config?.bgId, persona);
  const bgImage = snap.config?.bgImage || '';
  // 说话时优先显示她正在念的这句（原来这里直接写 subtitle，但 subtitle 没声明 ——
  // 只在 idle 分支不会被求值才一直没炸，一旦开口就会 ReferenceError）
  const spoken = voice.state === 'idle' ? bubble : (voice.subtitle || bubble);

  // 输入条上方只留最近几轮对话，越往上越淡，顶部自然消失。
  // 两个约束：总行数压在 4 行内（不然 3D 舞台被挤没），
  // 且最新那句如果正被下面的气泡念着就跳过 —— 否则同一句话上下重复一遍。
  // 完整记录仍在菜单页「聊天记录」里，这里只是"刚聊了什么"的余光。
  const transcript = useMemo(() => {
    const h = Array.isArray(snap.history) ? snap.history : [];
    const said = String(spoken || '').trim();
    const out = [];
    let lines = 0;
    for (let i = h.length - 1; i >= 0 && out.length < 4; i--) {
      const m = h[i];
      const c = typeof m?.content === 'string' ? m.content.trim() : '';
      if (!c) continue;
      if (out.length === 0 && said && m.role === 'assistant' && c === said) continue;
      const est = Math.max(1, Math.min(2, Math.ceil(c.length / 18)));
      if (out.length && lines + est > 4) break;
      lines += est;
      out.push({ key: `${m.ts || i}#${i}`, role: m.role, text: c });
    }
    return out.reverse();
  }, [snap.history, spoken]);

  return (
    <View style={styles.root}>
      {/* 背景：自定义图片优先，否则用预设渐变 */}
      {bgImage ? (
        <Image source={{ uri: bgImage }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <LinearGradient colors={bgColors} locations={[0, 0.34, 0.72, 1]} style={StyleSheet.absoluteFill} />
      )}
      {/* 上下压一层暗角：顶栏和输入条是白字，浅色背景上会糊掉 */}
      <LinearGradient
        colors={['rgba(0,0,0,0.45)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.42)']}
        locations={[0, 0.24, 0.6, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* 顶栏：左 = 角色 + 状态（点开换人 / 换舞台）　右 = 菜单页。
          前台只留这两个入口，其余功能全在菜单页里。 */}
      <View style={styles.topBar}>
        <Pressable style={styles.who} onPress={() => onSwitch?.()}>
          <Text style={styles.whoName} numberOfLines={1}>{persona.name}</Text>
          <Text style={styles.whoSub} numberOfLines={1}>
            {`LV.${level} ${levelTitle} · 心情 ${Math.round(snap.mood)}% · 第 ${snap.days} 天 ▾`}
          </Text>
        </Pressable>
        <Pressable style={styles.menuBtn} onPress={() => onMenu?.()}>
          <Text style={styles.menuBtnText}>☰</Text>
        </Pressable>
      </View>

      {/* 3D 舞台：吃掉顶栏和输入条之外的全部空间。
          戳/摸/转视角/缩放全在这块上，前台不放任何按钮。 */}
      <View
        ref={stageRef}
        style={styles.stage}
        onLayout={(e) => {
          layout.w = e.nativeEvent.layout.width;
          layout.h = e.nativeEvent.layout.height;
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={onRelease}
      >
        {glFailed ? (
          <View style={styles.fallback}>
            <Text style={styles.fallbackEmoji}>{persona.emoji}</Text>
            <Text style={styles.fallbackNote}>当前设备不支持 WebGL2，已降级显示</Text>
          </View>
        ) : (
          <Avatar3D ref={avatarRef} personaId={personaId} onError={() => setGlFailed(true)} />
        )}

        {/* 飘字 */}
        <View style={styles.floaterLayer} pointerEvents="none">
          {floaters.map((f) => (
            <Text key={f.id} style={[styles.floater, { color: f.color }]}>
              {f.text}
            </Text>
          ))}
        </View>
      </View>

      {/* 她说的话 / 语音状态：浮在输入条上方，不占控件位，也不挡手势 */}
      <View style={styles.saidWrap} pointerEvents="none">
        {/* 最近几轮对话：只留几行，越往上越淡。
            整块 pointerEvents 由父级统一关掉 —— 它盖在 3D 舞台下缘，
            漏了这行就会吃掉那一块的拖动转视角手势。 */}
        {transcript.length > 0 && (
          <View style={styles.transcript} nativeID="aiva-transcript">
            {transcript.map((m, i) => (
              <Text
                key={m.key}
                numberOfLines={2}
                nativeID={`aiva-tline-${i}`}
                style={[
                  styles.tLine,
                  m.role === 'user' ? styles.tUser : styles.tHer,
                  // 越旧越淡：最顶上那行几乎看不见，读起来就是"往上淡出"
                  { opacity: transcript.length === 1 ? 0.9 : 0.2 + (i / (transcript.length - 1)) * 0.7 },
                ]}
              >
                <Text style={styles.tWho}>{m.role === 'user' ? '你' : persona.name}　</Text>
                {m.text}
              </Text>
            ))}
          </View>
        )}
        {!!voice.error && (
          <Text style={styles.saidErr} numberOfLines={2}>{voice.error}</Text>
        )}
        {voice.state !== 'idle' && (
          <Text style={styles.saidState} numberOfLines={1}>
            {voice.state === 'recording' ? '我在听… 说完停一下会自动发出去'
              : voice.state === 'thinking' ? '在想…'
                : '开口就能打断我'}
          </Text>
        )}
        {!!spoken && (
          <Text style={styles.saidText} numberOfLines={3}>{spoken}</Text>
        )}
      </View>

      {/* 底部输入条：文件 · 输入 · 麦克风 · 发送 */}
      <View style={styles.dock}>
        <Pressable style={styles.dockBtn} onPress={() => onPickFile('attach')}>
          <Text style={styles.dockIcon}>📎</Text>
        </Pressable>

        <View style={styles.inputBox}>
          {!!attach && (
            <Text style={styles.attachChip} numberOfLines={1}>🖼 {attach.name}</Text>
          )}
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={voiceCfgReady ? '跟她说点什么…' : '跟她说点什么…（语音 Key 在右上菜单里配）'}
            placeholderTextColor="rgba(255,255,255,0.5)"
            onSubmitEditing={onSend}
            returnKeyType="send"
            editable={!sending}
            multiline={false}
          />
        </View>

        <Pressable
          style={[styles.dockBtn, voice.state !== 'idle' && styles.dockBtnOn]}
          onPress={voice.toggle}
        >
          <Text style={styles.dockIcon}>
            {voice.state === 'recording' ? '⬛'
              : voice.state === 'speaking' ? '⏸️'
                : voice.state === 'thinking' ? '✳️' : '🎙️'}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.sendBtn, !canSend && { opacity: 0.35 }]}
          onPress={onSend}
          disabled={!canSend}
        >
          {sending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.sendIcon}>➤</Text>}
        </Pressable>
      </View>

    </View>
  );
}

// 舞台尺寸缓存（不想为此触发重渲染，所以放模块级）
const layout = { w: 0, h: 0 };

const styles = StyleSheet.create({
  root: { flex: 1 },

  // 顶栏：左 = 角色/状态（点开换人换背景），右 = 主菜单。
  // 半透明深底 + 白字：背景可能是浅色渐变，纯白字会糊。
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: Platform.select({ ios: 52, android: 34, default: 16 }),
    paddingBottom: 10,
  },
  who: { flexShrink: 1, paddingVertical: 4, paddingRight: 8 },
  whoName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 6,
  },
  whoSub: {
    fontSize: 11.5,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.82)',
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 5,
  },
  menuBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18,18,26,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  menuBtnText: { fontSize: 17, color: '#FFFFFF', fontWeight: '700' },

  // 舞台吃掉顶栏和输入条之间的全部空间
  // ⚠️ touchAction:'none' 不是装饰：
  //    没有它，iOS Safari 会把捏合抢去做**页面缩放**，双指一开就整页放大，
  //    而舞台自己的缩放（相机推拉）反而收不到 move 事件。
  //    同理单指拖会被浏览器当成滚动（橡皮筋回弹），转视角会一顿一顿。
  //    只加在舞台上 —— 菜单/设置里的 ScrollView 还要正常滚。
  stage: { flex: 1, touchAction: 'none' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  fallbackEmoji: { fontSize: 76 },
  fallbackNote: { fontSize: 12, color: UI.textDim },

  floaterLayer: { position: 'absolute', left: 0, right: 0, top: '18%', alignItems: 'center', gap: 6 },
  floater: {
    fontSize: 16,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowRadius: 8,
  },

  // ── 她说的话：浮在输入条上方 ──────────────────────────────────────────
  saidWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 92,
    alignItems: 'center',
    gap: 5,
  },
  // 最近几轮对话：贴着气泡上方，只占几行
  transcript: {
    alignSelf: 'stretch',
    gap: 2,
    marginBottom: 6,
  },
  tLine: {
    fontSize: 12.5,
    lineHeight: 18,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.92)',
    // 这行字直接压在 3D 画面上，没有描边的话浅色背景里会糊掉
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  tUser: { textAlign: 'right' },
  tHer: { textAlign: 'left' },
  tWho: {
    fontSize: 11,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.5)',
  },
  saidText: {
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 1 },
  },
  saidState: {
    fontSize: 11.5,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.85)',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 6,
  },
  saidErr: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#FFB3C0',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowRadius: 6,
  },

  // ── 底部输入条 ────────────────────────────────────────────────────────
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.select({ ios: 30, android: 18, default: 16 }),
  },
  dockBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18,18,26,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  dockBtnOn: {
    backgroundColor: 'rgba(255,43,78,0.55)',
    borderColor: 'rgba(255,255,255,0.6)',
  },
  dockIcon: { fontSize: 17, color: '#FFFFFF' },
  inputBox: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: 21,
    backgroundColor: 'rgba(18,18,26,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  input: {
    flex: 1,
    paddingVertical: 10,
    // 不能写死 14.5：iOS Safari 聚焦 <16px 的输入框会整页放大且不缩回
    fontSize: inputFont(14.5),
    color: '#FFFFFF',
    fontWeight: '600',
  },
  attachChip: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.8)',
    marginRight: 8,
    maxWidth: 90,
    fontWeight: '700',
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI.accent,
  },
  sendIcon: { fontSize: 16, color: '#fff', fontWeight: '800' },
});
