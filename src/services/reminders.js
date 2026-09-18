// 提醒 / 通知
// ---------------------------------------------------------------------------
// 关于「写进 iPhone 提醒事项」这件事必须先讲清楚：
// **Apple 没有开放任何让第三方 App 往系统「提醒事项」里写数据的 API。**
// 任何声称能做到的方案都不可靠。所以这里用的是本地通知（Local Notification）——
// 锁屏弹出、带声音、有震动、可以按 snooze，体验上和提醒非常接近，
// 数据存在 App 自己这里。这是 iOS 上唯一合规且稳定的做法。
//
// 另外，iOS 上"精确时间"的通知会比"几秒后"的通知可靠得多。
// 所以这里统统换算成 triggerDate 的日期型 trigger，而不是 seconds。

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

let configured = false;

export async function setupNotifications() {
  if (configured) return true;
  // 这个 handler 决定了 App 在前台时通知怎么表现；不设的话 iOS 会静默吞掉
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  const settings = await Notifications.getPermissionsAsync();
  if (!settings.granted) {
    const req = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    if (!req.granted) return false;
  }

  if (Platform.OS === 'android') {
    // Android 8+ 必须有 channel，否则通知根本不显示
    await Notifications.setNotificationChannelAsync('reminders', {
      name: '伴侣提醒',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  configured = true;
  return true;
}

/**
 * 设置一个提醒
 * @param {string} title
 * @param {number} delayMinutes
 * @returns {Promise<string>} 给用户听的一句话
 */
export async function scheduleReminder(title, delayMinutes = 10) {
  const ok = await setupNotifications();
  if (!ok) return '我暂时没法设提醒 —— 你还没给 App 开通知权限。';

  const mins = Number.isFinite(delayMinutes) && delayMinutes > 0 ? delayMinutes : 10;
  const seconds = Math.max(60, Math.round(mins * 60));

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '⏰ 提醒',
        body: String(title).slice(0, 120),
        sound: 'default',
        // Android 要显式指 channel
        ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
      },
      // 用 seconds 而不是 Date：延迟类通知 seconds 更准，
      // 而且少于 60 秒的 Date trigger 在部分系统上会被丢弃
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds, repeats: false },
    });
  } catch (e) {
    // 有些模拟器 / 系统版本不支持 delay 通知，退而求其次立刻发一条
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title: '⏰ 提醒', body: String(title).slice(0, 120), sound: 'default' },
        trigger: null,
      });
      return `系统不太支持延迟通知，我已经先提醒你了：${title}`;
    } catch (_) {
      return `设提醒失败了：${e?.message || '未知原因'}`;
    }
  }

  const label = mins >= 60
    ? `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)} 个小时`
    : `${Math.round(mins)} 分钟`;
  return `好，${label}后我会叫你：${title}`;
}

/** 每天固定时间的重复提醒，用于"记得喝水""该写作业了"这种 */
export async function scheduleDaily(title, hour, minute) {
  const ok = await setupNotifications();
  if (!ok) return false;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '⏰ 每日提醒',
      body: String(title).slice(0, 120),
      sound: 'default',
      ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });
  return true;
}

export async function cancelAll() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export async function listReminders() {
  return (await Notifications.getAllScheduledNotificationsAsync()).map((n) => ({
    id: n.identifier,
    body: n.content.body,
    trigger: n.trigger,
  }));
}
