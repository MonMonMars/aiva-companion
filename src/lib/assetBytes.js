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

// ---------------------------------------------------------------------------
// 字节缓存（渐进式预热用）
// ---------------------------------------------------------------------------
// 为什么要缓存：**切换角色时的卡顿基本都来自重新读那 1MB 的 glb**。
// 预热阶段把字节先抓进来放这儿，真切换时 readAssetBytes 直接命中，
// 省掉一次网络往返（web）或一次 base64 解码（native，那个更慢）。
//
// 为什么不全部缓存：kizuna 一个就 7.4MB，15 个角色全驻留是 20MB+。
// 所以给个上限，超了就从**最早放进去的**开始丢（简单的 FIFO，够用）。
const cache = new Map();
let cacheBytes = 0;
const CACHE_BUDGET = 36 * 1024 * 1024; // 36MB

export function assetCacheStats() {
  return { items: cache.size, bytes: cacheBytes, budget: CACHE_BUDGET };
}

function putCache(uri, bytes) {
  if (cache.has(uri)) return;
  if (bytes.byteLength > CACHE_BUDGET) return;  // 单件就超预算，别把别人都挤掉
  while (cacheBytes + bytes.byteLength > CACHE_BUDGET && cache.size) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).byteLength;
    cache.delete(oldest);
  }
  cache.set(uri, bytes);
  cacheBytes += bytes.byteLength;
}

/**
 * 判断 require() 的结果是不是"资源引用"，还是 Metro 已经 inline 成的普通对象。
 * 判据和下面的 readAssetJSON 一致：资源模块一定带 uri / __packager_asset / width。
 */
export function isAssetModule(mod) {
  return !!mod && typeof mod === 'object'
    && !!(mod.uri || mod.__packager_asset || mod.width != null);
}

/**
 * @returns {Promise<{bytes: Uint8Array, uri: string}>}
 */
export async function readAssetBytes(mod) {
  const uri = await resolveUri(mod);

  const hit = cache.get(uri);
  if (hit) return { bytes: hit, uri };

  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`读取资源失败 ${res.status}: ${uri}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    putCache(uri, bytes);
    return { bytes, uri };
  }

  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = base64ToBytes(b64);
  putCache(uri, bytes);
  return { bytes, uri };
}

/**
 * 预热一个资源：把字节抓进缓存，**不做任何解析**。
 *
 * 为什么不做解析：解析 glb 是这一整条链路里最贵的一步，
 * 预热时把它做了 = 把卡顿从"切角色那一刻"搬到"刚进主页那一刻"，没占到便宜。
 * 而且只有当前主角那一份会被真正挂上场景，其余 14 份解析完也是白扔。
 *
 * @returns {Promise<{ok: boolean, cached?: boolean, bytes?: number, reason?: string}>}
 */
export async function warmAssetBytes(mod) {
  if (!isAssetModule(mod)) return { ok: false, reason: 'not-an-asset（Metro 已 inline）' };
  try {
    const uri = await resolveUri(mod);
    if (cache.has(uri)) return { ok: true, cached: true, bytes: 0 };
    const before = cacheBytes;
    await readAssetBytes(mod);
    return { ok: true, cached: false, bytes: cacheBytes - before };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/**
 * 读一个 JSON 资源，返回**解析后的对象**。
 *
 * 为什么不能直接 `JSON.parse(readAssetBytes(...))`：
 *   Metro 对 `.json` 的默认处理是**当 JS 模块 inline**，所以
 *   `require('./x.json')` 拿到的已经是解析好的对象，不是资源引用。
 *   这种对象喂给 `Asset.fromModule()` 会抛
 *   `Module "[object Object]" is missing from the asset registry`。
 *   —— 这条路在 web 上真踩过（页面能渲染，但表情静默失效）。
 *
 * 所以这里两条路都走：
 *   1) 传进来的已经是对象（Metro inline 的结果）→ 直接用，零成本；
 *   2) 是资源引用（native / 注册成 assetExts 的 `.morph.json`）→ 读字节再解析。
 *
 * @param {any} mod require() 的结果，可能是对象也可能是资源模块
 * @returns {Promise<object|null>}
 */
export async function readAssetJSON(mod) {
  if (!mod) return null;

  // 情况 1：Metro 已经把它当模块 inline 成对象了。
  // 判据是"不像资源模块"：资源模块一定带 uri 或 __packager_asset，
  // 而 inline 出来的就是普通对象。这里**不按内容形状判断**
  // （比如不许用 mod.shapes 来判断），否则别的 JSON 会被误拒。
  const looksLikeAsset = isAssetModule(mod);
  if (!looksLikeAsset) {
    // 有些打包器会把 default 包一层
    if (mod && typeof mod === 'object' && mod.default && Object.keys(mod).length === 1) {
      return mod.default;
    }
    return mod;
  }

  // 情况 2：资源引用 —— 读出字节再解析
  const { bytes } = await readAssetBytes(mod);
  return JSON.parse(new TextDecoder().decode(bytes));
}
