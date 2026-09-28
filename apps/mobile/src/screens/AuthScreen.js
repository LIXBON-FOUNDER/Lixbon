// AuthScreen.js — login / registro / olvidé mi contraseña.
// Con el sistema del IDE: fondo con luz ambiente, isotipo + wordmark,
// selector deslizante, campos de relleno con etiqueta flotante, CTA invertido
// y botones sociales de relleno.
import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDialogs } from '../components/dialogs';
import {
  AmbientGlow,
  AppleLogo,
  FadeUp,
  FloatingField,
  GoogleLogo,
  LixLogo,
  LogoMark,
  Segmented,
  useColors,
  useIsDark,
} from '../components/ui';
import { ApiException } from '../api';
import { DEFAULT_API_BASE, useApi, useAuth, usePrefs } from '../state';
import { FONTS, RADIUS } from '../theme';

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
    // Los botones se muestran siempre (como en la web); si el gateway aún no
    // tiene el proveedor configurado, se avisa en lugar de abrir el navegador.
    if (!providers.includes(provider)) {
      setError(
        `El inicio de sesión con ${provider === 'google' ? 'Google' : 'Apple'} ` +
          'aún no está disponible. Usa tu correo y contraseña.',
      );
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
  const screenBg = c.bg;
  const surface = c.surface3;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
      <AmbientGlow />
      {/* Sin esto el teclado tapaba los campos de abajo: con edge-to-edge la
          ventana no se encoge, así que el ScrollView tampoco tenía nada que
          desplazar y el formulario quedaba a medias. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
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
        <FadeUp style={{ alignItems: 'center', gap: 14 }}>
          <LogoMark size={48} />
          <LixLogo size={24} />
          <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkLabel }}>
            IA en nuestras propias GPUs
          </Text>
        </FadeUp>

        <View style={{ width: '100%', maxWidth: 420, marginTop: 30, gap: 18 }}>
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
          <FadeUp key={mode} style={{ gap: 10 }}>
            {mode === 'register' && (
              <View style={{ flexDirection: 'row', gap: 10 }}>
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
                marginTop: 6,
                height: 48,
                justifyContent: 'center',
                borderRadius: RADIUS,
                backgroundColor: c.primary,
                alignItems: 'center',
                opacity: busy ? 0.45 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
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

            {mode !== 'forgot' && (
              <>
                {/* Divisor (.auth__divider) */}
                <Text style={{ textAlign: 'center', marginTop: 8, fontFamily: FONTS.uiMedium, fontSize: 10.5, letterSpacing: 1, color: c.inkLabel }}>
                  {mode === 'login' ? 'O INICIA SESIÓN CON' : 'O REGÍSTRATE CON'}
                </Text>

                {/* Sociales: Google superficie clara, Apple tinta (auth.css) */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <SocialButton
                    label="Google"
                    icon={<GoogleLogo />}
                    variant="surface"
                    surface={surface}
                    disabled={busy}
                    onPress={() => withProvider('google')}
                  />
                  <SocialButton
                    label="Apple"
                    icon={<AppleLogo color={dark ? DARK_APPLE : '#FFFFFF'} />}
                    variant="ink"
                    disabled={busy}
                    onPress={() => withProvider('apple')}
                  />
                </View>
              </>
            )}
          </FadeUp>
        </View>

        <Pressable onLongPress={changeServer} style={{ marginTop: 30, padding: 6 }}>
          <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>lixbon.com</Text>
        </Pressable>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// En oscuro el botón Apple es crema (primary) → logo en tinta oscura.
const DARK_APPLE = '#0B0B0B';

function ModeToggle({ mode, onChange }) {
  return (
    <Segmented
      stretch
      value={mode}
      onChange={onChange}
      options={[
        { value: 'login', label: 'Iniciar sesión' },
        { value: 'register', label: 'Registrarse' },
      ]}
    />
  );
}

// Enlace en acento.
function LinkText({ children, onPress }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ alignSelf: 'center', padding: 4, opacity: pressed ? 0.72 : 1 })}>
      <Text
        style={{
          fontFamily: FONTS.uiMedium,
          fontSize: 13.5,
          color: c.accentDeep,
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
        height: 46,
        borderRadius: RADIUS,
        backgroundColor: ink ? c.primary : pressed ? c.surface4 : surface || c.surface3,
        opacity: disabled ? 0.45 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
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
