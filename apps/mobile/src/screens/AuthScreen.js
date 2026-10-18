// AuthScreen.js — acceso: iniciar sesión y crear cuenta como dos vistas, cada
// una con su lámina arriba (volver a casa / zarpar), titular en serif, Google y
// Apple primero, y el correo debajo. Recuperar la contraseña es una hoja sobre
// el login, no otra pantalla.
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { ApiException } from '../api';
import Icon from '../components/Icon';
import { SheetTitle, useDialogs } from '../components/dialogs';
import {
  AppleLogo,
  FadeUp,
  GoogleLogo,
  KeyboardAware,
  Lamina,
  LixLogo,
  LogoMark,
  Meter,
  ScreenTitle,
  useColors,
  useKeyboardOpen,
} from '../components/ui';
import { DEFAULT_API_BASE, useApi, useAuth, usePrefs } from '../state';
import { FONTS, RADIUS } from '../theme';

const MIN_PASSWORD = 8;

export default function AuthScreen() {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const prefs = usePrefs();
  const insets = useSafeAreaInsets();
  const { prompt, sheet } = useDialogs();

  const [mode, setMode] = useState('login'); // login | register
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState([]);

  const loadProviders = async () => {
    try {
      const data = await api.get('/api/auth/oauth/providers', { auth: false });
      setProviders(Array.isArray(data?.providers) ? data.providers : []);
    } catch {
      // sin proveedores: se avisa al tocar el botón
    }
  };

  useEffect(() => {
    loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    auth.clearNotice();
  };

  const submit = async () => {
    auth.clearNotice();
    setError('');
    if (mode === 'register') {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) return setError('Escribe tu nombre y tu apellido');
      if (password.length < MIN_PASSWORD) return setError(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await auth.login(email.trim(), password);
      } else {
        const parts = name.trim().split(/\s+/);
        await auth.register({ firstName: parts[0], lastName: parts.slice(1).join(' '), email: email.trim(), password });
      }
    } catch (err) {
      setError(err instanceof ApiException ? err.message : 'Algo salió mal. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  const withProvider = async (provider) => {
    auth.clearNotice();
    setError('');
    // Los botones se muestran siempre (como en la web); si el gateway aún no
    // tiene el proveedor configurado, se avisa en lugar de abrir el navegador.
    if (!providers.includes(provider)) {
      setError(`El acceso con ${provider === 'google' ? 'Google' : 'Apple'} aún no está disponible. Usa tu correo.`);
      return;
    }
    setBusy(true);
    try {
      await auth.loginWithProvider(provider);
    } catch (err) {
      const msg = err instanceof ApiException ? err.message : 'Algo salió mal. Intenta de nuevo.';
      if (!msg.toLowerCase().includes('cancelado')) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const recover = () => sheet({ keyboard: true, render: (close) => <RecoverSheet initialEmail={email} onDone={close} /> });

  // Mantener pulsada la marca: cambiar de servidor (desarrollo).
  const changeServer = async () => {
    const value = await prompt({
      title: 'Servidor',
      message: 'URL base del gateway (solo para desarrollo).',
      placeholder: DEFAULT_API_BASE,
      initialValue: prefs.apiBase,
      confirmLabel: 'Guardar',
    });
    if (value != null) {
      prefs.setApiBase(value);
      loadProviders();
    }
  };

  const register = mode === 'register';
  const message = error || auth.notice;
  const keyboard = useKeyboardOpen();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* La lámina queda detrás de la barra de estado también en claro. */}
      <StatusBar style="light" />
      {/* Con edge-to-edge la ventana no se encoge con el teclado: sin esto el
          formulario quedaba tapado y el ScrollView no tenía nada que mover. */}
      <KeyboardAware bottomInset={insets.bottom}>
        <ScrollView key={mode} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, paddingBottom: 28 + insets.bottom }}>
          <Lamina
            source={register ? LAMINA_REGISTRO : LAMINA_LOGIN}
            height={register ? 240 : 360}
            focus={register ? 0.46 : 0.18}
            compact={keyboard}
            label={register ? 'Un velero sale de un puerto tranquilo al amanecer' : 'Una casa con las ventanas encendidas en lo alto de una colina, a la hora azul'}
          >
            {register ? (
              <Pressable
                onPress={() => switchMode('login')}
                accessibilityRole="button"
                accessibilityLabel="Volver"
                style={({ pressed }) => ({
                  margin: 6,
                  marginLeft: 14,
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(14,14,14,0.42)',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Icon name="arrow-left" size={20} color="#FCFAEF" />
              </Pressable>
            ) : (
              <FadeUp>
                <Pressable
                  onLongPress={changeServer}
                  delayLongPress={800}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start', margin: 14, marginLeft: 24 }}
                >
                  <LogoMark size={28} />
                  <LixLogo size={16} color="#FCFAEF" />
                </Pressable>
              </FadeUp>
            )}
          </Lamina>

          <View style={{ flexGrow: 1, paddingHorizontal: 24, marginTop: keyboard ? -24 : register ? -46 : -60 }}>
            <FadeUp delay={60}>
              <ScreenTitle style={{ fontSize: 36, lineHeight: 40, marginBottom: 24 }}>
                {register ? 'Crea tu cuenta' : 'Bienvenido\nde nuevo'}
              </ScreenTitle>
            </FadeUp>

            <FadeUp delay={120} style={{ flexDirection: 'row', gap: 8 }}>
              <SocialButton label="Google" icon={<GoogleLogo size={18} />} disabled={busy} onPress={() => withProvider('google')} />
              <SocialButton label="Apple" icon={<AppleLogo size={18} color={c.ink} />} disabled={busy} onPress={() => withProvider('apple')} />
            </FadeUp>

            <FadeUp delay={160} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 20, marginBottom: 14 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: c.surface4 }} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>o con tu correo</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: c.surface4 }} />
            </FadeUp>

            <FadeUp delay={200} style={{ gap: 12 }}>
              {register && <Field label="Nombre y apellido" value={name} onChangeText={setName} autoCapitalize="words" textContentType="name" />}
              <Field label="Correo" value={email} onChangeText={setEmail} placeholder="tu@correo.com" keyboardType="email-address" textContentType="emailAddress" />
              <Field
                label="Contraseña"
                value={password}
                onChangeText={setPassword}
                secure
                onSubmitEditing={submit}
                aside={
                  register ? null : (
                    <Pressable onPress={recover} hitSlop={8}>
                      <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.dark ? c.accent : c.accentDeep }}>¿La olvidaste?</Text>
                    </Pressable>
                  )
                }
              />
              {register && password.length > 0 && <Strength password={password} />}

              {!!message && (
                <FadeUp key={message} distance={4}>
                  <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 19, color: c.danger }}>{message}</Text>
                </FadeUp>
              )}

              <Pressable
                onPress={submit}
                disabled={busy}
                style={({ pressed }) => ({
                  marginTop: 8,
                  height: 50,
                  borderRadius: RADIUS,
                  backgroundColor: c.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: busy ? 0.5 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                })}
              >
                <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.onPrimary }}>
                  {register ? (busy ? 'Creando cuenta…' : 'Crear cuenta') : busy ? 'Entrando…' : 'Iniciar sesión'}
                </Text>
              </Pressable>
            </FadeUp>

            <View style={{ flex: 1, minHeight: 32 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>{register ? '¿Ya tienes cuenta? ' : '¿No tienes cuenta? '}</Text>
              <Pressable onPress={() => switchMode(register ? 'login' : 'register')} hitSlop={10}>
                <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{register ? 'Iniciar sesión' : 'Crear cuenta'}</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAware>
    </View>
  );
}

