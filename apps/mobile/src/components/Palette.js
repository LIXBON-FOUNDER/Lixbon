// Palette.js — búsqueda global a pantalla completa: un campo para buscar o
// preguntar, filtros (Todo · Conversaciones · Comandos · Preguntar) y, sin
// texto, lo de siempre a mano: recientes, acciones con el tema en línea y
// accesos. Con texto, conversaciones y comandos por coincidencia difusa.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi, usePrefs } from '../state';
import { CHAT_SOURCE } from '../sse';
import { FONTS, MOTION, RADIUS } from '../theme';
import Icon from './Icon';
import { Chip, EASE, Eyebrow, KeyboardAware, LogoMark, Segmented, useColors, useReducedMotion } from './ui';

const FILTERS = [
  { value: 'all', label: 'Todo' },
  { value: 'conv', label: 'Conversaciones' },
  { value: 'cmd', label: 'Comandos' },
  { value: 'ask', label: 'Preguntar' },
];

const HOME_ACTIONS = ['new', 'model'];
const HOME_GOTO = ['go.usage', 'go.appearance', 'go.settings'];

export function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 3 : 1;
    score += streak - Math.min(idx - ti, 20) * 0.05;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}

export default function Palette({ visible, onClose, commands, onOpenConversation, onAsk }) {
  const c = useColors();
  const api = useApi();
  const prefs = usePrefs();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [convs, setConvs] = useState(null);
  const inputRef = useRef(null);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return undefined;
    setQuery('');
    setFilter('all');
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: reduced ? 0 : MOTION.fade, easing: EASE, useNativeDriver: true }).start();
    let alive = true;
    api
      .get(`/api/conversations?source=${CHAT_SOURCE}&limit=100`)
      .then((res) => {
        if (alive) setConvs((Array.isArray(res?.conversations) ? res.conversations : []).filter(Boolean));
      })
      .catch(() => alive && setConvs([]));
    return () => {
      alive = false;
    };
  }, [visible, api, anim, reduced]);

  const results = useMemo(() => {
    const text = query.trim();
    const q = text.toLowerCase().replace(/\s+/g, '');
    const out = [];
    const conv = (it, group) => ({ key: `c:${it.id}`, group, kind: 'conv', title: it.title || 'Sin título', run: () => onOpenConversation(it) });
    const cmd = (k, group) => ({ key: `k:${k.id}`, group, kind: 'cmd', ...k });

    if (!q) {
      if (filter === 'all' || filter === 'conv') {
        (convs || []).slice(0, filter === 'conv' ? 60 : 3).forEach((it) => out.push(conv(it, filter === 'conv' ? 'Conversaciones' : 'Recientes')));
      }
      if (filter === 'all') {
        HOME_ACTIONS.map((id) => commands.find((k) => k.id === id)).filter(Boolean).forEach((k) => out.push(cmd(k, 'Acciones')));
        out.push({ key: 'theme', group: 'Acciones', kind: 'theme', title: 'Tema' });
        HOME_GOTO.map((id) => commands.find((k) => k.id === id)).filter(Boolean).forEach((k) => out.push(cmd(k, 'Ir a')));
      }
      if (filter === 'cmd') commands.forEach((k) => out.push(cmd(k, k.category ? k.category[0].toUpperCase() + k.category.slice(1) : 'Comandos')));
      return out;
    }

    if (filter === 'all' || filter === 'conv') {
      (convs || [])
        .map((it) => ({ it, s: fuzzyScore(String(it.title || ''), q) }))
        .filter((m) => m.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, filter === 'conv' ? 40 : 5)
        .forEach((m) => out.push(conv(m.it, 'Conversaciones')));
    }
    if (filter === 'all' || filter === 'cmd') {
      commands
        .map((k) => ({ k, s: fuzzyScore(`${k.title} ${k.category || ''} ${k.keywords || ''}`, q) }))
        .filter((m) => m.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, filter === 'cmd' ? 30 : 8)
        .forEach((m) => out.push(cmd(m.k, 'Acciones')));
    }
    if (filter === 'all' || filter === 'ask') {
      out.push({ key: 'ask', group: 'Preguntar', kind: 'ask', title: text, run: () => onAsk(text) });
    }
    return out;
  }, [query, filter, convs, commands, onOpenConversation, onAsk]);

  const pick = (r) => {
    if (!r.run) return;
    onClose();
    // La búsqueda se cierra antes de ejecutar: algunos comandos abren una hoja.
    setTimeout(() => r.run(), 200);
  };

  const rise = (offset) => ({
    opacity: anim,
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      // autoFocus no abre el teclado dentro de un Modal en Android, y un focus()
      // antes de que la ventana gane el foco a veces tampoco: se pide otra vez
      // si el teclado no ha salido.
      onShow={() => {
        setTimeout(() => inputRef.current?.focus(), 300);
        setTimeout(() => {
          if (KeyboardController.isVisible() || !inputRef.current) return;
          inputRef.current.blur();
          inputRef.current.focus();
        }, 900);
      }}
    >
      <Animated.View style={{ flex: 1, backgroundColor: c.bg, opacity: anim }}>
        <KeyboardAware>
          <Animated.View style={[{ paddingTop: insets.top + 14, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }, rise(-16)]}>
            <View style={{ flex: 1, height: 48, paddingHorizontal: 14, borderRadius: RADIUS, backgroundColor: c.surface3, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="search" size={18} color={c.inkMuted} />
              <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                placeholder={filter === 'ask' ? 'Pregunta lo que quieras' : 'Buscar o preguntar'}
                placeholderTextColor={c.inkMuted}
                selectionColor={c.accent}
                autoCorrect={false}
                returnKeyType="go"
                accessibilityLabel="Buscar"
                onSubmitEditing={() => {
                  const first = results.find((r) => r.run);
                  if (first) pick(first);
                }}
                style={{ flex: 1, paddingVertical: 0, fontFamily: FONTS.ui, fontSize: 16, color: c.ink }}
              />
              {!!query && (
                <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Borrar búsqueda">
                  <Icon name="x" size={16} color={c.inkMuted} />
                </Pressable>
              )}
            </View>
            <Pressable onPress={onClose} style={{ height: 48, paddingHorizontal: 10, justifyContent: 'center' }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink70 }}>Cancelar</Text>
            </Pressable>
          </Animated.View>

          <Animated.View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingTop: 12 }, rise(-12)]}>
            {FILTERS.map((f) => (
              <Chip key={f.value} label={f.label} active={filter === f.value} onPress={() => setFilter(f.value)} />
            ))}
          </Animated.View>

          <Animated.View style={[{ flex: 1 }, rise(10)]}>
            <FlatList
              data={results}
              keyExtractor={(r) => r.key}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 18, paddingBottom: 24 + insets.bottom }}
              ListEmptyComponent={
                <Text style={{ paddingHorizontal: 12, fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>
                  {convs === null ? 'Cargando…' : filter === 'ask' ? 'Escribe tu pregunta arriba' : 'Nada coincide con tu búsqueda'}
                </Text>
              }
              renderItem={({ item, index }) => (
                <View>
                  {item.group !== results[index - 1]?.group && (
                    <Eyebrow style={{ paddingHorizontal: 12, paddingTop: index === 0 ? 0 : 20, paddingBottom: 4 }}>{item.group}</Eyebrow>
                  )}
                  {item.kind === 'theme' ? (
                    <View style={{ height: 46, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                      <Icon name={c.dark ? 'moon' : 'sun'} size={18} color={c.inkSoft} />
                      <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>Tema</Text>
                      <Segmented
                        size="sm"
                        bg={c.surface2}
                        value={prefs.themeMode}
                        onChange={prefs.setThemeMode}
                        options={[
                          { value: 'dark', icon: 'moon', a11y: 'Oscuro' },
                          { value: 'light', icon: 'sun', a11y: 'Claro' },
                          { value: 'system', icon: 'gear', a11y: 'Sistema' },
                        ]}
                      />
                    </View>
                  ) : (
                    <ResultRow item={item} onPress={() => pick(item)} />
                  )}
                </View>
              )}
            />
          </Animated.View>
        </KeyboardAware>
      </Animated.View>
    </Modal>
  );
}

function ResultRow({ item, onPress }) {
  const c = useColors();
  const ask = item.kind === 'ask';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minHeight: 46,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <View style={{ width: 18, alignItems: 'center' }}>
        {item.kind === 'conv' && <Icon name="chat" size={17} color={c.inkMuted} />}
        {ask && <LogoMark size={18} />}
        {item.kind === 'cmd' &&
          (item.swatch ? (
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: item.swatch }} />
          ) : (
            <Icon name={item.icon || 'chevron-right'} size={18} color={c.inkSoft} />
          ))}
      </View>
      <Text numberOfLines={ask ? 2 : 1} style={{ flex: 1, paddingVertical: ask ? 10 : 0, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>
        {ask ? `Preguntar: “${item.title}”` : item.title}
      </Text>
      {!!item.detail && <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{item.detail}</Text>}
      {ask && <Icon name="arrow-up" size={16} color={c.inkMuted} />}
    </Pressable>
  );
}
