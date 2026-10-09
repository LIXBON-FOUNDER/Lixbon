// ShimmerText.js — texto de una acción en curso con una franja de luz que lo
// recorre (Pensando…, Buscando en internet…). RN no recorta degradados con el
// texto sin dependencias nativas, así que la franja se pinta letra a letra con
// un solo reloj: cada letra se ilumina cuando la franja pasa por su posición.
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Text } from 'react-native';
import { useColors, useReducedMotion } from './ui';

const PERIOD = 2400;
// La franja entra desde -0.55 y sale por 1.55 del ancho del texto (lo mismo
// que background-position 120% → -20% con un degradado al 250%).
const FROM = -0.55;
const TRAVEL = 2.1;
const HALF_BAND = 0.25 / TRAVEL;

export default function ShimmerText({ text, style, base, highlight }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const clock = useRef(new Animated.Value(0)).current;
  const muted = base || c.inkMuted;
  const lit = highlight || c.ink;
  const chars = useMemo(() => [...(text.length > 90 ? `${text.slice(0, 89)}…` : text)], [text]);

  useEffect(() => {
    if (reduced) return undefined;
    clock.setValue(0);
    const loop = Animated.loop(Animated.timing(clock, { toValue: 1, duration: PERIOD, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [clock, reduced]);

  const colors = useMemo(() => {
    const n = Math.max(chars.length - 1, 1);
    return chars.map((_, i) => {
      const peak = (i / n - FROM) / TRAVEL;
      return clock.interpolate({
        inputRange: [0, peak - HALF_BAND, peak, peak + HALF_BAND, 1],
        outputRange: [muted, muted, lit, muted, muted],
      });
    });
  }, [chars, clock, muted, lit]);

  if (reduced) {
    return (
      <Text numberOfLines={1} style={[style, { color: muted }]}>
        {text}
      </Text>
    );
  }
  return (
    <Text numberOfLines={1} style={style} accessibilityLabel={text}>
      {chars.map((ch, i) => (
        <Animated.Text key={i} style={{ color: colors[i] }}>
          {ch}
        </Animated.Text>
      ))}
    </Text>
  );
}
