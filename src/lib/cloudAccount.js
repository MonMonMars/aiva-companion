// 账号状态：菜单页和账号页共用同一份，避免两处各自查一次会话和角色
// ---------------------------------------------------------------------------
// 角色（admin / user）永远只用来决定**界面上要不要显示那个入口**，
// 不是安全边界 —— 真正拦住写操作的是数据库里的 RLS 策略。
// 就算有人改了本地 state 让自己看到「管理后台」按钮，点进去也写不动任何东西。
import { useEffect, useState } from 'react';
import { cloud, currentSession } from './cloudClient';
import { ensureProfile } from './cloudSync';

export function useAccount() {
  const [acc, setAcc] = useState({ loading: true, session: null, role: 'user', error: '' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const session = await currentSession();
        let role = 'user';
        if (session) {
          try {
            role = await ensureProfile();
          } catch (e) {
            // 建 profile 失败不影响玩，只是不知道角色
          }
        }
        if (alive) setAcc({ loading: false, session, role, error: '' });
      } catch (e) {
        if (alive) setAcc({ loading: false, session: null, role: 'user', error: '云服务不可用' });
      }
    })();

    let unsub;
    try {
      const r = cloud.auth.onAuthStateChange((event) => {
        if (!alive) return;
        if (event === 'SIGNED_OUT') setAcc({ loading: false, session: null, role: 'user', error: '' });
      });
      unsub = r?.data?.subscription?.unsubscribe || (typeof r === 'function' ? r : undefined);
    } catch (e) {
      // 有的构建里没有这个事件；忽略即可，页面本身会在操作后主动刷新
    }
    return () => {
      alive = false;
      try { unsub?.(); } catch (e) { /* 已解绑 */ }
    };
  }, []);

  const refresh = async () => {
    const session = await currentSession();
    let role = 'user';
    if (session) {
      try { role = await ensureProfile(); } catch (e) { /* 同上 */ }
    }
    setAcc({ loading: false, session, role, error: '' });
  };

  return { ...acc, refresh, isAdmin: acc.role === 'admin' };
}

/** 邮箱打码，避免出现 Frederic-note 之类的全量隐私信息落在 UI 或日志里 */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '';
  const name = s.slice(0, at);
  const keep = name.slice(0, Math.min(2, name.length));
  return `${keep}${'*'.repeat(Math.max(3, name.length - keep.length))}@${s.slice(at + 1)}`;
}
