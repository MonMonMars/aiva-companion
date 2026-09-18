import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './store';

/** 订阅全局养成状态（返回扁平快照） */
export function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
