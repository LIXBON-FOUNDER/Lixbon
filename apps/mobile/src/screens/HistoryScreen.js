// HistoryScreen.js — historial de conversaciones (compartido con la web:
// source=web). Buscar, abrir, renombrar y borrar con mantener pulsado.
// Mismo lenguaje que el sidebar de la web: fondo blanco, búsqueda pill crema
// y filas limpias separadas por hairlines.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { ScreenTitle, useColors } from '../components/ui';
import { ApiException } from '../api';
import { useApi, useChat } from '../state';
import { FONTS, RADIUS_PILL } from '../theme';

function formatWhen(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export default function HistoryScreen({ onOpenChat }) {
  const c = useColors();
  const api = useApi();
  const chat = useChat();
  const { prompt, confirm, sheet, toast } = useDialogs();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [focused, setFocused] = useState(false);
  const queryRef = useRef('');
  const debounceRef = useRef(null);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const q = queryRef.current;
      const qs = q ? `?q=${encodeURIComponent(q)}&source=web` : '?source=web';
      const res = await api.get(`/api/conversations${qs}`);
      const list = (Array.isArray(res?.conversations) ? res.conversations : []).filter(
        (item) => item && typeof item === 'object',
      );
      setItems(list);
    } catch {
      // offline: se queda la lista anterior
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onQuery = (value) => {
    queryRef.current = value;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load({ silent: true }), 300);
  };

  const open = (item) => {
    chat.openConversation(item.id, typeof item.title === 'string' ? item.title : null);
    onOpenChat();
  };

  const rename = async (item) => {
    const value = await prompt({
      title: 'Renombrar conversación',
      placeholder: 'Nuevo título',
      initialValue: item.title || '',
      confirmLabel: 'Guardar',
    });
    const trimmed = (value || '').trim();
    if (!trimmed) return;
    try {
      await api.patch(`/api/conversations/${item.id}`, { title: trimmed });
      setItems((current) =>
        current.map((it) => (it.id === item.id ? { ...it, title: trimmed } : it)),
      );
    } catch (err) {
      toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    }
  };

  const remove = async (item) => {
    const ok = await confirm({
      title: 'Eliminar conversación',
      message: `"${item.title || 'Sin título'}" se eliminará definitivamente.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/conversations/${item.id}`);
      setItems((current) => current.filter((it) => it.id !== item.id));
      if (chat.conversationId === item.id) chat.newChat();
    } catch (err) {
      toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    }
  };

  const longPress = async (item) => {
    const action = await sheet({
      items: [
        { label: 'Renombrar', icon: 'pencil', value: 'rename' },
        { label: 'Eliminar', icon: 'trash', danger: true, value: 'delete' },
      ],
    });
    if (action === 'rename') rename(item);
    if (action === 'delete') remove(item);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScreenTitle>Historial</ScreenTitle>

      {/* Búsqueda pill crema, foco con borde de tinta (como los inputs web) */}
      <View
        style={{
          marginHorizontal: 16,
          marginBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 16,
          borderRadius: RADIUS_PILL,
          borderWidth: 1,
          borderColor: focused ? c.border : 'transparent',
          backgroundColor: c.bgInput,
        }}
      >
        <Icon name="search" size={16} color={c.inkSoft} />
        <TextInput
          onChangeText={onQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Buscar conversaciones…"
          placeholderTextColor={c.inkSoft}
          autoCorrect={false}
          style={{ flex: 1, paddingVertical: 11, fontFamily: FONTS.ui, fontSize: 14, color: c.ink }}
        />
      </View>

      {loading && items.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.inkSoft} />
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 40 }}>
          <Icon name="chat" size={32} color={c.inkMuted} strokeWidth={1.4} />
          <Text
            style={{
              textAlign: 'center',
              fontFamily: FONTS.ui,
              fontSize: 14,
              lineHeight: 21,
              color: c.inkSoft,
            }}
          >
            {queryRef.current
              ? 'Sin resultados para tu búsqueda.'
              : 'Aún no tienes conversaciones.\nEmpieza una desde el chat.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={c.ink}
              colors={[c.ink]}
              onRefresh={async () => {
                setRefreshing(true);
                await load({ silent: true });
                setRefreshing(false);
              }}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: c.borderSoft }} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => open(item)}
              onLongPress={() => longPress(item)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 14,
                paddingHorizontal: 6,
                backgroundColor: pressed ? c.pressed : 'transparent',
                borderRadius: 12,
              })}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}
                >
                  {item.title || 'Sin título'}
                </Text>
                <Text
                  style={{
                    fontFamily: FONTS.ui,
                    fontSize: 12.5,
                    color: c.inkSoft,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {formatWhen(item.updated_at || item.created_at)}
                </Text>
              </View>
              <Icon name="chevron-right" size={17} color={c.inkMuted} />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
