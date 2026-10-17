// SettingsScreen.js — Ajustes en secciones: perfil (abre su hoja), plan,
// apariencia, chat, privacidad, desarrolladores y sesión y datos. Las acciones
// delicadas piden confirmación, y eliminar la cuenta se hace manteniendo pulsado.
import Constants from 'expo-constants';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { pickAvatar } from '../attachments';
import Icon from '../components/Icon';
import { SheetTitle, useDialogs } from '../components/dialogs';
import { Avatar, EASE, FadeUp, Meter, PlanPill, Row, RowIcon, Section, Segmented, StackHeader, Toggle, avatarUri, useColors, useReducedMotion } from '../components/ui';
import { useApi, useAuth, useChat, usePrefs } from '../state';
import { ACCENTS, FONTS, RADIUS, RADIUS_SM } from '../theme';

const TEXT_LABEL = { sm: 'Pequeño', md: 'Normal', lg: 'Grande' };

export default function SettingsScreen({ onBack, onNavigate }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const chat = useChat();
  const prefs = usePrefs();
  const { sheet, confirm, toast } = useDialogs();
  const [usage, setUsage] = useState(null);

  const user = auth.user || {};
  const settings = user.settings && typeof user.settings === 'object' ? user.settings : {};
  const fullName = [user.first_name, user.last_name].filter((s) => typeof s === 'string' && s).join(' ');
  const email = typeof user.email === 'string' ? user.email : '';
  const accent = ACCENTS.find((a) => a.id === prefs.ui.accent) || ACCENTS[0];

  useEffect(() => {
    api
      .get('/api/account/usage')
      .then((res) => {
        const session = res?.buckets?.session;
        if (session && !session.unlimited && typeof session.percent === 'number') setUsage(session.percent / 100);
      })
      .catch(() => {});
    if (chat.models.length === 0) chat.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (err) => toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');

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
      toast(String(res?.message || 'Correo enviado'), { icon: 'check' });
    } catch (err) {
      fail(err);
    }
  };

  const pickDefaultModel = async () => {
    const value = await sheet({
      title: 'Modelo por defecto',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, value: m, selected: m === (chat.defaultModel || chat.model) })),
    });
    if (value) chat.setDefaultModel(value);
  };

  const editProfile = () => sheet({ keyboard: true, render: (close) => <ProfileSheet onDone={close} /> });

  const closeOtherSessions = async () => {
    const ok = await confirm({
      title: '¿Cerrar las demás sesiones?',
      message: 'Tus otros dispositivos (web, IDE, CLI y otros móviles) tendrán que volver a iniciar sesión. Esta app sigue dentro y tus API keys siguen funcionando.',
      confirmLabel: 'Cerrar las demás',
      danger: true,
    });
    if (!ok) return;
    try {
      await auth.closeOtherSessions();
      toast('Sesiones cerradas', { icon: 'check' });
    } catch (err) {
      fail(err);
    }
  };

  const clearHistory = async () => {
    const ok = await confirm({
      title: '¿Borrar todo el historial?',
      message: 'Se eliminan todas tus conversaciones en la web, el IDE y esta app. No se puede deshacer.',
      confirmLabel: 'Borrar todo',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete('/api/account/conversations');
      chat.newChat();
      toast('Historial eliminado', { icon: 'check' });
    } catch (err) {
      fail(err);
    }
  };

  const logout = async () => {
    const ok = await confirm({ title: '¿Cerrar sesión?', message: 'Tus conversaciones siguen guardadas en tu cuenta.', confirmLabel: 'Cerrar sesión' });
    if (ok) await auth.logout();
  };

  const deleteAccount = () => sheet({ keyboard: true, render: (close) => <DeleteAccountSheet planName={user.plan_name} onCancel={() => close(null)} /> });

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StackHeader title="Ajustes" onBack={onBack} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 32, gap: 22 }}>
        <FadeUp>
          <Pressable
            onPress={editProfile}
            style={({ pressed }) => ({ padding: 16, borderRadius: RADIUS, backgroundColor: pressed ? c.surface3 : c.surface2, gap: 14 })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar name={fullName || email} size={52} uri={avatarUri(api.base, user)} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text numberOfLines={1} style={{ fontFamily: FONTS.serif, fontSize: 21, lineHeight: 26, color: c.ink }}>
                  {fullName || user.username || '—'}
                </Text>
                <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                  {email}
                </Text>
              </View>
              {typeof user.plan_name === 'string' && <PlanPill size={12}>{user.plan_name}</PlanPill>}
            </View>
            {usage != null && (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.ink70 }}>Sesión actual</Text>
                  <Text style={{ fontFamily: FONTS.mono, fontSize: 12.5, color: c.inkMuted }}>{Math.round(usage * 100)} %</Text>
                </View>
                <Meter value={usage} color={usage >= 0.9 ? c.danger : c.accent} />
              </View>
            )}
          </Pressable>
          {Object.keys(user).length > 0 && user.email_verified !== true && (
            <Pressable
              onPress={resendVerification}
              style={({ pressed }) => ({ marginTop: 8, minHeight: 40, paddingHorizontal: 14, borderRadius: RADIUS, backgroundColor: c.warnSoft, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.75 : 1 })}
            >
              <Icon name="mail" size={16} color={c.warn} />
              <Text style={{ flex: 1, paddingVertical: 9, fontFamily: FONTS.ui, fontSize: 13.5, color: c.warn }}>Correo sin verificar · reenviar enlace</Text>
            </Pressable>
          )}
        </FadeUp>

        <Section title="Plan" delay={30}>
          <Row title="Uso y límites" icon="chart" onPress={() => onNavigate('usage')} />
          <Row title="Cambiar de plan" icon="bolt" external onPress={() => Linking.openURL(`${api.base}/plans`)} />
        </Section>

        <Section title="Apariencia" delay={60}>
          <View style={{ minHeight: 56, paddingLeft: 14, paddingRight: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <RowIcon name={prefs.themeMode === 'light' ? 'sun' : 'moon'} />
            <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>Tema</Text>
            <Segmented
              value={prefs.themeMode}
              onChange={prefs.setThemeMode}
              options={[
                { value: 'dark', label: 'Oscuro' },
                { value: 'light', label: 'Claro' },
                { value: 'system', label: 'Auto', a11y: 'Según el sistema' },
              ]}
            />
          </View>
          <Row
            title="Personalizar"
            icon="palette"
            onPress={() => onNavigate('appearance')}
            right={<View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.accent }} />}
            value={`${accent.label} · ${TEXT_LABEL[prefs.ui.textSize] || 'Normal'}`}
          />
        </Section>

        <Section title="Chat" delay={90}>
          <Row title="Modelo por defecto" icon="layers" value={chat.defaultModel || chat.model || '—'} onPress={pickDefaultModel} />
          <Row title="Enviar con Enter" icon="arrow-up" right={<Toggle label="Enviar con Enter" value={prefs.ui.sendOnEnter} onChange={(sendOnEnter) => prefs.setUi({ sendOnEnter })} />} />
        </Section>

        <Section title="Privacidad" delay={120}>
          <Row title="Guardar historial" icon="clock" right={<Toggle label="Guardar historial" value={settings.save_history !== false} onChange={(v) => toggleSetting('save_history', v)} />} />
          <Row title="Métricas anónimas" icon="activity" right={<Toggle label="Métricas anónimas" value={settings.anonymous_usage !== false} onChange={(v) => toggleSetting('anonymous_usage', v)} />} />
        </Section>

        <Section title="Desarrolladores" delay={150}>
          <Row title="API keys" icon="key" external onPress={() => Linking.openURL(`${api.base}/account/profile`)} />
          <Row title="Documentación" icon="book" external onPress={() => Linking.openURL(`${api.base}/docs`)} />
        </Section>

        <Section title="Sesión y datos" delay={180}>
          <Row title="Cerrar las demás sesiones" icon="x" onPress={closeOtherSessions} chevron={false} />
          <Row title="Cerrar sesión" icon="logout" onPress={logout} chevron={false} />
          <Row title="Borrar historial de conversaciones" icon="trash" danger onPress={clearHistory} chevron={false} />
          <Row title="Eliminar cuenta" icon="warning" danger onPress={deleteAccount} chevron={false} />
        </Section>

        <Text style={{ marginTop: 4, textAlign: 'center', fontFamily: FONTS.mono, fontSize: 12, color: c.inkFaint }}>
          Lixbon Android v{Constants.expoConfig?.version || ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, children }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.ink70 }}>{label}</Text>
      {children}
    </View>
  );
}

