// ui.js — primitivas del sistema visual: tema activo con acento elegible,
// marca, campos y botones de relleno (sin bordes), selector deslizante,
// interruptor, tarjetas, cabeceras, filas de ajustes y la luz ambiente.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Polygon, RadialGradient, Rect, Stop, Circle } from 'react-native-svg';

import { FONTS, MOTION, RADIUS, RADIUS_SM, buildTheme } from '../theme';
import { UI_DEFAULTS, usePrefs } from '../state';
import Icon from './Icon';

export const EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const SPRING = Easing.bezier(0.3, 1.2, 0.5, 1);

// ── Tema activo ──────────────────────────────────────────────────────────────

const ThemeContext = createContext(buildTheme('dark', 'lima'));

export function ThemeProvider({ children }) {
  const prefs = usePrefs();
  const system = useColorScheme();
  const mode = prefs.themeMode === 'system' ? system || 'dark' : prefs.themeMode;
  const accent = prefs.ui?.accent;
  const colors = useMemo(() => buildTheme(mode, accent), [mode, accent]);
  return <ThemeContext.Provider value={colors}>{children}</ThemeContext.Provider>;
}

export const useColors = () => useContext(ThemeContext);
export const useIsDark = () => useColors().dark;
export const useUi = () => usePrefs()?.ui || UI_DEFAULTS;

/// URL absoluta de la foto de perfil (el gateway la devuelve relativa).
export function avatarUri(base, user) {
  const url = user?.avatar_url;
  if (typeof url !== 'string' || !url) return null;
  return /^https?:/.test(url) ? url : `${base}${url}`;
}

// Sin animaciones si el sistema lo pide o si el usuario las apagó.
export function useReducedMotion() {
  const { motion } = useUi();
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub?.remove();
  }, []);
  return reduced || !motion;
}

const TEXT_SCALE = { sm: 0.93, md: 1, lg: 1.1 };
const SPACE_SCALE = { compact: 0.72, normal: 1, roomy: 1.3 };

/// Escalas de la personalización: `t(n)` para el texto del chat, `s(n)` para
/// el aire entre mensajes y filas.
// El KeyboardAvoidingView de RN no sirve con edge-to-edge: Android ya no
// encoge la ventana y RN solo detecta el teclado en un relayout que no llega.
// Tampoco vale medir la posición: measureInWindow descuenta la barra de estado.
// Los contenedores que usan esto llegan al borde inferior de la pantalla, así
// que basta con dejar debajo el alto del teclado (keyboard-controller lo lee
// del inset del IME y lo anima a su ritmo). bottomInset: lo que el contenedor
// ya deja libre abajo (p. ej. un SafeAreaView con borde inferior).
export function KeyboardAware({ children, style, bottomInset = 0 }) {
  const { height } = useReanimatedKeyboardAnimation();
  const avoid = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -height.value - bottomInset) }), [bottomInset]);
  return <Reanimated.View style={[{ flex: 1 }, style, avoid]}>{children}</Reanimated.View>;
}

export const useKeyboardOpen = () => useKeyboardState((state) => state.isVisible);

export function useScale() {
  const { textSize, density } = useUi();
  const tf = TEXT_SCALE[textSize] || 1;
  const sf = SPACE_SCALE[density] || 1;
  return { t: (n) => Math.round(n * tf * 10) / 10, s: (n) => Math.round(n * sf) };
}

// ── Marca ────────────────────────────────────────────────────────────────────

// La marca de lixbon.com es Fraunces cursiva fina en minúsculas: a igual
// `size` que el isotipo se ve pequeña, así que el cuerpo real va un 45% más.
export function LixLogo({ size = 28, color }) {
  const c = useColors();
  const fontSize = Math.round(size * 1.45);
  return (
    <Text style={{ fontFamily: FONTS.brand, fontSize, lineHeight: Math.round(fontSize * 1.15), letterSpacing: -fontSize * 0.01, color: color || c.ink }}>
      lixbon
    </Text>
  );
}

