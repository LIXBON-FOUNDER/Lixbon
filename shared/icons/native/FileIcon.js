import React from 'react';
import { SvgXml } from 'react-native-svg';
import ICONOS from '../file-icons/data.js';
import { iconoDeArchivo } from '../file-icons/resolver.js';
export { iconoDeArchivo } from '../file-icons/resolver.js';
export function FileIcon({ nombre = '', size = 16, color = '#9A9A9A', style }) {
  return <SvgXml xml={ICONOS[iconoDeArchivo(nombre)]} width={size} height={size} color={color} style={style} accessible={false} />;
}
