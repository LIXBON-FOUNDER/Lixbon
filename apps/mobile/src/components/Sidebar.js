// Sidebar.js — contenido del drawer lateral, espejo del sidebar de la web
// (DISENO_WEB.md 2.1): wordmark arriba, "Nueva conversación" como bloque
// crema, búsqueda, sección Historial con las conversaciones (abrir / mantener
// pulsado para renombrar o eliminar), un menú crema que despliega Remote / Uso
// / Documentación hacia arriba (sin separadores que corten la columna), y
// footer de perfil crema con avatar de tinta, plan y engranaje (→ Cuenta).
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
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
import { IconButton, LixLogo, PlanPill, useColors, useReducedMotion } from './ui';
import { CHAT_SOURCE } from '../sse';

const MENU_ITEM_HEIGHT = 46;

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
  const [menuOpen, setMenuOpen] = useState(false);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      // Historial propio de la app. Sin `source` el gateway devuelve TODAS las
      // superficies (la app se autentica con API key, no con sesión), y el CLI,
      // el IDE y la web acababan mezclados aquí dentro. Lo que se hable desde
      // el IDE o el CLI se sigue en la pantalla Remoto, no en este historial.
      const params = [`source=${CHAT_SOURCE}`];
      if (queryRef.current) params.push(`q=${encodeURIComponent(queryRef.current)}`);
      const qs = params.length ? `?${params.join('&')}` : '';
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

  // Recarga cada vez que se abre el drawer (la primera con spinner). Al
  // cerrarlo el menú desplegable vuelve a su estado plegado.
  useEffect(() => {
    if (open) {
      load({ silent: loadedOnce.current });
      loadedOnce.current = true;
    } else {
      setMenuOpen(false);
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
          paddingBottom: 14,
        }}
      >
        <LixLogo size={24} />
        <IconButton onPress={onClose}>
          <Icon name="panel" size={19} color={c.inkSoft} />
        </IconButton>
      </View>

      {/* Nueva conversación: bloque crema, la acción principal del drawer */}
      <Pressable
        onPress={newChat}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginHorizontal: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderRadius: 18,
          backgroundColor: c.primary,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="plus" size={19} color={c.onPrimary} strokeWidth={1.9} />
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.onPrimary }}>
          Nueva conversación
        </Text>
      </Pressable>

      {/* Búsqueda */}
      <View
        style={{
          marginHorizontal: 12,
          marginTop: 10,
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
          placeholder="Buscar conversaciones…"
          placeholderTextColor={c.inkSoft}
          autoCorrect={false}
          style={{ flex: 1, paddingVertical: 10, fontFamily: FONTS.ui, fontSize: 14, color: c.ink }}
        />
      </View>

      {/* Historial de la app: solo las conversaciones nacidas aquí. */}
      <Text
        style={{
          fontFamily: FONTS.uiMedium,
          fontSize: 11,
          letterSpacing: 1.1,
          color: c.inkMuted,
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 8,
        }}
      >
        HISTORIAL
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
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 11,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: active ? c.accentSoft : pressed ? c.pressed : 'transparent',
                  })}
                >
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: active ? c.accent : c.inkMuted,
                    }}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      fontFamily: active ? FONTS.uiMedium : FONTS.ui,
                      fontSize: 14,
                      color: active ? c.ink : c.inkSoft,
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

      {/* Accesos: menú que se despliega hacia arriba desde su propio botón */}
      <CollapsibleMenu
        open={menuOpen}
        onToggle={() => setMenuOpen((v) => !v)}
        items={[
          { icon: 'activity', label: 'Remote', onPress: () => onNavigate('remote') },
          { icon: 'chart', label: 'Uso', onPress: () => onNavigate('usage') },
          {
            icon: 'book',
            label: 'Documentación',
            onPress: () => Linking.openURL(`${api.base}/docs`),
          },
        ]}
      />

      {/* Footer de perfil (tarjeta crema, como la web) */}
      <Pressable
        onPress={() => onNavigate('account')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: pressed ? c.bgInput : c.bgSecondary,
          borderRadius: 18,
          marginHorizontal: 12,
          marginBottom: Math.max(insets.bottom, 12),
          paddingHorizontal: 14,
          paddingVertical: 12,
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

/// Menú de accesos que crece hacia arriba desde su botón, sin separadores que
/// corten la columna. El botón es crema (el color más contrastado del tema)
/// para que se lea como el mando de "más opciones" del drawer.
function CollapsibleMenu({ open, onToggle, items }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: reduced ? 0 : 220,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: false, // anima altura: no puede ir por el hilo nativo
    }).start();
  }, [open, anim, reduced]);

  return (
    <View style={{ paddingBottom: 8 }}>
      <Animated.View
        // El clip evita que los ítems asomen mientras la altura se pliega.
        style={{
          overflow: 'hidden',
          opacity: anim,
          height: anim.interpolate({
            inputRange: [0, 1],
            outputRange: [0, items.length * MENU_ITEM_HEIGHT + 6],
          }),
        }}
      >
        {items.map((item) => (
          <Pressable
            key={item.label}
            onPress={item.onPress}
            style={({ pressed }) => ({
              height: MENU_ITEM_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              marginHorizontal: 12,
              paddingHorizontal: 12,
              borderRadius: 12,
              backgroundColor: pressed ? c.pressed : 'transparent',
            })}
          >
            <Icon name={item.icon} size={19} color={c.inkSoft} />
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink }}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>

      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Cerrar el menú de opciones' : 'Abrir el menú de opciones'}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          marginHorizontal: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderRadius: RADIUS_PILL,
          backgroundColor: c.primary,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="menu" size={18} color={c.onPrimary} strokeWidth={1.9} />
        <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.onPrimary }}>
          {open ? 'Cerrar menú' : 'Más opciones'}
        </Text>
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size={16} color={c.onPrimary} />
      </Pressable>
    </View>
  );
}