/// Isotipo (el mismo del favicon de la web y del IDE).
export function LogoMark({ size = 26 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Rect x="0" y="0" width="32" height="32" rx="9" ry="9" fill="#1B1A17" />
      <Polygon points="16,3.2 3.2,16 16,16" fill="#DCD6BC" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <Polygon points="16,3.2 28.8,16 16,16" fill="#C7BE9F" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <Polygon points="3.2,16 16,28.8 16,16" fill="#4B5327" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <Polygon points="28.8,16 16,28.8 16,16" fill="#333A1C" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <Path
        d="M19.8 16C20.956 18.244 20.956 18.244 23.2 19.4C20.956 20.556 20.956 20.556 19.8 22.8C18.644 20.556 18.644 20.556 16.4 19.4C18.644 18.244 18.644 18.244 19.8 16Z"
        fill="#FCFAEF"
      />
      <Circle cx="23.4" cy="22.6" r="1.1" fill="#FCFAEF" />
    </Svg>
  );
}

export function ClaudeMark({ size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      {[0, 45, 90, 135].map((deg) => (
        <Rect key={deg} x="14.6" y="3" width="2.8" height="26" rx="1.4" fill={CLAUDE_ORANGE} transform={`rotate(${deg} 16 16)`} />
      ))}
    </Svg>
  );
}

export const CLAUDE_ORANGE = '#D97757';

// Marca y colores de cada agente que puede manejarse en remoto.
export function agentStyle(agent, c) {
  if (agent === 'claude') {
    return {
      label: 'Claude Code',
      ink: c.dark ? '#E8A38B' : '#B4553A',
      soft: c.dark ? 'rgba(217,119,87,0.14)' : 'rgba(217,119,87,0.16)',
      dot: CLAUDE_ORANGE,
    };
  }
  return { label: 'Lixbon', ink: c.accentDeep, soft: c.accentSoft, dot: c.accent };
}

export function AgentMark({ agent, size = 18 }) {
  return agent === 'claude' ? <ClaudeMark size={size} /> : <LogoMark size={size} />;
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

/// Luz ambiente del marco del IDE: dos halos suaves, uno de tinta arriba a la
/// izquierda y otro del acento abajo a la derecha.
export function AmbientGlow() {
  const c = useColors();
  const { ambient } = useUi();
  if (!ambient) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="lxInk" cx="10%" cy="0%" rx="80%" ry="45%">
            <Stop offset="0" stopColor={c.dark ? '#F2F2EE' : '#FFFFFF'} stopOpacity={c.dark ? 0.07 : 0.9} />
            <Stop offset="1" stopColor={c.dark ? '#F2F2EE' : '#FFFFFF'} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="lxAccent" cx="100%" cy="100%" rx="75%" ry="40%">
            <Stop offset="0" stopColor={c.accent} stopOpacity={c.dark ? 0.09 : 0.12} />
            <Stop offset="1" stopColor={c.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#lxInk)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#lxAccent)" />
      </Svg>
    </View>
  );
}

/// Lámina de las pantallas de acceso: va a sangre detrás de la barra de
/// estado y su mitad de abajo se funde con el fondo, en claro y en oscuro.
/// `focus` es la altura de la imagen (0 arriba, 1 abajo) que queda a la vista
/// al recortarla, y `compact` la encoge para que el teclado no tape el
/// formulario.
const LAMINA_RATIO = 1448 / 1086;

export function Lamina({ source, height, compactHeight = 120, compact = false, focus = 0.5, label, children }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const full = height + insets.top;
  const small = compactHeight + insets.top;
  const anim = useRef(new Animated.Value(compact ? small : full)).current;

  useEffect(() => {
    Animated.timing(anim, { toValue: compact ? small : full, duration: reduced ? 0 : 320, easing: EASE, useNativeDriver: false }).start();
  }, [compact, small, full, anim, reduced]);

  const imageHeight = width * LAMINA_RATIO;
  const top = -Math.max(0, imageHeight - full) * focus;

  return (
    <Animated.View style={{ width, height: anim, overflow: 'hidden', backgroundColor: c.surface2 }}>
      <Image source={source} accessible={!!label} accessibilityLabel={label} style={{ position: 'absolute', left: 0, top, width, height: imageHeight }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' }}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="lxLamina" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={c.bg} stopOpacity={0} />
              <Stop offset="0.45" stopColor={c.bg} stopOpacity={0.55} />
              <Stop offset="1" stopColor={c.bg} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#lxLamina)" />
        </Svg>
      </View>
      {children && <View style={{ position: 'absolute', left: 0, right: 0, top: insets.top }}>{children}</View>}
    </Animated.View>
  );
}

// ── Botones ──────────────────────────────────────────────────────────────────

/// Principal en tinta, secundario de relleno, acento para la acción positiva
/// del contexto y peligro en rojo apagado. Pulsar encoge un poco.
export function PillButton({ label, onPress, disabled = false, danger = false, outline = false, accent = false, size = 'md', icon, style }) {
  const c = useColors();
  const lg = size === 'lg';
  const sm = size === 'sm';
  const bg = danger ? c.dangerSoft : outline ? c.surface4 : accent ? c.accent : c.primary;
  const fg = danger ? c.danger : outline ? c.ink : accent ? c.onAccent : c.onPrimary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          gap: 8,
          borderRadius: sm ? RADIUS_SM : RADIUS,
          paddingHorizontal: sm ? 12 : 18,
          height: lg ? 50 : sm ? 36 : 44,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bg,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text style={{ fontFamily: danger || outline ? FONTS.uiMedium : FONTS.uiSemiBold, fontSize: sm ? 13.5 : 15, color: fg }}>{label}</Text>
    </Pressable>
  );
}

/// Botón de icono: 44 de lado (objetivo táctil), relleno solo al pulsar.
export function IconButton({ children, onPress, onLongPress, size = 44, bg = 'transparent', active = false, label, disabled = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size >= 40 ? RADIUS : RADIUS_SM,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed ? c.pressed : active ? c.surface4 : bg,
      })}
    >
      {children}
    </Pressable>
  );
}

