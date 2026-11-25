import React, { forwardRef } from 'react';
import { Pressable as NativePressable, StyleSheet } from 'react-native';
import { useReducedMotion } from './motionPreference';
import { MOTION } from '../theme';
export const Pressable = forwardRef(function Pressable({ style, ...props }, ref) {
  const reduced = useReducedMotion();
  return <NativePressable {...props} ref={ref} style={(state) => {
    const resolved = typeof style === 'function' ? style(state) : style;
    const transforms = (StyleSheet.flatten(resolved)?.transform || []).filter((t) => t.scale === undefined);
    return [resolved, { transform: [...transforms, ...(!reduced && state.pressed ? [{ scale: MOTION.press }] : [])] }];
  }} />;
});
