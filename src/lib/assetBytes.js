/**
 * 把 Metro 打包进来的静态资源（glb / jpg）读成字节数组。
 *
 * 为什么要这么绕：
 *  1. 原生端有 file:// 路径，但 React Native 的 fetch 不支持 file:// 协议，
 *     three 的 GLTFLoader / TextureLoader 内部都是 fetch，直接传 uri 会失败。
 *  2. Web 端打包出来是 http(s) 的 blob/静态资源，expo-file-system 在浏览器里
 *     对远程地址的支持不稳定。
 *  → 所以：原生走 expo-file-system 读成 base64，Web 走 fetch arrayBuffer，
 *    统一产出 Uint8Array 给上层用。
 *
 * 用 Uint8Array 而不是 ArrayBuffer，是因为 jpeg-js 和 GLTFLoader.parse 都能直接吃，
 * 而且 subarray 零拷贝，避免 500KB 的文件在内存里复制好几份。
 */

import { Platform } from 'react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;

/** 手写 base64 解码：RN 里没有 Buffer，别指望全局有 atob 也好用 */
export function base64ToBytes(b64) {
  let len = b64.length;
  while (len > 0 && (b64[len - 1] === '=' || b64[len - 1] === '\n' || b64[len - 1] === '\r')) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)];
    if (b64[i] === '=' ) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return p === out.length ? out : out.subarray(0, p);
}

/** require('...') 进来的资源模块 → 本地可读 uri */
async function resolveUri(mod) {
  const asset = Asset.fromModule(mod);
  await asset.downloadAsync();
  const uri = asset.localUri || asset.uri;
  if (!uri) throw new Error('资源 uri 解析失败');
  return uri;
}

/**
 * @returns {Promise<{bytes: Uint8Array, uri: string}>}
 */
export async function readAssetBytes(mod) {
  const uri = await resolveUri(mod);

  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`读取资源失败 ${res.status}: ${uri}`);
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), uri };
  }

  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { bytes: base64ToBytes(b64), uri };
}
