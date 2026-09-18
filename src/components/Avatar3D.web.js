// Web 端 3D 渲染（Expo 的 react-native-web 环境下，View 会渲染成真实 DOM 节点）
// Metro 在 web 打包时会自动优先选中这个 .web.js

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';
import * as THREE from 'three';
import { createCompanionScene } from '../three/companion';
import { loadCompanionModel } from '../lib/companionModel';
import { getPersona } from '../theme';

const Avatar3D = forwardRef(function Avatar3D({ personaId, onError }, ref) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);

  useImperativeHandle(ref, () => ({
    react: (kind) => sceneRef.current?.react(kind),
    setLookTarget: (x, y) => sceneRef.current?.setLookTarget(x, y),
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
      loadCompanionModel(comp, personaId).then((r) => {
        if (!r.ok) console.info('[Avatar3D.web] 使用程序化角色：', r.reason);
      }).catch(() => {});

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
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      globalThis.removeEventListener?.('resize', sizeTo);
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
