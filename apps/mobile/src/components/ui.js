// ui.js — piezas compartidas del design system Lixbon (espejo fiel de
// apps/web/src/styles: base.css, auth.css, account.css): tema activo,
// wordmark, iconos de marca, campo pill con etiqueta sobre el borde,
// botones pill, icon-buttons circulares y tarjetas blancas sobre crema.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { DARK, FONTS, LIGHT, RADIUS_BOX, RADIUS_PILL } from '../theme';
import { usePrefs } from '../state';

// ── Tema activo ──────────────────────────────────────────────────────────────

const ThemeContext = createContext(LIGHT);

export function ThemeProvider({ children }) {
  const prefs = usePrefs();
  const system = useColorScheme();
  const mode = prefs.themeMode === 'system' ? system || 'light' : prefs.themeMode;
  const colors = mode === 'dark' ? DARK : LIGHT;
  return <ThemeContext.Provider value={colors}>{children}</ThemeContext.Provider>;
}

export const useColors = () => useContext(ThemeContext);
export const useIsDark = () => useColors() === DARK;

// Espejo de prefers-reduced-motion (base.css lo respeta; la app también).
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub?.remove();
  }, []);
  return reduced;
}

// ── Marca ────────────────────────────────────────────────────────────────────

export function LixLogo({ size = 28, color }) {
  const c = useColors();
  return (
    <Text
      style={{
        fontFamily: FONTS.brand,
        fontSize: size,
        letterSpacing: size * 0.04,
        color: color || c.ink,
      }}
    >
      LIXBON
    </Text>
  );
}

const SPARK_PATH = 'M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z';

export function Spark({ size = 18, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={SPARK_PATH} fill={color} />
    </Svg>
  );
}

export function GoogleLogo({ size = 19 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <Path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <Path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <Path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </Svg>
  );
}

const APPLE_PATH =
  'M16.36 12.79c-.03-2.53 2.07-3.74 2.16-3.8-1.18-1.72-3.01-1.96-3.66-1.99-1.56-.16-3.04.92-3.83.92-.79 0-2.01-.9-3.3-.87-1.7.02-3.27.99-4.14 2.5-1.77 3.07-.45 7.61 1.27 10.1.84 1.22 1.84 2.59 3.16 2.54 1.27-.05 1.75-.82 3.28-.82 1.53 0 1.96.82 3.3.79 1.36-.02 2.22-1.24 3.05-2.46.96-1.41 1.36-2.78 1.38-2.85-.03-.01-2.64-1.01-2.67-4.02zM13.84 5.35c.7-.85 1.17-2.03 1.04-3.21-1.01.04-2.23.67-2.95 1.52-.65.75-1.22 1.95-1.06 3.1 1.12.09 2.27-.57 2.97-1.41z';

export function AppleLogo({ size = 19, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={APPLE_PATH} fill={color} />
    </Svg>
  );
}

// ── Campo pill con etiqueta sobre el borde ───────────────────────────────────
// Espejo del .ffield de auth.css: campo pill con superficie blanca, borde
// suave, foco olivo y label que sube hasta quedar SOBRE el borde (con fondo
// propio para cortar la línea), estilo outlined.

