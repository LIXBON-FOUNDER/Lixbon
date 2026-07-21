// RemoteScreen.js — sección Remote: controla sesiones /remote del IDE o CLI.
// Lista de sesiones (en vivo vía /api/remote/subscribe) y detalle con el
// transcript del agente en streaming, envío de prompts, interrupción y
// tarjetas de aprobación. Todo se ejecuta en la máquina host; esta pantalla
// es un mando a distancia.
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { FadeUp, IconButton, useColors } from '../components/ui';
import { initialRemoteState, openEventStream, remoteReducer } from '../remote';
import { useApi, useAuth } from '../state';
import { FONTS, RADIUS_BOX, RADIUS_PILL } from '../theme';

const SOURCE_LABEL = { cli: 'CLI', ide: 'IDE' };

export default function RemoteScreen({ onBack, initialToken = null }) {
  const api = useApi();
  const [session, setSession] = useState(null); // sesión abierta en detalle
  const [claiming, setClaiming] = useState(!!initialToken);
  const { toast } = useDialogs();

  // Deep link (QR / notificación): el token solo identifica la sesión; el
  // claim va autenticado con la API key y el gateway verifica que seas el dueño.
  useEffect(() => {
    if (!initialToken) return;
    (async () => {
      try {
        const res = await api.post('/api/remote/claim', { token: initialToken });
        if (res?.session?.id) setSession(res.session);
      } catch (err) {
        toast(err instanceof ApiException ? err.message : 'Link inválido, expirado o de otra cuenta');
      } finally {
        setClaiming(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialToken]);

  if (claiming) {
    return (
      <SafeAreaView edges={['top']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (session) {
    return (
      <RemoteSessionView
        session={session}
        onBack={() => setSession(null)}
      />
    );
  }
  return <RemoteListView onBack={onBack} onOpen={setSession} />;
}

// ── Lista de sesiones ───────────────────────────────────────────────────────

function RemoteListView({ onBack, onOpen }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/remote/sessions');
      if (aliveRef.current) setSessions(Array.isArray(res?.sessions) ? res.sessions : []);
    } catch {
      // offline: se queda la lista anterior
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api]);

  // Suscripción en vivo: cuando se ejecuta /remote en el IDE/CLI, la sesión
  // aparece aquí al instante sin refrescar.
  useEffect(() => {
    aliveRef.current = true;
    load();
    let backoff = 2000;
    const connect = () => {
      if (!aliveRef.current) return;
      streamRef.current = openEventStream({
        base: api.base,
        token: auth.apiKey,
        path: '/api/remote/subscribe',
        onEvent: (ev) => {
          backoff = 2000;
          if (ev.type === 'session_created' && ev.session) {
            setSessions((cur) => [ev.session, ...cur.filter((sx) => sx.id !== ev.session.id)]);
          } else if (ev.type === 'session_online' || ev.type === 'session_offline') {
            const status = ev.type === 'session_online' ? 'online' : 'offline';
            setSessions((cur) => cur.map((sx) => (sx.id === ev.session_id ? { ...sx, status } : sx)));
          } else if (ev.type === 'session_ended') {
            setSessions((cur) => cur.map((sx) => (sx.id === ev.session_id ? { ...sx, status: 'ended' } : sx)));
          }
        },
        onEnd: () => setTimeout(connect, backoff),
        onError: () => {
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30000);
        },
      });
    };
    connect();
    return () => {
      aliveRef.current = false;
      streamRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bgSecondary }}>
      <ScreenHeader title="Remote" onBack={onBack} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.inkSoft} />
        </View>
      ) : sessions.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 12 }}>
          <Icon name="activity" size={30} color={c.inkSoft} />
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 17, color: c.ink, textAlign: 'center' }}>
            Sin sesiones remotas
          </Text>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 14, lineHeight: 21, color: c.inkMuted, textAlign: 'center' }}>
            Ejecuta /remote en el IDE o el CLI de Lixbon y la sesión aparecerá aquí
            al instante para controlarla desde el teléfono.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 14, gap: 10 }}
          renderItem={({ item }) => <SessionCard session={item} onPress={() => onOpen(item)} />}
        />
      )}
    </SafeAreaView>
  );
}

