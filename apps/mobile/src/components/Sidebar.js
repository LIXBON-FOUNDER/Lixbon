// Sidebar.js — contenido del drawer lateral, espejo del sidebar de la web
// (DISENO_WEB.md 2.1): wordmark arriba, "Nueva conversación", búsqueda,
// sección Historial con las conversaciones (abrir / mantener pulsado para
// renombrar o eliminar), accesos a Uso y Documentación, y footer de perfil
// crema con avatar de tinta, plan y engranaje (→ Cuenta).
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { useApi, useAuth, useChat } from '../state';
import { FONTS, RADIUS_PILL } from '../theme';
import Icon from './Icon';
import { useDialogs } from './dialogs';
import { IconButton, LixLogo, PlanPill, useColors } from './ui';

export default function Sidebar({ open, onClose, onNavigate }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const chat = useChat();
  const insets = useSafeAreaInsets();
  const { prompt, confirm, sheet, toast } = useDialogs();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const queryRef = useRef('');
  const debounceRef = useRef(null);
  const loadedOnce = useRef(false);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const q = queryRef.current;
      const qs = q ? `?q=${encodeURIComponent(q)}&source=web` : '?source=web';
      const res = await api.get(`/api/conversations${qs}`);
      setItems(
        (Array.isArray(res?.conversations) ? res.conversations : []).filter(
          (it) => it && typeof it === 'object',
        ),
      );
    } catch {
      // offline: se queda la lista anterior
    } finally {
      setLoading(false);
    }
  };

  // Recarga cada vez que se abre el drawer (la primera con spinner).
  useEffect(() => {
    if (open) {
      load({ silent: loadedOnce.current });
      loadedOnce.current = true;
    }
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onQuery = (value) => {
    queryRef.current = value;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load({ silent: true }), 300);
  };

  const openConversation = (item) => {
    chat.openConversation(item.id, typeof item.title === 'string' ? item.title : null);
    onClose();
  };

  const newChat = () => {
    chat.newChat();
    onClose();
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
      setItems((cur) => cur.map((it) => (it.id === item.id ? { ...it, title: trimmed } : it)));
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
      setItems((cur) => cur.filter((it) => it.id !== item.id));
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

  const user = auth.user || {};
  const fullName = [user.first_name, user.last_name]
    .filter((s) => typeof s === 'string' && s)
    .join(' ');
  const displayName = fullName || user.username || user.email || '—';
  const initial = (displayName[0] || '?').toUpperCase();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bgSidebar,
        paddingTop: insets.top + 6,
        borderRightWidth: 1,
        borderRightColor: c.borderSoft,
      }}
    >
      {/* Cabecera: wordmark + cerrar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 18,
          paddingRight: 10,
          paddingBottom: 12,
        }}
      >
        <LixLogo size={20} />
        <IconButton onPress={onClose}>
          <Icon name="panel" size={19} color={c.inkSoft} />
        </IconButton>
      </View>

      {/* Nueva conversación */}
      <NavItem icon="plus" label="Nueva conversación" onPress={newChat} strong />

      {/* Búsqueda */}
      <View
        style={{
          marginHorizontal: 12,
          marginTop: 8,
          marginBottom: 4,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 14,
          borderRadius: RADIUS_PILL,
          backgroundColor: c.bgInput,
        }}
      >
        <Icon name="search" size={15} color={c.inkSoft} />
        <TextInput
          onChangeText={onQuery}
          placeholder="Buscar…"
          placeholderTextColor={c.inkSoft}
          autoCorrect={false}
          style={{ flex: 1, paddingVertical: 9, fontFamily: FONTS.ui, fontSize: 14, color: c.ink }}
        />
      </View>

      {/* Historial */}
      <Text
        style={{
          fontFamily: FONTS.ui,
          fontSize: 12,
          color: c.inkMuted,
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: 4,
        }}
      >
        Historial
      </Text>
      <View style={{ flex: 1 }}>
        {loading && items.length === 0 ? (
          <View style={{ paddingTop: 30, alignItems: 'center' }}>
            <ActivityIndicator color={c.inkSoft} />
          </View>
        ) : items.length === 0 ? (
          <Text
            style={{
              paddingHorizontal: 20,
              paddingTop: 14,
              fontFamily: FONTS.ui,
              fontSize: 13,
              lineHeight: 19,
              color: c.inkMuted,
            }}
          >
            {queryRef.current ? 'Sin resultados.' : 'Aún no tienes conversaciones.'}
          </Text>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
            renderItem={({ item }) => {
              const active = chat.conversationId === item.id;
              return (
                <Pressable
                  onPress={() => openConversation(item)}
                  onLongPress={() => longPress(item)}
                  style={({ pressed }) => ({
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: active ? c.accentSoft : pressed ? c.pressed : 'transparent',
                  })}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: active ? FONTS.uiMedium : FONTS.ui,
                      fontSize: 14,
                      color: c.ink,
                    }}
                  >
                    {item.title || 'Sin título'}
                  </Text>
                </Pressable>
              );
            }}
          />
        )}
      </View>

      {/* Accesos */}
      <View style={{ borderTopWidth: 1, borderTopColor: c.borderSoft, paddingVertical: 6 }}>
        <NavItem icon="activity" label="Remote" onPress={() => onNavigate('remote')} />
        <NavItem icon="chart" label="Uso" onPress={() => onNavigate('usage')} />
        <NavItem
          icon="book"
          label="Documentación"
          onPress={() => Linking.openURL(`${api.base}/docs`)}
        />
      </View>

      {/* Footer de perfil (crema, como la web) */}
      <Pressable
        onPress={() => onNavigate('account')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: pressed ? c.bgInput : c.bgSecondary,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: Math.max(insets.bottom, 14),
        })}
      >
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: c.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.onPrimary }}>
            {initial}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>
            {displayName}
          </Text>
          {typeof user.plan_name === 'string' && <PlanPill>{user.plan_name}</PlanPill>}
        </View>
        <Icon name="gear" size={19} color={c.inkSoft} />
      </Pressable>
    </View>
  );
}

function NavItem({ icon, label, onPress, strong = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: 12,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <Icon name={icon} size={19} color={c.ink} strokeWidth={strong ? 1.9 : 1.6} />
      <Text
        style={{
          fontFamily: strong ? FONTS.uiMedium : FONTS.ui,
          fontSize: 14.5,
          color: c.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
