// RemoteScreen.js — sección Remoto: sesiones /remote del IDE o del CLI, sea
// cual sea su agente (Lixbon o Claude Code). Lista en vivo y detalle con el
// transcript, los comandos "/" que publica el host, adjuntos, menciones de
// @archivos y aprobaciones. Todo se ejecuta en la máquina host; esto es un mando.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { composeMessage, splitMessage } from '../attachments';
import { AttachmentTray, MentionChip, useAttachments } from '../components/Attachments';
import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { markdownStyles } from '../components/markdown';
import {
  AgentMark,
  FadeUp,
  IconButton,
  KeyboardAware,
  Segmented,
  agentStyle,
  useColors,
  useKeyboardOpen,
  useReducedMotion,
  useScale,
} from '../components/ui';
import { initialRemoteState, openEventStream, remoteReducer } from '../remote';
import { describeRemoteTool, summarizeRemoteTools } from '../toolText';
import WaveText from '../components/WaveText';
import RemoteOrch from './RemoteOrch';
import { useApi, useAuth } from '../state';
import { FONTS, RADIUS, RADIUS_BOX } from '../theme';

const SOURCE_LABEL = { cli: 'CLI', ide: 'IDE' };
const GROUP_LABEL = { lixbon: 'Lixbon', claude: 'Claude Code', skill: 'Skills' };
// Mismos nombres que en el IDE (Lixbon: agent/ask/plan; Claude Code: el resto).
const MODE_LABEL = {
  agent: 'agente',
  ask: 'preguntar',
  plan: 'plan',
  default: 'preguntar',
  acceptEdits: 'aceptar ediciones',
  auto: 'auto',
  bypassPermissions: 'sin permisos',
};
const MENTION_AT_END = /(^|\s)@([^\s@]*)$/;

// Catálogo de reserva: si el host es de una versión anterior a que el `hello`
// publicara sus comandos, la barra sigue ofreciendo lo básico en vez de nada.
const FALLBACK_COMMANDS = [
  { name: 'help', args: '', description: 'Ver los comandos disponibles' },
  { name: 'new', args: '', description: 'Empezar una conversación nueva' },
  { name: 'status', args: '', description: 'Estado de la sesión y del host' },
];

// Las sesiones de antes de que el host anunciara su agente son de Lixbon.
const agentOf = (session, meta) => meta?.agent || session?.agent || 'lixbon';

function timeAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

function isOnline(session) {
  if (session.status === 'ended') return false;
  // host_connected lo calcula el gateway desde el hub y es la verdad viva; el
  // status de la BD puede ir por detrás (el barrido corre cada pocos minutos).
  return typeof session.host_connected === 'boolean' ? session.host_connected : session.status === 'online';
}

