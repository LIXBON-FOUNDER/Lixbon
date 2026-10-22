// Sidebar.js — menú lateral: marca, botón de nueva conversación, selector
// Chat · Remoto y debajo lo de cada uno: buscar y el historial por fechas,
// plegable y por páginas (mantener pulsado para fijar, renombrar, compartir o
// eliminar con "Deshacer"), las sesiones remotas o, con el prototipo activo,
// el resumen de Supervisar. Abajo, la tarjeta de
// cuenta (foto, nombre y uso de la sesión), que entera lleva a Ajustes.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { groupByDate, togglePin, usePins } from '../pins';
import { hostName, sessionOnline } from '../observe/hosts';
import { shareConversationById } from '../share';
import { CHAT_SOURCE } from '../sse';
import { useApi, useAuth, useChat } from '../state';
import { FONTS, RADIUS } from '../theme';
import Icon from './Icon';
import RemoteSessionList from './RemoteSessionList';
import { useDialogs } from './dialogs';
import { Avatar, avatarUri, Eyebrow, FadeUp, LixLogo, LogoMark, Meter, Segmented, SkeletonLines, useColors } from './ui';

const PAGE = 30; // conversaciones por página del historial

export default function Sidebar({ open, onClose, onNavigate, section, onSection, onSearch, remote, activeRemoteId, onOpenSession, supervision }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const chat = useChat();
  const insets = useSafeAreaInsets();
  const { prompt, sheet, toast } = useDialogs();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState([]);
  const [usage, setUsage] = useState(null);
  const [tab, setTab] = useState(section);
  const [more, setMore] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const fetchingMore = useRef(false);
  const loadedOnce = useRef(false);
  const user = auth.user || {};
  const pins = usePins(user.id);

  // El historial llega por páginas: la primera al abrir el menú y las
  // siguientes al bajar hasta el final de la lista.
  const page = async (offset) => {
    // Historial propio de la app: sin `source` el gateway devolvería también
    // lo del CLI, el IDE y la web (la app se autentica con API key).
    const res = await api.get(`/api/conversations?source=${CHAT_SOURCE}&limit=${PAGE}&offset=${offset}`);
    return (Array.isArray(res?.conversations) ? res.conversations : []).filter((it) => it && typeof it === 'object');
  };

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const first = await page(0);
      setItems(first);
      setMore(first.length === PAGE);
    } catch {
      // offline: se queda la lista anterior
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!more || fetchingMore.current) return;
    fetchingMore.current = true;
    try {
      const next = await page(items.length);
      setItems((cur) => {
        const seen = new Set(cur.map((it) => it.id));
        return [...cur, ...next.filter((it) => !seen.has(it.id))];
      });
      setMore(next.length === PAGE);
    } catch {
      // se reintenta al volver a llegar al final
    } finally {
      fetchingMore.current = false;
    }
  };

  const loadUsage = async () => {
    try {
      const res = await api.get('/api/account/usage');
      const session = res?.buckets?.session;
      setUsage(session && !session.unlimited && typeof session.percent === 'number' ? session.percent / 100 : null);
    } catch {
      // sin uso: la tarjeta queda sin barra
    }
  };

  useEffect(() => {
    if (open) {
      setTab(section);
      load({ silent: loadedOnce.current });
      loadUsage();
      loadedOnce.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const visible = useMemo(() => items.filter((it) => !hidden.includes(it.id)), [items, hidden]);

  const rows = useMemo(() => {
    const pinned = visible.filter((it) => pins.includes(it.id));
    const groups = [...(pinned.length ? [['Fijadas', pinned]] : []), ...groupByDate(visible.filter((it) => !pins.includes(it.id)))];
    return groups.flatMap(([label, list]) => [
      { key: `g:${label}`, label },
      ...list.map((it) => ({ key: String(it.id), item: it, pinned: label === 'Fijadas' })),
    ]);
  }, [visible, pins]);

  const openConversation = (item) => {
    onSection('chat');
    chat.openConversation(item.id, typeof item.title === 'string' ? item.title : null);
    onClose();
  };

  const newChat = () => {
    onSection('chat');
    chat.newChat();
    onClose();
  };

  const fail = (err) => toast(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');

  const rename = async (item) => {
    const value = await prompt({ title: 'Renombrar', placeholder: 'Nuevo título', initialValue: item.title || '', confirmLabel: 'Guardar' });
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

  // Deshacer en vez de confirmar: la fila desaparece al momento y el borrado
  // real se manda cuando el aviso se va sin que lo deshagan.
  const remove = (item) => {
    setHidden((cur) => [...cur, item.id]);
    if (chat.conversationId === item.id) chat.newChat();
    const restore = () => setHidden((cur) => cur.filter((id) => id !== item.id));
    toast('Conversación eliminada', {
      action: { label: 'Deshacer', onPress: restore },
      onTimeout: async () => {
        try {
          await api.delete(`/api/conversations/${item.id}`);
          setItems((cur) => cur.filter((it) => it.id !== item.id));
        } catch (err) {
          restore();
          fail(err);
        } finally {
          setHidden((cur) => cur.filter((id) => id !== item.id));
        }
      },
    });
  };

  const longPress = async (item, pinned) => {
    const action = await sheet({
      title: item.title || 'Sin título',
      items: [
        { label: pinned ? 'Quitar de fijadas' : 'Fijar arriba', icon: 'pin', value: 'pin' },
        { label: 'Renombrar', icon: 'pencil', value: 'rename' },
        { label: 'Compartir como Markdown', icon: 'share', value: 'share' },
        { divider: true },
        { label: 'Eliminar conversación', icon: 'trash', danger: true, value: 'delete' },
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
    <View
      style={{
        flex: 1,
        backgroundColor: c.surface1,
        paddingTop: insets.top + 14,
        paddingHorizontal: 12,
        paddingBottom: Math.max(insets.bottom, 14),
        borderTopRightRadius: RADIUS,
        borderBottomRightRadius: RADIUS,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, paddingLeft: 6, paddingRight: 4 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <LogoMark size={24} />
          <LixLogo size={14} />
        </View>
      </View>

      <Pressable
        onPress={newChat}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginTop: 8,
          height: 42,
          paddingHorizontal: 12,
          borderRadius: RADIUS,
          backgroundColor: pressed ? c.surface4 : c.surface2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        })}
      >
        <Icon name="plus" size={18} color={c.ink} />
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>Nueva conversación</Text>
      </Pressable>

      <View style={{ marginTop: 10 }}>
        <Segmented
          stretch
          size="lg"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'remote', label: 'Remoto', dot: remote.live && tab !== 'remote', a11y: remote.live ? 'Remoto, sesión en curso' : 'Remoto' },
            ...(supervision ? [{ value: 'supervise', label: 'Supervisar' }] : []),
          ]}
        />
      </View>

      {tab === 'supervise' && supervision ? (
        <SupervisionTab
          sup={supervision}
          onOpen={(route) => {
            supervision.home();
            if (route) supervision.push(route);
            onSection('supervise');
            onClose();
          }}
        />
      ) : tab === 'remote' ? (
        <RemoteTab remote={remote} activeId={section === 'remote' ? activeRemoteId : null} onOpen={onOpenSession} />
      ) : (
        <>
          <Pressable
            onPress={onSearch}
            style={({ pressed }) => ({
              marginTop: 10,
              height: 42,
              paddingHorizontal: 12,
              borderRadius: RADIUS,
              backgroundColor: pressed ? c.surface4 : c.surface2,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            })}
          >
            <Icon name="search" size={17} color={c.inkMuted} />
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkMuted }}>Buscar</Text>
          </Pressable>
    
          <Pressable
            onPress={() => setHistoryOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: historyOpen }}
            style={{ marginTop: 14, height: 32, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.inkMuted }}>Historial</Text>
            <Icon name={historyOpen ? 'chevron-up' : 'chevron-down'} size={15} color={c.inkMuted} />
          </Pressable>

          <View style={{ flex: 1, marginTop: 6, display: historyOpen ? 'flex' : 'none' }}>
            {loading && items.length === 0 ? (
              <SkeletonLines widths={['70%', '52%', '62%', '44%', '58%']} style={{ paddingHorizontal: 12, paddingTop: 6 }} />
            ) : visible.length === 0 ? (
              <Text style={{ paddingHorizontal: 12, fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>Aún no tienes conversaciones</Text>
            ) : (
              <FlatList
                data={rows}
                keyExtractor={(r) => r.key}
                showsVerticalScrollIndicator={false}
                onEndReached={loadMore}
                onEndReachedThreshold={0.6}
                renderItem={({ item: row, index }) => {
                  if (row.label) {
                    return <Eyebrow style={{ paddingHorizontal: 12, paddingTop: index === 0 ? 0 : 18, paddingBottom: 4 }}>{row.label}</Eyebrow>;
                  }
                  const item = row.item;
                  const active = chat.conversationId === item.id;
                  return (
                    <FadeUp delay={Math.min(index, 10) * 30} distance={4}>
                      <Pressable
                        onPress={() => openConversation(item)}
                        onLongPress={() => longPress(item, row.pinned)}
                        delayLongPress={320}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          height: 42,
                          paddingHorizontal: 12,
                          borderRadius: RADIUS,
                          backgroundColor: active ? c.surface3 : pressed ? c.pressed : 'transparent',
                        })}
                      >
                        {row.pinned && <Icon name="pin" size={13} color={c.inkMuted} strokeWidth={1.8} />}
                        <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14.5, color: active ? c.ink : c.inkBody }}>
                          {item.title || 'Sin título'}
                        </Text>
                      </Pressable>
                    </FadeUp>
                  );
                }}
              />
            )}
          </View>
          {!historyOpen && <View style={{ flex: 1 }} />}
        </>
      )}

      <Pressable
        onPress={() => onNavigate('settings')}
        accessibilityLabel={`${displayName}, ajustes`}
        style={({ pressed }) => ({
          marginTop: 8,
          padding: 12,
          borderRadius: RADIUS,
          backgroundColor: pressed ? c.surface4 : c.surface2,
          gap: 10,
        })}
      >
        {/* Toda la tarjeta lleva a Ajustes: el engranaje solo lo indica. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar name={displayName} size={36} uri={avatarUri(api.base, user)} />
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>
            {displayName}
          </Text>
          <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
            <Icon name="gear" size={18} color={c.inkMuted} strokeWidth={1.7} />
          </View>
        </View>
        {usage != null && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Meter value={usage} color={usage >= 0.9 ? c.danger : c.accent} />
            <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkMuted }}>{Math.round(usage * 100)} %</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

// Resumen de Supervisar con datos del Core: cuánto pide atención, el trabajo activo y los IDE (hosts).
// Los números vienen de la snapshot; si está desactualizada se dice.
function SupervisionTab({ sup, onOpen }) {
  const c = useColors();
  const snap = sup.core?.snapshot;
  const stale = sup.view.kind !== 'online';
  const count = (n) => (snap ? `${n}${stale ? ' · sin actualizar' : ''}` : '—');
  const row = (label, value, route) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={() => onOpen(route)}
      style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: RADIUS, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: pressed ? c.pressed : 'transparent' })}
    >
      <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkBody }}>{label}</Text>
      <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{value}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={{ flex: 1, marginTop: 18 }} showsVerticalScrollIndicator={false}>
      <Eyebrow style={{ paddingHorizontal: 12, paddingBottom: 4 }}>{sup.view.title}</Eyebrow>
      {row('Atención', count(snap?.attention.total ?? 0), null)}
      {row('Trabajo activo', count(snap?.active_tasks.total ?? 0), null)}
      <Eyebrow style={{ paddingHorizontal: 12, paddingTop: 18, paddingBottom: 4 }}>IDE</Eyebrow>
      {sup.candidates.length === 0 ? (
        <Text style={{ paddingHorizontal: 12, fontFamily: FONTS.ui, fontSize: 13, lineHeight: 19, color: c.inkMuted }}>
          Abre Lixbon en el escritorio y activa Remoto para supervisarlo.
        </Text>
      ) : (
        sup.candidates.map((s) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityState={{ selected: s.id === sup.session?.id }}
            accessibilityLabel={`${hostName(s)}, ${sessionOnline(s) ? 'conectado' : 'desconectado'}`}
            onPress={() => {
              sup.select(s.id);
              onOpen(null);
            }}
            style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: RADIUS, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: pressed ? c.pressed : 'transparent' })}
          >
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: sessionOnline(s) ? c.good : c.inkFaint }} />
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: s.id === sup.session?.id ? FONTS.uiMedium : FONTS.ui, fontSize: 14.5, color: c.inkBody }}>{hostName(s)}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function RemoteTab({ remote, activeId, onOpen }) {
  const c = useColors();
  if (remote.loading && remote.sessions.length === 0) {
    return <SkeletonLines widths={['70%', '52%', '62%']} style={{ flex: 1, paddingHorizontal: 12, paddingTop: 24 }} />;
  }
  if (remote.sessions.length === 0) {
    return (
      <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 24, gap: 6 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkBody }}>Sin sesiones remotas</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 19, color: c.inkMuted }}>
          Escribe /remote en el IDE o en el CLI y la sesión aparece aquí al instante.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView style={{ flex: 1, marginTop: 18 }} showsVerticalScrollIndicator={false}>
      <RemoteSessionList sessions={remote.sessions} activeId={activeId} onOpen={onOpen} />
    </ScrollView>
  );
}