/// Ficha de filtro: tinta cuando está elegida, relleno suave si no.
export function Chip({ label, icon, onPress, active = false, mono = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 32,
        paddingHorizontal: 12,
        borderRadius: RADIUS_SM,
        backgroundColor: active ? c.primary : pressed ? c.surface4 : c.surface2,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={active ? c.onPrimary : c.inkSoft} /> : null}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: mono ? FONTS.mono : active ? FONTS.uiMedium : FONTS.ui,
          fontSize: mono ? 12 : 13.5,
          color: active ? c.onPrimary : c.ink70,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Selector deslizante e interruptor ────────────────────────────────────────

/// Selector con indicador que se desliza. `icon` sin `label` vuelve la opción
/// un botón cuadrado (el tema en la búsqueda); `dot` marca actividad.
export function Segmented({ options, value, onChange, stretch = false, size = 'md', bg }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [layouts, setLayouts] = useState({});
  const x = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const ready = layouts[value] != null;
  const placed = useRef(false);

  useEffect(() => {
    const l = layouts[value];
    if (!l) return;
    if (!placed.current || reduced) {
      x.setValue(l.x);
      w.setValue(l.width);
      placed.current = true;
      return;
    }
    Animated.parallel([
      Animated.timing(x, { toValue: l.x, duration: MOTION.fade, easing: EASE, useNativeDriver: false }),
      Animated.timing(w, { toValue: l.width, duration: MOTION.fade, easing: EASE, useNativeDriver: false }),
    ]).start();
  }, [value, layouts, x, w, reduced]);

  const lg = size === 'lg';
  const h = size === 'xl' ? 38 : lg ? 36 : size === 'sm' ? 30 : 32;
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: 'row',
        alignSelf: stretch ? 'stretch' : 'flex-start',
        padding: 3,
        borderRadius: lg ? RADIUS : RADIUS_SM,
        backgroundColor: bg || c.surface0,
      }}
    >
      {ready && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 3,
            left: x,
            width: w,
            height: h,
            borderRadius: lg ? RADIUS_SM : 5,
            backgroundColor: c.dark ? (lg ? c.surface4 : c.surface5) : c.surface2,
          }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        const iconOnly = o.icon && !o.label;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            onLayout={(e) => {
              const { x: lx, width } = e.nativeEvent.layout;
              setLayouts((cur) => (cur[o.value]?.x === lx && cur[o.value]?.width === width ? cur : { ...cur, [o.value]: { x: lx, width } }));
            }}
            accessibilityRole="radio"
            accessibilityLabel={o.a11y || (typeof o.label === 'string' ? o.label : undefined)}
            accessibilityState={{ selected: active }}
            style={[
              {
                height: h,
                minWidth: iconOnly ? 36 : undefined,
                paddingHorizontal: iconOnly ? 0 : 12,
                flexDirection: 'row',
                gap: 6,
                alignItems: 'center',
                justifyContent: 'center',
              },
              stretch && { flex: 1 },
            ]}
          >
            {o.icon ? <Icon name={o.icon} size={16} color={active ? c.ink : c.inkMuted} /> : null}
            {o.label ? (
              <Text
                numberOfLines={1}
                style={{ fontFamily: active ? FONTS.uiMedium : FONTS.ui, fontSize: o.size || (lg ? 14 : 13.5), color: active ? c.ink : c.inkMuted }}
              >
                {o.label}
              </Text>
            ) : null}
            {o.dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/// Interruptor: pista redonda de 44×26 y perilla circular; encendido en acento.
export function Toggle({ value, onChange, disabled = false, label }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: reduced ? 0 : MOTION.fade,
      easing: EASE,
      useNativeDriver: false,
    }).start();
  }, [value, anim, reduced]);

  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View
        style={{
          width: 44,
          height: 26,
          borderRadius: 13,
          backgroundColor: anim.interpolate({ inputRange: [0, 1], outputRange: [c.surface5, c.accent] }),
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: 3,
            left: anim.interpolate({ inputRange: [0, 1], outputRange: [3, 21] }),
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: anim.interpolate({ inputRange: [0, 1], outputRange: [c.inkMuted, c.onAccent] }),
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

// ── Tarjetas, grupos y cabeceras ─────────────────────────────────────────────

export function Card({ children, style }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.sheet, borderRadius: RADIUS, padding: 16 }, style]}>{children}</View>;
}

