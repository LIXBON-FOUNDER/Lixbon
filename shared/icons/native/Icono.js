// Iconos de Lixbon para React Native (Expo). Necesita react-native-svg.
//   <Icono nombre="campana" color="#F6EEDC" />
//   <Icono nombre="visuals" relleno tema="oscuro" />   gemela rellena del ítem activo
import React from 'react';
import { SvgXml } from 'react-native-svg';
import ICONOS from './iconos-native-datos.js';

export const NOMBRES = Object.keys(ICONOS);

export function Icono({ nombre, relleno = false, tema = 'oscuro', size = 24, color, style }) {
  const icono = ICONOS[nombre];
  if (!icono) return null;
  const xml = (relleno && (tema === 'claro' ? icono.claro : icono.oscuro)) || icono.linea;
  // El trazo usa currentColor: `color` lo fija.
  return <SvgXml xml={xml} width={size} height={size} color={color} style={style} />;
}

export default Icono;
