// AccountScreen.js — todo lo del usuario: perfil, verificación de correo,
// tema, privacidad, API key, documentación (abre la web), borrado de
// historial, cierre de sesión y eliminación de cuenta. Paneles del IDE sobre
// el fondo, sin líneas: los grupos se separan por relleno.
import Constants from 'expo-constants';
import React from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { Avatar, Card, CardTitle, IconButton, PlanPill, Segmented, StackHeader, Toggle, useColors } from '../components/ui';
import { ApiException } from '../api';
import { useApi, useAuth, useChat, usePrefs } from '../state';
import { FONTS, RADIUS } from '../theme';

export default function AccountScreen({ onBack, onNavigate }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const chat = useChat();
  const prefs = usePrefs();
  const { prompt, confirm, toast } = useDialogs();

  const user = auth.user || {};
  const settings = user.settings && typeof user.settings === 'object' ? user.settings : {};

  const fullName = [user.first_name, user.last_name]
    .filter((s) => typeof s === 'string' && s)
    .join(' ');
  const email = typeof user.email === 'string' ? user.email : '';
  const initialsSource = fullName || email;
  const initials = initialsSource
    ? initialsSource
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join('')
    : '?';

  const fail = (err) =>
    toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');

  const editName = async () => {
    const value = await prompt({
      title: 'Tu nombre',
      message: 'Nombre y apellido separados por un espacio.',
      placeholder: 'Nombre Apellido',
      initialValue: fullName,
      confirmLabel: 'Guardar',
    });
    const trimmed = (value || '').trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : user.last_name || '';
    try {
      await api.patch('/api/account/profile', { first_name: firstName, last_name: lastName });
      await auth.refreshMe();
    } catch (err) {
      fail(err);
    }
  };

  const toggleSetting = async (key, value) => {
    try {
      await api.patch('/api/account/settings', { [key]: value });
      await auth.refreshMe();
    } catch (err) {
      fail(err);
    }
  };

  const resendVerification = async () => {
    try {
      const res = await api.post('/api/auth/resend-verification');
      toast(String(res?.message || 'Correo enviado'));
    } catch (err) {
      fail(err);
    }
  };

  const regenerateKey = async () => {
    const ok = await confirm({
      title: 'Regenerar API key',
      message:
        'Tu key actual dejará de funcionar en todos los dispositivos ' +
        '(esta app adoptará la nueva automáticamente).',
      confirmLabel: 'Regenerar',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.post('/api/auth/api-key/regenerate');
      if (typeof res?.newApiKey === 'string' && res.newApiKey) {
        await auth.adoptApiKey(res.newApiKey);
      }
      toast('API key regenerada. Esta app ya usa la nueva.');
    } catch (err) {
      fail(err);
    }
  };

  const clearHistory = async () => {
    const ok = await confirm({
      title: 'Borrar historial',
      message: 'Se eliminarán TODAS tus conversaciones. Esta acción no se puede deshacer.',
      confirmLabel: 'Borrar todo',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete('/api/account/conversations');
      chat.newChat();
      toast('Historial eliminado.');
    } catch (err) {
      fail(err);
    }
  };

  const deleteAccount = async () => {
    const password = await prompt({
      title: 'Eliminar cuenta',
      message:
        'Se borrarán tu cuenta, historial y claves de forma definitiva. ' +
        'Escribe tu contraseña para confirmar. (Si entraste con Google/Apple, ' +
        'primero crea una contraseña con "¿Olvidaste tu contraseña?").',
      placeholder: 'Contraseña',
      secure: true,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!password) return;
    try {
      await api.delete('/api/account', { password });
      await auth.logout('Tu cuenta fue eliminada.');
    } catch (err) {
      fail(err);
    }
  };

  const logout = async () => {
    const ok = await confirm({
      title: 'Cerrar sesión',
      message: '¿Salir de tu cuenta en este dispositivo?',
      confirmLabel: 'Cerrar sesión',
      danger: true,
    });
    if (ok) await auth.logout();
  };

  const version = Constants.expoConfig?.version || '';

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StackHeader title="Cuenta" onBack={onBack} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingTop: 6 }}>
        <View style={{ paddingHorizontal: 10, gap: 10 }}>
          {/* Perfil */}
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Avatar name={initials} size={48} />
              <View style={{ flex: 1, marginLeft: 14, gap: 2 }}>
                <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}>
                  {fullName || user.username || '—'}
                </Text>
                <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkLabel }}>
                  {email}
                </Text>
                {typeof user.plan_name === 'string' && (
                  <View style={{ marginTop: 4 }}>
                    <PlanPill>{user.plan_name}</PlanPill>
                  </View>
                )}
              </View>
              <IconButton onPress={editName}>
                <Icon name="pencil" size={16} color={c.ink} />
              </IconButton>
            </View>

            {Object.keys(user).length > 0 && user.email_verified !== true && (
              <Pressable
                onPress={resendVerification}
                style={({ pressed }) => ({
                  marginTop: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: RADIUS,
                  backgroundColor: c.warnSoft,
                  opacity: pressed ? 0.72 : 1,
                })}
              >
                <Icon name="mail" size={15} color={c.warn} />
                <Text
                  style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 13, color: c.warn }}
                >
                  Correo sin verificar — toca para reenviar el enlace
                </Text>
              </Pressable>
            )}
          </Card>

          {/* Apariencia */}
          <Card style={{ gap: 12 }}>
            <CardTitle>Apariencia</CardTitle>
            <Segmented
              stretch
              value={prefs.themeMode}
              onChange={prefs.setThemeMode}
              options={[
                { value: 'dark', label: 'Oscuro' },
                { value: 'light', label: 'Claro' },
                { value: 'system', label: 'Sistema' },
              ]}
            />
            <ActionRow icon="palette" label="Acento, texto, densidad y más" onPress={() => onNavigate?.('appearance')} />
          </Card>

          {/* Privacidad */}
          <Card>
            <CardTitle style={{ marginBottom: 6 }}>Privacidad</CardTitle>
            <SwitchRow
              icon="save"
              label="Guardar historial"
              value={settings.save_history !== false}
              onChange={(v) => toggleSetting('save_history', v)}
            />
            <SwitchRow
              icon="activity"
              label="Métricas anónimas"
              value={settings.anonymous_usage !== false}
              onChange={(v) => toggleSetting('anonymous_usage', v)}
            />
          </Card>

          {/* Recursos y seguridad */}
          <Card style={{ paddingVertical: 8 }}>
            <ActionRow
              icon="book"
              label="Documentación"
              onPress={() => Linking.openURL(`${api.base}/docs`)}
            />
            <ActionRow icon="key" label="Regenerar API key" onPress={regenerateKey} />
            <ActionRow
              icon="trash"
              label="Borrar historial de conversaciones"
              onPress={clearHistory}
            />
          </Card>

          {/* Sesión */}
          <Card style={{ paddingVertical: 8 }}>
            <ActionRow icon="logout" label="Cerrar sesión" onPress={logout} />
            <ActionRow icon="warning" label="Eliminar cuenta" danger onPress={deleteAccount} />
          </Card>

          <Text
            style={{
              textAlign: 'center',
              marginTop: 6,
              fontFamily: FONTS.mono,
              fontSize: 11,
              color: c.inkLabel,
            }}
          >
            lixbon android · v{version}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SwitchRow({ icon, label, value, onChange }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 8,
      }}
    >
      <Icon name={icon} size={18} color={c.inkSoft} />
      <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink }}>{label}</Text>
      <Toggle label={label} value={value} onChange={onChange} />
    </View>
  );
}

function ActionRow({ icon, label, onPress, danger = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 8,
        marginHorizontal: -8,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <Icon name={icon} size={19} color={danger ? c.danger : c.inkSoft} />
      <Text
        style={{
          flex: 1,
          fontFamily: FONTS.ui,
          fontSize: 14.5,
          color: danger ? c.danger : c.ink,
        }}
      >
        {label}
      </Text>
      <Icon name="chevron-right" size={16} color={c.inkMuted} />
    </Pressable>
  );
}
