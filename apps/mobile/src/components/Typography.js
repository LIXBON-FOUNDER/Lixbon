import React, { forwardRef } from 'react';
import { Text as NativeText, TextInput as NativeTextInput } from 'react-native';
import { FONTS, TEXT } from '../theme';
const base = { fontFamily: FONTS.ui, fontSize: TEXT.body, letterSpacing: 0.1, fontVariant: ['tabular-nums'] };
export const Text = forwardRef(function Text({ style, ...props }, ref) {
  return <NativeText {...props} ref={ref} style={[base, style]} />;
});
export const TextInput = forwardRef(function TextInput({ style, ...props }, ref) {
  return <NativeTextInput {...props} ref={ref} style={[base, style]} />;
});
