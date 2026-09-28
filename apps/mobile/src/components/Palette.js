// Palette.js — paleta de comandos (el Ctrl K del IDE) en una hoja superior:
// conversaciones, comandos y "preguntar" en una sola lista, con prefijos
// > (comandos), # (conversaciones) y ? (preguntar).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '../state';
import { CHAT_SOURCE } from '../sse';
import { FONTS, RADIUS, RADIUS_BOX } from '../theme';
import Icon from './Icon';
import { Eyebrow, LogoMark, useColors } from './ui';

const PREFIXES = [
  { key: '>', label: 'comandos' },
  { key: '#', label: 'conversaciones' },
  { key: '?', label: 'preguntar' },
];

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
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [convs, setConvs] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!visible) return undefined;
    setQuery('');
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
  }, [visible, api]);

  const results = useMemo(() => {
    const raw = query.trimStart();
    const prefix = PREFIXES.some((p) => p.key === raw[0]) ? raw[0] : '';
    const text = raw.slice(prefix ? 1 : 0).trim();
    const q = text.toLowerCase().replace(/\s+/g, '');
    const out = [];
    if (prefix === '' || prefix === '#') {
      const list = convs || [];
      const hits = q
        ? list.map((it) => ({ it, s: fuzzyScore(String(it.title || ''), q) })).filter((m) => m.s >= 0).sort((a, b) => b.s - a.s).map((m) => m.it)
        : list;
      const group = q || prefix ? 'Conversaciones' : 'Recientes';
      hits.slice(0, prefix === '#' ? 40 : q ? 6 : 4).forEach((it) =>
        out.push({ key: `c:${it.id}`, group, kind: 'conv', title: it.title || 'Sin título', run: () => onOpenConversation(it) }),
      );
    }
    if (prefix === '' || prefix === '>') {
      const hits = q
        ? commands.map((cmd) => ({ cmd, s: fuzzyScore(`${cmd.title} ${cmd.category || ''} ${cmd.keywords || ''}`, q) })).filter((m) => m.s >= 0).sort((a, b) => b.s - a.s).map((m) => m.cmd)
        : commands;
      hits.slice(0, q ? 10 : 80).forEach((cmd) => out.push({ key: `k:${cmd.id}`, group: 'Comandos', kind: 'cmd', ...cmd }));
    }
    if (text && (prefix === '' || prefix === '?')) {
      out.push({ key: 'ask', group: 'Preguntar', kind: 'ask', title: `Preguntar a lixbon: “${text}”`, run: () => onAsk(text) });
    }
    return out;
  }, [query, convs, commands, onOpenConversation, onAsk]);

  const pick = (r) => {
    onClose();
    // La hoja se cierra antes de ejecutar: algunos comandos abren otra.
    setTimeout(() => r.run?.(), 180);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable onPress={onClose} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.scrim }} />
        <View
          style={{
            marginTop: insets.top + 8,
            marginHorizontal: 8,
            maxHeight: '82%',
            borderRadius: RADIUS_BOX,
            backgroundColor: c.surface2,
            overflow: 'hidden',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 52, backgroundColor: c.surface3 }}>
            <Icon name="search" size={17} color={c.inkLabel} />
            <TextInput
              ref={inputRef}
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="Conversaciones, comandos o pregunta"
              placeholderTextColor={c.inkLabel}
              selectionColor={c.accent}
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => results[0] && pick(results[0])}
              style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 15.5, color: c.ink }}
            />
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>Esc</Text>
            </Pressable>
          </View>

          <FlatList
            data={results}
            keyExtractor={(r) => r.key}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 6 }}
            ListEmptyComponent={
              <Text style={{ padding: 14, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                {convs === null ? 'Cargando conversaciones…' : 'Nada coincide con tu búsqueda'}
              </Text>
            }
            renderItem={({ item, index }) => (
              <View>
                {item.group !== results[index - 1]?.group && <Eyebrow style={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 5 }}>{item.group}</Eyebrow>}
                <Pressable
                  onPress={() => pick(item)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 11,
                    minHeight: 42,
                    paddingHorizontal: 10,
                    borderRadius: RADIUS,
                    backgroundColor: pressed || (index === 0 && query) ? c.surface4 : 'transparent',
                  })}
                >
                  <View style={{ width: 20, alignItems: 'center' }}>
                    {item.kind === 'conv' && <Icon name="chat" size={15} color={c.inkLabel} />}
                    {item.kind === 'ask' && <LogoMark size={16} />}
                    {item.kind === 'cmd' &&
                      (item.swatch ? (
                        <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: item.swatch }} />
                      ) : (
                        <Icon name={item.icon || 'chevron-right'} size={15} color={c.inkLabel} />
                      ))}
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>
                    {item.title}
                  </Text>
                  {item.kind === 'cmd' && !!item.category && (
                    <Text style={{ fontFamily: FONTS.mono, fontSize: 9.5, color: c.inkLabel, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: c.pressed }}>
                      {item.category.toUpperCase()}
                    </Text>
                  )}
                </Pressable>
              </View>
            )}
          />

          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: c.surface1, paddingBottom: 9 }}>
            {PREFIXES.map((p) => (
              <Pressable
                key={p.key}
                onPress={() => {
                  setQuery(p.key);
                  inputRef.current?.focus();
                }}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkSoft, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: c.pressed }}>
                  {p.key}
                </Text>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
