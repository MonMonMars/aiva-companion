// 云服务客户端 —— 整个 app 只初始化这一次
// ---------------------------------------------------------------------------
// ⚠️ endpoint 和 publishableKey 只能来自 workbuddy_cloud_service 返回的 publicConfig
//    （存在 ./cloudConfig.json，改它要去云服务端拿新值）。
//    不要硬编码别的域名、不要用 window.location 去猜：云端对 Origin 做**精确匹配**，
//    猜错就是全线 401，而且看不出来到底是哪个参数错的。
//
// 这四个模块（Auth / Database / Storage / LLM）共用这一个实例：
// 登录之后请求层会自动给 Database 带上会话，不用也没地方手传 token。
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import cfg from './cloudConfig.json';

export const cloud = createWorkBuddyCloud({
  endpoint: cfg.endpoint,
  publishableKey: cfg.publishableKey,
});

/**
 * 当前会话。一期没有匿名登录，所以没登录就是 null —— 调用方必须自己处理
 * 「还没登录」这条路径，不要指望拿到一个假身份。
 */
export async function currentSession() {
  try {
    const { data, error } = await cloud.auth.getSession();
    if (error || !data) return null;
    return data;
  } catch (e) {
    // 网络不可用时要能正常降级到「离线玩」，不能把整个 app 打崩
    return null;
  }
}

/** 去掉友好错误里不该暴露的内部细节，统一给一句人话 */
export function authErrorMessage(error) {
  if (!error) return '出了点问题，再试一次';
  switch (error.kind) {
    case 'invalid_grant':
    case 'unauthenticated':
      return '账号或密码不对';
    case 'network':
    case 'backend-unavailable':
      return '连不上服务器，检查一下网络';
    default:
      return error.message || '出了点问题，再试一次';
  }
}