const LAMINA_LOGIN = require('../../assets/laminas/acceso-login.jpg');
const LAMINA_REGISTRO = require('../../assets/laminas/acceso-registro.jpg');

/// Campo con la etiqueta encima (y un enlace opcional a la derecha); el de
/// contraseña trae el ojo para mostrarla.
function Field({ label, aside = null, secure = false, surface, ...input }) {
  const c = useColors();
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.ink70 }}>{label}</Text>
        {aside}
      </View>
      <View style={{ height: 48, borderRadius: RADIUS, backgroundColor: surface || (focused ? c.surface4 : c.surface3), flexDirection: 'row', alignItems: 'center' }}>
        <TextInput
          {...input}
          accessibilityLabel={label}
          secureTextEntry={secure && !shown}
          autoCapitalize={input.autoCapitalize || 'none'}
          autoCorrect={false}
          placeholderTextColor={c.inkFaint}
          selectionColor={c.accent}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ flex: 1, height: 48, paddingLeft: 14, paddingRight: secure ? 4 : 14, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}
        />
        {secure && (
          <Pressable
            onPress={() => setShown((v) => !v)}
            accessibilityLabel={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={shown ? 'eye-off' : 'eye'} size={18} color={c.inkMuted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Strength({ password }) {
  const c = useColors();
  const n = password.length;
  const missing = MIN_PASSWORD - n;
  const varied = /[A-Z]/.test(password) + /[0-9]/.test(password) + /[^A-Za-z0-9]/.test(password);
  const strong = n >= 12 || (n >= MIN_PASSWORD && varied >= 2);
  const label = missing > 0 ? `Casi · ${missing} ${missing === 1 ? 'carácter' : 'caracteres'} más` : strong ? 'Segura' : 'Válida';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -4 }}>
      <Meter value={missing > 0 ? n / MIN_PASSWORD / 1.5 : strong ? 1 : 0.75} color={missing > 0 ? c.inkMuted : c.accent} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>{label}</Text>
    </View>
  );
}

function SocialButton({ label, icon, onPress, disabled }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        height: 48,
        borderRadius: RADIUS,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        backgroundColor: pressed ? c.surface4 : c.surface2,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon}
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{label}</Text>
    </Pressable>
  );
}