/// Perfil: foto, nombre y apellido editables, correo de solo lectura y el
/// enlace para cambiar la contraseña (manda el correo de restablecimiento).
function ProfileSheet({ onDone }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const { toast } = useDialogs();
  const user = auth.user || {};
  const initial = [user.first_name, user.last_name].filter((s) => typeof s === 'string' && s).join(' ');
  const [name, setName] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const email = typeof user.email === 'string' ? user.email : '';

  const fail = (err) => toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');

  const changePhoto = async () => {
    try {
      const file = await pickAvatar();
      if (!file) return;
      setBusy(true);
      const form = new FormData();
      form.append('file', file);
      await api.upload('/api/account/avatar', form);
      await auth.refreshMe();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    try {
      await api.post('/api/auth/request-password-reset', { email }, { auth: false });
      toast('Te enviamos un enlace para cambiarla', { icon: 'mail' });
    } catch (err) {
      fail(err);
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== initial) {
      const parts = trimmed.split(/\s+/);
      try {
        await api.patch('/api/account/profile', { first_name: parts[0], last_name: parts.slice(1).join(' ') });
        await auth.refreshMe();
      } catch (err) {
        fail(err);
        return;
      }
    }
    onDone(null);
  };

  return (
    <View style={{ paddingHorizontal: 8, gap: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 8 }}>
        <View style={{ opacity: busy ? 0.5 : 1 }}>
          <Avatar name={initial || email} size={64} uri={avatarUri(api.base, user)} />
        </View>
        <Pressable
          onPress={changePhoto}
          disabled={busy}
          style={({ pressed }) => ({ height: 36, paddingHorizontal: 12, borderRadius: RADIUS_SM, backgroundColor: pressed ? c.surface5 : c.surface4, flexDirection: 'row', alignItems: 'center', gap: 8 })}
        >
          <Icon name="image" size={16} color={c.inkBody} />
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.ink }}>{busy ? 'Subiendo…' : 'Cambiar foto'}</Text>
        </Pressable>
      </View>
      <Field label="Nombre y apellido">
        <TextInput
          value={name}
          onChangeText={setName}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={save}
          selectionColor={c.accent}
          autoCapitalize="words"
          style={{
            height: 48,
            paddingHorizontal: 14,
            borderRadius: RADIUS,
            borderWidth: 1.5,
            borderColor: focused ? c.accent : 'transparent',
            backgroundColor: c.surface4,
            fontFamily: FONTS.ui,
            fontSize: 15,
            color: c.ink,
          }}
        />
      </Field>
      <Field label="Correo">
        <View style={{ height: 48, paddingHorizontal: 14, borderRadius: RADIUS, backgroundColor: c.surface3, justifyContent: 'center' }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 15, color: c.inkMuted }}>
            {email}
          </Text>
        </View>
        <Pressable onPress={changePassword} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkBody }}>Cambiar contraseña</Text>
        </Pressable>
      </Field>
      <Pressable
        onPress={save}
        style={({ pressed }) => ({ height: 50, borderRadius: RADIUS, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.98 : 1 }] })}
      >
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.onPrimary }}>Guardar</Text>
      </Pressable>
    </View>
  );
}

