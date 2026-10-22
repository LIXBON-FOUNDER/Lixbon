// RemoteScreen.js — sección Remoto: sesiones /remote del IDE o del CLI, sea
// cual sea su agente (Lixbon o Claude Code). Sin sesión abierta muestra la
// lista; con una, el hilo por turnos del lienzo «Chat remoto»: lo que el
// agente piensa, cada herramienta en su fila (con su diff, salida o lista) y
// la respuesta; al terminar, todo se pliega en un resumen. Permisos,
// preguntas y el compact van encima del compositor. Todo se ejecuta en la
// máquina host; esto es un mando.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AppState, BackHandler, Easing, FlatList, Keyboard, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { ApiException } from '../api';
import { composeMessage, splitMessage } from '../attachments';
import { AttachmentTray, MentionChip, useAttachments } from '../components/Attachments';
import Icon from '../components/Icon';
import QuestionBatch, { isBatch } from '../components/QuestionBatch';
import { ImageThumb, ImageViewer, RemoteImageContext, ShownImageCard, useImageViewer } from '../components/RemoteImages';
import RemoteSessionList, { LiveDot } from '../components/RemoteSessionList';
import ShimmerText from '../components/ShimmerText';
import { useDialogs } from '../components/dialogs';
import { markdownRules, markdownStyles } from '../components/markdown';
import { AgentMark, ChatHeader, FadeUp, IconButton, KeyboardAware, Segmented, SkeletonLines, agentStyle, useColors, useKeyboardOpen, useReducedMotion, useScale } from '../components/ui';
import { initialRemoteState, keepStreamAlive, openEventStream, remoteReducer } from '../remote';
import { openRemoteSocket } from '../remoteSocket';
import { useCoreBootstrap } from '../observe/useCoreBootstrap';
import { agentOf } from '../remoteSessions';
import { buildBlocks, changedTurns, contextLevels, diffLines, fmtSecs, fmtTokens, toolState } from '../remoteTurns';
import { useApi, useAuth } from '../state';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';
import { summarizeRemoteTools, toolKind, toolParts } from '../toolText';
import RemoteOrch from './RemoteOrch';
import { GrowBar, Quota } from './UsageScreen';

const GROUP_LABEL = { lixbon: 'Lixbon', claude: 'Claude Code', skill: 'Skills' };
const MENTION_AT_END = /(^|\s)@([^\s@]*)$/;
const CARET = '⁣';
const RING = 2 * Math.PI * 8;
const EMPTY_TURN = { type: 'turn', key: 'live', work: [], images: [], qa: [], end: null, answer: null, actions: 0, adds: 0, dels: 0, files: [], tests: null, commit: '' };
const BIG_RING = 2 * Math.PI * 18;
// Las filas del hilo miden 34 como en el lienzo; el toque llega a 44.
const ROW_SLOP = { top: 5, bottom: 5 };
// Lo que piensa el agente en vivo: solo las últimas líneas.
const THINK_LINES = 3;
const THINK_LH = 20;
// Más arriba de esto el usuario está leyendo: el hilo deja de seguir al
// agente y conserva lo que tiene a la vista aunque llegue salida nueva.
const FOLLOW_SLACK = 60;
const HOLD_POSITION = { minIndexForVisible: 0 };

// Catálogo de reserva: si el host es de una versión anterior a que el `hello`
// publicara sus comandos, la hoja sigue ofreciendo lo básico en vez de nada.
const FALLBACK_COMMANDS = [
  { name: 'help', args: '', description: 'Ver los comandos disponibles' },
  { name: 'new', args: '', description: 'Empezar una conversación nueva' },
  { name: 'status', args: '', description: 'Estado de la sesión y del host' },
];

export default function RemoteScreen({ remote, session, onOpen, onClose, onMenu, onUsage, initialToken = null }) {
  const api = useApi();
  const [claiming, setClaiming] = useState(!!initialToken);
  const { toast } = useDialogs();

  // Deep link (QR / notificación): el token solo identifica la sesión; el
  // claim va autenticado con la API key y el gateway verifica que seas el dueño.
  useEffect(() => {
    if (!initialToken) return;
    (async () => {
      try {
        const res = await api.post('/api/remote/claim', { token: initialToken });
        if (res?.session?.id) onOpen(res.session);
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
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <SkeletonLines widths={['60%', '40%']} style={{ width: 200 }} />
      </SafeAreaView>
    );
  }
  if (session) return <RemoteSessionView key={session.id} session={session} onBack={onClose} onUsage={onUsage} />;
  return <RemoteListView remote={remote} onOpen={onOpen} onMenu={onMenu} />;
}

// ── Lista de sesiones ───────────────────────────────────────────────────────

function RemoteListView({ remote, onOpen, onMenu }) {
  const c = useColors();
  const api = useApi();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await remote.refresh();
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <ChatHeader title="Remoto" onLeading={onMenu} />
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.inkSoft} colors={[c.ink]} progressBackgroundColor={c.surface3} />}
      >
        {!!remote.error && (
          <View style={{ padding: 14, marginBottom: 12, borderRadius: RADIUS, backgroundColor: c.dangerSoft }}>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.danger }}>{remote.error}</Text>
          </View>
        )}
        {remote.loading && remote.sessions.length === 0 ? (
          <SkeletonLines widths={['70%', '52%', '62%']} style={{ paddingHorizontal: 12, paddingTop: 8 }} />
        ) : remote.sessions.length === 0 ? (
          <EmptySessions base={api.base} />
        ) : (
          <RemoteSessionList sessions={remote.sessions} onOpen={onOpen} />
        )}
      </ScrollView>
    </View>
  );
}

function EmptySessions({ base }) {
  const c = useColors();
  return (
    <FadeUp style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 60, gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {['lixbon', 'claude'].map((agent) => (
          <View key={agent} style={{ width: 44, height: 44, borderRadius: RADIUS, backgroundColor: agentStyle(agent, c).soft, alignItems: 'center', justifyContent: 'center' }}>
            <AgentMark agent={agent} size={agent === 'claude' ? 22 : 26} />
          </View>
        ))}
      </View>
      <Text style={{ fontFamily: FONTS.serif, fontSize: 26, lineHeight: 31, color: c.ink, textAlign: 'center' }}>Sin sesiones remotas</Text>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.inkMuted, textAlign: 'center' }}>
        Escribe <Text style={{ fontFamily: FONTS.mono, color: c.inkBody }}>/remote</Text> en el IDE o en el CLI, con Lixbon o con Claude Code, y la sesión aparece aquí al instante.
      </Text>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkFaint }}>Misma cuenta · {base.replace(/^https?:\/\//, '')}</Text>
    </FadeUp>
  );
}

// ── Detalle de sesión ───────────────────────────────────────────────────────

function useNow(active, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}

// El cupo es de la cuenta (el mismo en web, IDE y móvil): se pide al abrir la
// sesión y otra vez al terminar cada turno, que es cuando cambia.
function useQuota(busy) {
  const api = useApi();
  const [usage, setUsage] = useState(null);
  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/account/usage');
      if (res && typeof res === 'object') setUsage(res);
    } catch {
      // sin cupo a la vista: la píldora no se pinta
    }
  }, [api]);
  useEffect(() => {
    if (!busy) load();
  }, [busy, load]);
  return usage;
}

