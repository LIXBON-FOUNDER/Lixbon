// StatusStrip.js — la barra de estado del IDE bajo el compositor: estado,
// modelo, búsqueda web, contexto usado y número de mensajes, en mono.
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { useChat } from '../state';
import { FONTS } from '../theme';
import { useColors } from './ui';

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export default function StatusStrip({ onPickModel }) {
  const c = useColors();
  const chat = useChat();
  const failed = !!chat.error;
  const dot = failed ? c.danger : chat.streaming ? c.warn : c.accent;
  const state = failed ? 'error' : chat.streaming ? 'generando…' : 'listo';
  const u = chat.usage;
  const pct = u?.total ? Math.min(100, Math.round((u.used / u.total) * 100)) : null;
  const ctxColor = pct >= 90 ? c.danger : pct >= 75 ? c.warn : c.inkLabel;
  const txt = { fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 22, paddingHorizontal: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: dot }} />
        <Text style={txt}>{state}</Text>
      </View>
      <Pressable onPress={onPickModel} hitSlop={6} style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={[txt, { color: c.inkSoft }]}>
          {chat.model || 'sin modelo'}
        </Text>
      </Pressable>
      <Pressable onPress={() => chat.setWebSearch(!chat.webSearch)} hitSlop={6}>
        <Text style={[txt, chat.webSearch && { color: c.accentDeep }]}>web {chat.webSearch ? 'on' : 'off'}</Text>
      </Pressable>
      <View style={{ flex: 1 }} />
      {u && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <Text numberOfLines={1} style={[txt, { color: ctxColor }]}>
            ctx {compact(u.used)}
            {u.total ? `/${compact(u.total)}` : ''}
          </Text>
          {pct !== null && (
            <View style={{ width: 30, height: 4, borderRadius: 2, backgroundColor: c.track, overflow: 'hidden' }}>
              <View style={{ width: `${pct}%`, height: '100%', backgroundColor: pct >= 75 ? ctxColor : c.accent }} />
            </View>
          )}
        </View>
      )}
      {chat.messages.length > 0 && !u && <Text numberOfLines={1} style={txt}>{chat.messages.length} msj</Text>}
    </View>
  );
}