export function FloatingField({
  label,
  value,
  onChangeText,
  secure = false,
  keyboardType,
  autoCapitalize = 'none',
  onSubmitEditing,
  surface, // fondo del campo (y de la etiqueta que corta el borde)
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const fieldBg = surface || c.bg;
  const [focused, setFocused] = useState(false);
  const lifted = focused || !!value;
  const anim = useRef(new Animated.Value(lifted ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: lifted ? 1 : 0,
      duration: reduced ? 0 : 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [lifted, anim, reduced]);

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmitEditing}
        style={{
          backgroundColor: fieldBg,
          borderWidth: 1,
          borderColor: focused ? c.accentDeep : c.borderSoft,
          borderRadius: RADIUS_PILL,
          paddingHorizontal: 22,
          paddingVertical: 15,
          fontFamily: FONTS.ui,
          fontSize: 15,
          color: c.ink,
        }}
      />
      <Animated.Text
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: anim.interpolate({ inputRange: [0, 1], outputRange: [24, 18] }),
          top: anim.interpolate({ inputRange: [0, 1], outputRange: [16, -9] }),
          fontSize: anim.interpolate({ inputRange: [0, 1], outputRange: [15, 12.5] }),
          fontFamily: lifted ? FONTS.uiMedium : FONTS.ui,
          color: lifted ? (focused ? c.accentDeep : c.inkSoft) : c.inkMuted,
          backgroundColor: lifted ? fieldBg : 'transparent',
          paddingHorizontal: lifted ? 6 : 0,
          borderRadius: 4,
        }}
      >
        {label}
      </Animated.Text>
    </View>
  );
}

// ── Botones ──────────────────────────────────────────────────────────────────

/// CTA pill (.pill-btn de base.css; size="lg" = .auth__cta). El feedback de
/// pulsación es una caída sutil de opacidad, como el hover de la web.
export function PillButton({
  label,
  onPress,
  disabled = false,
  danger = false,
  outline = false,
  size = 'md',
}) {
  const c = useColors();
  const bg = danger ? c.danger : c.primary;
  const fg = danger ? '#FFFFFF' : c.onPrimary;
  const lg = size === 'lg';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          borderRadius: RADIUS_PILL,
          paddingHorizontal: 22,
          paddingVertical: lg ? 16 : 11,
          alignItems: 'center',
          justifyContent: 'center',
        },
        outline
          ? {
              backgroundColor: pressed ? c.bgSecondary : c.bg,
              borderWidth: 1,
              borderColor: danger ? c.danger : c.border,
            }
          : { backgroundColor: bg, opacity: pressed ? 0.85 : 1 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text
        style={{
          fontFamily: lg ? FONTS.uiSemiBold : FONTS.uiMedium,
          fontSize: 15,
          color: outline ? (danger ? c.danger : c.ink) : fg,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/// Botón circular de icono (.icon-btn de base.css): 34px, hover tinta al 7 %.
export function IconButton({ children, onPress, size = 34, bg = 'transparent' }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c.pressed : bg,
      })}
    >
      {children}
    </Pressable>
  );
}

// ── Tarjetas y títulos ───────────────────────────────────────────────────────

/// Tarjeta blanca sobre página crema (.card de account.css).
export function Card({ children, style }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: c.bg,
          borderRadius: RADIUS_BOX,
          borderWidth: 1,
          borderColor: c.borderSoft,
          padding: 18,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/// Título de tarjeta (.card__title: 18px semibold — sin kickers en mayúsculas).
export function CardTitle({ children, style }) {
  const c = useColors();
  return (
    <Text style={[{ fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink }, style]}>
      {children}
    </Text>
  );
}

export function ScreenTitle({ children }) {
  const c = useColors();
  return (
    <Text
      style={{
        fontFamily: FONTS.uiSemiBold,
        fontSize: 24,
        color: c.ink,
        paddingHorizontal: 18,
        paddingTop: 12,
        paddingBottom: 14,
      }}
    >
      {children}
    </Text>
  );
}

/// Etiqueta de plan (.plan-pill: fondo acento, texto tinta).
export function PlanPill({ children }) {
  const c = useColors();
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: c.accent,
        borderRadius: RADIUS_PILL,
        paddingHorizontal: 12,
        paddingVertical: 4,
      }}
    >
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 12, color: c.onAccent }}>
        {children}
      </Text>
    </View>
  );
}

/// Entrada suave (fade + subida 10px) para mensajes y cambios de vista,
/// espejo de las animaciones msg-in / fields-in de la web.
export function FadeUp({ children, delay = 0, style }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: reduced ? 0 : 260,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, delay, reduced]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