function RemoteSessionView({ session, onBack, onUsage }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const { confirm, sheet, toast } = useDialogs();
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [input, setInput] = useState('');
  const [mentions, setMentions] = useState([]);
  const [sending, setSending] = useState(false);
  const [overlay, setOverlayState] = useState(null);
  const [composerH, setComposerH] = useState(70);
  const [open, setOpen] = useState({});
  const [timeline, setTimeline] = useState(null);
  const [following, setFollowing] = useState(true);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  const inputRef = useRef(null);
  const socketRef = useRef(null);
  // WebSocket por defecto; SSE + POST solo si el gateway aún no lo ofrece.
  const [transport, setTransport] = useState('ws');
  const [link, setLink] = useState('connecting');

  const caps = state.meta?.capabilities || [];
  const attachments = useAttachments({ describeImages: false, allowImages: caps.includes('images') });
  const toggle = useCallback((key) => setOpen((cur) => ({ ...cur, [key]: !cur[key] })), []);
  const openTimeline = useCallback((turn, focus) => setTimeline({ turn, focus }), []);
  const closeTimeline = useCallback(() => setTimeline(null), []);
  // La lista está invertida: el desplazamiento 0 es el final del hilo.
  const onListScroll = useCallback((e) => {
    const near = e.nativeEvent.contentOffset.y <= FOLLOW_SLACK;
    setFollowing((cur) => (cur === near ? cur : near));
  }, []);
  // Las capas se anclan al compositor: con el teclado abierto quedarían debajo.
  const setOverlay = useCallback((next) => {
    if (next) Keyboard.dismiss();
    setOverlayState(next);
  }, []);

  // Respuestas del bootstrap del Core (LXO-107): no son transcript y no pasan por el reducer.
  const coreEventRef = useRef(null);
  const onRemoteEvent = useCallback((ev) => {
    if (typeof ev.seq === 'number' && ev.type !== 'channel_status') seqRef.current = Math.max(seqRef.current, ev.seq);
    if (coreEventRef.current?.(ev)) return;
    dispatch(ev);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (transport !== 'ws') return undefined;
    const socket = openRemoteSocket({
      base: api.base,
      getToken: auth.currentToken,
      sessionId: session.id,
      getSeq: () => seqRef.current,
      onEvent: onRemoteEvent,
      onStatus: setLink,
      onEnded: () => dispatch({ type: 'session_ended' }),
      onUnsupported: () => setTransport('sse'),
      appState: AppState,
    });
    socketRef.current = socket;
    return () => {
      aliveRef.current = false;
      socketRef.current = null;
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, transport]);

  // Respaldo con un gateway sin WebSocket: SSE que reconecta retomando desde
  // el último seq visto.
  useEffect(() => {
    if (transport !== 'sse') return undefined;
    aliveRef.current = true;
    setLink('open');
    const stop = keepStreamAlive(({ ok, retry }) =>
      openEventStream({
        base: api.base,
        token: auth.currentToken(),
        path: `/api/remote/sessions/${session.id}/stream?from_seq=${seqRef.current}`,
        onEvent: (ev) => {
          ok();
          onRemoteEvent(ev);
        },
        onEnd: () => retry(false),
        onError: (err) => {
          if (err?.status === 404 || err?.status === 410) dispatch({ type: 'session_ended' });
          else retry(true);
        },
      }),
    );
    return () => {
      aliveRef.current = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, transport]);

  // El historial se queda en el IDE o el CLI: cuando el host cierra la sesión
  // la vista se cierra sola.
  useEffect(() => {
    if (!state.ended) return;
    toast('La sesión remota terminó');
    onBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ended]);

  // Por el WebSocket cada comando espera su acuse (y se reenvía solo si la
  // conexión se corta antes). Por POST, un fallo sin respuesta del servidor
  // se reintenta: al volver de segundo plano la red tarda un momento.
  const sendCommand = useCallback(
    async (command, { quiet = false } = {}) => {
      const socket = socketRef.current;
      if (socket) {
        const res = await socket.send(command);
        if (res.ok) return true;
        if (!res.retry) {
          if (!quiet) toast(res.detail || 'Sin conexión con el host');
          return false;
        }
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await api.post(`/api/remote/sessions/${session.id}/commands`, command);
          return true;
        } catch (err) {
          const answered = err instanceof ApiException && err.status;
          if (!answered && attempt < 2 && aliveRef.current) {
            await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          if (!quiet) toast(err instanceof ApiException ? err.message : 'Sin conexión con el host');
          return false;
        }
      }
    },
    [api, session.id, toast],
  );

  // Bootstrap observacional del Core (LXO-107): el acuse se devuelve tal cual (con su estado HTTP) para
  // distinguir IDE desconectado, sesión no autorizada y gateway anterior.
  const sendCoreCommand = useCallback(
    async (command) => {
      const socket = socketRef.current;
      if (socket) {
        const res = await socket.send(command);
        return res.retry ? { ok: false } : res;
      }
      try {
        await api.post(`/api/remote/sessions/${session.id}/commands`, command);
        return { ok: true };
      } catch (err) {
        return { ok: false, status: err instanceof ApiException ? err.status : undefined };
      }
    },
    [api, session.id],
  );
  const core = useCoreBootstrap({
    sessionId: session.id,
    send: sendCoreCommand,
    transportOpen: link === 'open',
    hostConnected: state.hostConnected,
    capabilities: state.meta?.capabilities,
  });
  coreEventRef.current = core.handleEvent;

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
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // El gateway solo releva approve: la opción elegida de un selector o la
  // respuesta a una pregunta del agente viaja como su decisión ('' = cancelar).
  const choose = (id, value) => sendCommand({ type: 'approve', id, decision: value });
  const question = [...state.choices].reverse().find((x) => x.question) || null;
  const batchRef = useRef(null);
  // Imágenes del chat: el gateway las sirve al dueño de la sesión.
  const viewer = useImageViewer();
  const imageDownload = useCallback(
    (id) => ({ url: `${api.base}/api/remote/sessions/${session.id}/images/${id}`, headers: { Authorization: `Bearer ${auth.currentToken()}` } }),
    [api, auth, session.id],
  );
  const images = useMemo(
    () => ({
      source: (id, attempt = 0) => {
        const { url, headers } = imageDownload(id);
        return { uri: attempt ? `${url}?r=${attempt}` : url, headers };
      },
      open: viewer.open,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageDownload],
  );

  const sendPrompt = async (override) => {
    const text = (override ?? input).trim();
    const ready = override ? [] : attachments.ready;
    if ((!text && ready.length === 0) || sending || attachments.reading) return;
    // Con una pregunta del agente abierta, lo escrito es la respuesta.
    if (question && !override && text && !text.startsWith('/') && ready.length === 0) {
      setInput('');
      // En una tanda, lo escrito es «otra respuesta» de la pregunta a la vista.
      if (isBatch(question) && batchRef.current) {
        batchRef.current.answerCurrent(text);
        return;
      }
      if (!(await choose(question.id, text))) setInput((cur) => cur || text);
      return;
    }
    // Un host que no anuncia adjuntos solo entiende texto: los documentos van
    // dentro del mensaje, como en el chat.
    const command = caps.includes('attachments')
      ? {
          type: 'prompt',
          text,
          attachments: ready.map((a) =>
            a.kind === 'image' ? { kind: 'image', name: a.name, base64: a.base64, mime: a.mime } : { kind: 'doc', name: a.name, text: a.text },
          ),
          mentions: override ? [] : mentions.map(({ name, rel, path }) => ({ name, rel, path })),
        }
      : { type: 'prompt', text: composeMessage(text, ready.filter((a) => a.kind === 'doc')) };
    // Un texto normal aparece en el hilo al instante. Los comandos "/" no: el
    // host los contesta con una nota, sin eco del mensaje.
    const optimistic = !text.startsWith('/');
    const local = `l${Date.now()}`;
    const draft = { input, mentions };
    if (optimistic) {
      const photos = ready.filter((a) => a.kind === 'image');
      dispatch({ type: 'local_user', local, text: command.text, images: photos.length, localImages: photos.map((a) => a.preview).filter(Boolean), mentions: command.mentions || [] });
    }
    if (!override) {
      setInput('');
      setMentions([]);
    }
    setSending(true);
    const ok = await sendCommand(command);
    setSending(false);
    if (ok) {
      if (optimistic) dispatch({ type: 'local_user_sent', local });
      if (!override) attachments.clear();
    } else {
      if (optimistic) dispatch({ type: 'local_user_failed', local });
      if (!override) {
        setInput((cur) => cur || draft.input);
        setMentions((cur) => (cur.length ? cur : draft.mentions));
      }
    }
  };

  const interrupt = () => sendCommand({ type: 'interrupt' });
  const approve = (id, decision) => sendCommand({ type: 'approve', id, decision });

  const endSession = async () => {
    const ok = await confirm({
      title: '¿Terminar la sesión remota?',
      message: 'El equipo recupera el control local y el enlace del QR deja de funcionar.',
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
  const busy = state.agentState === 'thinking';
  const compacting = !!state.compact || (busy && state.activity === 'compacting');
  const canCompact = commands.some((x) => x.name === 'compact');
  const usage = useQuota(busy);

  const runCommand = (name) => {
    if (name === 'status' || name === 'compact') setOverlay(null);
    sendPrompt(`/${name}`);
  };

  // Comandos y acciones en una sola hoja: accesos grandes arriba y la lista de
  // comandos del host, filtrable, debajo.
  const openCommands = async () => {
    const action = await sheet({
      keyboard: true,
      render: (close) => (
        <CommandsSheet
          agent={agent}
          commands={commands}
          tiles={[
            { value: 'attach', icon: 'clip', label: 'Adjuntar' },
            ...(canMention ? [{ value: 'mention', glyph: '@', label: 'Archivo' }] : []),
            ...(busy ? [{ value: 'interrupt', icon: 'stop', label: 'Interrumpir' }] : []),
            ...(commands.some((x) => x.name === 'status') ? [{ value: 'cmd:status', icon: 'activity', label: 'Estado' }] : []),
            { value: 'usage', icon: 'gauge', label: 'Uso' },
            { value: 'end', icon: 'logout', label: 'Terminar', danger: true },
          ]}
          onPick={close}
        />
      ),
    });
    if (!action) return;
    if (action === 'attach') attachments.pick();
    if (action === 'mention') startMention();
    if (action === 'interrupt') interrupt();
    if (action === 'usage') setOverlay('quota');
    if (action === 'end') endSession();
    if (action.startsWith?.('cmd:')) {
      const cmd = commands.find((x) => x.name === action.slice(4)) || { name: action.slice(4) };
      // Igual que en el IDE: sin argumento se envía de una; con argumento se
      // deja el nombre escrito para completarlo.
      if (cmd.args) {
        setInput(`/${cmd.name} `);
        setTimeout(() => inputRef.current?.focus(), 50);
      } else {
        runCommand(cmd.name);
      }
    }
  };

  const turnBlocks = useMemo(() => buildBlocks(state.items), [state.items]);
  const changes = useMemo(() => changedTurns(turnBlocks), [turnBlocks]);
  // Recién enviado, el turno aún no tiene nada que enseñar: «está pensando…».
  const blocks = useMemo(() => {
    const out = [...turnBlocks];
    const last = out[out.length - 1];
    // Un comando «/» que sigue en el equipo no es un turno del agente.
    if (busy && compacting) return out.reverse();
    if (busy && state.activity === 'command') out.push({ type: 'running', key: 'running', label: state.activityLabel });
    else if (busy && !(last?.type === 'turn' && !last.end)) out.push(EMPTY_TURN);
    return out.reverse();
  }, [turnBlocks, busy, compacting, state.activity, state.activityLabel]);
  const [tab, setTab] = useState('chat');
  const [seenChanges, setSeenChanges] = useState(0);
  useEffect(() => {
    if (tab === 'changes') setSeenChanges(changes.length);
  }, [tab, changes.length]);
  const canOrch = !state.ended && caps.includes('orch');
  const orchBusy = !!state.orch?.tasks?.some((x) => !['done', 'failed', 'stopped', 'exited'].includes(x.status));
  const waitingTool = state.approvals[0]?.tool;
  const live = { busy, activity: state.activity, activityLabel: state.activityLabel, since: state.busySince, waitingTool, context: state.context };

  return (
    <RemoteImageContext.Provider value={images}>
      <KeyboardAware>
        <SessionHeader
          session={session}
          state={state}
          link={link}
          agent={agent}
          usage={usage}
          question={!!question}
          compacting={compacting}
          onBack={onBack}
          onQuota={state.ended ? null : () => setOverlay('quota')}
          onOptions={state.ended ? null : openCommands}
        />

        {!state.ended && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Segmented
              stretch
              value={tab}
              onChange={setTab}
              bg={c.surface2}
              options={[
                { value: 'chat', label: 'Conversación' },
                { value: 'changes', label: changes.length ? `Cambios · ${changes.length}` : 'Cambios', dot: changes.length > seenChanges && tab !== 'changes' },
                ...(canOrch ? [{ value: 'orch', label: 'Orquestar', dot: orchBusy && tab !== 'orch' }] : []),
              ]}
            />
          </View>
        )}

        <View style={{ flex: 1 }}>
          {canOrch && tab === 'orch' ? (
            <RemoteOrch state={state} sendCommand={sendCommand} core={core} />
          ) : tab === 'changes' ? (
            <ChangesView changes={changes} open={open} toggle={toggle} />
          ) : state.items.length === 0 ? (
            <SessionEmpty state={state} agent={agent} />
          ) : (
            <FlatList
              inverted
              data={blocks}
              keyExtractor={(b) => b.key}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
              onScroll={onListScroll}
              scrollEventThrottle={100}
              maintainVisibleContentPosition={following ? undefined : HOLD_POSITION}
              renderItem={({ item, index }) => <Block block={item} last={index === 0} agent={agent} live={live} open={open} toggle={toggle} onTimeline={openTimeline} />}
              extraData={[busy, state.activity, state.activityLabel, waitingTool, open, state.context]}
            />
          )}
        </View>

        {!state.ended && !busy && !compacting && state.background.length > 0 && <WaitingStrip tasks={state.background} agent={agent} />}

        {!state.ended && compacting && <CompactCard compact={state.compact} />}

        {state.approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecide={approve} />
        ))}

        {!state.ended &&
          state.choices
            .slice(-1)
            .map((x) =>
              isBatch(x) ? (
                <QuestionBatch key={x.id} ref={batchRef} choice={x} agent={agent} onChoose={choose} />
              ) : x.question ? (
                <QuestionCard key={x.id} choice={x} agent={agent} onChoose={choose} />
              ) : (
                <ChoiceCard key={x.id} choice={x} onChoose={choose} />
              ),
            )}

        {!state.ended && (
          <View onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}>
            <RemoteComposer
              input={input}
              inputRef={inputRef}
              onChangeInput={setInput}
              onSend={() => sendPrompt()}
              onInterrupt={interrupt}
              onCommands={openCommands}
              onRunCommand={(text) => sendPrompt(text)}
              commands={commands}
              thinking={busy}
              answering={!!question}
              disabled={!state.hostConnected}
              sending={sending}
              attachments={attachments}
              mentions={mentions}
              onRemoveMention={(path) => setMentions((cur) => cur.filter((m) => m.path !== path))}
              mentionQuery={canMention ? mentionQuery : null}
              files={state.files}
              onPickMention={pickMention}
              context={state.context}
              compacting={compacting}
              onContext={() => setOverlay('context')}
            />
          </View>
        )}

        {overlay === 'context' && state.context && (
          <ContextPopover
            context={state.context}
            compacted={state.items.some((it) => it.kind === 'compacted')}
            bottom={composerH + 4}
            busy={busy}
            compacting={compacting}
            canCompact={canCompact}
            onCompact={() => runCommand('compact')}
            onClose={() => setOverlay(null)}
          />
        )}
        {!!timeline &&
          (() => {
            const turn = turnBlocks.find((b) => b.key === timeline.turn);
            if (!turn) return null;
            const lastTurn = turnBlocks[turnBlocks.length - 1];
            const turnLive = turn === lastTurn && busy && !turn.end ? live : null;
            return <TimelineSheet turn={turn} focus={timeline.focus} live={turnLive} agent={agent} open={open} toggle={toggle} onClose={closeTimeline} />;
          })()}
        {overlay === 'quota' && (
          <QuotaModal
            usage={usage}
            onClose={() => setOverlay(null)}
            onDaily={() => {
              setOverlay(null);
              onUsage?.();
            }}
          />
        )}
        <ImageViewer image={viewer.image} onClose={viewer.close} download={imageDownload} />
      </KeyboardAware>
    </RemoteImageContext.Provider>
  );
}

// La acción que el modelo está escribiendo y cuánto lleva («Escribiendo
// index.html · 12.4 kB»): con una larga es lo único que avanza, y sin ella el
// turno parece trabado.
const preparingText = (label) => label || 'Preparando una acción';

// La fase del agente en palabras: es lo que dice la cabecera bajo el título.
function phaseOf(state, { question, compacting }) {
  if (compacting) return 'compactando';
  if (state.approvals.length) return 'espera tu permiso';
  if (question) return 'espera tu respuesta';
  if (state.agentState === 'thinking') {
    if (state.activity === 'command') return 'ejecutando un comando';
    if (state.activity === 'reasoning') return 'pensando';
    if (state.activity === 'writing') return 'escribiendo';
    if (state.activity === 'preparing') return preparingText(state.activityLabel).toLowerCase();
    return 'trabajando';
  }
  if (state.background.length) return 'esperando';
  return 'en vivo';
}

function SessionHeader({ session, state, link, agent, usage, question, compacting, onBack, onQuota, onOptions }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const a = agentStyle(agent, c);
  const meta = state.meta || {};
  const phase = phaseOf(state, { question, compacting });
  const breathing = phase !== 'en vivo';
  // Una reconexión de un par de segundos no se anuncia: solo si se alarga.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (link === 'open') {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [link]);
  const status = state.ended
    ? `${meta.workspace || session.workspace || a.label} · terminada`
    : slow
      ? 'Reconectando…'
      : !state.hostConnected
        ? `${a.label} · host sin conexión`
        : `${a.label} · ${phase}`;
  const sessionQuota = usage?.buckets?.session;
  const weekQuota = usage?.buckets?.week;
  const pct = typeof sessionQuota?.percent === 'number' && !sessionQuota.unlimited ? Math.round(sessionQuota.percent) : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: insets.top + 8, height: insets.top + 64 }}>
      <IconButton onPress={onBack} label="Volver a las sesiones">
        <Icon name="arrow-left" size={20} color={c.inkBody} />
      </IconButton>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 2 }}>
        <Text numberOfLines={1} style={{ maxWidth: '100%', fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>
          {meta.title || session.title || 'Sesión remota'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {!state.ended && !slow && state.hostConnected &&
            (breathing ? <LiveDot size={6} color={a.dot} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: a.dot }} />)}
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
            {status}
          </Text>
        </View>
      </View>
      {onQuota && pct !== null && (
        <Pressable
          onPress={onQuota}
          accessibilityRole="button"
          accessibilityLabel={`Cupo: sesión ${pct} %${typeof weekQuota?.percent === 'number' ? `, semana ${Math.round(weekQuota.percent)} %` : ''}. Ver uso`}
          style={{ height: 44, paddingHorizontal: 2, justifyContent: 'center' }}
        >
          <View style={{ height: 30, paddingHorizontal: 8, borderRadius: RADIUS_SM, backgroundColor: c.surface2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="gauge" size={14} color={pct >= 80 ? c.warn : c.inkBody} strokeWidth={1.8} />
            <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: pct >= 80 ? c.warn : c.inkBody }}>{pct} %</Text>
          </View>
        </Pressable>
      )}
      {onOptions ? (
        <IconButton onPress={onOptions} label="Opciones y comandos">
          <Icon name="dots" size={19} color={c.inkBody} />
        </IconButton>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </View>
  );
}

function SessionEmpty({ state, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  if (!state.hostConnected && !state.ended) {
    return <SkeletonLines widths={['84%', '62%', '74%']} height={13} style={{ paddingHorizontal: 20, paddingTop: 16 }} />;
  }
  return (
    <FadeUp style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 14 }}>
      <View style={{ width: 44, height: 44, borderRadius: RADIUS, backgroundColor: a.soft, alignItems: 'center', justifyContent: 'center' }}>
        <AgentMark agent={agent} size={agent === 'claude' ? 22 : 26} />
      </View>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.inkMuted, textAlign: 'center' }}>
        {`Conectado con ${a.label}. Pídele algo o toca + para adjuntar y ver sus comandos.`}
      </Text>
    </FadeUp>
  );
}

