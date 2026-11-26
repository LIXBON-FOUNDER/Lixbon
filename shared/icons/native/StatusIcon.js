import React from 'react';
import { SvgXml } from 'react-native-svg';
import ICONOS from '../status/data.js';
export function StatusIcon({ kind = 'paused', size = 16, color, label, style }) {
  return <SvgXml xml={ICONOS[kind] || ICONOS.paused} width={size} height={size} color={color} style={style} accessible={!!label} accessibilityLabel={label} />;
}
