// 原生端 3D 渲染：expo-gl 提供 WebGL 上下文，three 通过 canvas 垫片接管
// 注意：three r16x 之后只支持 WebGL2。绝大多数 2019 年后的真机都支持，
// 万一不支持会走 onError → 父组件降级显示卡面立绘。

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { GLView } from 'expo-gl';
import * as THREE from 'three';
import { createCompanionScene } from '../three/companion';
// ⚠️ 这个 import 之前是漏的。它在 try 块里被调到，ReferenceError 会被 catch 吞掉
//    再走 onError —— 表现是"原生端 3D 直接降级成静态卡面"，而且不报有用的错。
import { loadCompanionModel } from '../lib/companionModel';
import { getPersona } from '../theme';

const Avatar3D = forwardRef(function Avatar3D({ personaId, onError }, ref) {
  const compRef = useRef(null);

  useImperativeHandle(ref, () => ({
    react: (kind) => compRef.current?.react(kind),
    setLookTarget: (x, y) => compRef.current?.setLookTarget(x, y),
    /** 开始"说"一句 —— 只做口型，声音由 voice/session 那条线出 */
    speak: (text, opts) => compRef.current?.speak(text, opts),
    /** 闭嘴（打断 / 播完 / 切屏都要调，否则嘴会一直动） */
    stopSpeaking: () => compRef.current?.stopSpeaking(),
    /** 直接给面部表情（不依赖 TTS） */
    setFaceEmotion: (tag) => compRef.current?.setFaceEmotion(tag),
    hasFace: () => !!compRef.current?.hasFace?.(),

    // --- 相机：单指拖空白区转、双指捏合缩放、双指上下拖平移 -----------------
    orbitByPixels: (dx, dy, viewH) => compRef.current?.orbitByPixels(dx, dy, viewH),
    zoomBy: (mult) => compRef.current?.zoomBy(mult),
    panByPixels: (dy, viewH) => compRef.current?.panByPixels(dy, viewH),
    resetCamera: () => compRef.current?.resetCamera(),
    cameraMoved: () => !!compRef.current?.cameraMoved?.(),

    // --- 戳中判定 + 待机姿势 ------------------------------------------------
    /** @returns {null | {part:'head'|'body', point, distance}} null = 戳空了 */
    hitTest: (ndcX, ndcY) => compRef.current?.hitTest(ndcX, ndcY) ?? null,
    setPoseState: (tag) => compRef.current?.setPoseState(tag),
    playPose: (id) => compRef.current?.playPose(id),
    currentPose: () => compRef.current?.currentPose?.() ?? null,
  }));

  useEffect(() => {
    return () => {
      try {
        compRef.current?.dispose();
      } catch (_) {}
      compRef.current = null;
    };
  }, [personaId]);

  const onContextCreate = async (gl) => {
    let renderer, raf, disposed = false;
    try {
      const persona = getPersona(personaId);
      const comp = createCompanionScene(persona);
      compRef.current = comp;

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      comp.resize(width, height);

      renderer = new THREE.WebGLRenderer({
        // three 需要一个"像 canvas 的对象"，这里给它一个最小垫片
        canvas: {
          width,
          height,
          style: {},
          addEventListener: () => {},
          removeEventListener: () => {},
          getContext: () => gl,
        },
        context: gl,
        alpha: true,
        antialias: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);

      // 真实 glb 模型异步挂载：先让程序化角色顶上，模型好了再热替换。
      // 这条路里任何一步失败都不会影响已经在跑的渲染循环。
      loadCompanionModel(comp, personaId).then((r) => {
        if (!r.ok) console.info('[Avatar3D.native] 使用程序化角色：', r.reason);
      }).catch(() => {});

      let last = Date.now();
      let elapsed = 0;
      const loop = () => {
        if (disposed) return;
        raf = requestAnimationFrame(loop);
        const now = Date.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        elapsed += dt;
        comp.update(elapsed, dt);
        renderer.render(comp.scene, comp.camera);
        gl.endFrameEXP?.();
      };
      raf = requestAnimationFrame(loop);
    } catch (e) {
      console.warn('[Avatar3D.native] GL init failed', e);
      onError?.(e);
    }

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      try {
        renderer?.dispose();
        compRef.current?.dispose();
      } catch (_) {}
    };
  };

  return (
    <GLView
      style={{ flex: 1, width: '100%', height: '100%', backgroundColor: 'transparent' }}
      onContextCreate={onContextCreate}
      pointerEvents="none"
    />
  );
});

export default Avatar3D;