// ── Hilo ────────────────────────────────────────────────────────────────────

function Block({ block, last, agent, live, open, toggle, onTimeline }) {
  const { s } = useScale();
  switch (block.type) {
    case 'user':
      return <UserRow item={block.item} busy={live.busy} />;
    case 'turn':
      return (
        <TurnBlock
          turn={block}
          live={last && live.busy && !block.end ? live : null}
          waitingTool={last ? live.waitingTool : null}
          agent={agent}
          open={open}
          toggle={toggle}
          onTimeline={onTimeline}
        />
      );
    case 'command':
      return <CommandCard item={block.item} agent={agent} context={live.context} />;
    case 'compacted':
      return <CompactedRow item={block.item} open={!!open[block.key]} onToggle={() => toggle(block.key)} />;
    case 'notice':
      return <NoticeBox text={block.item.text} />;
    case 'running':
      return <RunningCommand label={block.label} since={live.since} />;
    case 'error':
      return <ErrorBox text={block.item.text} style={{ marginVertical: s(9) }} />;
    default:
      return null;
  }
}

function RunningCommand({ label, since }) {
  const now = useNow(true);
  return <ThinkLive label={label ? `Ejecutando ${label}…` : 'Ejecutando el comando…'} secs={since ? now - since : null} text="" />;
}

function NoticeBox({ text }) {
  const c = useColors();
  const { s } = useScale();
  // Respuesta del host a un comando: monoespaciada, para que se lea como
  // salida del equipo y no como algo que dijo el modelo.
  return (
    <FadeUp style={{ marginVertical: s(9) }}>
      <Text selectable style={{ padding: 12, borderRadius: RADIUS, backgroundColor: c.surface1, fontFamily: FONTS.mono, fontSize: 12.5, lineHeight: 19, color: c.inkBody }}>
        {text}
      </Text>
    </FadeUp>
  );
}

function ErrorBox({ text, style }) {
  const c = useColors();
  return (
    <View style={[{ padding: 12, borderRadius: RADIUS, backgroundColor: c.dangerSoft }, style]}>
      <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.danger }}>
        {text}
      </Text>
    </View>
  );
}

/** Un turno del agente. En marcha: lo que piensa, cada herramienta y la
    respuesta según llega. Terminado: una fila resumen que despliega todo,
    la respuesta, lo que preguntó y los cambios. */
function TurnBlock({ turn, live, waitingTool, agent, open, toggle, onTimeline }) {
  const c = useColors();
  const { s } = useScale();
  const now = useNow(!!live);
  const label = agentStyle(agent, c).label;
  const hasWork = turn.work.length > 0;
  const answer = turn.answer;
  const elapsed = live?.since ? now - live.since : null;

  const preparing = live?.activity === 'preparing';
  if (live && !turn.work.some((it) => it.kind !== 'thinking') && !answer?.text) {
    const thinking = turn.work.filter((it) => it.kind === 'thinking');
    const text = preparing ? '' : thinking.map((it) => it.text).join('\n\n');
    return <ThinkLive label={preparing ? `${preparingText(live.activityLabel)}…` : `${label} está pensando…`} secs={elapsed} text={text} />;
  }

  // Mientras escribe la respuesta, el trabajo ya hecho se pliega en el resumen.
  const writing = !!live && !!answer?.open && live.activity === 'writing';
  const collapsed = !live || writing;
  const summaryOpen = !!open[turn.key];
  const interrupted = !!turn.end?.interrupted;
  const ms = turn.end?.ms ?? (live ? elapsed : null);

  return (
    <View style={{ marginVertical: s(4) }}>
      {collapsed && hasWork && (
        <SummaryRow
          label={summaryLabel({ interrupted, ms, actions: turn.actions })}
          interrupted={interrupted}
          adds={turn.adds}
          dels={turn.dels}
          open={summaryOpen}
          onToggle={() => toggle(turn.key)}
        />
      )}
      {(!collapsed || summaryOpen) && (
        <WorkList
          work={turn.work}
          live={live}
          waitingTool={waitingTool}
          label={label}
          open={open}
          toggle={toggle}
          elapsed={elapsed}
          onTimeline={(focus) => onTimeline?.(turn.key, focus)}
        />
      )}
      {(turn.images || []).length > 0 && <TurnImages images={turn.images} />}
      {!!answer?.text && <AnswerBlock text={answer.text} streaming={!!live && answer.open && !preparing} />}
      {preparing && <ThinkLive label={`${preparingText(live.activityLabel)}…`} secs={null} text="" compact />}
      {interrupted && <NoticeBox text="Interrumpiste al agente. Lo que ya hizo se queda en el equipo." />}
    </View>
  );
}

/** Lo que el agente enseñó en el turno (show_image), a todo el ancho. */
function TurnImages({ images }) {
  const [width, setWidth] = useState(0);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && images.map((img) => <ShownImageCard key={img.key} item={img} maxWidth={width} />)}
    </View>
  );
}

function summaryLabel({ interrupted, ms, actions }) {
  const n = `${actions} ${actions === 1 ? 'acción' : 'acciones'}`;
  if (interrupted) return `Interrumpido · ${n}`;
  return typeof ms === 'number' ? `Trabajó ${fmtSecs(ms)} · ${n}` : `Trabajó · ${n}`;
}

/** Las herramientas seguidas van juntas en una fila; lo pensado y lo que el
    agente cuenta entre ellas cortan el tramo. */