function RecoverSheet({ initialEmail, onDone }) {
  const c = useColors();
  const api = useApi();
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState('idle'); // idle | sending | sent
  const [error, setError] = useState('');

  const send = async () => {
    if (!email.trim()) return;
    setState('sending');
    setError('');
    try {
      await api.post('/api/auth/request-password-reset', { email: email.trim() }, { auth: false });
      setState('sent');
    } catch (err) {
      setState('idle');
      setError(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    }
  };

  if (state === 'sent') {
    return (
      <FadeUp style={{ paddingHorizontal: 8, gap: 18 }}>
        <SheetTitle detail={`Si ${email.trim()} tiene cuenta, en unos minutos te llega el enlace. Revisa también el correo no deseado.`}>Revisa tu correo</SheetTitle>
        <Pressable onPress={() => onDone(null)} style={{ height: 50, borderRadius: RADIUS, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.onRaised }}>Listo</Text>
        </Pressable>
      </FadeUp>
    );
  }

  return (
    <View style={{ paddingHorizontal: 8, gap: 18 }}>
      <SheetTitle detail="Te enviaremos un enlace para crear una nueva.">Recupera tu contraseña</SheetTitle>
      <Field label="Correo" value={email} onChangeText={setEmail} keyboardType="email-address" surface={c.surface4} onSubmitEditing={send} autoFocus={!initialEmail} />
      {!!error && <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.danger }}>{error}</Text>}
      <Pressable
        onPress={send}
        disabled={state === 'sending'}
        style={({ pressed }) => ({ height: 50, borderRadius: RADIUS, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', opacity: state === 'sending' ? 0.5 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
      >
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.onPrimary }}>{state === 'sending' ? 'Enviando…' : 'Enviar enlace'}</Text>
      </Pressable>
    </View>
  );
}
