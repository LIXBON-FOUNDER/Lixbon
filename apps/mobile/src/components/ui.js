// ui.js — primitivas del sistema del IDE llevadas a la app: tema activo con
// acento elegible, marca, campos y botones de relleno (sin bordes), selector
// deslizante, interruptor, tarjetas, cabeceras y la luz ambiente del fondo.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Svg, { Defs, Path, Polygon, RadialGradient, Rect, Stop, Circle } from 'react-native-svg';

import { FONTS, RADIUS, buildTheme } from '../theme';
import { UI_DEFAULTS, usePrefs } from '../state';
import Icon from './Icon';

export const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
export const SPRING = Easing.bezier(0.3, 1.25, 0.5, 1);

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
export function useScale() {
  const { textSize, density } = useUi();
  const tf = TEXT_SCALE[textSize] || 1;
  const sf = SPACE_SCALE[density] || 1;
  return { t: (n) => Math.round(n * tf * 10) / 10, s: (n) => Math.round(n * sf) };
}

// ── Marca ────────────────────────────────────────────────────────────────────

export function LixLogo({ size = 28, color }) {
  const c = useColors();
  return (
    <Text style={{ fontFamily: FONTS.brand, fontSize: size, letterSpacing: size * 0.04, color: color || c.ink }}>
      LIXBON
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

// ── Campos ───────────────────────────────────────────────────────────────────

/// Campo de relleno con etiqueta flotante dentro (sin contorno): el foco se
/// dice con el relleno y una línea de acento abajo, como el .field del IDE.
export function FloatingField({
  label,
  value,
  onChangeText,
  secure = false,
  keyboardType,
  autoCapitalize = 'none',
  onSubmitEditing,
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const lifted = focused || !!value;
  const anim = useRef(new Animated.Value(lifted ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: lifted ? 1 : 0,
      duration: reduced ? 0 : 180,
      easing: EASE,
      useNativeDriver: false,
    }).start();
  }, [lifted, anim, reduced]);

  return (
    <View
      style={{
        borderRadius: RADIUS,
        backgroundColor: focused ? c.surface4 : c.surface3,
        overflow: 'hidden',
      }}
    >
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
        selectionColor={c.accent}
        style={{
          paddingHorizontal: 14,
          paddingTop: 22,
          paddingBottom: 8,
          fontFamily: FONTS.ui,
          fontSize: 15,
          color: c.ink,
        }}
      />
      <Animated.Text
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 14,
          top: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 7] }),
          fontSize: anim.interpolate({ inputRange: [0, 1], outputRange: [15, 11] }),
          fontFamily: lifted ? FONTS.uiMedium : FONTS.ui,
          color: focused ? c.accentDeep : c.inkLabel,
        }}
      >
        {label}
      </Animated.Text>
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 2,
          backgroundColor: focused ? c.accent : 'transparent',
        }}
      />
    </View>
  );
}

// ── Botones ──────────────────────────────────────────────────────────────────

/// Botón del IDE (.btn): primario invertido, secundario de relleno, peligro
/// en rojo apagado. Pulsar encoge un poco, como el :active del escritorio.
export function PillButton({ label, onPress, disabled = false, danger = false, outline = false, size = 'md', icon }) {
  const c = useColors();
  const lg = size === 'lg';
  const bg = danger ? c.dangerSoft : outline ? c.surface5 : c.primary;
  const fg = danger ? c.danger : outline ? c.inkBody : c.onPrimary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 8,
        borderRadius: RADIUS,
        paddingHorizontal: 18,
        height: lg ? 48 : 38,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
        opacity: disabled ? 0.45 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: lg ? 15 : 13.5, color: fg }}>{label}</Text>
    </Pressable>
  );
}

/// Botón de icono (.ic del IDE): cuadrado de radio 7, relleno solo al pulsar.
export function IconButton({ children, onPress, onLongPress, size = 36, bg = 'transparent', active = false, label }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c.pressed : active ? c.surface4 : bg,
        transform: [{ scale: pressed ? 0.9 : 1 }],
      })}
    >
      {children}
    </Pressable>
  );
}