function workSegments(work) {
  const out = [];
  for (const it of work) {
    const prev = out[out.length - 1];
    if (it.kind !== 'tool') out.push(it);
    else if (prev?.kind === 'tools') prev.items.push(it);
    else out.push({ kind: 'tools', key: it.key, items: [it] });
  }
  return out;
}

function WorkList({ work, live, waitingTool, label, open, toggle, elapsed, onTimeline }) {
  const lastItem = work[work.length - 1];
  return (
    <View>
      {workSegments(work).map((it) => {
        if (it.kind === 'thinking') {
          if (it.open && live) return <ThinkLive key={it.key} label={`${label} está pensando…`} secs={Date.now() - (it.since || Date.now())} text={it.text} compact />;
          return <ThoughtRow key={it.key} item={it} open={!!open[it.key]} onToggle={() => toggle(it.key)} />;
        }
        if (it.kind === 'tools') {
          const tail = it.items[it.items.length - 1];
          const running = !!live && tail.running && tail === lastItem;
          return <ActionsRow key={it.key} items={it.items} running={running} waitingTool={running ? waitingTool : null} onPress={() => onTimeline(it.key)} />;
        }
        if (it.kind === 'notice') return <NoticeBox key={it.key} text={it.text} />;
        if (it.kind === 'qa') return <QaRecord key={it.key} item={it} label={label} />;
        if (it.kind === 'assistant' && it.text.trim()) return <ProseLine key={it.key} text={it.text} />;
        return null;
      })}
      {!!live && elapsed !== null && live.activity === 'reasoning' && !work.some((it) => it.kind === 'thinking' && it.open) && (
        <ThinkLive label={`${label} está pensando…`} secs={null} text="" compact />
      )}
    </View>
  );
}

function ThinkLive({ label, secs, text, compact = false }) {
  const c = useColors();
  const { s } = useScale();
  const tail = text.length > 400 ? `…${text.slice(-400)}` : text;
  return (
    <FadeUp style={{ marginVertical: compact ? s(4) : s(9), gap: 6 }} accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <ShimmerText text={label} style={{ fontFamily: FONTS.uiMedium, fontSize: compact ? 13.5 : 15 }} />
        {typeof secs === 'number' && secs >= 0 && <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkFaint }}>{`${Math.max(1, Math.round(secs / 1000))} s`}</Text>}
      </View>
      {/* Alto fijo y pegado abajo: se ven las últimas líneas y el hilo no
          crece mientras el modelo piensa. Entero queda en «Pensó». */}
      {!!tail.trim() && (
        <View style={{ maxHeight: THINK_LINES * THINK_LH, overflow: 'hidden', justifyContent: 'flex-end' }}>
          <Text style={{ flexShrink: 0, fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: THINK_LH, color: c.inkMuted }}>{tail.trim()}</Text>
        </View>
      )}
    </FadeUp>
  );
}

function ThoughtRow({ item, open, onToggle }) {
  const c = useColors();
  const secs = typeof item.ms === 'number' ? Math.max(1, Math.round(item.ms / 1000)) : null;
  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={ROW_SLOP}
        style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <Icon name="bulb" size={15} color={c.inkMuted} strokeWidth={1.7} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>{secs ? `Pensó ${secs} s` : 'Pensó'}</Text>
        <View style={{ flex: 1 }} />
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={c.inkFaint} strokeWidth={2} />
      </Pressable>
      {open && (
        <Text selectable style={{ paddingLeft: 25, paddingBottom: 8, fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 20, color: c.inkMuted }}>
          {item.text}
        </Text>
      )}
    </View>
  );
}

function SummaryRow({ label, interrupted, adds, dels, open, onToggle }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => ({
        minHeight: 40,
        marginTop: 6,
        marginBottom: 2,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.surface2 : c.surface1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      })}
    >
      <Icon name={interrupted ? 'stop' : 'tick'} size={15} color={interrupted ? c.danger : c.good} strokeWidth={1.8} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkBody }}>{label}</Text>
      {(adds > 0 || dels > 0) && <LineCounts adds={adds} dels={dels} />}
      <View style={{ flex: 1 }} />
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={c.inkFaint} strokeWidth={2} />
    </Pressable>
  );
}

function ProseLine({ text }) {
  const c = useColors();
  return (
    <Text selectable style={{ paddingVertical: 4, fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 20, color: c.inkBody }}>
      {text.trim()}
    </Text>
  );
}

function LineCounts({ adds = 0, dels = 0 }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 5 }}>
      <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.good }}>{`+${adds || 0}`}</Text>
      <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.danger }}>{`−${dels || 0}`}</Text>
    </View>
  );
}

const ICON_OF = { read: 'file', search: 'search', web: 'globe', edit: 'edit', cmd: 'console' };

function toolMeta(it, kind) {
  if (it.running) return '';
  if (kind === 'cmd') {
    if (/^git\s+commit\b/.test(String(it.summary || '').trim())) {
      const hash = /\[[^\]\n]*?\s([0-9a-f]{7,40})\]/.exec(String(it.result || ''))?.[1];
      if (hash) return hash.slice(0, 7);
    }
    if (typeof it.exit === 'number' && it.exit > 0) return `código ${it.exit}`;
    return fmtSecs(it.ms);
  }
  if (it.meta) return it.meta;
  if (kind === 'search' && it.lines?.length) return `${it.lines.length} resultados`;
  return '';
}

/** Una herramienta en una fila: icono por tipo, verbo, destino, líneas
    cambiadas y su medida; se despliega a la lista, al diff o a la salida. */
/** Verbo, destino e icono de una herramienta según cómo quedó. */
function toolRowParts(it, waitingTool) {
  const kind = toolKind(it);
  const st = toolState(it, waitingTool);
  const { verb: baseVerb, target: baseTarget, mono } = toolParts(it, st.waiting);
  const git = kind === 'cmd' && /^git\b/.test(String(it.summary || '').trim());
  const verb = st.denied ? (kind === 'edit' ? 'No editó' : kind === 'cmd' ? 'No ejecutó' : 'Rechazado') : st.cut ? 'Cortado' : baseVerb;
  const target = st.waiting ? `tu permiso · ${baseTarget}` : baseTarget;
  const icon = st.bad ? 'warning' : git ? 'git' : ICON_OF[kind] || 'layers';
  return { kind, st, verb, target, mono, git, icon };
}

function ToolRow({ it, waitingTool, open, onToggle }) {
  const c = useColors();
  const { kind, st, verb, target, mono, icon } = toolRowParts(it, waitingTool);
  const hasDiff = !!(it.rows?.length || it.diff);
  const hasList = !!it.lines?.length;
  const isCmd = kind === 'cmd';
  const hasResult = !!it.result && it.result !== it.meta && !/^interrumpid|rechazad/i.test(it.result);
  const expandable = !st.waiting && !st.denied && (hasDiff || hasList || (isCmd && (hasResult || !!it.output)) || (!isCmd && hasResult && !it.readonly));
  const isOpen = expandable && open;
  const showOut = isCmd && (it.running || isOpen) && !st.waiting;
  const meta = st.bad && !(isCmd && typeof it.exit === 'number') ? '' : toolMeta(it, kind);
  const tone = st.bad ? c.danger : c.inkMuted;

  return (
    <View>
      <Pressable
        onPress={expandable ? onToggle : undefined}
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: isOpen } : undefined}
        accessibilityLabel={`${verb} ${target}`}
        hitSlop={ROW_SLOP}
        style={({ pressed }) => ({ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.7 : 1 })}
      >
        <Icon name={icon} size={15} color={tone} strokeWidth={1.7} />
        {it.running && !st.waiting ? (
          <View style={{ width: 60 }}>
            <ShimmerText text={verb} style={{ fontFamily: FONTS.ui, fontSize: 13.5 }} />
          </View>
        ) : (
          <Text numberOfLines={1} style={{ width: 60, fontFamily: FONTS.ui, fontSize: 13.5, color: tone }}>
            {verb}
          </Text>
        )}
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: mono ? FONTS.mono : FONTS.ui, fontSize: mono ? 12.5 : 13.5, color: c.inkBody }}>
          {target}
        </Text>
        {hasDiff && !st.denied && <LineCounts adds={it.adds} dels={it.dels} />}
        {!!meta && <Text style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: c.inkFaint }}>{meta}</Text>}
        {expandable && <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} color={c.inkFaint} strokeWidth={2} />}
      </Pressable>

      {isOpen && hasList && (
        <View style={{ marginLeft: 25, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: RADIUS_SM, backgroundColor: c.surface1, gap: 4 }}>
          {it.lines.map((line, i) => {
            const m = /^(.+?)(:\d+)(?::|\s|$)/.exec(line);
            return (
              <Text key={i} numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody }}>
                {m ? m[1] : line}
                {!!m && <Text style={{ color: c.inkFaint }}>{m[2]}</Text>}
              </Text>
            );
          })}
        </View>
      )}
      {isOpen && hasDiff && <DiffView item={it} style={{ marginTop: 2, marginBottom: 8, backgroundColor: c.surface1 }} />}
      {showOut && <CommandBox it={it} state={st} />}
      {isOpen && !hasDiff && !hasList && !isCmd && hasResult && (
        <Text selectable style={{ marginLeft: 25, marginBottom: 8, padding: 10, borderRadius: RADIUS_SM, backgroundColor: c.surface1, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.inkBody }}>
          {it.result}
        </Text>
      )}
    </View>
  );
}

/** Un tramo de herramientas seguidas en una sola fila: el icono de cada tipo
    que usó, qué hizo en palabras y las líneas cambiadas. Mientras una corre
    dice cuál; un toque abre la línea de tiempo del turno. */
