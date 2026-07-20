// AuthScreen.js — login / registro / olvidé mi contraseña.
// Espejo fiel del auth de la web (auth.css): fondo crema SIN tarjeta, logo
// arriba, toggle segmentado con pastilla oscura deslizante, campos pill con
// etiqueta sobre el borde, CTA pill grande, enlaces olivo subrayados y
// botones sociales Google (blanco) / Apple (tinta).
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDialogs } from '../components/dialogs';
import {
  AppleLogo,
  FadeUp,
  FloatingField,
  GoogleLogo,
  LixLogo,
  useColors,
  useIsDark,
  useReducedMotion,
} from '../components/ui';
import { ApiException } from '../api';
import { DEFAULT_API_BASE, useApi, useAuth, usePrefs } from '../state';
import { FONTS, RADIUS_PILL } from '../theme';

export default function AuthScreen() {
  const c = useColors();
  const dark = useIsDark();
  const api = useApi();
  const auth = useAuth();
  const prefs = usePrefs();
  const { prompt } = useDialogs();

  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState('');
  const [noticeLocal, setNoticeLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState([]);

  const loadProviders = async () => {
    try {
      const data = await api.get('/api/auth/oauth/providers', { auth: false });
      setProviders(Array.isArray(data?.providers) ? data.providers : []);
    } catch {
      // sin proveedores: los botones no se muestran
    }
  };

  useEffect(() => {
    loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setNoticeLocal('');
    auth.clearNotice();
  };

  const submit = async () => {
    auth.clearNotice();
    setError('');
    setNoticeLocal('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await auth.login(email.trim(), password);
      } else if (mode === 'register') {
        if (password !== confirmPw) {
          setError('Las contraseñas no coinciden');
          return;
        }
        await auth.register({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          password,
        });
      } else {
        await api.post('/api/auth/request-password-reset', { email: email.trim() }, { auth: false });
        setNoticeLocal('Si el correo existe, te enviamos un enlace para restablecer la contraseña.');
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

  // Mantener pulsado el pie: cambiar de servidor (desarrollo)
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

  const notice = auth.notice;
  // La web invierte las capas en oscuro: fondo --bg y superficies --bg-secondary.
  const screenBg = dark ? c.bg : c.bgSecondary;
  const surface = dark ? c.bgSecondary : c.bg;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 26,
          paddingVertical: 40,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <FadeUp>
          <LixLogo size={30} />
        </FadeUp>

        <View style={{ width: '100%', maxWidth: 420, marginTop: 30, gap: 22 }}>
          <FadeUp delay={60}>
            {mode !== 'forgot' ? (
              <ModeToggle mode={mode} onChange={switchMode} surface={surface} />
            ) : (
              <Text
                style={{
                  textAlign: 'center',
                  fontFamily: FONTS.uiSemiBold,
                  fontSize: 23,
                  color: c.ink,
                  marginBottom: 4,
                }}
              >
                Restablecer contraseña
              </Text>
            )}
          </FadeUp>

          {/* Campos: la key fuerza el fields-in al cambiar de modo */}
          <FadeUp key={mode} style={{ gap: 16 }}>
            {mode === 'register' && (
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <View style={{ flex: 1 }}>
                  <FloatingField surface={surface} label="Nombre" value={firstName} onChangeText={setFirstName} autoCapitalize="words" />
                </View>
                <View style={{ flex: 1 }}>
                  <FloatingField surface={surface} label="Apellido" value={lastName} onChangeText={setLastName} autoCapitalize="words" />
                </View>
              </View>
            )}

            <FloatingField
              surface={surface}
              label="Correo Electrónico"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
            />
            {mode !== 'forgot' && (
              <FloatingField surface={surface} label="Contraseña" value={password} onChangeText={setPassword} secure />
            )}
            {mode === 'register' && (
              <FloatingField
                surface={surface}
                label="Confirmar Contraseña"
                value={confirmPw}
                onChangeText={setConfirmPw}
                secure
              />
            )}

            {(!!error || !!notice) && (
              <Text
                style={{
                  textAlign: 'center',
                  fontFamily: FONTS.ui,
                  fontSize: 14,
                  color: c.danger,
                }}
              >
                {error || notice}
              </Text>
            )}
            {!!noticeLocal && (
              <Text
                style={{
                  textAlign: 'center',
                  fontFamily: FONTS.ui,
                  fontSize: 14,
                  color: c.accentDeep,
                }}
              >
                {noticeLocal}
              </Text>
            )}

            {/* CTA grande (.auth__cta) */}
            <Pressable
              onPress={busy ? undefined : submit}
              disabled={busy}
              style={({ pressed }) => ({
                marginTop: 4,
                paddingVertical: 17,
                borderRadius: RADIUS_PILL,
                backgroundColor: c.primary,
                alignItems: 'center',
                opacity: busy ? 0.45 : pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.onPrimary }}>
                {mode === 'register'
                  ? busy
                    ? 'Creando cuenta…'
                    : 'Crear Cuenta'
                  : mode === 'forgot'
                    ? busy
                      ? 'Enviando…'
                      : 'Enviar enlace'
                    : busy
                      ? 'Iniciando…'
                      : 'Iniciar Sesión'}
              </Text>
            </Pressable>

            {mode === 'login' && (
              <LinkText onPress={() => switchMode('forgot')}>¿Olvidaste tu contraseña?</LinkText>
            )}
            {mode === 'forgot' && (
              <LinkText onPress={() => switchMode('login')}>Volver a iniciar sesión</LinkText>
            )}

            {mode !== 'forgot' && providers.length > 0 && (
              <>
                {/* Divisor (.auth__divider) */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: c.borderSoft }} />
                  <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
                    {mode === 'login' ? 'O inicia sesión con' : 'O regístrate con'}
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: c.borderSoft }} />
                </View>

                {/* Sociales: Google superficie clara, Apple tinta (auth.css) */}
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  {providers.includes('google') && (
                    <SocialButton
                      label="Google"
                      icon={<GoogleLogo />}
                      variant="surface"
                      surface={surface}
                      disabled={busy}
                      onPress={() => withProvider('google')}
                    />
                  )}
                  {providers.includes('apple') && (
                    <SocialButton
                      label="Apple"
                      icon={<AppleLogo color={dark ? DARK_APPLE : '#FFFFFF'} />}
                      variant="ink"
                      disabled={busy}
                      onPress={() => withProvider('apple')}
                    />
                  )}
                </View>
              </>
            )}
          </FadeUp>
        </View>

        <Pressable onLongPress={changeServer} style={{ marginTop: 30, padding: 6 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>lixbon.com</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

// En oscuro el botón Apple es crema (primary) → logo en tinta oscura.
const DARK_APPLE = '#1A1913';

// Toggle segmentado (.auth__toggle): superficie clara con borde y pastilla
// de tinta deslizante con sombra; curva cubic-bezier(0.22,1,0.36,1).
function ModeToggle({ mode, onChange, surface }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const anim = useRef(new Animated.Value(mode === 'register' ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: mode === 'register' ? 1 : 0,
      duration: reduced ? 0 : 380,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [mode, anim, reduced]);

  const half = (width - 10) / 2;

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        backgroundColor: surface,
        borderWidth: 1,
        borderColor: c.borderSoft,
        borderRadius: RADIUS_PILL,
        padding: 5,
      }}
    >
      {width > 0 && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 5,
            bottom: 5,
            left: 5,
            width: half,
            borderRadius: RADIUS_PILL,
            backgroundColor: c.primary,
            elevation: 4,
            shadowColor: '#1B1A17',
            shadowOpacity: 0.16,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            transform: [
              { translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [0, half] }) },
            ],
          }}
        />
      )}
      <View style={{ flexDirection: 'row' }}>
        {[
          ['Iniciar Sesión', 'login'],
          ['Registrarse', 'register'],
        ].map(([label, value]) => {
          const active = mode === value;
          return (
            <Pressable
              key={value}
              onPress={() => onChange(value)}
              style={{ flex: 1, paddingVertical: 12 }}
            >
              <Text
                style={{
                  textAlign: 'center',
                  fontFamily: FONTS.uiSemiBold,
                  fontSize: 14.5,
                  color: active ? c.onPrimary : c.ink,
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Enlace olivo subrayado (.auth__link).
function LinkText({ children, onPress }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ alignSelf: 'center', padding: 4, opacity: pressed ? 0.72 : 1 })}>
      <Text
        style={{
          fontFamily: FONTS.ui,
          fontSize: 13.5,
          color: c.accentDeep,
          textDecorationLine: 'underline',
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function SocialButton({ label, icon, onPress, disabled, variant, surface }) {
  const c = useColors();
  const ink = variant === 'ink';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 14,
        borderRadius: RADIUS_PILL,
        backgroundColor: ink ? c.primary : surface || c.bg,
        borderWidth: ink ? 0 : 1,
        borderColor: pressed ? c.accentDeep : c.borderSoft,
        opacity: disabled ? 0.45 : ink && pressed ? 0.85 : 1,
      })}
    >
      {icon}
      <Text
        style={{
          fontFamily: FONTS.uiSemiBold,
          fontSize: 14,
          color: ink ? c.onPrimary : c.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
