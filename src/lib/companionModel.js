/**
 * 把「真实 3D 模型」挂到角色场景上。
 *
 * 管线是这样的：
 *   assets/models/<id>.glb  ──require──>  bytes ──GLTFLoader.parse──> Object3D ──attachModel──> 舞台
 *   assets/models/<id>.jpg  ──require──>  bytes ──jpeg-js──────────> DataTexture ─applyTexture──> 材质
 *
 * 每一步都允许失败，并且失败时的表现是「降级」而不是「崩」：
 *   glb 挂不上  → 保留程序化角色（那个手搓的小人）
 *   jpg 解不了  → 模型以赛璐璐纯色显示
 * 所以对使用者来说最差的结果也只是「没那么好看」，不会出现白屏。
 */

import * as THREE from 'three';
import jpeg from 'jpeg-js';
import { readAssetBytes } from './assetBytes';

/**
 * 角色 → 模型资源。
 * 加第 4 个角色时：生成模型丢进 assets/models/，然后在这里补一行即可。
 * 注意：这些都是静态 require，Metro 在打包时解析 —— 文件不存在会直接构建失败，
 * 所以不要在这里引用还没生成的模型。
 */
export const PERSONA_MODELS = {
  girlfriend: {
    model: require('../../assets/models/girlfriend.glb'),
    texture: require('../../assets/models/girlfriend.jpg'),
  },
  boyfriend: {
    model: require('../../assets/models/boyfriend.glb'),
    texture: require('../../assets/models/boyfriend.jpg'),
  },
  secretary: {
    model: require('../../assets/models/secretary.glb'),
    texture: require('../../assets/models/secretary.jpg'),
  },
};

export const hasModel = (personaId) => !!PERSONA_MODELS[personaId];

/** 一张 1024² RGBA = 4MB，给上限防止将来换成大图时把低端机打爆 */
const DECODE_MEMORY_MB = 96;

function decodeToTexture(bytes) {
  const img = jpeg.decode(bytes, {
    useTArray: true,          // 必须：不给它用 Buffer，RN 里没有
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxMemoryUsageInMB: DECODE_MEMORY_MB,
  });

  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  // glTF 的 UV 原点在左上，DataTexture 默认 flipY=false，两者正好对上 —— 千万别 flip
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** GLTFLoader.parse 只吃正经 ArrayBuffer，而 subarray 出来的视图 byteOffset 可能不为 0 */
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * @param {object} comp  createCompanionScene() 的返回值
 * @param {string} personaId
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function loadCompanionModel(comp, personaId) {
  const entry = PERSONA_MODELS[personaId];
  if (!entry) return { ok: false, reason: 'no-asset' };

  try {
    const { bytes } = await readAssetBytes(entry.model);
    if (!await comp.loadModel(toArrayBuffer(bytes))) {
      return { ok: false, reason: 'attach-failed' };
    }
  } catch (e) {
    console.warn('[model] glb 加载失败，回退到程序化角色：', e?.message || e);
    return { ok: false, reason: 'glb-error' };
  }

  // 模型没有顶点色（只有 TEXCOORD_0），所以贴图这一步不是锦上添花，是必需的
  if (entry.texture) {
    try {
      const { bytes } = await readAssetBytes(entry.texture);
      const tex = decodeToTexture(bytes);
      if (!comp.applyTexture(tex)) {
        tex.dispose();
        console.warn('[model] 贴图挂载失败，模型以纯色显示');
      }
    } catch (e) {
      console.warn('[model] 贴图解码失败，模型以纯色显示：', e?.message || e);
    }
  }

  return { ok: true };
}