function ActionsRow({ items, running, waitingTool, onPress }) {
  const c = useColors();
  const tail = items[items.length - 1];
  const now = toolRowParts(tail, waitingTool);
  const parts = items.map((it) => toolRowParts(it));
  const icons = [...new Set(parts.map((p) => p.icon))];
  const bad = parts.some((p) => p.st.bad);
  let adds = 0;
  let dels = 0;
  for (const it of items) {
    if ((it.rows?.length || it.diff) && !toolState(it).denied) {
      adds += it.adds || 0;
      dels += it.dels || 0;
    }
  }
  const single = items.length === 1 || running;
  const one = running ? now : parts[0];
  const label = single ? `${one.verb} ${one.target}` : summarizeRemoteTools(items);
  const showOut = running && now.kind === 'cmd' && !now.st.waiting;
  return (
    <View>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Ver la línea de tiempo`}
        hitSlop={ROW_SLOP}
        style={({ pressed }) => ({ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {icons.slice(0, 4).map((name) => (
            <Icon key={name} name={name} size={15} color={name === 'warning' ? c.danger : c.inkMuted} strokeWidth={1.7} />
          ))}
        </View>
        {running && !now.st.waiting ? (
          <View style={{ flex: 1, minWidth: 0 }}>
            <ShimmerText text={label} style={{ fontFamily: FONTS.ui, fontSize: 13.5 }} />
          </View>
        ) : single ? (
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: FONTS.ui, fontSize: 13.5, color: one.st.bad ? c.danger : c.inkMuted }}>
            {`${one.verb} `}
            <Text style={{ fontFamily: one.mono ? FONTS.mono : FONTS.ui, fontSize: one.mono ? 12.5 : 13.5, color: c.inkBody }}>{one.target}</Text>
          </Text>
        ) : (
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: FONTS.ui, fontSize: 13.5, color: bad ? c.danger : c.inkBody }}>
            {label}
          </Text>
        )}
        {(adds > 0 || dels > 0) && <LineCounts adds={adds} dels={dels} />}
        <Icon name="chevron-right" size={13} color={c.inkFaint} strokeWidth={2} />
      </Pressable>
      {showOut && <CommandBox it={tail} state={now.st} />}
    </View>
  );
}

/** Todo lo que hizo el turno en orden, de arriba abajo: lo pensado, lo que
    contó y cada herramienta con su diff o su salida. Se abre en el tramo
    que se tocó. */
function TimelineSheet({ turn, focus, live, agent, open, toggle, onClose }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef(null);
  const placed = useRef(false);
  const label = agentStyle(agent, c).label;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  const work = turn.work.filter((it) => it.kind !== 'assistant' || it.text.trim());
  const lastItem = turn.work[turn.work.length - 1];
  const actions = turn.work.filter((it) => it.kind === 'tool').length;
  const ms = turn.end?.ms ?? (live?.since ? Date.now() - live.since : null);
  const sub = [`${actions} ${actions === 1 ? 'acción' : 'acciones'}`, typeof ms === 'number' ? fmtSecs(ms) : ''].filter(Boolean).join(' · ');
  return (
    <Overlay onClose={onClose} label="Cerrar la línea de tiempo">
      <FadeUp
        distance={12}
        accessibilityViewIsModal
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: c.sheet, paddingBottom: insets.bottom + 8 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 18, paddingHorizontal: 16, paddingBottom: 10 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text accessibilityRole="header" style={{ fontFamily: FONTS.serif, fontSize: 22, lineHeight: 26, color: c.ink }}>
              Línea de tiempo
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{sub}</Text>
              {(turn.adds > 0 || turn.dels > 0) && <LineCounts adds={turn.adds} dels={turn.dels} />}
            </View>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar" style={{ width: 44, height: 44, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={18} color={c.inkMuted} strokeWidth={1.8} />
          </Pressable>
        </View>
        <ScrollView ref={scrollRef} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          {work.map((it, i) => {
            const onLayout =
              it.key === focus
                ? (e) => {
                    if (placed.current) return;
                    placed.current = true;
                    scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 8), animated: false });
                  }
                : undefined;
            let body = null;
            if (it.kind === 'thinking') {
              body =
                it.open && live ? (
                  <ThinkLive label={`${label} está pensando…`} secs={Date.now() - (it.since || Date.now())} text={it.text} compact />
                ) : (
                  <ThoughtRow item={it} open={!!open[it.key]} onToggle={() => toggle(it.key)} />
                );
            } else if (it.kind === 'tool') {
              const lastRunning = !!live && it.running && it === lastItem;
              body = <ToolRow it={it} waitingTool={lastRunning ? live.waitingTool : null} open={!!open[it.key]} onToggle={() => toggle(it.key)} />;
            } else if (it.kind === 'notice') body = <NoticeBox text={it.text} />;
            else if (it.kind === 'qa') body = <QaRecord item={it} label={label} />;
            else if (it.kind === 'assistant') body = <ProseLine text={it.text} />;
            if (!body) return null;
            return (
              <View key={it.key} onLayout={onLayout} style={{ flexDirection: 'row' }}>
                <View style={{ width: 14 }}>
                  {work.length > 1 && (
                    <View
                      style={{
                        position: 'absolute',
                        left: 6,
                        width: 1.5,
                        top: i === 0 ? 17 : 0,
                        bottom: i === work.length - 1 ? undefined : 0,
                        height: i === work.length - 1 ? 17 : undefined,
                        backgroundColor: c.surface4,
                      }}
                    />
                  )}
                  <View style={{ position: 'absolute', left: 3, top: 14, width: 7.5, height: 7.5, borderRadius: 4, backgroundColor: it.kind === 'tool' ? c.inkFaint : c.surface4 }} />
                </View>
                <View style={{ flex: 1, minWidth: 0, paddingLeft: 8 }}>{body}</View>
              </View>
            );
          })}
        </ScrollView>
      </FadeUp>
    </Overlay>
  );
}

const outTone = (line, c) => (/^\s*(PASS|ok\b|✓)/.test(line) ? c.good : /^\s*(FAIL|✗|error\b)/i.test(line) ? c.danger : /^\s*>/.test(line) ? c.inkMuted : c.inkBody);

/** «$ comando», las últimas líneas mientras corre y cómo terminó. */
function CommandBox({ it, state }) {
  const c = useColors();
  const now = useNow(!!it.running);
  const text = it.running ? it.output || '' : it.result || it.output || '';
  const all = text.replace(/\n$/, '').split('\n').filter((l, i, arr) => l.length || i < arr.length - 1);
  const lines = it.running ? all.slice(-4) : all.slice(-40);
  const secs = it.running ? fmtSecs(now - (it.since || now)) : fmtSecs(it.ms);
  const failed = state.cut || (typeof it.exit === 'number' ? it.exit !== 0 : it.error);
  const footer = it.running
    ? null
    : state.cut
      ? 'Cortado'
      : it.exit === -1
        ? `Se cortó por tiempo${secs ? ` · ${secs}` : ''}`
        : typeof it.exit === 'number'
          ? `Salió con código ${it.exit}${secs ? ` · ${secs}` : ''}`
          : `${it.error ? 'Falló' : 'Terminó'}${secs ? ` · ${secs}` : ''}`;
  return (
    <View style={{ marginTop: 2, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS_SM, backgroundColor: c.surface1 }}>
      <Text selectable style={{ fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.ink }}>{`$ ${it.summary || it.tool}`}</Text>
      {lines.map((line, i) => (
        <Text key={i} selectable style={{ fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: outTone(line, c) }}>
          {line || ' '}
        </Text>
      ))}
      {it.running ? (
        <View style={{ marginTop: 6 }}>
          <ShimmerText text={`Corriendo en el equipo · ${secs || '0,0 s'}`} style={{ fontFamily: FONTS.ui, fontSize: 12 }} />
        </View>
      ) : (
        <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={failed ? 'warning' : 'tick'} size={13} color={failed ? c.danger : c.good} strokeWidth={2} />
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: failed ? c.danger : c.good }}>{footer}</Text>
        </View>
      )}
    </View>
  );
}

/** Solo las líneas cambiadas con una de contexto, numeradas: nunca el
    archivo entero. Añadidas sobre verde, borradas sobre rojo. */
function DiffView({ item, style, maxHeight }) {
  const c = useColors();
  const lines = useMemo(() => diffLines(item), [item]);
  const body = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
      <View style={{ minWidth: '100%' }}>
        {lines.map((ln, i) =>
          ln.gap ? (
            <Text key={i} style={{ paddingVertical: 3, paddingLeft: 12, paddingRight: 10, fontFamily: FONTS.ui, fontSize: 11.5, lineHeight: 17, color: c.inkFaint }}>
              {ln.text}
            </Text>
          ) : (
            <View key={i} style={{ flexDirection: 'row', backgroundColor: ln.kind === 'a' ? c.goodSoft : ln.kind === 'd' ? c.dangerSoft : 'transparent' }}>
              <Text style={{ width: 34, paddingRight: 8, textAlign: 'right', fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 18, color: c.inkFaint }}>{ln.num}</Text>
              <Text style={{ width: 14, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 18, color: ln.kind === 'a' ? c.good : ln.kind === 'd' ? c.danger : c.inkFaint }}>
                {ln.kind === 'a' ? '+' : ln.kind === 'd' ? '−' : ' '}
              </Text>
              <Text selectable style={{ paddingRight: 14, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 18, color: ln.kind === 'c' ? c.inkMuted : c.ink }}>
                {ln.text || ' '}
              </Text>
            </View>
          ),
        )}
      </View>
    </ScrollView>
  );
  return (
    <View style={[{ paddingVertical: 6, borderRadius: RADIUS_SM, overflow: 'hidden' }, style]}>
      {maxHeight ? (
        <ScrollView style={{ maxHeight }} nestedScrollEnabled>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

// El cursor de la respuesta en curso: un carácter dentro del propio texto del
// Markdown (así queda pegado a la última palabra) que parpadea.
function Caret() {
  const c = useColors();
  const reduced = useReducedMotion();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (reduced) return undefined;
    const timer = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(timer);
  }, [reduced]);
  return <Text style={{ color: on ? c.ink : 'transparent' }}>▍</Text>;
}

function AnswerBlock({ text, streaming }) {
  const c = useColors();
  const { t, s } = useScale();
  const { toast } = useDialogs();
  const mdStyles = useMemo(() => markdownStyles(c, t), [c, t]);
  const mdRules = useMemo(() => {
    const base = markdownRules(c, t, () => toast('Código copiado', { icon: 'check' }));
    return {
      ...base,
      text: (node, children, parent, styles, inherited = {}) => {
        const content = String(node.content || '');
        if (!content.includes(CARET)) {
          return (
            <Text key={node.key} style={[inherited, styles.text]}>
              {content}
            </Text>
          );
        }
        return (
          <Text key={node.key} style={[inherited, styles.text]}>
            {content.replace(CARET, '')}
            <Caret />
          </Text>
        );
      },
    };
  }, [c, t, toast]);
  return (
    <FadeUp style={{ marginVertical: s(9) }}>
      <Markdown style={mdStyles} rules={mdRules}>
        {streaming ? `${text.replace(/\s+$/, '')}${CARET}` : text}
      </Markdown>
    </FadeUp>
  );
}

function QaRecord({ item, label }) {
  const c = useColors();
  if (item.total > 1) return <QaBatchRecord item={item} />;
  return (
    <FadeUp style={{ marginVertical: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, backgroundColor: c.surface1, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="message" size={14} color={c.inkMuted} strokeWidth={1.7} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{`${label} preguntó`}</Text>
      </View>
      <Text selectable style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{item.question}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <View style={{ paddingTop: 3 }}>
          <Icon name="tick" size={14} color={c.accentDeep} strokeWidth={1.9} />
        </View>
        <Text selectable style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13.5, color: c.accentDeep }}>{item.answer}</Text>
      </View>
    </FadeUp>
  );
}

/** Lo respondido en una tanda: una fila por pregunta con su título corto. */
function QaBatchRecord({ item }) {
  const c = useColors();
  const n = item.rows.length;
  return (
    <FadeUp style={{ marginVertical: 6, paddingHorizontal: 14, paddingVertical: 12, borderRadius: RADIUS, backgroundColor: c.surface1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="tick" size={13} color={c.good} strokeWidth={2.2} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
          {n === item.total ? `Respondiste ${n} preguntas` : `Respondiste ${n} de ${item.total} preguntas`}
        </Text>
      </View>
      {item.rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkMuted }}>{r.header || r.question}</Text>
          <Text selectable style={{ flexShrink: 1, textAlign: 'right', fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.ink }}>{r.answer}</Text>
        </View>
      ))}
    </FadeUp>
  );
}

/** Pestaña «Cambios»: lo que dejó cada turno, del más reciente al primero,
    para que el hilo de la conversación no cargue con las listas de archivos. */
function ChangesView({ changes, open, toggle }) {
  const c = useColors();
  if (changes.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
        <Icon name="edit" size={22} color={c.inkFaint} strokeWidth={1.6} />
        <Text style={{ textAlign: 'center', fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>Aún no hay cambios</Text>
        <Text style={{ textAlign: 'center', fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 19, color: c.inkMuted }}>
          Cuando el agente edite, cree o borre archivos, cada turno aparece aquí con su diff.
        </Text>
      </View>
    );
  }
  const files = new Set(changes.flatMap((x) => x.turn.files.map((f) => f.path))).size;
  const adds = changes.reduce((n, x) => n + x.turn.adds, 0);
  const dels = changes.reduce((n, x) => n + x.turn.dels, 0);
  return (
    <FlatList
      data={changes}
      keyExtractor={(x) => x.turn.key}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}
      ListHeaderComponent={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
            {`${files} ${files === 1 ? 'archivo' : 'archivos'} en esta sesión`}
          </Text>
          <LineCounts adds={adds} dels={dels} />
        </View>
      }
      renderItem={({ item }) => <ChangesCard turn={item.turn} title={splitMessage(item.prompt).text} open={open} toggle={toggle} />}
    />
  );
}

/** Lo que el turno dejó cambiado: cada archivo con sus líneas, desplegable a
    su diff, y si pasaron los tests y en qué commit quedó. */
function ChangesCard({ turn, title, open, toggle }) {
  const c = useColors();
  const { s } = useScale();
  return (
    <FadeUp style={{ marginVertical: s(6), borderRadius: RADIUS, backgroundColor: c.surface1, overflow: 'hidden' }}>
      <Text numberOfLines={2} style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2, fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 17, color: c.inkMuted }}>
        {title.trim() || 'Cambios del turno'}
      </Text>
      {turn.files.map((f) => {
        const key = `${turn.key}:${f.path}`;
        const isOpen = !!open[key];
        return (
          <View key={f.path}>
            <Pressable
              onPress={() => toggle(key)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.7 : 1 })}
            >
              <Icon name="edit" size={15} color={c.inkMuted} strokeWidth={1.7} />
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: FONTS.mono, fontSize: 12.5, color: c.inkBody }}>{f.path}</Text>
              <LineCounts adds={f.adds} dels={f.dels} />
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} color={c.inkFaint} strokeWidth={2} />
            </Pressable>
            {isOpen && f.edits.map((e) => <DiffView key={e.key} item={e} style={{ marginHorizontal: 12, marginBottom: 4, backgroundColor: c.bg }} />)}
          </View>
        );
      })}
      {(turn.tests || turn.commit) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingTop: 6 }}>
          {turn.tests && (
            <View style={{ height: 26, paddingHorizontal: 9, borderRadius: RADIUS_SM, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: turn.tests.ok ? c.goodSoft : c.dangerSoft }}>
              <Icon name={turn.tests.ok ? 'tick' : 'warning'} size={12} color={turn.tests.ok ? c.good : c.danger} strokeWidth={2.2} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: turn.tests.ok ? c.good : c.danger }}>{testsLabel(turn.tests)}</Text>
            </View>
          )}
          {!!turn.commit && (
            <View style={{ height: 26, paddingHorizontal: 9, borderRadius: RADIUS_SM, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.surface3 }}>
              <Icon name="git" size={12} color={c.inkBody} strokeWidth={2} />
              <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkBody }}>{turn.commit.slice(0, 7)}</Text>
            </View>
          )}
        </View>
      )}
      <View style={{ height: 12 }} />
    </FadeUp>
  );
}

function testsLabel({ ok, count }) {
  if (count === null) return ok ? 'Los tests pasan' : 'Los tests fallan';
  if (ok) return `${count} ${count === 1 ? 'test pasa' : 'tests pasan'}`;
  return `${count} ${count === 1 ? 'test falla' : 'tests fallan'}`;
}

function CompactedRow({ item, open, onToggle }) {
  const c = useColors();
  const label = item.before !== null && item.after !== null ? `Conversación compactada · ${item.before} % → ${item.after} %` : 'Conversación compactada';
  return (
    <FadeUp style={{ marginTop: 10, marginBottom: 6 }}>
      <Pressable
        onPress={item.summary ? onToggle : undefined}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={ROW_SLOP}
        style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: c.surface5 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="compress" size={13} color={c.inkMuted} strokeWidth={1.8} />
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{label}</Text>
        </View>
        <View style={{ flex: 1, height: 1, backgroundColor: c.surface5 }} />
      </Pressable>
      {open && !!item.summary && (
        <View style={{ marginTop: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, backgroundColor: c.surface1, gap: 4 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Resumen que conserva el agente</Text>
          <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 20, color: c.inkBody }}>{item.summary}</Text>
        </View>
      )}
    </FadeUp>
  );
}

const TASK_LABEL = { local_bash: 'comando', local_agent: 'subagente', remote_agent: 'agente remoto' };

const ago = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min`;
};

// El turno terminó pero el agente dejó algo corriendo y retomará solo cuando
// acabe: sin esto la sesión parecía parada.
function WaitingStrip({ tasks, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const now = useNow(true);
  return (
    <FadeUp style={{ marginHorizontal: 12, marginBottom: 8, padding: 12, borderRadius: RADIUS, backgroundColor: a.soft, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <LiveDot size={6} color={a.dot} />
        <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 13.5, color: a.ink }}>
          {tasks.length === 1 ? 'Esperando a una tarea en segundo plano' : `Esperando a ${tasks.length} tareas en segundo plano`}
        </Text>
      </View>
      {tasks.map((t) => (
        <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: a.ink }}>{TASK_LABEL[t.type] || 'tarea'}</Text>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.inkBody }}>{t.description || t.id}</Text>
          {!!t.since && <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkMuted }}>{ago(now - t.since)}</Text>}
        </View>
      ))}
    </FadeUp>
  );
}