/// Chip del IDE: relleno, texto suave; activo en acento.
export function Chip({ label, icon, onPress, active = false, mono = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 30,
        paddingHorizontal: 11,
        borderRadius: RADIUS,
        backgroundColor: active ? c.accentSoft : pressed ? c.surface5 : c.surface3,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={active ? c.accentDeep : c.inkSoft} /> : null}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: mono ? FONTS.mono : active ? FONTS.uiSemiBold : FONTS.ui,
          fontSize: mono ? 11.5 : 12.5,
          color: active ? c.accentDeep : c.ink70,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Selector deslizante e interruptor ────────────────────────────────────────

/// Selector con indicador deslizante (.seg / .modeswitch del IDE).
export function Segmented({ options, value, onChange, stretch = false, size = 'md' }) {
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
      Animated.timing(x, { toValue: l.x, duration: 380, easing: SPRING, useNativeDriver: false }),
      Animated.timing(w, { toValue: l.width, duration: 300, easing: EASE, useNativeDriver: false }),
    ]).start();
  }, [value, layouts, x, w, reduced]);

  const h = size === 'sm' ? 26 : 30;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignSelf: stretch ? 'stretch' : 'flex-start',
        padding: 3,
        borderRadius: RADIUS,
        backgroundColor: c.dark ? c.surface0 : c.surface4,
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
            borderRadius: RADIUS,
            backgroundColor: c.dark ? c.surface5 : c.surface2,
          }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            onLayout={(e) => {
              const { x: lx, width } = e.nativeEvent.layout;
              setLayouts((cur) => (cur[o.value]?.x === lx && cur[o.value]?.width === width ? cur : { ...cur, [o.value]: { x: lx, width } }));
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={[{ height: h, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' }, stretch && { flex: 1 }]}
          >
            <Text
              numberOfLines={1}
              style={{
                fontFamily: active ? FONTS.uiSemiBold : FONTS.ui,
                fontSize: size === 'sm' ? 12 : 13,
                color: active ? c.ink : c.inkMuted,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/// Interruptor del IDE: pista de radio 7 y perilla cuadrada que se estira
/// al pulsar; encendido en acento.
export function Toggle({ value, onChange, disabled = false, label }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: reduced ? 0 : 320,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
  }, [value, anim, reduced]);

  return (
    <Pressable
      onPress={() => onChange(!value)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View
        style={{
          width: 40,
          height: 24,
          borderRadius: RADIUS,
          backgroundColor: anim.interpolate({ inputRange: [0, 1], outputRange: [c.surface5, c.accent] }),
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: 4,
            left: anim.interpolate({ inputRange: [0, 1], outputRange: [4, pressed ? 14 : 20] }),
            width: pressed ? 22 : 16,
            height: 16,
            borderRadius: 5,
            backgroundColor: value ? c.onAccent : c.inkMuted,
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

// ── Tarjetas, etiquetas y cabeceras ──────────────────────────────────────────

/// Panel del IDE: relleno un peldaño por encima del fondo, sin borde.
export function Card({ children, style }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: c.surface1, borderRadius: RADIUS, padding: 16 }, style]}>{children}</View>
  );
}

export function CardTitle({ children, style }) {
  const c = useColors();
  return <Text style={[{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.ink }, style]}>{children}</Text>;
}

/// Etiqueta en versalitas que encabeza un grupo (HOY, FIJADAS…).
export function Eyebrow({ children, style }) {
  const c = useColors();
  return (
    <Text style={[{ fontFamily: FONTS.uiMedium, fontSize: 10.5, letterSpacing: 1, color: c.inkLabel }, style]}>
      {String(children).toUpperCase()}
    </Text>
  );
}

/// Cabecera de pantalla apilada (.panelhead): volver + título.
export function StackHeader({ title, onBack, right = null }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, height: 50 }}>
      <IconButton onPress={onBack} size={38} label="Volver">
        <Icon name="arrow-left" size={19} color={c.ink} />
      </IconButton>
      <Text style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}>{title}</Text>
      {right}
    </View>
  );
}

export function ScreenTitle({ children }) {
  const c = useColors();
  return (
    <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 22, color: c.ink, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14 }}>
      {children}
    </Text>
  );
}

/// Cabecera de conversación: acción izquierda, título con subtítulo en mono y
/// menú de opciones. Todo el bloque central abre las opciones.
export function ChatHeader({ title, subtitle, onLeading, leadingIcon = 'menu', onOptions, dot = null }) {
  const c = useColors();
  const dotColor = dot === 'live' ? c.accent : c.inkFaint;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, height: 52 }}>
      <IconButton onPress={onLeading} size={40}>
        <Icon name={leadingIcon} size={20} color={c.ink} />
      </IconButton>

      <Pressable
        onPress={onOptions}
        disabled={!onOptions}
        style={({ pressed }) => ({
          flex: 1,
          alignItems: 'flex-start',
          paddingHorizontal: 6,
          paddingVertical: 3,
          borderRadius: RADIUS,
          backgroundColor: pressed && onOptions ? c.pressed : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%' }}>
          {dot !== null && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />}
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.ink }}>
            {title}
          </Text>
        </View>
        {!!subtitle && (
          <Text numberOfLines={1} style={{ maxWidth: '100%', marginTop: 1, fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>
            {subtitle}
          </Text>
        )}
      </Pressable>

      {onOptions ? (
        <IconButton onPress={onOptions} size={40}>
          <Icon name="dots" size={19} color={c.ink} />
        </IconButton>
      ) : (
        <View style={{ width: 40 }} />
      )}
    </View>
  );
}

/// Etiqueta de plan: velo de acento, texto en acento.
export function PlanPill({ children }) {
  const c = useColors();
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: c.accentSoft, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 11, color: c.accentDeep }}>{children}</Text>
    </View>
  );
}

/// Avatar cuadrado de radio 7 (el del IDE): inicial sobre tinta.
export function Avatar({ name, size = 34 }) {
  const c = useColors();
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: RADIUS, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: FONTS.uiBold, fontSize: size * 0.42, color: c.onPrimary }}>{initial}</Text>
    </View>
  );
}

/// Entrada suave (fade + subida) para mensajes y cambios de vista.
export function FadeUp({ children, delay = 0, style }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: reduced ? 0 : 280,
      delay: reduced ? 0 : delay,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [anim, delay, reduced]);
  return (
    <Animated.View
      style={[
        style,
        { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] },
      ]}
    >
      {children}
    </Animated.View>
  );
}
