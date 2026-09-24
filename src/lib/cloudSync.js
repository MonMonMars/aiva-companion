// 云同步：把本机养成进度搬到 user_state 表
// ---------------------------------------------------------------------------
// ⚠️ 前置：一期没有匿名登录。没登录就是同步不了，必须先在 UI 上引导去登录，
//    不允许为了「看起来能用」造一个 localStorage 假身份去撞带保护的表。
//
// 冲突规则（简单但可解释）：谁更晚谁赢。
//   登录时先看云端那行的时间戳 ts 和本机 store.localDirtyAt() 比，
//   云端更晚 → 本机被覆盖；本机更晚 → 立刻把本机推上去覆盖云端。
//   这样离线玩一天再登录不会丢进度，换设备也能拉到最新的那份。
import { cloud } from './cloudClient';
import * as S from '../store';

/**
 * 保证自己有一条 profile 行。
 * 客户端对这个表**只有 INSERT 权限**（没有 UPDATE），而且 INSERT 策略强制 role='user' ——
 * 所以这里怎么写都不可能把自己提权成 admin。管理员身份只能由数据库侧授予。
 */
export async function ensureProfile() {
  const { data, error } = await cloud.database.from('profiles').select('role').maybeSingle();
  if (error) throw error;
  if (data) return data.role || 'user';

  // 还没有行：建一条自己的。role 不允许客户端指定，用默认值 'user'。
  const ins = await cloud.database.from('profiles').insert({}).select('role');
  if (ins.error && ins.error.code !== '23505') throw ins.error; // 23505 = 并发下已存在，忽略
  return 'user';
}

export const getRole = ensureProfile;

/** 拉云端进度；没有云端记录返回 null */
export async function pullState() {
  const { data, error } = await cloud.database.from('user_state').select('payload').maybeSingle();
  if (error) throw error;
  return data?.payload || null;
}

/** 把本机进度推上去。返回是否写入成功。 */
export async function pushState() {
  const payload = { v: 1, ...S.exportCloud(), ts: Date.now() };
  const existing = await cloud.database.from('user_state').select('id').maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    const up = await cloud.database
      .from('user_state')
      .update({ payload })
      .eq('id', existing.data.id)
      .select('id');
    if (up.error) throw up.error;
    // ⚠️ RLS 会静默过滤：跨用户更新返回空数组且不带 error。空数组 = 没写成，要报错而不是装成功。
    return Array.isArray(up.data) && up.data.length > 0;
  }

  const ins = await cloud.database.from('user_state').insert({ payload }).select('id');
  if (ins.error) throw ins.error;
  return Array.isArray(ins.data) && ins.data.length > 0;
}

/**
 * 登录后的首次同步：按时间戳决定方向，返回给人看的结论。
 * 失败要带着原因抛出去，UI 上明确提示 —— 同步失败必须让用户知道。
 */
export async function syncOnLogin() {
  const remote = await pullState();
  const localAt = S.localDirtyAt();
  const remoteAt = remote?.ts || 0;

  if (remoteAt > localAt) {
    S.importCloud(remote);
    return { direction: 'down', at: remoteAt };
  }
  if (localAt > 0) {
    const ok = await pushState();
    if (!ok) throw new Error('权限不足，写不进去');
    return { direction: 'up', at: localAt };
  }
  return { direction: 'none', at: remoteAt };
}