const TONE_COLOR = { ok: 'good', wait: 'accent', warn: 'warn', bad: 'danger' };
const COMMAND_ROWS = 12;

// Resultado de un «/» del IDE (/status, /cost, /doctor…): allí es una tarjeta
// con controles, aquí llega resumido en filas o como texto de Claude Code.
function CommandCard({ item, agent, context }) {
  const c = useColors();
  const { s } = useScale();
  const a = agentStyle(agent, c);
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => {
    if (item.name !== 'status' || !context || item.rows.some((r) => /^contexto/i.test(r.label || ''))) return item.rows;
    const lv = contextLevels(context);
    const tone = context.pct >= lv.danger ? 'bad' : context.pct >= lv.warn ? 'warn' : 'ok';
    return [...item.rows, { label: 'Contexto', detail: `${context.pct} % usado · se compacta solo al ${lv.auto} %`, tone }];
  }, [item, context]);
  const rows = expanded ? all : all.slice(0, COMMAND_ROWS);
  return (
    <FadeUp style={{ marginVertical: s(9), borderRadius: RADIUS, backgroundColor: c.surface1, overflow: 'hidden' }}>
      <Text numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 10, fontFamily: FONTS.monoMedium, fontSize: 12.5, color: a.ink }}>
        /{item.name}
        {!!item.args && <Text style={{ fontFamily: FONTS.mono, color: c.inkMuted }}>{`  ${item.args}`}</Text>}
      </Text>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingTop: 8 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: c[TONE_COLOR[r.tone]] || c.inkFaint }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.ink }}>{r.label}</Text>
            {!!r.detail && <Text selectable style={{ fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.inkMuted }}>{r.detail}</Text>}
          </View>
        </View>
      ))}
      {all.length > COMMAND_ROWS && (
        <Pressable onPress={() => setExpanded((v) => !v)} style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.accent }}>{expanded ? 'Ver menos' : `Ver ${all.length - COMMAND_ROWS} más`}</Text>
        </Pressable>
      )}
      {!!item.text &&
        (item.diff ? (
          <DiffView item={{ diff: expanded ? item.text : item.text.split('\n').slice(0, 60).join('\n') }} style={{ marginHorizontal: 12, marginTop: 8, backgroundColor: c.bg }} />
        ) : (
          <Text selectable style={{ paddingHorizontal: 12, paddingTop: 8, fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody }}>{item.text}</Text>
        ))}
      {item.diff && all.length <= COMMAND_ROWS && item.text.split('\n').length > 60 && (
        <Pressable onPress={() => setExpanded((v) => !v)} style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.accent }}>{expanded ? 'Ver menos' : 'Ver el diff completo'}</Text>
        </Pressable>
      )}
      <View style={{ height: 12 }} />
    </FadeUp>
  );
}

function UserRow({ item, busy }) {
  const c = useColors();
  const { t, s } = useScale();
  const { files, text } = splitMessage(item.text);
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  const local = Array.isArray(item.localImages) ? item.localImages : [];
  const remoteIds = Array.isArray(item.imageIds) ? item.imageIds : [];
  // Lo que se mandó desde este móvil se ve con la foto local; lo demás, del gateway.
  const photos = local.length ? local.map((uri, i) => ({ uri, name: `imagen ${i + 1}` })) : remoteIds.map((id) => ({ id, name: id }));
  const extras = [
    ...files.map((f) => ({ icon: f.kind === 'image' ? 'image' : 'file', label: f.name })),
    // Sin ids (un host anterior) solo se sabe cuántas eran.
    ...(item.images > 0 && !photos.length ? [{ icon: 'image', label: item.images === 1 ? '1 imagen' : `${item.images} imágenes` }] : []),
    ...mentions.map((m) => ({ glyph: '@', label: typeof m === 'string' ? m : m.name })),
  ];
  return (
    <FadeUp style={{ alignItems: 'flex-end', marginVertical: s(9), opacity: item.local && !item.sent ? 0.6 : 1 }}>
      <View style={{ maxWidth: '84%', backgroundColor: c.surface3, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS }}>
        {photos.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, marginBottom: text || extras.length ? 8 : 0 }}>
            {photos.map((p, i) => (
              <ImageThumb key={p.id || p.uri || i} image={p} width={photos.length === 1 ? 168 : 92} height={photos.length === 1 ? 120 : 92} />
            ))}
          </View>
        )}
        {extras.length > 0 && (
          <View style={{ gap: 4, marginBottom: text ? 8 : 0 }}>
            {extras.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {x.glyph ? (
                  <Text style={{ width: 14, textAlign: 'center', fontFamily: FONTS.monoMedium, fontSize: 12.5, color: c.ink70 }}>@</Text>
                ) : (
                  <Icon name={x.icon} size={14} color={c.ink70} />
                )}
                <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: t(13), color: c.ink70 }}>
                  {x.label}
                </Text>
              </View>
            ))}
          </View>
        )}
        {!!text && (
          <Text selectable style={{ fontFamily: FONTS.ui, fontSize: t(15), lineHeight: t(22.5), color: c.ink }}>
            {text}
          </Text>
        )}
      </View>
      {item.origin === 'local' && <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkFaint, marginTop: 4 }}>Desde el equipo</Text>}
      {item.local && item.sent && busy && <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkFaint, marginTop: 4 }}>En cola · el agente lo verá al terminar</Text>}
    </FadeUp>
  );
}