function SessionCard({ session, onPress }) {
  const c = useColors();
  const online = session.status === 'online';
  const ended = session.status === 'ended';
  return (
    <Pressable
      onPress={ended ? undefined : onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? c.bgInput : c.bg,
        borderRadius: RADIUS_BOX,
        borderWidth: 1,
        borderColor: c.borderSoft,
        padding: 16,
        gap: 6,
        opacity: ended ? 0.55 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: online ? '#2E9E5B' : c.inkSoft,
          }}
        />
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.ink }}>
          {session.title || 'Sesión remota'}
        </Text>
        <View
          style={{
            paddingHorizontal: 9,
            paddingVertical: 3,
            borderRadius: RADIUS_PILL,
            backgroundColor: c.accentSoft,
          }}
        >
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 11, color: c.ink }}>
            {SOURCE_LABEL[session.source] || session.source}
          </Text>
        </View>
      </View>
      <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
        {session.machine || '—'}
        {'  ·  '}
        {ended ? 'terminada' : online ? 'en línea' : 'sin conexión'}
      </Text>
    </Pressable>
  );
}

// ── Detalle de sesión ───────────────────────────────────────────────────────

function RemoteSessionView({ session, onBack }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const { confirm, toast } = useDialogs();
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    seqRef.current = state.lastSeq;
  }, [state.lastSeq]);

  // Stream de eventos con reconexión (retoma desde el último seq visto).
  useEffect(() => {
    aliveRef.current = true;
    let backoff = 2000;
    const connect = () => {
      if (!aliveRef.current) return;
      streamRef.current = openEventStream({
        base: api.base,
        token: auth.apiKey,
        path: `/api/remote/sessions/${session.id}/stream?from_seq=${seqRef.current}`,
        onEvent: (ev) => {
          backoff = 2000;
          dispatch(ev);
        },
        onEnd: () => {
          if (aliveRef.current) setTimeout(connect, backoff);
        },
        onError: (err) => {
          if (!aliveRef.current) return;
          if (err?.status === 404 || err?.status === 410) {
            dispatch({ type: 'session_ended' });
            return;
          }
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30000);
        },
      });
    };
    connect();
    return () => {
      aliveRef.current = false;
      streamRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const sendCommand = useCallback(
    async (command, { quiet = false } = {}) => {
      try {
        await api.post(`/api/remote/sessions/${session.id}/commands`, command);
        return true;
      } catch (err) {
        if (!quiet) toast(err instanceof ApiException ? err.message : 'Sin conexión con el host');
        return false;
      }
    },
    [api, session.id, toast],
  );

  const sendPrompt = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await sendCommand({ type: 'prompt', text });
    setSending(false);
    if (ok) setInput('');
  };

  const interrupt = () => sendCommand({ type: 'interrupt' });

  const approve = (id, decision) => sendCommand({ type: 'approve', id, decision });

  const endSession = async () => {
    const ok = await confirm({
      title: 'Terminar sesión remota',
      message: 'El IDE/CLI recupera el control local y el link del QR deja de funcionar.',
      confirmLabel: 'Terminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/remote/sessions/${session.id}`);
    } catch {
      // si ya terminó, da igual
    }
    onBack();
  };

  const title = state.meta?.title || session.title || 'Sesión remota';
  const subtitle = state.ended
    ? 'Sesión terminada'
    : !state.hostConnected
      ? 'Host sin conexión…'
      : state.agentState === 'thinking'
        ? 'El agente está trabajando…'
        : 'Conectado · listo';

  const items = [...state.items].reverse();

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Cabecera */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.borderSoft,
        }}
      >
        <IconButton onPress={onBack} size={38}>
          <Icon name="arrow-left" size={20} color={c.ink} />
        </IconButton>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12, color: state.ended ? c.danger : c.inkMuted }}>
            {SOURCE_LABEL[state.meta?.source || session.source] || ''}
            {state.meta?.machine ? ` · ${state.meta.machine}` : ''}
            {'  ·  '}
            {subtitle}
          </Text>
        </View>
        {!state.ended && (
          <IconButton onPress={endSession} size={38}>
            <Icon name="logout" size={18} color={c.danger} />
          </IconButton>
        )}
      </View>

      {/* Transcript */}
      <View style={{ flex: 1 }}>
        {state.items.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 10 }}>
            {state.hostConnected ? (
              <>
                <Icon name="chat" size={26} color={c.inkSoft} />
                <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted, textAlign: 'center' }}>
                  Sesión conectada. Escribe abajo para pedirle algo al agente.
                </Text>
              </>
            ) : (
              <ActivityIndicator color={c.inkSoft} />
            )}
          </View>
        ) : (
          <FlatList
            inverted
            data={items}
            keyExtractor={(item) => item.key}
            contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 14 }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <TranscriptRow item={item} />}
          />
        )}
      </View>

      {/* Aprobaciones pendientes */}
      {state.approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} onDecide={approve} />
      ))}

      {/* Compositor */}
      <RemoteComposer
        input={input}
        onChangeInput={setInput}
        onSend={sendPrompt}
        onInterrupt={interrupt}
        thinking={state.agentState === 'thinking'}
        disabled={state.ended || !state.hostConnected}
        sending={sending}
        ended={state.ended}
      />
    </SafeAreaView>
  );
}

