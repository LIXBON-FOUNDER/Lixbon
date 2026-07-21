// push.js — registro best-effort del push token de Expo para los avisos de
// /remote con la app cerrada (sesión creada, aprobación pendiente).
// Si el build no tiene FCM configurado (google-services.json) o el usuario
// niega el permiso, todo esto es un no-op silencioso: la app funciona igual
// y la sección Remote sigue actualizándose en vivo mientras está abierta.
import { Platform } from 'react-native';

export async function registerPushToken(api) {
  try {
    const Notifications = await import('expo-notifications');
    const current = await Notifications.getPermissionsAsync();
    let granted = current.status === 'granted';
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.status === 'granted';
    }
    if (!granted) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    if (token) {
      await api.post('/api/remote/devices', { expo_push_token: token, platform: Platform.OS });
    }
  } catch {
    // sin FCM o sin permiso: silencioso
  }
}

/// Suscribe el tap sobre una notificación de /remote; devuelve un unsubscribe.
export function onRemoteNotificationTap(callback) {
  let sub = null;
  let cancelled = false;
  (async () => {
    try {
      const Notifications = await import('expo-notifications');
      if (cancelled) return;
      sub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response?.notification?.request?.content?.data;
        if (data && typeof data.kind === 'string' && data.kind.startsWith('remote')) {
          callback(data);
        }
      });
    } catch {
      // módulo no disponible
    }
  })();
  return () => {
    cancelled = true;
    try {
      sub?.remove();
    } catch {
      // ya removido
    }
  };
}