// ── Encima del compositor ───────────────────────────────────────────────────

function ApprovalCard({ approval, onDecide }) {
  const c = useColors();
  const isCommand = approval.risk === 'command';
  const hasDiff = !!(approval.rows?.length || approval.diff);
  const btn = { flex: 1, height: 44, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center' };
  return (
    <FadeUp accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={isCommand ? 'console' : 'edit'} size={16} color={c.accent} strokeWidth={1.7} />
        <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{isCommand ? '¿Ejecutar este comando?' : '¿Aplicar este cambio?'}</Text>
        {hasDiff && <LineCounts adds={approval.adds} dels={approval.dels} />}
      </View>
      {hasDiff ? (
        <View style={{ borderRadius: RADIUS_SM, backgroundColor: c.bg, overflow: 'hidden' }}>
          <Text numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 9, paddingBottom: 4, fontFamily: FONTS.mono, fontSize: 12, color: c.inkBody }}>
            {approval.path || approval.summary || approval.tool}
          </Text>
          <DiffView item={approval} maxHeight={196} style={{ paddingTop: 4, paddingBottom: 8 }} />
        </View>
      ) : (
        <Text selectable style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS_SM, backgroundColor: c.bg, fontFamily: FONTS.mono, fontSize: 13, color: c.ink }}>
          {isCommand ? `$ ${approval.summary || approval.tool}` : approval.summary || approval.tool}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={() => onDecide(approval.id, 'deny')} accessibilityRole="button" style={({ pressed }) => [btn, { backgroundColor: c.raised, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.onRaised }}>Rechazar</Text>
        </Pressable>
        <Pressable onPress={() => onDecide(approval.id, 'allow')} accessibilityRole="button" style={({ pressed }) => [btn, { backgroundColor: c.primary, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.onPrimary }}>Permitir</Text>
        </Pressable>
      </View>
    </FadeUp>
  );
}

/** Pregunta del agente: opciones con su descripción o una respuesta propia
    escrita en el compositor. */
function QuestionCard({ choice, agent, onChoose }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  return (
    <FadeUp accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="message" size={14} color={a.ink} strokeWidth={1.7} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: a.ink }}>{`${a.label} pregunta`}</Text>
      </View>
      <Text selectable style={{ fontFamily: FONTS.uiMedium, fontSize: 15, lineHeight: 21, color: c.ink }}>{choice.title}</Text>
      {!!choice.body && <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkBody }}>{choice.body}</Text>}
      {choice.options.length > 0 && (
        <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
          {choice.options.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => onChoose(choice.id, o.value)}
              accessibilityRole="button"
              style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: 12, paddingVertical: 9, borderRadius: RADIUS_SM, backgroundColor: pressed ? c.surface3 : c.bg, flexDirection: 'row', alignItems: 'center', gap: 10 })}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flexShrink: 1, fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{o.label || o.value}</Text>
                  {!!o.badge && <Text style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: a.ink }}>{o.badge}</Text>}
                </View>
                {!!o.description && <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 17, color: c.inkMuted }}>{o.description}</Text>}
              </View>
              <Icon name="chevron-right" size={13} color={c.inkFaint} strokeWidth={2} />
            </Pressable>
          ))}
        </ScrollView>
      )}
      {choice.free && <Text style={{ textAlign: 'center', fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{choice.options.length ? 'O escribe otra respuesta abajo' : 'Escribe tu respuesta abajo'}</Text>}
    </FadeUp>
  );
}

// Selector abierto en el host por un comando (/model, /branch, confirmar un
// commit…): sigue abierto también allí y vale la primera respuesta.
function ChoiceCard({ choice, onChoose }) {
  const c = useColors();
  return (
    <FadeUp accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="layers" size={16} color={c.accent} />
        <Text numberOfLines={2} style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{choice.title}</Text>
      </View>
      {!!choice.body && (
        <Text selectable numberOfLines={8} style={{ fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody }}>{choice.body}</Text>
      )}
      <ScrollView style={{ maxHeight: 280 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {choice.options.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => onChoose(choice.id, o.value)}
            style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6, borderRadius: RADIUS_SM, backgroundColor: pressed ? c.surface3 : c.bg })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{o.label || o.value}</Text>
              {!!o.badge && <Text style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: c.accent }}>{o.badge}</Text>}
            </View>
            {!!o.description && <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 17, color: c.inkMuted, marginTop: 2 }}>{o.description}</Text>}
          </Pressable>
        ))}
      </ScrollView>
      <Pressable onPress={() => onChoose(choice.id, '')} style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>Cancelar</Text>
      </Pressable>
    </FadeUp>
  );
}

function Spinner({ size = 15 }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin, reduced]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 20 20">
        <Circle cx="10" cy="10" r="7.5" fill="none" strokeWidth="2.2" stroke={c.surface5} />
        <Circle cx="10" cy="10" r="7.5" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="12 47.1" stroke={c.accent} />
      </Svg>
    </Animated.View>
  );
}

const COMPACT_STEP = (pct, messages) => (pct < 35 ? (messages ? `Leyendo ${messages} mensajes` : 'Leyendo la conversación') : pct < 75 ? 'Resumiendo la conversación' : 'Guardando el resumen');

/** Avance del compact: fase, porcentaje y cuánto contexto quedará. Con un
    host que no da avance (Claude Code) la barra es indeterminada. */
function CompactCard({ compact }) {
  const c = useColors();
  const pct = compact?.pct ?? null;
  const reduced = useReducedMotion();
  const fill = useRef(new Animated.Value(pct ?? 0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (pct === null) return undefined;
    Animated.timing(fill, { toValue: pct, duration: reduced ? 0 : 600, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: false }).start();
    return undefined;
  }, [pct, fill, reduced]);
  useEffect(() => {
    if (pct !== null || reduced) return undefined;
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [pct, sweep, reduced]);
  const width = pct === null ? '30%' : fill.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  const left = pct === null ? sweep.interpolate({ inputRange: [0, 1], outputRange: ['-30%', '100%'] }) : 0;
  return (
    <FadeUp accessibilityRole="progressbar" accessibilityLabel="Compactando la conversación" style={{ marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Spinner />
        <View style={{ flex: 1 }}>
          <ShimmerText text="Compactando la conversación" style={{ fontFamily: FONTS.uiMedium, fontSize: 14 }} />
        </View>
        {pct !== null && <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{`${pct} %`}</Text>}
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface4, overflow: 'hidden' }}>
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left, width, borderRadius: 2, backgroundColor: c.accent }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{pct === null ? 'Resumiendo la conversación' : COMPACT_STEP(pct, compact?.messages)}</Text>
        {compact?.before != null && (
          <Text style={{ fontFamily: FONTS.mono, fontSize: 12.5, color: c.inkMuted }}>{`${compact.before} %${compact.estimate != null ? ` → ~${compact.estimate} %` : ''}`}</Text>
        )}
      </View>
    </FadeUp>
  );
}

function ringColor(ctx, c) {
  const lv = contextLevels(ctx);
  return ctx.pct >= lv.danger ? c.danger : ctx.pct >= lv.warn ? c.warn : c.inkMuted;
}

