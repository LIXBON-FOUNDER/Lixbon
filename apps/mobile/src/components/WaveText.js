// WaveText.js — texto de una acción en curso con una ola de color que recorre
// las letras, como en el IDE y la web. Un solo reloj (Animated.Value en bucle)
// mueve todas las letras, cada una con su desfase.
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Text } from 'react-native';
import { useReducedMotion } from './ui';

const PERIOD = 1800;
const STEP = 38; // ms entre letra y letra

export default function WaveText({ text, color, accent, style }) {
  const reduced = useReducedMotion();
  const clock = useRef(new Animated.Value(0)).current;
  const chars = useMemo(() => [...(text.length > 90 ? `${text.slice(0, 89)}…` : text)], [text]);

  useEffect(() => {
    if (reduced) return undefined;
    clock.setValue(0);
    const loop = Animated.loop(Animated.timing(clock, { toValue: 1, duration: PERIOD, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [clock, reduced]);

  const colors = useMemo(() => chars.map((_, i) => {
    const offset = ((i * STEP) % PERIOD) / PERIOD;
    const phase = Animated.modulo(Animated.add(clock, 1 - offset), 1);
    return phase.interpolate({ inputRange: [0, 0.12, 0.3, 1], outputRange: [color, accent, color, color] });
  }), [chars, clock, color, accent]);

  if (reduced) return <Text numberOfLines={1} style={[style, { color: accent }]}>{text}</Text>;
  return (
    <Text numberOfLines={1} style={style} accessibilityLabel={text}>
      {chars.map((ch, i) => <Animated.Text key={i} style={{ color: colors[i] }}>{ch}</Animated.Text>)}
    </Text>
  );
}
