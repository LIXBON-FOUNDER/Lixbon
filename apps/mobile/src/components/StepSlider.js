// StepSlider.js — deslizador por pasos (niveles de razonamiento): se arrastra
// o se toca la marca.
import React, { useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';

import { FONTS } from '../theme';
import { useColors } from './ui';

const THUMB = 22;

export default function StepSlider({ steps, value, onChange, labelOf }) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const live = useRef({ width: 0, steps, onChange });
  live.current = { width, steps, onChange };
  const index = Math.max(0, steps.indexOf(value));
  const span = steps.length - 1;

  const pick = (x) => {
    const { width: w, steps: st, onChange: change } = live.current;
    if (!w || st.length < 2) return;
    const i = Math.round(Math.min(1, Math.max(0, (x - THUMB / 2) / (w - THUMB))) * (st.length - 1));
    change(st[i]);
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => pick(e.nativeEvent.locationX),
      onPanResponderMove: (e) => pick(e.nativeEvent.locationX),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const left = span > 0 && width ? (index / span) * (width - THUMB) : 0;
  return (
    <View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: 36, justifyContent: 'center' }}
        accessibilityRole="adjustable"
        accessibilityValue={{ text: labelOf(steps[index]) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const next = index + (e.nativeEvent.actionName === 'increment' ? 1 : -1);
          if (next >= 0 && next <= span) onChange(steps[next]);
        }}
        {...pan.panHandlers}
      >
        <View style={{ height: 4, marginHorizontal: THUMB / 2, borderRadius: 2, backgroundColor: c.surface4 }}>
          <View style={{ width: Math.max(0, left), height: 4, borderRadius: 2, backgroundColor: c.accent }} />
        </View>
        {steps.map((st, i) => (
          <View
            key={st}
            pointerEvents="none"
            style={{ position: 'absolute', left: span > 0 && width ? (i / span) * (width - THUMB) + THUMB / 2 - 3 : 0, width: 6, height: 6, borderRadius: 3, backgroundColor: i <= index ? c.accent : c.surface5 }}
          />
        ))}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: c.primary }}
        />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {steps.map((st) => (
          <Pressable key={st} onPress={() => onChange(st)} hitSlop={8}>
            <Text style={{ fontFamily: st === steps[index] ? FONTS.uiMedium : FONTS.ui, fontSize: 12.5, color: st === steps[index] ? c.ink : c.inkMuted }}>
              {labelOf(st)}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
