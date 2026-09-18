// 原生端 3D 渲染：expo-gl 提供 WebGL 上下文，three 通过 canvas 垫片接管
// 注意：three r16x 之后只支持 WebGL2。绝大多数 2019 年后的真机都支持，
// 万一不支持会走 onError → 父组件降级显示卡面立绘。

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { GLView } from 'expo-gl';
import * as THREE from 'three';
import { createCompanionScene } from '../three/companion';
import { getPersona } from '../theme';

const Avatar3D = forwardRef(function Avatar3D({ personaId, onError }, ref) {
  const compRef = useRef(null);

  useImperativeHandle(ref, () => ({
    react: (kind) => compRef.current?.react(kind),
    setLookTarget: (x, y) => compRef.current?.setLookTarget(x, y),
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
