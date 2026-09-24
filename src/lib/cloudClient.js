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
import { withTimeout } from './withTimeout';

export const cloud = createWorkBuddyCloud({
  endpoint: cfg.endpoint,
  publishableKey: cfg.publishableKey,
});

/**
 * 账号类请求的等待上限。
 *
 * ⚠️ 别删。SDK 的 AuthModule 里 auth 请求是**裸 fetch**：既没有 abortSignal，
 * 也没有任何超时（lib/index.js 里的 AbortSignal / timeout 都在 database 和
 * storage 模块，auth 一份都没有）。所以网络「挂起」而不是「快速失败」时
 * （电梯里、欠费 4G、DNS 黑洞 —— 连接建不上但也没被拒），await 永不落定：
 *   · useAccount 起始 loading:true 只在 getSession() 落定后才置 false
 *     → 账号页永远停在「正在读取账号…」
 *   · AccountView 每个操作 setBusy(true) 之后 await auth
 *     → 登录按钮被 ActivityIndicator 永久替换，而且**没有取消入口**
 * 10 秒是「用户主动点了按钮、愿意等但不想被钉死」的量级，别照抄启动那个 2 秒。
 */
export const AUTH_TIMEOUT_MS = 10000;

/**
 * 所有 `cloud.auth.*` 都要经它调用。
 *
 * 归一成 SDK 那套 `{ data, error }` 形状（而不是抛异常），这样调用处现有的
 * `if (r.error) return fail(r.error)` 分支一行都不用改 —— 超时会自然落进
 * 「服务器没响应」那句人话里。
 */
export async function authCall(fn, ms = AUTH_TIMEOUT_MS) {
  try {
    return await withTimeout(fn(), ms, 'auth-timeout');
  } catch (e) {
    // fn() 同步抛错、请求 reject、等待超时，三种都收在这儿
    return { data: null, error: { kind: 'timeout', message: String(e?.message || e) } };
  }
}

/**
 * 当前会话。一期没有匿名登录，所以没登录就是 null —— 调用方必须自己处理
 * 「还没登录」这条路径，不要指望拿到一个假身份。
 */
export async function currentSession() {
  try {
    const { data, error } = await authCall(() => cloud.auth.getSession());
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
    case 'timeout':
      // 连接建不上但也没被拒时不算「网络坏了」，别误导用户去改设置
      return '服务器没响应，等一会儿再试';
    default:
      return error.message || '出了点问题，再试一次';
  }
}
