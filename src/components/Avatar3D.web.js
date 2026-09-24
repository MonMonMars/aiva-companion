// Web 端 3D 渲染（Expo 的 react-native-web 环境下，View 会渲染成真实 DOM 节点）
// Metro 在 web 打包时会自动优先选中这个 .web.js

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';
import * as THREE from 'three';
import { createCompanionScene } from '../three/companion';
import { loadCompanionModel } from '../lib/companionModel';
import { getPersona } from '../theme';
// ⚠️ 这两个 import 别删：模型加载和后台预热全靠它们排进渐进加载队列。
//    漏了就是 ReferenceError，被下面的 try/catch 吃掉 → 误报成"不支持 WebGL2"。
import { schedule } from '../lib/preload';
import { warmOtherModels } from '../lib/warmModels';
import { registerMotionBus } from '../anim/motionBus';

// 某些内嵌浏览器（包括部分 App 里的 webview）默认不开 WebGL。
// 先探一下，没有就直接走 onError → Home 的"已降级显示"兜底，
// 而不是让 three.js 抛一个看不懂的错、把整个页面弄白。
function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

const Avatar3D = forwardRef(function Avatar3D({ personaId, onError }, ref) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);

  useImperativeHandle(ref, () => ({
    react: (kind) => sceneRef.current?.react(kind),
    setLookTarget: (x, y) => sceneRef.current?.setLookTarget(x, y),
    /** 开始"说"一句 —— 只做口型，声音由 voice/session 那条线出 */
    speak: (text, opts) => sceneRef.current?.speak(text, opts),
    /** 闭嘴（打断 / 播完 / 切屏都要调，否则嘴会一直动） */
    stopSpeaking: () => sceneRef.current?.stopSpeaking(),
    /** 直接给面部表情（不依赖 TTS） */
    setFaceEmotion: (tag) => sceneRef.current?.setFaceEmotion(tag),
    /** 调试：表情驱动在不在 */
    hasFace: () => !!sceneRef.current?.hasFace?.(),

    // --- 相机：单指拖空白区转、双指捏合缩放、双指上下拖平移 -----------------
    orbitByPixels: (dx, dy, viewH) => sceneRef.current?.orbitByPixels(dx, dy, viewH),
    zoomBy: (mult) => sceneRef.current?.zoomBy(mult),
    panByPixels: (dy, viewH) => sceneRef.current?.panByPixels(dy, viewH),
    resetCamera: () => sceneRef.current?.resetCamera(),
    cameraMoved: () => !!sceneRef.current?.cameraMoved?.(),

    // --- 戳中判定 + 待机姿势 ------------------------------------------------
    /** @returns {null | {part:'head'|'body', point, distance}} null = 戳空了 */
    hitTest: (ndcX, ndcY) => sceneRef.current?.hitTest(ndcX, ndcY) ?? null,
    /** 切换待机姿势池：idle 站着发呆 / think 在想事 / load 加载等待 */
    setPoseState: (tag) => sceneRef.current?.setPoseState(tag),
    /** 抢占播一个反应姿势，如 'startle' / 'pet-lean' */
    playPose: (id) => sceneRef.current?.playPose(id),
    currentPose: () => sceneRef.current?.currentPose?.() ?? null,
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer, comp, raf, ro, disposed = false;
    let sizeTo = () => {};

    try {
      const persona = getPersona(personaId);
      comp = createCompanionScene(persona);
      sceneRef.current = comp;
      // 登记到动作总线：语音会话（useVoice）拿不到 ref，只能走这条模块级通道
      const unbus = registerMotionBus((kind) => comp.playMotion(kind));

      if (!webglSupported()) {
        const e = new Error('当前浏览器/内嵌浏览器未开启 WebGL，无法渲染 3D');
        // 让 onError 触发 → Home 切到"已降级显示"兜底面，而不是白屏
        onError?.(e);
        return;
      }

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.setClearColor(0x000000, 0);

      const canvas = renderer.domElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      // 关键：不调整尺寸，否则 three 会写 inline style 覆盖 RNW 的布局
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(canvas);

      sizeTo = () => {
        const w = host.clientWidth || 300;
        const h = host.clientHeight || 300;
        renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        comp.resize(w, h);
      };
      sizeTo();

      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(sizeTo);
        ro.observe(host);
      } else {
        globalThis.addEventListener?.('resize', sizeTo);
      }

      // 真实 glb 模型是异步挂上来的：先有程序化角色顶着，模型到位后热替换。
      // 任何一步失败都只是降级（见 loadCompanionModel），不会影响已经在跑的渲染循环。
      //
      // ⚠️ 这里**不直接 await**，而是丢进渐进加载队列（src/lib/preload.js）：
      //   kizuna 那个 glb 有 7.4MB，GLTFLoader.parse 是同步吃 CPU 的，
      //   放在挂载流程里会把首屏堵住几百毫秒 —— 输入框要等它跑完才真正能点。
      //   现在先让 Home 画出来（它一挂载就 markInteractive），
      //   模型紧接着以最高优先级补上，视觉上就是"人先出来、脸过半秒变清晰"。
      schedule({
        id: 'model',
        label: '加载 3D 模型',
        priority: 100,
        force: true,           // 换角色时这条要能重跑，否则人换不了
        run: async () => {
          if (disposed) return;  // 组件已经卸载：别往一个已释放的场景里塞模型
          const r = await loadCompanionModel(comp, personaId);
          if (!r.ok) console.info('[Avatar3D.web] 使用程序化角色：', r.reason);
        },
      });

      // 动作库（跳舞 / 功夫，289KB JSON）**不进首屏**：排在主角模型后面、
      // 优先级压到最低。用户开始打字聊天的那几秒它就悄悄下好了，
      // 等真的说"跳个舞"时是秒开 —— 而首屏为此付出的代价是 0。
      schedule({
        id: 'motion',
        label: '动作库',
        priority: 1,
        after: 'model',
        run: async () => {
          if (disposed) return;
          await comp.preloadMotion();
        },
      });

      // 后台预热剩下的 14 个角色模型。
      // warmOtherModels 内部用 after:'model' 排了依赖，所以这条就算先登记
      // 也不会抢在主角前面 —— 主角没上场之前，预热一个都不跑。
      warmOtherModels(personaId);

      // 调试口：让外部的自动化脚本（tools/_verify_lips.mjs）能直接驱动口型。
      // 只在 web 上挂，且不影响任何正常路径 —— 没有这个钩子，
      // "嘴到底会不会动"就只能靠人去点，没法进 CI。
      globalThis.__aivaDebug = {
        speak: (text, opts) => comp.speak(text, opts),
        stopSpeaking: () => comp.stopSpeaking(),
        setFaceEmotion: (tag) => comp.setFaceEmotion(tag),
        hasFace: () => !!comp.hasFace(),
        // 相机 / 戳中 / 姿势：让无头脚本能断言"转了视角""戳中了头"
        hitTest: (x, y) => comp.hitTest(x, y),
        // 摸头判不出来时先看它：headLine 必须落在角色身上，不能飘到背景板高度
        hitBounds: () => comp.hitBounds?.() ?? null,
        orbit: (dx, dy, h) => comp.orbitByPixels(dx, dy, h),
        zoom: (m) => comp.zoomBy(m),
        pan: (dy, h) => comp.panByPixels(dy, h),
        resetCamera: () => comp.resetCamera(),
        cameraMoved: () => comp.cameraMoved(),
        cameraPos: () => comp.camera.position.toArray().map((v) => Number(v.toFixed(3))),
        setPoseState: (t) => comp.setPoseState(t),
        playPose: (id) => comp.playPose(id),
        currentPose: () => comp.currentPose(),
        // 动作片段：跳舞 / 功夫。playMotion 是异步的（库没下好会先下）
        playMotion: (kind) => comp.playMotion(kind),
        stopMotion: () => comp.stopMotion(),
        motionReady: () => !!comp.motionReady?.(),
        currentMotion: () => comp.currentMotion?.() ?? null,
        getRig: () => comp.getRig?.() ?? null,
        /**
         * 关键骨的**世界高度**。用来查"按髋踝跨度归一化"有没有量错 ——
         * 真踩过：量出来 0.135m（成年人应该是 0.8~0.9m），根位移因此被缩小 6 倍。
         */
        boneY: () => {
          const rig = comp.getRig?.();
          if (!rig) return null;
          const out = {};
          for (const [k, o] of Object.entries(rig.mapping)) {
            if (!o) continue;
            const v = o.position.clone();
            o.getWorldPosition(v);
            out[k] = Number(v.y.toFixed(4));
          }
          return out;
        },
        /** 这个片段有没有接管下半身（腿被驱动 → 落地支撑让开） */
        motionLegs: () => !!comp.motionLegsDriven?.(),
        /**
         * 骨骼的**四元数**快照。
         * 为什么不能拿 boneDump 的欧拉角来比"动了多少"：欧拉三元组在 ±π 处
         * 会环绕，两根骨头明明只差 5°，分量差能算出 355°。四元数点积没有这个问题。
         */
        quatDump: () => {
          const rig = comp.getRig();
          if (!rig) return null;
          const out = {};
          for (const [k, o] of Object.entries(rig.mapping)) {
            if (!o) continue;
            out[k] = [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]
              .map((v) => Number(v.toFixed(5)));
          }
          return out;
        },
        hasRig: () => !!comp.hasRig(),
        /**
         * 脚离地多少米。「她浮着」这类问题截图看不出来 ——
         * 相机俯仰 + 地面圆盘 + 背景板都会骗人，只有骨头世界高度是硬证据。
         * footLift > 0.005 就是肉眼能看出来的飘。
         */
        groundInfo: () => comp.groundInfo?.() ?? null,
        // --- MakeHuman 档专用（眼球重绑 / 骨架表情）---------------------------
        /** 眼球有没有重绑到 eye.L / eye.R。false = 头一动眼睛就飞 */
        hasEyes: () => !!comp.hasEyes?.(),
        /** 眼球绑定的分派结果 + 每颗球的实测半径，用来断言"真的绑对了侧" */
        eyeInfo: () => {
          const r = comp.getEyeRig?.();
          if (!r) return null;
          const meshes = [];
          for (const [m, info] of r.measure || []) {
            meshes.push({
              name: m.name,
              radius: Number(info.meanR.toFixed(5)),
              isSphere: !!info.isSphere,
            });
          }
          return { sides: r.sides, meshes };
        },
        /** 骨架表情接上了哪些通道 */
        faceChannels: () => comp.getFaceRig?.()?.names ?? null,
        /** 当前每根表情骨转了多少度 —— 断言"嘴真的张开了" */
        faceAngles: () => comp.getFaceRig?.()?.boneAngles?.() ?? null,
        /** 当前表情通道的目标权重 */
        faceWeights: () => comp.getFaceRig?.()?.weights?.() ?? null,
        /** 按当前滑块状态刷新眼球尺寸，返回调整过的网格数 */
        resizeEyes: () => comp.resizeEyes?.() ?? 0,
        /** 已挂载的换装部件网格数；0 = 只有底座（身体+脸），没头发也没衣服 */
        partCount: () => (typeof comp.partCount === 'function' ? comp.partCount() : null),
        /** 当前生效的骨骼转角，用来断言"姿势真的摆上去了" */
        boneDump: () => {
          const rig = comp.getRig();
          if (!rig) return null;
          const out = {};
          for (const [k, o] of Object.entries(rig.mapping)) {
            if (!o) continue;
            out[k] = [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => Number(v.toFixed(4)));
          }
          return out;
        },
        /**
         * 临时把换装部件藏起来，只留底座（身体+脸）。
         * 用来在浏览器里肉眼验收"脱掉衣服后躯干是不是闭合的、有没有破洞" ——
         * 光看几何数据（12/12 扇区闭合）是推不出"看起来有没有洞"的。
         * @param {boolean} on true = 藏起头发和衣服
         */
        hideParts: (on = true) => {
          let n = 0;
          comp.scene.traverse((o) => {
            if (!o.isMesh || !o.userData.__aivaPart) return;
            o.userData.__aivaPartHidden = !!on;
            o.visible = !on;
            n++;
          });
          return n;
        },
        /** 当前所有 morph 权重里最大的几个，用来断言"嘴真的在动" */
        weights: () => {
          const out = {};
          comp.scene.traverse((o) => {
            if (!o.isMesh || !o.morphTargetInfluences) return;
            const dict = o.morphTargetDictionary || {};
            Object.keys(dict).forEach((name) => {
              const v = o.morphTargetInfluences[dict[name]];
              if (v > 0.005) out[name] = Number(v.toFixed(3));
            });
          });
          return out;
        },
      };

      let last = performance.now();
      let elapsed = 0;
      const loop = (now) => {
        if (disposed) return;
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        elapsed += dt;
        comp.update(elapsed, dt);
        renderer.render(comp.scene, comp.camera);
      };
      raf = requestAnimationFrame(loop);
    } catch (e) {
      console.warn('[Avatar3D.web] init failed', e);
      onError?.(e);
    }

    return () => {
      disposed = true;
      unbus?.();                 // 注销动作总线，别让旧场景继续接活
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      globalThis.removeEventListener?.('resize', sizeTo);
      if (globalThis.__aivaDebug) delete globalThis.__aivaDebug;
      sceneRef.current = null;
      try {
        comp?.dispose();
        renderer?.dispose();
        if (host && renderer?.domElement?.parentNode === host) {
          host.removeChild(renderer.domElement);
        }
      } catch (_) {}
    };
  }, [personaId]);

  return <View ref={hostRef} style={{ flex: 1, width: '100%', height: '100%' }} collapsable={false} pointerEvents="none" />;
});

export default Avatar3D;