function TranscriptRow({ item }) {
  const c = useColors();
  if (item.kind === 'user') {
    return (
      <FadeUp style={{ alignItems: 'flex-end', marginVertical: 8 }}>
        <View
          style={{
            maxWidth: '80%',
            backgroundColor: c.primary,
            paddingHorizontal: 19,
            paddingVertical: 11,
            borderRadius: RADIUS_BOX,
            borderBottomRightRadius: 15,
          }}
        >
          <Text style={{ fontFamily: FONTS.ui, fontSize: 15, lineHeight: 22, color: c.onPrimary }}>
            {item.text}
          </Text>
        </View>
        {item.origin === 'local' && (
          <Text style={{ fontFamily: FONTS.ui, fontSize: 11, color: c.inkMuted, marginTop: 3 }}>
            desde el equipo
          </Text>
        )}
      </FadeUp>
    );
  }
  if (item.kind === 'tool') {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginVertical: 4,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.borderSoft,
          backgroundColor: c.bgSecondary,
        }}
      >
        {item.running ? (
          <ActivityIndicator size="small" color={c.inkSoft} />
        ) : (
          <Icon name={item.error ? 'warning' : 'check'} size={14} color={item.error ? c.danger : c.inkSoft} />
        )}
        <Text numberOfLines={2} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkSoft }}>
          <Text style={{ fontFamily: FONTS.uiMedium, color: c.ink }}>{item.tool}</Text>
          {item.summary ? `  ${item.summary}` : ''}
          {!item.running && item.result ? `\n${firstLine(item.result)}` : ''}
        </Text>
      </View>
    );
  }
  if (item.kind === 'error') {
    return (
      <View style={{ marginVertical: 6, padding: 10, borderRadius: 10, backgroundColor: c.dangerSoft }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.danger }}>{item.text}</Text>
      </View>
    );
  }
  // asistente
  return (
    <View style={{ marginVertical: 8 }}>
      {item.text ? (
        <Markdown style={remoteMarkdownStyles(c)}>{item.text}</Markdown>
      ) : item.open ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={c.inkSoft} />
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Pensando…</Text>
        </View>
      ) : null}
    </View>
  );
}