/// Encabezado de grupo (Fijadas, Hoy, Plan…): sin versalitas, apagado.
export function Eyebrow({ children, style }) {
  const c = useColors();
  // Etiqueta de grupo en mono y versalitas, para que no compita con las filas.
  return <Text style={[{ fontFamily: FONTS.monoMedium, fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase', color: c.inkMuted }, style]}>{children}</Text>;
}

/// Sección de ajustes: encabezado y un bloque de filas sobre la tarjeta.
export function Section({ title, children, delay = 0, style }) {
  const c = useColors();
  return (
    <FadeUp delay={delay} style={[{ gap: 8 }, style]}>
      {!!title && <Eyebrow style={{ paddingHorizontal: 4 }}>{title}</Eyebrow>}
      <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>{children}</View>
    </FadeUp>
  );
}

/// Fila de ajustes: título con detalle opcional, valor o control a la derecha
/// y flecha cuando lleva a otra pantalla.
export function Row({ title, detail, value, right, onPress, chevron = !!onPress, external = false, danger = false, icon }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        minHeight: detail ? 64 : 52,
        paddingHorizontal: 14,
        paddingVertical: detail ? 10 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed && onPress ? c.pressed : 'transparent',
      })}
    >
      {icon ? <RowIcon name={icon} danger={danger} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 15, color: danger ? c.danger : c.ink }}>
          {title}
        </Text>
        {!!detail && <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkMuted }}>{detail}</Text>}
      </View>
      {right}
      {value != null && (
        <Text numberOfLines={1} style={{ maxWidth: 170, fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>
          {value}
        </Text>
      )}
      {chevron && <Icon name={external ? 'external' : 'chevron-right'} size={external ? 15 : 16} color={c.inkFaint} />}
    </Pressable>
  );
}

/// Icono de fila sobre una pastilla de relleno, para que la columna de iconos
/// se lea de un vistazo.
export function RowIcon({ name, danger = false, children }) {
  const c = useColors();
  return (
    <View style={{ width: 28, height: 28, borderRadius: RADIUS_SM, backgroundColor: danger ? c.dangerSoft : c.surface4, alignItems: 'center', justifyContent: 'center' }}>
      {children || <Icon name={name} size={15} color={danger ? c.danger : c.inkBody} />}
    </View>
  );
}

/// Barra fina de progreso (uso del plan).
export function Meter({ value, width, color }) {
  const c = useColors();
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <View style={{ width, flex: width ? undefined : 1, height: 3, borderRadius: 2, backgroundColor: c.surface5, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height: 3, borderRadius: 2, backgroundColor: color || (pct >= 0.9 ? c.danger : c.ink70) }} />
    </View>
  );
}