function ContextRing({ context, compacting, onPress }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!compacting || reduced) {
      spin.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [compacting, spin, reduced]);
  const color = ringColor(context, c);
  const dash = compacting ? `${(RING * 0.25).toFixed(1)} ${RING.toFixed(1)}` : `${((RING * Math.min(100, context.pct)) / 100).toFixed(1)} ${RING.toFixed(1)}`;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Contexto ${context.pct} % usado. Ver detalle`}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={({ pressed }) => ({ width: 36, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
    >
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Svg width={22} height={22} viewBox="0 0 20 20">
          <Circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.2" stroke={c.surface5} />
          <Circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.2" strokeLinecap="round" stroke={color} strokeDasharray={dash} rotation={-90} origin="10, 10" />
        </Svg>
      </Animated.View>
    </Pressable>
  );
}

// Capa sobre toda la sesión con velo: un toque fuera la cierra.
function Overlay({ children, onClose, label, center = false }) {
  const c = useColors();
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, elevation: 20, justifyContent: center ? 'center' : undefined, paddingHorizontal: center ? 16 : 0 }}>
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={label} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim }} />
      {children}
    </View>
  );
}

function ContextPopover({ context, compacted, bottom, busy, compacting, canCompact, onCompact, onClose }) {
  const c = useColors();
  const lv = contextLevels(context);
  const size = context.window || 1;
  const files = Math.min(context.files || 0, context.tokens || 0);
  const parts = [
    { label: compacted ? 'Resumen compactado' : 'Conversación', tokens: Math.max(0, (context.tokens || 0) - files), color: c.ink70 },
    ...(files > 0 ? [{ label: 'Archivos leídos', tokens: files, color: c.inkMuted }] : []),
    ...(context.system > 0 ? [{ label: 'Instrucciones y herramientas · fijo', tokens: context.system, color: c.inkFaint }] : []),
  ].map((p) => ({ ...p, pct: Math.max(p.tokens > 0 ? 1 : 0, Math.round((p.tokens * 100) / size)) }));
  const warn = context.pct >= lv.warn;
  const color = ringColor(context, c);
  const disabled = busy || compacting;
  return (
    <Overlay onClose={onClose} label="Cerrar contexto">
      <FadeUp distance={6} accessibilityViewIsModal style={{ position: 'absolute', right: 12, bottom, width: 300, maxWidth: '92%', padding: 16, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Svg width={44} height={44} viewBox="0 0 44 44">
            <Circle cx="22" cy="22" r="18" fill="none" strokeWidth="4" stroke={c.surface4} />
            <Circle cx="22" cy="22" r="18" fill="none" strokeWidth="4" strokeLinecap="round" stroke={color} strokeDasharray={`${((BIG_RING * Math.min(100, context.pct)) / 100).toFixed(1)} ${BIG_RING.toFixed(1)}`} rotation={-90} origin="22, 22" />
          </Svg>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Contexto de la sesión</Text>
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 22, letterSpacing: -0.4, color: c.ink }}>{`${context.pct} % usado`}</Text>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surface4, overflow: 'hidden', flexDirection: 'row', gap: 2 }}>
            {parts.map((p, i) => (
              <View key={p.label} style={{ width: `${p.pct}%`, height: 6 }}>
                <GrowBar ratio={1} color={p.color} delay={i * 60} style={{ height: 6 }} />
              </View>
            ))}
          </View>
          {parts.map((p) => (
            <View key={p.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.color }} />
              <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.inkBody }}>{p.label}</Text>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{`${p.pct} %`}</Text>
            </View>
          ))}
          {context.tokens != null && context.window != null && (
            <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkFaint }}>{`${fmtTokens(context.tokens)} de ${fmtTokens(context.window)} tokens`}</Text>
          )}
        </View>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 18, color: warn ? c.warn : c.inkMuted }}>
          {warn ? `Queda poco espacio. Al ${lv.auto} % se compacta solo; compactar ahora resume la conversación sin perder el hilo.` : `Al ${lv.auto} % se compacta solo.`}
        </Text>
        {canCompact && (
          <Pressable
            onPress={disabled ? undefined : onCompact}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            style={({ pressed }) => ({ height: 44, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: disabled ? c.surface4 : c.primary, transform: [{ scale: pressed && !disabled ? 0.98 : 1 }] })}
          >
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: disabled ? c.inkMuted : c.onPrimary }}>
              {compacting ? 'Compactando…' : busy ? 'Disponible al terminar el turno' : 'Compactar ahora'}
            </Text>
          </Pressable>
        )}
      </FadeUp>
    </Overlay>
  );
}

function QuotaModal({ usage, onClose, onDaily }) {
  const c = useColors();
  const api = useApi();
  const plan = usage?.plan && typeof usage.plan === 'object' ? usage.plan : null;
  const buckets = usage?.buckets && typeof usage.buckets === 'object' ? usage.buckets : null;
  return (
    <Overlay onClose={onClose} label="Cerrar uso" center>
      <FadeUp distance={6} accessibilityViewIsModal style={{ width: '100%', paddingTop: 18, paddingHorizontal: 16, paddingBottom: 10, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: FONTS.serif, fontSize: 24, lineHeight: 28, color: c.ink }}>Uso y límites</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar" style={{ width: 44, height: 44, margin: -8, marginLeft: 0, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={18} color={c.inkMuted} strokeWidth={1.8} />
          </Pressable>
        </View>
        {!usage && <SkeletonLines widths={['50%', '100%', '40%']} />}
        {plan && (
          <View style={{ padding: 12, borderRadius: RADIUS, backgroundColor: c.surface3, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>Plan {String(plan.name || plan.id || '')}</Text>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>El mismo cupo en web, IDE y móvil</Text>
            </View>
            <Pressable
              onPress={() => Linking.openURL(`${api.base}/plans`)}
              accessibilityRole="link"
              style={({ pressed }) => ({ height: 36, paddingHorizontal: 12, borderRadius: RADIUS_SM, justifyContent: 'center', backgroundColor: pressed ? c.surface5 : c.raised })}
            >
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.onRaised }}>Mejorar</Text>
            </Pressable>
          </View>
        )}
        {buckets && (
          <>
            <Quota label="Sesión actual" bucket={buckets.session} accent />
            <Quota label="Esta semana" bucket={buckets.week} delay={100} />
          </>
        )}
        <Pressable onPress={onDaily} accessibilityRole="button" style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>Ver uso por día</Text>
          <Icon name="chevron-right" size={13} color={c.inkMuted} strokeWidth={2} />
        </Pressable>
      </FadeUp>
    </Overlay>
  );
}

/// Hoja de comandos: accesos grandes (adjuntar, archivo, estado, uso,
/// terminar…) y los comandos "/" del host con un filtro.
function CommandsSheet({ agent, commands, tiles, onPick }) {
  const c = useColors();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.replace(/^\//, '').toLowerCase();
    return commands.filter((x) => !needle || x.name.toLowerCase().includes(needle) || String(x.description || '').toLowerCase().includes(needle)).slice(0, 80);
  }, [commands, q]);
  const groupLabel = (g) => GROUP_LABEL[g] || g || agentStyle(agent, c).label;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {tiles.map((tile) => (
          <Pressable
            key={tile.value}
            onPress={() => onPick(tile.value)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexGrow: 1,
              flexBasis: '30%',
              height: 72,
              borderRadius: RADIUS,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: tile.danger ? c.dangerSoft : pressed ? c.surface4 : c.surface3,
              opacity: pressed && tile.danger ? 0.85 : 1,
            })}
          >
            {tile.glyph ? (
              <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 18, lineHeight: 20, color: c.inkBody }}>{tile.glyph}</Text>
            ) : (
              <Icon name={tile.icon} size={20} color={tile.danger ? c.danger : c.inkBody} strokeWidth={1.7} />
            )}
            <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: tile.danger ? c.danger : c.inkBody }}>{tile.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ height: 44, paddingHorizontal: 12, borderRadius: RADIUS, backgroundColor: c.surface4, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ fontFamily: FONTS.mono, fontSize: 14, color: c.inkMuted }}>/</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Filtrar comandos"
          placeholderTextColor={c.inkMuted}
          selectionColor={c.accent}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Filtrar comandos"
          style={{ flex: 1, paddingVertical: 0, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}
        />
      </View>
      <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
        {list.map((cmd, i) => (
          <View key={`${cmd.group || ''}${cmd.name}`}>
            {(i === 0 || cmd.group !== list[i - 1]?.group) && (
              <Text style={{ paddingHorizontal: 12, paddingTop: i ? 10 : 0, paddingBottom: 4, fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.inkMuted }}>
                {groupLabel(cmd.group)}
              </Text>
            )}
            <Pressable
              onPress={() => onPick(`cmd:${cmd.name}`)}
              accessibilityRole="button"
              style={({ pressed }) => ({ minHeight: 52, paddingVertical: 6, paddingHorizontal: 12, borderRadius: RADIUS, justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
            >
              <Text style={{ fontFamily: FONTS.mono, fontSize: 14, color: c.ink }}>
                /{cmd.name}
                {cmd.args ? <Text style={{ color: c.inkMuted }}> {cmd.args}</Text> : null}
              </Text>
              {!!cmd.description && (
                <Text numberOfLines={2} style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                  {cmd.description}
                </Text>
              )}
            </Pressable>
          </View>
        ))}
        {list.length === 0 && <Text style={{ padding: 12, fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>Ningún comando coincide</Text>}
      </ScrollView>
    </View>
  );
}

function RemoteComposer({
  input,
  inputRef,
  onChangeInput,
  onSend,
  onInterrupt,
  onCommands,
  onRunCommand,
  commands,
  thinking,
  answering,
  disabled,
  sending,
  attachments,
  mentions,
  onRemoveMention,
  mentionQuery,
  files,
  onPickMention,
  context,
  compacting,
  onContext,
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const hasContent = !!input.trim() || attachments.ready.length > 0;
  const canSend = hasContent && !disabled && !sending && !attachments.reading;
  // Los hosts encolan lo que llega mientras el agente trabaja: con algo escrito
  // se envía; con la caja vacía, el botón interrumpe.
  const showStop = thinking && !hasContent;

  // Las sugerencias "/" aparecen mientras se escribe el nombre (antes del
  // primer espacio): a partir de ahí lo que se teclea es el argumento.
  const slashQuery = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) return null;
    return input.slice(1).toLowerCase();
  }, [input]);
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((cmd) => cmd.name.toLowerCase().startsWith(slashQuery)).slice(0, 40)),
    [slashQuery, commands],
  );

  const mentionResults = useMemo(() => {
    if (mentionQuery === null || !files || files.query !== mentionQuery) return null;
    return files.items.filter((f) => !mentions.some((m) => m.path === f.path));
  }, [mentionQuery, files, mentions]);

  const hasTray = attachments.items.length > 0 || mentions.length > 0;
  const placeholder = disabled ? 'Host sin conexión…' : answering ? 'Responde con tus palabras…' : 'Pídele algo al agente…';

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: keyboardOpen ? 8 : Math.max(insets.bottom, 14) }}>
      {slashMatches.length > 0 && (
        <SuggestionBox>
          {slashMatches.map((cmd) => (
            <SuggestionRow key={`${cmd.group || ''}${cmd.name}`} onPress={() => (cmd.args ? onChangeInput(`/${cmd.name} `) : onRunCommand(`/${cmd.name}`))}>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 13.5, color: c.ink }}>/{cmd.name}</Text>
              <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
                {cmd.description}
              </Text>
            </SuggestionRow>
          ))}
        </SuggestionBox>
      )}

      {mentionQuery !== null && (
        <SuggestionBox>
          {mentionResults === null ? (
            <SkeletonLines widths={['60%', '45%']} style={{ padding: 12 }} />
          ) : mentionResults.length === 0 ? (
            <Text style={{ padding: 12, fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>Ningún archivo coincide</Text>
          ) : (
            mentionResults.map((f) => (
              <SuggestionRow key={f.path} onPress={() => onPickMention(f)}>
                <Icon name="file" size={14} color={c.inkSoft} />
                <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.ink }}>
                  {f.name}
                </Text>
                <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkMuted }}>
                  {f.rel}
                </Text>
              </SuggestionRow>
            ))
          )}
        </SuggestionBox>
      )}

      <View style={{ padding: 6, borderRadius: RADIUS, backgroundColor: c.surface2 }}>
        {hasTray && (
          <View style={{ paddingHorizontal: 4, paddingTop: 4 }}>
            <AttachmentTray
              items={attachments.items}
              onRemove={attachments.remove}
              extra={mentions.length ? mentions.map((m) => <MentionChip key={m.path} mention={m} onRemove={() => onRemoveMention(m.path)} />) : null}
            />
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
          <Pressable
            onPress={onCommands}
            accessibilityRole="button"
            accessibilityLabel="Adjuntar, comandos y más"
            hitSlop={{ top: 4, bottom: 4, left: 2 }}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
          >
            {/* Un +: el botón abre adjuntar, archivo, estado y uso además de
                los comandos, que se siguen escribiendo con «/». */}
            <Icon name="plus" size={20} color={c.ink70} strokeWidth={1.8} />
          </Pressable>
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={onChangeInput}
            placeholder={placeholder}
            placeholderTextColor={c.inkMuted}
            selectionColor={c.accent}
            accessibilityLabel="Mensaje para el agente"
            multiline
            style={{ flex: 1, minHeight: 40, maxHeight: 140, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 10, fontFamily: FONTS.ui, fontSize: 15, lineHeight: 20, color: c.ink }}
          />
          {context && <ContextRing context={context} compacting={compacting} onPress={onContext} />}
          <Pressable
            onPress={showStop ? onInterrupt : onSend}
            disabled={showStop ? disabled : !canSend}
            accessibilityRole="button"
            accessibilityLabel={showStop ? 'Interrumpir al agente' : 'Enviar'}
            hitSlop={{ top: 4, bottom: 4, right: 2 }}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: RADIUS_SM,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: showStop ? c.raised : canSend ? c.accent : c.surface4,
              transform: [{ scale: pressed ? 0.94 : 1 }],
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : showStop ? (
              <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: c.onRaised }} />
            ) : (
              <Icon name="arrow-up" size={18} color={canSend ? c.onAccent : c.inkFaint} strokeWidth={1.8} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SuggestionBox({ children }) {
  const c = useColors();
  return (
    <FadeUp distance={6} style={{ marginBottom: 8, borderRadius: RADIUS, backgroundColor: c.sheet, overflow: 'hidden', maxHeight: 260 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 4 }}>
        {children}
      </ScrollView>
    </FadeUp>
  );
}

function SuggestionRow({ children, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, backgroundColor: pressed ? c.surface4 : 'transparent' })}
    >
      {children}
    </Pressable>
  );
}

