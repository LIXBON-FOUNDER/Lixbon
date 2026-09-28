// TitleBar.js — la barra de título del IDE en el teléfono: menú, isotipo,
// selector de sección con indicador deslizante (Chat · Remoto), buscador que
// abre la paleta y la cuenta.
import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Icon from './Icon';
import { Avatar, IconButton, LogoMark, Segmented, useColors } from './ui';

const SECTIONS = [
  { value: 'chat', label: 'Chat' },
  { value: 'remote', label: 'Remoto' },
];

export default function TitleBar({ section, onSection, onMenu, onSearch, onAccount, userName }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingHorizontal: 6,
        height: insets.top + 50,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
      }}
    >
      <IconButton onPress={onMenu} label="Abrir el panel">
        <Icon name="menu" size={19} color={c.ink} />
      </IconButton>
      <Pressable onPress={onMenu} hitSlop={4} style={{ paddingHorizontal: 4 }}>
        <LogoMark size={22} />
      </Pressable>

      <View style={{ flex: 1, alignItems: 'center' }}>
        <Segmented options={SECTIONS} value={section} onChange={onSection} />
      </View>

      <IconButton onPress={onSearch} label="Buscar o ejecutar">
        <Icon name="search" size={18} color={c.ink70} />
      </IconButton>
      <Pressable onPress={onAccount} hitSlop={6} accessibilityLabel="Tu cuenta" style={{ paddingHorizontal: 4 }}>
        <Avatar name={userName} size={28} />
      </Pressable>
    </View>
  );
}
