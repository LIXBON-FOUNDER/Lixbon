// Sidebar.js — el panel lateral del IDE en el drawer: marca, "Nueva
// conversación", filtro, historial (fijadas + grupos por fecha; mantener
// pulsado para fijar, renombrar, compartir o eliminar), accesos y tarjeta de
// cuenta.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { groupByDate, togglePin, usePins } from '../pins';
import { shareConversationById } from '../share';
import { CHAT_SOURCE } from '../sse';
import { useApi, useAuth, useChat } from '../state';
import { FONTS, RADIUS } from '../theme';
import Icon from './Icon';
import { useDialogs } from './dialogs';
import { Avatar, Eyebrow, IconButton, LixLogo, LogoMark, PlanPill, useColors, useScale } from './ui';

export default function Sidebar({ open, onClose, onNavigate }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const chat = useChat();
  const insets = useSafeAreaInsets();
  const { s } = useScale();
  const { prompt, confirm, sheet, toast } = useDialogs();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  const debounceRef = useRef(null);
  const loadedOnce = useRef(false);
  const user = auth.user || {};
  const pins = usePins(user.id);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      // Historial propio de la app: sin `source` el gateway devolvería también
      // lo del CLI, el IDE y la web (la app se autentica con API key).
      const params = [`source=${CHAT_SOURCE}`, 'limit=100'];
      if (queryRef.current) params.push(`q=${encodeURIComponent(queryRef.current)}`);
      const res = await api.get(`/api/conversations?${params.join('&')}`);
      setItems((Array.isArray(res?.conversations) ? res.conversations : []).filter((it) => it && typeof it === 'object'));
    } catch {
      // offline: se queda la lista anterior
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      load({ silent: loadedOnce.current });
      loadedOnce.current = true;
    }
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onQuery = (value) => {
    setQuery(value);
    queryRef.current = value;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load({ silent: true }), 300);
  };

  const rows = useMemo(() => {
    const pinned = items.filter((it) => pins.includes(it.id));
    const groups = [...(pinned.length ? [['Fijadas', pinned]] : []), ...groupByDate(items.filter((it) => !pins.includes(it.id)))];
    return groups.flatMap(([label, list]) => [
      { key: `g:${label}`, label },
      ...list.map((it) => ({ key: String(it.id), item: it, pinned: label === 'Fijadas' })),
    ]);
  }, [items, pins]);

  const openConversation = (item) => {
    chat.openConversation(item.id, typeof item.title === 'string' ? item.title : null);
    onClose();
  };

  const newChat = () => {
    chat.newChat();
    onClose();
  };

  const fail = (err) => toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');

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
      setItems((cur) => cur.map((it) => (it.id === item.id ? { ...it, title: trimmed } : it)));
      if (chat.conversationId === item.id) chat.setTitle(trimmed);
    } catch (err) {
      fail(err);
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
      setItems((cur) => cur.filter((it) => it.id !== item.id));
      if (chat.conversationId === item.id) chat.newChat();
    } catch (err) {
      fail(err);
    }
  };

  const longPress = async (item, pinned) => {
    const action = await sheet({
      title: item.title || 'Sin título',
      items: [
        { label: pinned ? 'Quitar de fijadas' : 'Fijar arriba', icon: 'pin', value: 'pin' },
        { label: 'Renombrar', icon: 'pencil', value: 'rename' },
        { label: 'Compartir como Markdown', icon: 'share', value: 'share' },
        { label: 'Eliminar', icon: 'trash', danger: true, value: 'delete' },
      ],
    });
    if (action === 'pin') togglePin(user.id, item.id);
    if (action === 'rename') rename(item);
    if (action === 'share') shareConversationById(api, item.id).catch(fail);
    if (action === 'delete') remove(item);
  };

  const fullName = [user.first_name, user.last_name].filter((x) => typeof x === 'string' && x).join(' ');
  const displayName = fullName || user.username || user.email || '—';

  return (
    <View style={{ flex: 1, backgroundColor: c.surface1, paddingTop: insets.top + 6, borderTopRightRadius: RADIUS, borderBottomRightRadius: RADIUS }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 16, paddingRight: 8, height: 46 }}>
        <LogoMark size={22} />
        <LixLogo size={14} />
        <View style={{ flex: 1 }} />
        <IconButton onPress={onClose} label="Cerrar el panel">
          <Icon name="panel" size={18} color={c.inkSoft} />
        </IconButton>
      </View>

      <View style={{ paddingHorizontal: 10, gap: 8, paddingTop: 4 }}>
        <Pressable
          onPress={newChat}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            height: 42,
            paddingHorizontal: 13,
            borderRadius: RADIUS,
            backgroundColor: pressed ? c.surface4 : c.surface3,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          <Icon name="plus" size={17} color={c.accentDeep} strokeWidth={1.9} />
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14, color: c.ink }}>Nueva conversación</Text>
        </Pressable>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 11, borderRadius: RADIUS, backgroundColor: c.surface3 }}>
          <Icon name="search" size={14} color={c.inkLabel} />
          <TextInput
            value={query}
            onChangeText={onQuery}
            placeholder="Buscar conversaciones"
            placeholderTextColor={c.inkLabel}
            selectionColor={c.accent}
            autoCorrect={false}
            style={{ flex: 1, paddingVertical: 0, fontFamily: FONTS.ui, fontSize: 13.5, color: c.ink }}
          />
          {!!query && (
            <Pressable onPress={() => onQuery('')} hitSlop={8}>
              <Icon name="x" size={13} color={c.inkLabel} />
            </Pressable>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 }}>
        <Eyebrow style={{ flex: 1 }}>Historial</Eyebrow>
        {items.length > 0 && (
          <Text style={{ fontFamily: FONTS.mono, fontSize: 10, color: c.ink70, paddingHorizontal: 6, borderRadius: 5, backgroundColor: c.surface4 }}>
            {items.length}
          </Text>
        )}
      </View>

      <View style={{ flex: 1 }}>
        {loading && items.length === 0 ? (
          <View style={{ paddingTop: 30, alignItems: 'center' }}>
            <ActivityIndicator color={c.inkSoft} />
          </View>
        ) : items.length === 0 ? (
          <Text style={{ paddingHorizontal: 20, paddingTop: 14, fontFamily: FONTS.ui, fontSize: 13, lineHeight: 19, color: c.inkMuted }}>
            {query ? 'Sin resultados.' : 'Aún no tienes conversaciones.'}
          </Text>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r.key}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
            renderItem={({ item: row }) => {
              if (row.label) {
                return <Eyebrow style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, fontSize: 10 }}>{row.label}</Eyebrow>;
              }
              const item = row.item;
              const active = chat.conversationId === item.id;
              return (
                <Pressable
                  onPress={() => openConversation(item)}
                  onLongPress={() => longPress(item, row.pinned)}
                  delayLongPress={320}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 9,
                    paddingVertical: s(9),
                    paddingHorizontal: 12,
                    borderRadius: RADIUS,
                    backgroundColor: active ? c.surface4 : pressed ? c.pressed : 'transparent',
                  })}
                >
                  {row.pinned && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c.accent }} />}
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, fontFamily: active ? FONTS.uiMedium : FONTS.ui, fontSize: 14, color: active ? c.ink : c.ink70 }}
                  >
                    {item.title || 'Sin título'}
                  </Text>
                </Pressable>
              );
            }}
          />
        )}
      </View>

      <View style={{ paddingHorizontal: 8, paddingTop: 6 }}>
        <NavRow icon="activity" label="Remoto" onPress={() => onNavigate('remote')} />
        <NavRow icon="chart" label="Uso y límites" onPress={() => onNavigate('usage')} />
        <NavRow icon="palette" label="Personalizar" onPress={() => onNavigate('appearance')} />
        <NavRow icon="book" label="Documentación" onPress={() => Linking.openURL(`${api.base}/docs`)} />
      </View>

      <Pressable
        onPress={() => onNavigate('account')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          backgroundColor: pressed ? c.surface4 : c.surface3,
          borderRadius: RADIUS,
          marginHorizontal: 10,
          marginTop: 8,
          marginBottom: Math.max(insets.bottom, 10),
          paddingHorizontal: 12,
          paddingVertical: 10,
        })}
      >
        <Avatar name={displayName} size={34} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 13.5, color: c.ink }}>
            {displayName}
          </Text>
          {typeof user.plan_name === 'string' && <PlanPill>{user.plan_name}</PlanPill>}
        </View>
        <Icon name="gear" size={18} color={c.inkSoft} />
      </Pressable>
    </View>
  );
}

function NavRow({ icon, label, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        height: 40,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <Icon name={icon} size={17} color={c.inkSoft} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.ink70 }}>{label}</Text>
    </Pressable>
  );
}
