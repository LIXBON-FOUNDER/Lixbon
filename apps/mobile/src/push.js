// push.js — avisos de /remote: sesión nueva y permisos pendientes.
// Con la app cerrada solo llegan por FCM, que exige que el build lleve
// google-services.json y el gateway la cuenta de servicio (FCM_SERVICE_ACCOUNT).
// Sin eso, la app avisa con notificaciones locales mientras sigue viva.
import { Platform } from 'react-native';

const CHANNEL = 'remote';
let pushRegistered = false;

async function notifications() {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

export async function setupNotifications() {
  const N = await notifications();
  if (!N) return null;
  N.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync(CHANNEL, {
      name: 'Sesiones remotas',
      description: 'Sesiones nuevas del IDE y del CLI, y permisos que pide el agente',
      importance: N.AndroidImportance.HIGH,
      vibrationPattern: [0, 180],
    }).catch(() => {});
  }
  return N;
}

async function granted(N) {
  const current = await N.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!current.canAskAgain) return false;
  return (await N.requestPermissionsAsync()).status === 'granted';
}

export async function registerPushToken(api) {
  try {
    const N = await setupNotifications();
    if (!N || !(await granted(N))) return;
    // Token nativo de FCM: el gateway le habla a Firebase sin pasar por Expo.
    const { data } = await N.getDevicePushTokenAsync();
    if (typeof data !== 'string' || !data) return;
    await api.post('/api/remote/devices', { token: data, platform: Platform.OS });
    pushRegistered = true;
  } catch {
    // Build sin google-services.json: se queda en los avisos locales.
  }
}

export async function notifyLocal({ title, body, data }) {
  if (pushRegistered) return;
  const N = await notifications();
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
      content: { title, body, data },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {
    // sin permiso de notificaciones
  }
}

const isRemote = (data) => data && typeof data.kind === 'string' && data.kind.startsWith('remote');

/// Toque sobre un aviso de /remote, también el que abrió la app en frío.
export function onRemoteNotificationTap(callback) {
  let sub = null;
  let cancelled = false;
  (async () => {
    const N = await notifications();
    if (!N || cancelled) return;
    const last = await N.getLastNotificationResponseAsync().catch(() => null);
    const lastData = last?.notification?.request?.content?.data;
    if (!cancelled && isRemote(lastData)) {
      callback(lastData);
      N.clearLastNotificationResponseAsync?.().catch(() => {});
    }
    sub = N.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (isRemote(data)) callback(data);
    });
  })();
  return () => {
    cancelled = true;
    sub?.remove();
  };
}