const HOLD_MS = 1600;

/// Eliminar la cuenta: en vez de escribir "ELIMINAR" se mantiene pulsado; el
/// relleno avanza 1,6 s y si se suelta antes vuelve atrás. El gateway exige la
/// contraseña, así que va justo encima.
function DeleteAccountSheet({ planName, onCancel }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const reduced = useReducedMotion();
  const { toast } = useDialogs();
  const [password, setPassword] = useState('');
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const fill = useRef(new Animated.Value(0)).current;
  const ready = password.length > 0 && !busy;

  const run = async () => {
    setBusy(true);
    try {
      await api.delete('/api/account', { password });
      await auth.logout('Tu cuenta fue eliminada.');
    } catch (err) {
      setBusy(false);
      fill.setValue(0);
      toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    }
  };

  const press = () => {
    if (!ready) return;
    setHolding(true);
    Animated.timing(fill, { toValue: 1, duration: reduced ? 600 : HOLD_MS, easing: Easing.linear, useNativeDriver: false }).start(({ finished }) => {
      setHolding(false);
      if (finished) run();
    });
  };

  const release = () => {
    if (busy) return;
    fill.stopAnimation();
    setHolding(false);
    Animated.timing(fill, { toValue: 0, duration: 500, easing: EASE, useNativeDriver: false }).start();
  };

  const lost = ['Todas tus conversaciones', 'Tu API key y sesiones remotas', ...(planName && planName !== 'Free' ? [`Tu suscripción ${planName}`] : [])];

  return (
    <View style={{ paddingHorizontal: 8, gap: 20 }}>
      <SheetTitle detail="No se puede deshacer. Se borra de inmediato:">Eliminar tu cuenta</SheetTitle>
      <View style={{ gap: 12, marginTop: -8 }}>
        {lost.map((item) => (
          <View key={item} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="x" size={16} color={c.danger} strokeWidth={1.8} />
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkBody }}>{item}</Text>
          </View>
        ))}
      </View>
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Tu contraseña"
        placeholderTextColor={c.inkMuted}
        selectionColor={c.danger}
        secureTextEntry
        autoCapitalize="none"
        accessibilityLabel="Contraseña"
        style={{ height: 48, paddingHorizontal: 14, borderRadius: RADIUS, backgroundColor: c.surface4, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}
      />
      <Pressable
        onPressIn={press}
        onPressOut={release}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="Mantén pulsado para eliminar la cuenta"
        style={{ height: 54, borderRadius: RADIUS, overflow: 'hidden', backgroundColor: c.dangerSoft, alignItems: 'center', justifyContent: 'center', opacity: ready || busy ? 1 : 0.5 }}
      >
        <Animated.View
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: c.danger, width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }}
        />
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: holding || busy ? c.onAccent : c.danger }}>
          {busy ? 'Eliminando…' : 'Mantén pulsado para eliminar'}
        </Text>
      </Pressable>
      <Pressable onPress={onCancel} style={{ height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -8 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink70 }}>Cancelar</Text>
      </Pressable>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 18, color: c.inkMuted, textAlign: 'center', marginTop: -12 }}>
        ¿Entraste con Google o Apple? Crea una contraseña desde «Cambiar contraseña» en tu perfil.
      </Text>
    </View>
  );
}
