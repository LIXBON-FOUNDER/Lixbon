// observe/ui.js — piezas visuales de Supervisar con datos reales (LXO-108…111), con el lenguaje del
// prototipo del Sprint D (LXO-227): estado como punto de color con texto, avisos en superficie suave y el
// rojo reservado a fallos de verdad (nunca a «sin conexión» ni a «desactualizado»).
import React from 'react';
import { Text, View } from 'react-native';

import Icon from '../components/Icon';
import { PillButton, useColors } from '../components/ui';
import { FONTS, RADIUS } from '../theme';

export function toneColor(tone, c) {
  return { ok: c.good || c.ok, warn: c.warn, error: c.danger, muted: c.inkFaint }[tone] || c.inkFaint;
}

export function Dot({ color, size = 7 }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Estado como punto de color con texto (nunca una píldora). */
export function StateText({ tone, children }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dot color={toneColor(tone, c)} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{children}</Text>
    </View>
  );
}

export function Body({ children, muted = false, style, ...rest }) {
  const c = useColors();
  return (
    <Text {...rest} style={[{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: muted ? c.inkMuted : c.inkBody }, style]}>
      {children}
    </Text>
  );
}

export function Mono({ children, style, ...rest }) {
  const c = useColors();
  return (
    <Text {...rest} style={[{ fontFamily: FONTS.mono, fontSize: 12.5, color: c.inkBody }, style]}>
      {children}
    </Text>
  );
}

export function Title({ children }) {
  const c = useColors();
  return <Text accessibilityRole="header" style={{ fontFamily: FONTS.serif, fontSize: 24, lineHeight: 29, color: c.ink }}>{children}</Text>;
}

/** Aviso en superficie suave. `tone`: warn · error · info · muted. */
export function Notice({ tone = 'warn', icon, title, children, action, onAction, accessibilityLabel }) {
  const c = useColors();
  const fg = tone === 'warn' ? c.warn : tone === 'error' ? c.danger : tone === 'info' ? c.info : c.inkMuted;
  const bg = tone === 'warn' ? c.warnSoft : tone === 'error' ? c.dangerSoft : tone === 'info' ? c.surface3 : c.surface2;
  return (
    <View
      accessible
      accessibilityRole={tone === 'error' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: RADIUS, backgroundColor: bg }}
    >
      {icon ? <Icon name={icon} size={17} color={fg} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: tone === 'muted' ? c.inkBody : fg }}>{title}</Text> : null}
        {children ? <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 19, color: c.inkBody }}>{children}</Text> : null}
      </View>
      {action ? <PillButton size="sm" outline label={action} onPress={onAction} /> : null}
    </View>
  );
}