export default function RemoteScreen({ onBack, initialToken = null, initialSessionId = null, embedded = false }) {
  const api = useApi();
  const [session, setSession] = useState(null);
  const [claiming, setClaiming] = useState(!!initialToken || !!initialSessionId);
  const { toast } = useDialogs();

  useEffect(() => {
    if (!initialSessionId || initialToken) return;
    api
      .get('/api/remote/sessions')
      .then((res) => {
        const found = (res?.sessions || []).find((sx) => sx.id === initialSessionId);
        if (found) setSession(found);
        else toast('Esa sesión ya no existe');
      })
      .catch(() => {})
      .finally(() => setClaiming(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

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
      <SafeAreaView edges={embedded ? [] : ['top']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (session) {
    return <RemoteSessionView session={session} onBack={() => setSession(null)} embedded={embedded} />;
  }
  return <RemoteListView onBack={onBack} onOpen={setSession} embedded={embedded} />;
}

// ── Lista de sesiones ───────────────────────────────────────────────────────

function RemoteListView({ onBack, onOpen, embedded }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/remote/sessions');
      if (!aliveRef.current) return;
      setSessions(Array.isArray(res?.sessions) ? res.sessions : []);
      setError(null);
    } catch (err) {
      // El fallo se muestra: una lista vacía "porque sí" hacía parecer que el
      // IDE no había publicado la sesión cuando el problema era la petición.
      if (aliveRef.current) {
        setError(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Suscripción en vivo: cuando se ejecuta /remote en el IDE/CLI, la sesión
  // aparece aquí al instante sin refrescar. Cada (re)conexión relee la lista:
  // los avisos emitidos mientras el stream estaba caído no se reenvían.
  useEffect(() => {
    aliveRef.current = true;
    let backoff = 2000;
    const patch = (id, fields) => setSessions((cur) => cur.map((sx) => (sx.id === id ? { ...sx, ...fields } : sx)));
    const connect = () => {
      if (!aliveRef.current) return;
      load();
      streamRef.current = openEventStream({
        base: api.base,
        token: auth.apiKey,
        path: '/api/remote/subscribe',
        onEvent: (ev) => {
          backoff = 2000;
          if (ev.type === 'session_created' && ev.session) {
            setSessions((cur) => [ev.session, ...cur.filter((sx) => sx.id !== ev.session.id)]);
          } else if (ev.type === 'session_updated' && ev.session) {
            // El host cambió de conversación, de título o de agente.
            patch(ev.session.id, ev.session);
          } else if (ev.type === 'session_online' || ev.type === 'session_offline') {
            const online = ev.type === 'session_online';
            patch(ev.session_id, { status: online ? 'online' : 'offline', host_connected: online });
          } else if (ev.type === 'session_ended') {
            patch(ev.session_id, { status: 'ended', host_connected: false });
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

  const rows = useMemo(() => {
    const live = sessions.filter((sx) => sx.status !== 'ended');
    const past = sessions.filter((sx) => sx.status === 'ended');
    return [
      ...(live.length ? [{ header: 'En curso', count: live.length }, ...live] : []),
      ...(past.length ? [{ header: 'Anteriores', count: past.length }, ...past] : []),
    ];
  }, [sessions]);

  const liveCount = sessions.filter(isOnline).length;

  return (
    <SafeAreaView edges={embedded ? [] : ['top']} style={{ flex: 1, backgroundColor: embedded ? 'transparent' : c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: embedded ? 16 : 6, paddingRight: 16, height: 50 }}>
        {!embedded && (
          <IconButton onPress={onBack} size={38} label="Atrás">
            <Icon name="arrow-left" size={20} color={c.ink} />
          </IconButton>
        )}
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>Sesiones remotas</Text>
          <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>
            {liveCount > 0 ? `${liveCount} en vivo · Lixbon y Claude Code` : 'Lixbon y Claude Code · IDE y CLI'}
          </Text>
        </View>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.inkSoft} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => (item.header ? `h-${item.header}` : item.id)}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 6, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.inkSoft} />}
          ListHeaderComponent={
            error ? (
              <View style={{ padding: 12, marginBottom: 6, borderRadius: RADIUS, backgroundColor: c.dangerSoft }}>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.danger }}>{error}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={<EmptySessions base={api.base} />}
          renderItem={({ item }) =>
            item.header ? (
              <Text style={{ marginTop: 10, marginBottom: 2, marginLeft: 4, fontFamily: FONTS.monoMedium, fontSize: 10, letterSpacing: 0.8, color: c.inkLabel }}>
                {item.header.toUpperCase()} · {item.count}
              </Text>
            ) : (
              <SessionCard session={item} onPress={() => onOpen(item)} />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function EmptySessions({ base }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ padding: 10, borderRadius: RADIUS_BOX, backgroundColor: agentStyle('lixbon', c).soft }}>
          <AgentMark agent="lixbon" size={26} />
        </View>
        <View style={{ padding: 10, borderRadius: RADIUS_BOX, backgroundColor: agentStyle('claude', c).soft }}>
          <AgentMark agent="claude" size={26} />
        </View>
      </View>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink, textAlign: 'center' }}>Sin sesiones remotas</Text>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 20, color: c.inkMuted, textAlign: 'center' }}>
        Escribe /remote en el IDE, con Lixbon o con Claude Code, o en el CLI, y la sesión aparecerá aquí al instante.
      </Text>
      <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkFaint, textAlign: 'center' }}>
        misma cuenta · {base.replace(/^https?:\/\//, '')}
      </Text>
    </View>
  );
}

function SessionCard({ session, onPress }) {
  const c = useColors();
  const agent = agentOf(session);
  const a = agentStyle(agent, c);
  const ended = session.status === 'ended';
  // Una sesión terminada con transcript guardado se sigue pudiendo abrir en
  // modo lectura, para releer lo que se habló.
  const readable = ended && (session.transcript_events || 0) > 0;
  const online = isOnline(session);
  const status = ended ? (readable ? 'terminada · ver conversación' : 'terminada') : online ? 'en vivo' : 'sin conexión';
  const where = [session.workspace, session.source === 'cli' ? `CLI · ${session.machine || ''}` : SOURCE_LABEL[session.source]]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={ended && !readable ? undefined : onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.surface4 : c.surface2,
        opacity: ended && !readable ? 0.5 : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: RADIUS, backgroundColor: a.soft, alignItems: 'center', justifyContent: 'center' }}>
        <AgentMark agent={agent} size={agent === 'claude' ? 22 : 26} />
        {online && (
          <View
            style={{
              position: 'absolute',
              right: -3,
              bottom: -3,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: c.good,
              borderWidth: 2,
              borderColor: c.surface2,
            }}
          />
        )}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>
            {session.title || 'Sesión remota'}
          </Text>
          <Text style={{ fontFamily: FONTS.mono, fontSize: 10, color: c.inkFaint }}>
            {timeAgo(session.last_seen_at || session.created_at)}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 10.5, color: a.ink }}>{a.label}</Text>
          {!!where && (
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>
              · {where}
            </Text>
          )}
        </View>
        <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: online ? c.good : c.inkFaint }}>{status}</Text>
      </View>
    </Pressable>
  );
}

// ── Detalle de sesión ───────────────────────────────────────────────────────

function RemoteSessionView({ session, onBack, embedded }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const { confirm, sheet, toast } = useDialogs();
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [input, setInput] = useState('');
  const [mentions, setMentions] = useState([]);
  const [sending, setSending] = useState(false);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  const inputRef = useRef(null);

  const caps = state.meta?.capabilities || [];
  const attachments = useAttachments({ describeImages: false, allowImages: caps.includes('images') });

  useEffect(() => {
    seqRef.current = state.lastSeq;
  }, [state.lastSeq]);

  // Sesión ya terminada: no hay canal en vivo, pero el transcript se guardó.
  // Se lee de una vez y se reproduce por el mismo reducer que el streaming.
  const archived = session.status === 'ended';
  useEffect(() => {
    if (!archived) return undefined;
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/api/remote/sessions/${session.id}/transcript`);
        if (!alive) return;
        for (const ev of Array.isArray(res?.events) ? res.events : []) dispatch(ev);
      } catch (err) {
        if (alive) {
          dispatch({ type: 'error', message: err instanceof ApiException ? err.message : 'No se pudo cargar la conversación' });
        }
      } finally {
        if (alive) dispatch({ type: 'session_ended' });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, archived]);

  // Stream de eventos con reconexión (retoma desde el último seq visto).
  useEffect(() => {
    if (archived) return undefined;
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
  }, [session.id, archived]);

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

  // @archivo: el host busca en su workspace y responde con un evento `files`.
  const mentionQuery = useMemo(() => {
    const m = input.match(MENTION_AT_END);
    return m ? m[2] : null;
  }, [input]);
  const canMention = caps.includes('files') && state.hostConnected && !state.ended;
  useEffect(() => {
    if (mentionQuery === null || !canMention) return undefined;
    const timer = setTimeout(() => sendCommand({ type: 'files', query: mentionQuery }, { quiet: true }), 180);
    return () => clearTimeout(timer);
  }, [mentionQuery, canMention, sendCommand]);

  const pickMention = (file) => {
    setInput((cur) => cur.replace(MENTION_AT_END, '$1'));
    setMentions((cur) => (cur.some((m) => m.path === file.path) ? cur : [...cur, file]));
    inputRef.current?.focus();
  };

  const startMention = () => {
    setInput((cur) => (cur && !/\s$/.test(cur) ? `${cur} @` : `${cur}@`));
    inputRef.current?.focus();
  };

  const sendPrompt = async () => {
    const text = input.trim();
    const ready = attachments.ready;
    if ((!text && ready.length === 0) || sending || attachments.reading) return;
    // Un host que no anuncia adjuntos solo entiende texto: los documentos van
    // dentro del mensaje, como en el chat.
    const command = caps.includes('attachments')
      ? {
          type: 'prompt',
          text,
          attachments: ready.map((a) =>
            a.kind === 'image'
              ? { kind: 'image', name: a.name, base64: a.base64, mime: a.mime }
              : { kind: 'doc', name: a.name, text: a.text },
          ),
          mentions: mentions.map(({ name, rel, path }) => ({ name, rel, path })),
        }
      : { type: 'prompt', text: composeMessage(text, ready.filter((a) => a.kind === 'doc')) };
    setSending(true);
    const ok = await sendCommand(command);
    setSending(false);
    if (ok) {
      setInput('');
      setMentions([]);
      attachments.clear();
    }
  };

  const runSlash = async (text) => {
    if (await sendCommand({ type: 'prompt', text })) setInput('');
  };

  const interrupt = () => sendCommand({ type: 'interrupt' });
  const approve = (id, decision) => sendCommand({ type: 'approve', id, decision });

  const endSession = async () => {
    const ok = await confirm({
      title: 'Terminar sesión remota',
      message: 'El equipo recupera el control local y el link del QR deja de funcionar.',
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

  const agent = agentOf(session, state.meta);
  const commands = state.meta?.commands?.length ? state.meta.commands : FALLBACK_COMMANDS;

  const options = async () => {
    const action = await sheet({
      title: state.meta?.title || session.title || 'Sesión remota',
      subtitle: [agentStyle(agent, c).label, state.meta?.workspace || session.workspace].filter(Boolean).join(' · '),
      items: [
        { label: 'Comandos', description: `Los «/» de ${agentStyle(agent, c).label}`, icon: 'slash', hint: '/', value: 'commands' },
        ...(canMention ? [{ label: 'Mencionar un archivo', description: 'Busca en la carpeta del proyecto', icon: 'file', hint: '@', value: 'mention' }] : []),
        ...(state.agentState === 'thinking' ? [{ label: 'Interrumpir', description: 'Detiene el turno en curso', icon: 'stop', value: 'interrupt' }] : []),
        ...(state.ended ? [] : [{ label: 'Terminar sesión remota', description: 'El equipo recupera el control y el QR deja de valer', icon: 'logout', danger: true, value: 'end' }]),
      ],
    });
    if (action === 'commands') setInput('/');
    if (action === 'mention') startMention();
    if (action === 'interrupt') interrupt();
    if (action === 'end') endSession();
  };

  const items = useMemo(() => groupItems(state.items).reverse(), [state.items]);
  const thinking = state.agentState === 'thinking';
  const [tab, setTab] = useState('chat');
  const canOrch = !state.ended && (state.meta?.capabilities || []).includes('orch');
  const orchBusy = !!state.orch?.tasks?.some((x) => !['done', 'failed', 'stopped', 'exited'].includes(x.status));

  return (
    <SafeAreaView edges={embedded ? [] : ['top']} style={{ flex: 1, backgroundColor: embedded ? 'transparent' : c.bg }}>
      <KeyboardAware>
        <SessionHeader session={session} state={state} agent={agent} onBack={onBack} onOptions={options} />

        {canOrch && (
          <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
            <Segmented
              stretch
              size="sm"
              value={tab}
              onChange={setTab}
              options={[{ value: 'chat', label: 'Conversación' }, { value: 'orch', label: orchBusy ? 'Orquestar ·' : 'Orquestar' }]}
            />
          </View>
        )}

        <View style={{ flex: 1 }}>
          {canOrch && tab === 'orch' ? (
            <RemoteOrch state={state} sendCommand={sendCommand} />
          ) : state.items.length === 0 ? (
            <SessionEmpty state={state} agent={agent} />
          ) : (
            <FlatList
              inverted
              data={items}
              keyExtractor={(item) => item.key}
              contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => <TranscriptRow item={item} agent={agent} />}
            />
          )}
        </View>

        {!state.ended && state.agentState !== 'thinking' && state.background.length > 0 && (
          <WaitingStrip tasks={state.background} agent={agent} />
        )}

        {state.approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecide={approve} />
        ))}

        <RemoteComposer
          input={input}
          inputRef={inputRef}
          onChangeInput={setInput}
          onSend={sendPrompt}
          onInterrupt={interrupt}
          onRunCommand={runSlash}
          commands={commands}
          thinking={thinking}
          disabled={state.ended || !state.hostConnected}
          sending={sending}
          ended={state.ended}
          attachments={attachments}
          mentions={mentions}
          onRemoveMention={(path) => setMentions((cur) => cur.filter((m) => m.path !== path))}
          canMention={canMention}
          onStartMention={startMention}
          mentionQuery={canMention ? mentionQuery : null}
          files={state.files}
          onPickMention={pickMention}
        />
      </KeyboardAware>
    </SafeAreaView>
  );
}

function SessionHeader({ session, state, agent, onBack, onOptions }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const meta = state.meta || {};
  const status = state.ended
    ? 'terminada'
    : !state.hostConnected
      ? 'host sin conexión…'
      : state.agentState === 'thinking'
        ? 'trabajando…'
        : state.background.length
          ? 'esperando…'
          : 'en vivo';
  const live = state.hostConnected && !state.ended;
  const details = [meta.workspace || session.workspace, meta.model, MODE_LABEL[meta.mode] || meta.mode]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={{ paddingBottom: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 54, paddingHorizontal: 6 }}>
        <IconButton onPress={onBack} size={38} label="Volver a las sesiones">
          <Icon name="arrow-left" size={19} color={c.ink} />
        </IconButton>
        <View style={{ width: 32, height: 32, borderRadius: RADIUS, backgroundColor: a.soft, alignItems: 'center', justifyContent: 'center' }}>
          <AgentMark agent={agent} size={agent === 'claude' ? 17 : 20} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>
            {meta.title || session.title || 'Sesión remota'}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: a.ink }}>
            {a.label}
            <Text style={{ color: c.inkLabel }}>{details ? `  ·  ${details}` : ''}</Text>
          </Text>
        </View>
        <IconButton onPress={onOptions} size={38} label="Opciones de la sesión">
          <Icon name="dots" size={18} color={c.inkSoft} />
        </IconButton>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, height: 22 }}>
        <PulseDot active={live && (state.agentState === 'thinking' || state.background.length > 0)} color={live ? (state.agentState === 'thinking' || state.background.length ? a.dot : c.good) : c.inkFaint} />
        <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: live ? c.ink70 : c.inkLabel }}>{status}</Text>
        <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkFaint }}>
          {[SOURCE_LABEL[meta.source || session.source], session.source === 'cli' ? meta.machine || session.machine : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </View>
  );
}

function SessionEmpty({ state, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 12 }}>
      {state.hostConnected || state.ended ? (
        <>
          <View style={{ padding: 12, borderRadius: RADIUS_BOX, backgroundColor: a.soft }}>
            <AgentMark agent={agent} size={28} />
          </View>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 20, color: c.inkMuted, textAlign: 'center' }}>
            {state.ended
              ? 'Esta sesión terminó sin conversación guardada.'
              : `Conectado con ${a.label}. Pídele algo, adjunta archivos o empieza con «/» para usar un comando.`}
          </Text>
        </>
      ) : (
        <ActivityIndicator color={c.inkSoft} />
      )}
    </View>
  );
}

function TranscriptRow({ item, agent }) {
  const c = useColors();
  const { t } = useScale();
  if (item.kind === 'user') return <UserRow item={item} />;
  if (item.kind === 'tools') return <ToolLine items={item.items} />;
  if (item.kind === 'command') return <CommandCard item={item} agent={agent} />;
  if (item.kind === 'notice') {
    // Respuesta del host a un comando: monoespaciada, para que se lea como
    // salida del equipo y no como algo que dijo el modelo.
    return (
      <FadeUp style={{ marginVertical: 6 }}>
        <View style={{ flexDirection: 'row', borderRadius: RADIUS, backgroundColor: c.surface2, overflow: 'hidden' }}>
          <View style={{ width: 2, backgroundColor: agentStyle(agent, c).dot }} />
          <Text selectable style={{ flex: 1, padding: 10, fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody }}>
            {item.text}
          </Text>
        </View>
      </FadeUp>
    );
  }
  if (item.kind === 'error') {
    return (
      <View style={{ marginVertical: 6, padding: 10, borderRadius: RADIUS, backgroundColor: c.dangerSoft }}>
        <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.danger }}>{item.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ marginVertical: 8 }}>
      {item.text ? (
        <Markdown style={markdownStyles(c, t)}>{item.text}</Markdown>
      ) : item.open ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AgentMark agent={agent} size={14} />
          <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkLabel }}>trabajando…</Text>
        </View>
      ) : null}
    </View>
  );
}

function UserRow({ item }) {
  const c = useColors();
  const { t } = useScale();
  const { files, text } = splitMessage(item.text);
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  const hasExtras = files.length > 0 || item.images > 0 || mentions.length > 0;
  return (
    <FadeUp style={{ alignItems: 'flex-end', marginVertical: 8 }}>
      <View style={{ maxWidth: '86%', backgroundColor: c.surface3, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS }}>
        {hasExtras && (
          <View style={{ gap: 4, marginBottom: text ? 8 : 0 }}>
            {files.map((f, i) => (
              <ExtraLine key={`f${i}`} icon={f.kind === 'image' ? 'image' : 'file'} label={f.name} />
            ))}
            {item.images > 0 && (
              <ExtraLine icon="image" label={item.images === 1 ? '1 imagen' : `${item.images} imágenes`} />
            )}
            {mentions.map((m, i) => (
              <ExtraLine key={`m${i}`} icon="at" label={typeof m === 'string' ? m : m.name} />
            ))}
          </View>
        )}
        {!!text && (
          <Text selectable style={{ fontFamily: FONTS.ui, fontSize: t(14.5), lineHeight: t(21), color: c.ink }}>
            {text}
          </Text>
        )}
      </View>
      {item.origin === 'local' && (
        <Text style={{ fontFamily: FONTS.mono, fontSize: 10, color: c.inkFaint, marginTop: 3 }}>desde el equipo</Text>
      )}
    </FadeUp>
  );
}

function ExtraLine({ icon, label }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {icon === 'at' ? (
        <Text style={{ width: 13, textAlign: 'center', fontFamily: FONTS.monoMedium, fontSize: 12, color: c.accentDeep }}>@</Text>
      ) : (
        <Icon name={icon} size={13} color={c.accentDeep} />
      )}
      <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.mono, fontSize: 11.5, color: c.ink70 }}>{label}</Text>
    </View>
  );
}

const TASK_LABEL = { local_bash: 'comando', local_agent: 'subagente', remote_agent: 'agente remoto' };

function PulseDot({ active, color }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active || reduced) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduced, pulse]);
  return <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: pulse }} />;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const elapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

// El turno terminó pero el agente dejó algo corriendo y retomará solo cuando
// acabe: sin esto la sesión parecía parada.
function WaitingStrip({ tasks, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const now = useNow(true);
  return (
    <FadeUp style={{ marginHorizontal: 10, marginBottom: 6 }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: RADIUS_BOX, backgroundColor: a.soft, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PulseDot active color={a.dot} />
          <Text style={{ flex: 1, fontFamily: FONTS.monoMedium, fontSize: 11.5, color: a.ink }}>
            {tasks.length === 1 ? 'Esperando a una tarea en segundo plano' : `Esperando a ${tasks.length} tareas en segundo plano`}
          </Text>
        </View>
        {tasks.map((t) => (
          <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: FONTS.mono, fontSize: 10, color: a.ink, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: c.pressed }}>
              {TASK_LABEL[t.type] || 'tarea'}
            </Text>
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkBody }}>{t.description || t.id}</Text>
            {!!t.since && <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>{elapsed(now - t.since)}</Text>}
          </View>
        ))}
      </View>
    </FadeUp>
  );
}

const TONE_COLOR = { ok: 'good', wait: 'accent', warn: 'accentDeep', bad: 'danger' };

// Resultado de un «/» del IDE (/status, /cost, /doctor…): allí es una tarjeta
// con controles, aquí llega resumido en filas o como texto de Claude Code.
function CommandCard({ item, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? item.rows : item.rows.slice(0, 12);
  return (
    <FadeUp style={{ marginVertical: 6 }}>
      <View style={{ borderRadius: RADIUS_BOX, backgroundColor: c.surface2, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 36, backgroundColor: c.surface3 }}>
          <AgentMark agent={agent} size={13} />
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.monoMedium, fontSize: 12, color: a.ink }}>
            /{item.name}
            {!!item.args && <Text style={{ fontFamily: FONTS.mono, color: c.inkLabel }}>{`  ${item.args}`}</Text>}
          </Text>
        </View>
        {rows.length > 0 && (
          <View style={{ paddingVertical: 4 }}>
            {rows.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 6 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 6, backgroundColor: r.tone && TONE_COLOR[r.tone] ? c[TONE_COLOR[r.tone]] : c.inkFaint }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: c.ink }}>{r.label}</Text>
                  {!!r.detail && (
                    <Text selectable style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 16, color: c.inkMuted, marginTop: 1 }}>{r.detail}</Text>
                  )}
                </View>
              </View>
            ))}
            {item.rows.length > 12 && (
              <Pressable onPress={() => setExpanded((v) => !v)} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.accentDeep }}>
                  {expanded ? 'ver menos' : `ver ${item.rows.length - 12} más`}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {!!item.text && (
          <Text selectable style={{ padding: 12, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.inkBody }}>{item.text}</Text>
        )}
      </View>
    </FadeUp>
  );
}

/** Agrupa las herramientas consecutivas para pintarlas como una sola línea. */
function groupItems(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'tool' && last?.kind === 'tools') last.items.push(it);
    else if (it.kind === 'tool') out.push({ kind: 'tools', key: it.key, items: [it] });
    else out.push(it);
  }
  return out;
}

/** Un tramo de herramientas en UNA línea: la acción en curso en palabras con
    una ola de color, o el resumen al terminar. El detalle se despliega. */
function ToolLine({ items }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(null);
  const current = [...items].reverse().find((it) => it.running);
  const failed = items.filter((it) => it.error).length;
  const done = items.filter((it) => !it.running).length;
  const text = current ? describeRemoteTool(current) : summarizeRemoteTools(items);
  return (
    <View style={{ marginVertical: 4 }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 9, alignSelf: 'flex-start', maxWidth: '100%',
          paddingVertical: 6, paddingHorizontal: 8, marginLeft: -8, borderRadius: RADIUS,
          backgroundColor: pressed ? c.surface2 : 'transparent',
        })}
      >
        {current ? (
          <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: c.accent }} />
        ) : (
          <Icon name={failed ? 'warning' : 'check'} size={13} color={failed ? c.danger : c.good} />
        )}
        {current ? (
          <WaveText key={text} text={text} color={c.ink70} accent={c.accent} style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: 13 }} />
        ) : (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{text}</Text>
        )}
        {current && items.length > 1 && (
          <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkFaint }}>{done + 1} de {items.length}</Text>
        )}
        {!current && failed > 0 && (
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.danger }}>{failed === 1 ? '1 falló' : `${failed} fallaron`}</Text>
        )}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} color={c.inkFaint} />
      </Pressable>
      {open && (
        <View style={{ marginLeft: 6, paddingLeft: 12, borderLeftWidth: 1.5, borderLeftColor: c.surface4, gap: 8, paddingVertical: 4 }}>
          {items.map((it) => (
            <Pressable key={it.key} onPress={it.result ? () => setShown((k) => (k === it.key ? null : it.key)) : undefined} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%', fontFamily: FONTS.uiMedium, fontSize: 12.5, color: it.error ? c.danger : c.ink70 }}>
                  {describeRemoteTool(it)}
                </Text>
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>{it.summary}</Text>
                {!!it.result && <Icon name={shown === it.key ? 'chevron-down' : 'chevron-right'} size={11} color={c.inkFaint} />}
              </View>
              {shown === it.key && (
                <Text selectable style={{ padding: 9, borderRadius: RADIUS, backgroundColor: c.surface2, fontFamily: FONTS.mono, fontSize: 11, lineHeight: 16, color: c.inkBody }}>
                  {it.result}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function ApprovalCard({ approval, onDecide }) {
  const c = useColors();
  const isCommand = approval.risk === 'command';
  return (
    <FadeUp style={{ marginHorizontal: 10, marginBottom: 8 }}>
      <View style={{ padding: 12, borderRadius: RADIUS_BOX, backgroundColor: c.surface3, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="warning" size={15} color={c.accentDeep} />
          <Text style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 13.5, color: c.ink }}>
            {isCommand ? 'El agente quiere ejecutar un comando' : 'El agente quiere aplicar un cambio'}
          </Text>
        </View>
        <Text selectable style={{ padding: 9, borderRadius: RADIUS, backgroundColor: c.surface2, fontFamily: FONTS.mono, fontSize: 12, color: c.inkBody }}>
          <Text style={{ color: c.accentDeep }}>{approval.tool}</Text>
          {approval.summary ? `  ${approval.summary}` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => onDecide(approval.id, 'deny')}
            style={({ pressed }) => ({
              flex: 1,
              height: 40,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: RADIUS,
              backgroundColor: pressed ? c.surface6 : c.surface5,
            })}
          >
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 13.5, color: c.danger }}>Denegar</Text>
          </Pressable>
          <Pressable
            onPress={() => onDecide(approval.id, 'allow')}
            style={({ pressed }) => ({
              flex: 1,
              height: 40,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: RADIUS,
              backgroundColor: c.primary,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 13.5, color: c.onPrimary }}>Permitir</Text>
          </Pressable>
        </View>
      </View>
    </FadeUp>
  );
}

function RemoteComposer({
  input,
  inputRef,
  onChangeInput,
  onSend,
  onInterrupt,
  onRunCommand,
  commands,
  thinking,
  disabled,
  sending,
  ended,
  attachments,
  mentions,
  onRemoveMention,
  canMention,
  onStartMention,
  mentionQuery,
  files,
  onPickMention,
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const [focused, setFocused] = useState(false);
  const hasContent = !!input.trim() || attachments.ready.length > 0;
  const canSend = hasContent && !disabled && !sending && !attachments.reading;
  // Los hosts encolan lo que llega mientras el agente trabaja: con algo escrito
  // se envía; con la caja vacía, el botón interrumpe.
  const showStop = thinking && !hasContent;

  // El menú "/" aparece mientras se escribe el nombre (antes del primer
  // espacio): a partir de ahí lo que se teclea es el argumento.
  const slashQuery = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) return null;
    return input.slice(1).toLowerCase();
  }, [input]);
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((cmd) => cmd.name.toLowerCase().startsWith(slashQuery)).slice(0, 60)),
    [slashQuery, commands],
  );

  const mentionResults = useMemo(() => {
    if (mentionQuery === null) return null;
    if (!files || files.query !== mentionQuery) return null;
    return files.items.filter((f) => !mentions.some((m) => m.path === f.path));
  }, [mentionQuery, files, mentions]);

  // Igual que en el IDE: sin argumento se envía de una; con argumento se deja
  // el nombre escrito para completarlo.
  const pickCommand = (cmd) => (cmd.args ? onChangeInput(`/${cmd.name} `) : onRunCommand(`/${cmd.name}`));

  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 4, paddingBottom: keyboardOpen ? 8 : Math.max(insets.bottom, 10) }}>
      {slashMatches.length > 0 && !ended && (
        <SuggestionBox>
          {slashMatches.map((cmd, i) => (
            <React.Fragment key={`${cmd.group || ''}${cmd.name}`}>
              {cmd.group && cmd.group !== slashMatches[i - 1]?.group && <GroupLabel>{GROUP_LABEL[cmd.group] || cmd.group}</GroupLabel>}
              <SuggestionRow onPress={() => pickCommand(cmd)}>
                <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 12.5, color: c.ink }}>/{cmd.name}</Text>
                {!!cmd.args && <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>{cmd.args}</Text>}
                <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontFamily: FONTS.ui, fontSize: 11.5, color: c.inkLabel }}>
                  {cmd.description}
                </Text>
              </SuggestionRow>
            </React.Fragment>
          ))}
        </SuggestionBox>
      )}

      {mentionQuery !== null && (
        <SuggestionBox>
          <GroupLabel>{mentionQuery ? `Archivos · «${mentionQuery}»` : 'Archivos del proyecto'}</GroupLabel>
          {mentionResults === null ? (
            <View style={{ padding: 12, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={c.inkSoft} />
            </View>
          ) : mentionResults.length === 0 ? (
            <Text style={{ padding: 12, fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkLabel }}>Sin coincidencias.</Text>
          ) : (
            mentionResults.map((f) => (
              <SuggestionRow key={f.path} onPress={() => onPickMention(f)}>
                <Icon name="file" size={13} color={c.accentDeep} />
                <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.ink }}>{f.name}</Text>
                <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>
                  {f.rel}
                </Text>
              </SuggestionRow>
            ))
          )}
        </SuggestionBox>
      )}

      <View
        style={{
          backgroundColor: focused ? c.surface4 : c.surface3,
          borderRadius: RADIUS_BOX,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 8,
          opacity: ended ? 0.55 : 1,
        }}
      >
        <AttachmentTray
          items={attachments.items}
          onRemove={attachments.remove}
          extra={
            mentions.length > 0
              ? mentions.map((m) => <MentionChip key={m.path} mention={m} onRemove={() => onRemoveMention(m.path)} />)
              : null
          }
        />
        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={onChangeInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!ended}
          placeholder={ended ? 'La sesión terminó' : disabled ? 'Host sin conexión…' : 'Pídele algo al agente…'}
          placeholderTextColor={c.inkLabel}
          selectionColor={c.accent}
          multiline
          style={{
            maxHeight: 140,
            paddingHorizontal: 4,
            paddingTop: 2,
            paddingBottom: 6,
            fontFamily: FONTS.ui,
            fontSize: 15,
            lineHeight: 21,
            color: c.ink,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <ToolButton icon="clip" label="Adjuntar" onPress={attachments.pick} disabled={ended} />
          {canMention && <ToolButton glyph="@" label="Mencionar un archivo" onPress={onStartMention} active={mentionQuery !== null} />}
          <ToolButton
            icon="slash"
            label="Comandos"
            onPress={() => onChangeInput(input.startsWith('/') ? '' : '/')}
            disabled={ended}
            active={slashQuery !== null}
          />
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={showStop ? onInterrupt : onSend}
            disabled={showStop ? disabled : !canSend}
            accessibilityLabel={showStop ? 'Interrumpir' : 'Enviar'}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              borderRadius: RADIUS,
              backgroundColor: showStop || canSend ? c.primary : c.surface5,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: pressed ? 0.92 : 1 }],
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color={c.onPrimary} />
            ) : (
              <Icon name={showStop ? 'stop' : 'arrow-up'} size={17} color={showStop || canSend ? c.onPrimary : c.inkLabel} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ToolButton({ icon, glyph, label, onPress, disabled = false, active = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 32,
        height: 32,
        borderRadius: RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        backgroundColor: active ? c.accentSoft : pressed ? c.pressed : 'transparent',
      })}
    >
      {glyph ? (
        <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 16, color: active ? c.accentDeep : c.inkSoft }}>{glyph}</Text>
      ) : (
        <Icon name={icon} size={17} color={active ? c.accentDeep : c.inkSoft} />
      )}
    </Pressable>
  );
}

function SuggestionBox({ children }) {
  const c = useColors();
  return (
    <View style={{ marginBottom: 6, borderRadius: RADIUS_BOX, backgroundColor: c.surface2, overflow: 'hidden', maxHeight: 260 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 4 }}>
        {children}
      </ScrollView>
    </View>
  );
}

function GroupLabel({ children }) {
  const c = useColors();
  return (
    <Text style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 3, fontFamily: FONTS.monoMedium, fontSize: 9.5, letterSpacing: 0.8, color: c.inkLabel }}>
      {String(children).toUpperCase()}
    </Text>
  );
}

function SuggestionRow({ children, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 38,
        paddingHorizontal: 12,
        backgroundColor: pressed ? c.surface4 : 'transparent',
      })}
    >
      {children}
    </Pressable>
  );
}