function ApprovalCard({ approval, onDecide }) {
  const c = useColors();
  const isCommand = approval.risk === 'command';
  return (
    <View
      style={{
        marginHorizontal: 14,
        marginBottom: 8,
        padding: 14,
        borderRadius: RADIUS_BOX,
        borderWidth: 1,
        borderColor: c.borderSoft,
        backgroundColor: c.bgSecondary,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="warning" size={16} color={c.ink} />
        <Text style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 14, color: c.ink }}>
          {isCommand ? 'El agente quiere ejecutar un comando' : 'El agente quiere aplicar un cambio'}
        </Text>
      </View>
      <Text style={{ fontFamily: 'monospace', fontSize: 12.5, color: c.ink }}>
        {approval.tool}
        {approval.summary ? `  ${approval.summary}` : ''}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pressable
          onPress={() => onDecide(approval.id, 'deny')}
          style={({ pressed }) => ({
            flex: 1,
            alignItems: 'center',
            paddingVertical: 10,
            borderRadius: RADIUS_PILL,
            borderWidth: 1,
            borderColor: c.borderSoft,
            backgroundColor: pressed ? c.pressed : 'transparent',
          })}
        >
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.danger }}>Denegar</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide(approval.id, 'allow')}
          style={({ pressed }) => ({
            flex: 1,
            alignItems: 'center',
            paddingVertical: 10,
            borderRadius: RADIUS_PILL,
            backgroundColor: c.primary,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.onPrimary }}>Permitir</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RemoteComposer({ input, onChangeInput, onSend, onInterrupt, thinking, disabled, sending, ended }) {
  const c = useColors();
  const canSend = !!input.trim() && !disabled && !sending;
  return (
    <View style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12 }}>
      <View
        style={{
          backgroundColor: c.bgInput,
          borderRadius: RADIUS_BOX,
          paddingHorizontal: 15,
          paddingTop: 11,
          paddingBottom: 9,
          opacity: ended ? 0.55 : 1,
        }}
      >
        <TextInput
          value={input}
          onChangeText={onChangeInput}
          editable={!ended}
          placeholder={ended ? 'La sesión terminó' : disabled ? 'Host sin conexión…' : 'Pídele algo al agente…'}
          placeholderTextColor={c.inkSoft}
          multiline
          style={{
            maxHeight: 130,
            paddingHorizontal: 6,
            paddingTop: 2,
            paddingBottom: 6,
            fontFamily: FONTS.ui,
            fontSize: 15,
            lineHeight: 21,
            color: c.ink,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 }}>
          <Pressable
            onPress={thinking ? onInterrupt : onSend}
            disabled={thinking ? disabled : !canSend}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: c.primary,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: (thinking ? disabled : !canSend) ? 0.45 : pressed ? 0.85 : 1,
            })}
          >
            <Icon name={thinking ? 'stop' : 'arrow-up'} size={17} color={c.onPrimary} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ScreenHeader({ title, onBack }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <IconButton onPress={onBack} size={38}>
        <Icon name="arrow-left" size={20} color={c.ink} />
      </IconButton>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink }}>{title}</Text>
    </View>
  );
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 120);
}

function remoteMarkdownStyles(c) {
  return {
    body: { fontFamily: FONTS.ui, fontSize: 15, lineHeight: 23, color: c.ink },
    heading1: { fontFamily: FONTS.uiSemiBold, fontSize: 20, color: c.ink, marginTop: 8, marginBottom: 4 },
    heading2: { fontFamily: FONTS.uiSemiBold, fontSize: 18, color: c.ink, marginTop: 8, marginBottom: 4 },
    heading3: { fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink, marginTop: 6, marginBottom: 3 },
    strong: { fontFamily: FONTS.uiBold, color: c.ink },
    link: { color: c.accentDeep, textDecorationLine: 'underline' },
    code_inline: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    code_block: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderColor: c.borderSoft,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginVertical: 6,
    },
    fence: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderColor: c.borderSoft,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginVertical: 6,
    },
  };
}