/// Cabecera de pantalla apilada: volver + título.
export function StackHeader({ title, onBack, right = null }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: 2, height: 50 }}>
      <IconButton onPress={onBack} label="Volver">
        <Icon name="arrow-left" size={20} color={c.inkBody} />
      </IconButton>
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink }}>
        {title}
      </Text>
      {right}
    </View>
  );
}

/// Titular en serif (bienvenidas, acceso).
export function ScreenTitle({ children, style }) {
  const c = useColors();
  return (
    <Text style={[{ fontFamily: FONTS.serif, fontSize: 32, lineHeight: 37, letterSpacing: -0.3, color: c.ink }, style]}>
      {children}
    </Text>
  );
}

/// Cabecera de sección: menú, título centrado que abre las acciones y una
/// acción a la derecha.
export function ChatHeader({ title, onLeading, leadingIcon = 'menu', onTitle, trailing, onTrailing, trailingLabel, dot = null }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: insets.top + 2, height: insets.top + 50 }}>
      <IconButton onPress={onLeading} label={leadingIcon === 'menu' ? 'Abrir menú' : 'Volver'}>
        <Icon name={leadingIcon} size={leadingIcon === 'menu' ? 22 : 20} color={c.inkBody} />
      </IconButton>

      <Pressable
        onPress={onTitle}
        disabled={!onTitle}
        style={({ pressed }) => ({
          flex: 1,
          height: 44,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          borderRadius: RADIUS,
          backgroundColor: pressed && onTitle ? c.pressed : 'transparent',
        })}
      >
        {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot === 'live' ? c.accent : c.inkFaint }} />}
        {!!title && (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>
            {title}
          </Text>
        )}
        {!!title && !!onTitle && <Icon name="chevron-down" size={14} color={c.inkMuted} />}
      </Pressable>

      {trailing ? (
        <IconButton onPress={onTrailing} label={trailingLabel}>
          <Icon name={trailing} size={trailing === 'search' ? 20 : 21} color={trailing === 'search' ? c.ink70 : c.inkBody} />
        </IconButton>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </View>
  );
}

/// Plan del usuario: solo texto en acento, sin cápsula.
export function PlanPill({ children, size = 11.5 }) {
  const c = useColors();
  return <Text style={{ fontFamily: FONTS.uiMedium, fontSize: size, color: c.accent }}>{children}</Text>;
}

/// Avatar cuadrado de radio 8: la foto de perfil o la inicial sobre tinta.
export function Avatar({ name, size = 38, uri }) {
  const c = useColors();
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: RADIUS, backgroundColor: c.surface4 }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: RADIUS, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: size * 0.4, color: c.onPrimary }}>{initial}</Text>
    </View>
  );
}

/// Entrada suave (fundido + subida) para mensajes, secciones y vistas.
export function FadeUp({ children, delay = 0, distance = 8, duration = MOTION.fade, style, ...rest }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: reduced ? 0 : duration,
      delay: reduced ? 0 : delay,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [anim, delay, duration, reduced]);
  return (
    <Animated.View
      {...rest}
      style={[
        style,
        { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }] },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/// Opacidad que respira (puntos de estado y esqueletos de carga).
export function Breathe({ children, delay = 0, style, from = 0.35, to = 0.8 }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? to : from)).current;
  useEffect(() => {
    if (reduced) {
      anim.setValue(to);
      return undefined;
    }
    const half = { duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true };
    const loop = Animated.loop(
      Animated.sequence([Animated.timing(anim, { ...half, toValue: to }), Animated.timing(anim, { ...half, toValue: from })]),
    );
    const t = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(t);
      loop.stop();
    };
  }, [anim, delay, from, to, reduced]);
  return <Animated.View style={[style, { opacity: anim }]}>{children}</Animated.View>;
}

/// Esqueleto de carga: barras que respiran en cascada.
export function SkeletonLines({ widths = ['70%', '52%', '62%'], height = 12, gap = 10, style }) {
  const c = useColors();
  return (
    <View style={[{ gap }, style]} accessibilityLabel="Cargando">
      {widths.map((w, i) => (
        <Breathe key={i} delay={i * 200} style={{ width: w, height, borderRadius: 4, backgroundColor: c.surface4 }} />
      ))}
    </View>
  );
}
