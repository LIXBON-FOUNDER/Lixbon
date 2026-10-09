// RemoteScreen.js — sección Remoto: sesiones /remote del IDE o del CLI, sea
// cual sea su agente (Lixbon o Claude Code). Sin sesión abierta muestra la
// lista; con una, el transcript a pantalla completa con las herramientas en
// filas cortas, los permisos encima del compositor y los comandos "/" en una
// hoja. Todo se ejecuta en la máquina host; esto es un mando.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { composeMessage, splitMessage } from '../attachments';
import { AttachmentTray, MentionChip, useAttachments } from '../components/Attachments';
import Icon from '../components/Icon';
import RemoteSessionList, { LiveDot } from '../components/RemoteSessionList';
import ShimmerText from '../components/ShimmerText';
import { useDialogs } from '../components/dialogs';
import { markdownRules, markdownStyles } from '../components/markdown';
import { AgentMark, ChatHeader, FadeUp, IconButton, KeyboardAware, Segmented, SkeletonLines, agentStyle, useColors, useKeyboardOpen, useScale } from '../components/ui';
import { initialRemoteState, keepStreamAlive, openEventStream, remoteReducer } from '../remote';
import { openRemoteSocket } from '../remoteSocket';
import { agentOf } from '../remoteSessions';
import { useApi, useAuth } from '../state';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';
import { describeRemoteTool, toolParts } from '../toolText';
import RemoteOrch from './RemoteOrch';

const GROUP_LABEL = { lixbon: 'Lixbon', claude: 'Claude Code', skill: 'Skills' };
const MENTION_AT_END = /(^|\s)@([^\s@]*)$/;
const TOOL_ICON = { Ejecuta: 'terminal', Ejecutó: 'terminal', Edita: 'pencil', Editó: 'pencil', Lee: 'file', Leyó: 'file', Busca: 'search', Buscó: 'search', Consulta: 'globe', Consultó: 'globe' };

// Catálogo de reserva: si el host es de una versión anterior a que el `hello`
// publicara sus comandos, la hoja sigue ofreciendo lo básico en vez de nada.
const FALLBACK_COMMANDS = [
  { name: 'help', args: '', description: 'Ver los comandos disponibles' },
  { name: 'new', args: '', description: 'Empezar una conversación nueva' },
  { name: 'status', args: '', description: 'Estado de la sesión y del host' },
];

export default function RemoteScreen({ remote, session, onOpen, onClose, onMenu, initialToken = null }) {
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
  if (session) return <RemoteSessionView key={session.id} session={session} onBack={onClose} />;
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

function RemoteSessionView({ session, onBack }) {
  const c = useColors();
  const api = useApi();
  const auth = useAuth();
  const { confirm, sheet, toast } = useDialogs();
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const [input, setInput] = useState('');
  const [mentions, setMentions] = useState([]);
  const [sending, setSending] = useState(false);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  const inputRef = useRef(null);
  const socketRef = useRef(null);
  // WebSocket por defecto; SSE + POST solo si el gateway aún no lo ofrece.
  const [transport, setTransport] = useState('ws');
  const [link, setLink] = useState('connecting');

  const caps = state.meta?.capabilities || [];
  const attachments = useAttachments({ describeImages: false, allowImages: caps.includes('images') });

  const onRemoteEvent = useCallback((ev) => {
    if (typeof ev.seq === 'number' && ev.type !== 'channel_status') seqRef.current = Math.max(seqRef.current, ev.seq);
    dispatch(ev);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (transport !== 'ws') return undefined;
    const socket = openRemoteSocket({
      base: api.base,
      token: auth.apiKey,
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
        token: auth.apiKey,
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

  const sendPrompt = async (override) => {
    const text = (override ?? input).trim();
    const ready = override ? [] : attachments.ready;
    if ((!text && ready.length === 0) || sending || attachments.reading) return;
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
      dispatch({ type: 'local_user', local, text: command.text, images: ready.filter((a) => a.kind === 'image').length, mentions: command.mentions || [] });
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
  const thinking = state.agentState === 'thinking';

  // Comandos y acciones en una sola hoja: accesos grandes arriba y la lista de
  // comandos del host, filtrable, debajo.
  const openCommands = async () => {
    const action = await sheet({
      keyboard: true,
      render: (close) => (
        <CommandsSheet
          commands={commands}
          tiles={[
            { value: 'attach', icon: 'clip', label: 'Adjuntar' },
            ...(canMention ? [{ value: 'mention', glyph: '@', label: 'Archivo' }] : []),
            ...(thinking ? [{ value: 'interrupt', icon: 'stop', label: 'Interrumpir' }] : []),
            ...(commands.some((x) => x.name === 'status') ? [{ value: 'cmd:status', icon: 'activity', label: 'Estado' }] : []),
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
    if (action === 'end') endSession();
    if (action.startsWith?.('cmd:')) {
      const cmd = commands.find((x) => x.name === action.slice(4)) || { name: action.slice(4) };
      // Igual que en el IDE: sin argumento se envía de una; con argumento se
      // deja el nombre escrito para completarlo.
      if (cmd.args) {
        setInput(`/${cmd.name} `);
        setTimeout(() => inputRef.current?.focus(), 50);
      } else {
        sendPrompt(`/${cmd.name}`);
      }
    }
  };

  const items = useMemo(() => groupItems(state.items).reverse(), [state.items]);
  const [tab, setTab] = useState('chat');
  const canOrch = !state.ended && caps.includes('orch');
  const orchBusy = !!state.orch?.tasks?.some((x) => !['done', 'failed', 'stopped', 'exited'].includes(x.status));
  const waitingTool = state.approvals[0]?.tool;

  return (
    <KeyboardAware>
      <SessionHeader session={session} state={state} link={link} agent={agent} onBack={onBack} onOptions={state.ended ? null : openCommands} />

      {canOrch && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          <Segmented
            stretch
            value={tab}
            onChange={setTab}
            bg={c.surface2}
            options={[
              { value: 'chat', label: 'Conversación' },
              { value: 'orch', label: 'Orquestar', dot: orchBusy && tab !== 'orch' },
            ]}
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
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item, index }) => <TranscriptRow item={item} agent={agent} busy={thinking} waitingTool={index === 0 ? waitingTool : null} />}
            extraData={thinking}
          />
        )}
      </View>

      {state.activity === 'compacting' && thinking && !state.ended && (
        <View accessibilityRole="progressbar" style={{ paddingHorizontal: 20, paddingVertical: 6 }}>
          <ShimmerText text="Compactando la conversación…" style={{ fontFamily: FONTS.ui, fontSize: 14 }} />
        </View>
      )}

      {!state.ended && !thinking && state.background.length > 0 && <WaitingStrip tasks={state.background} agent={agent} />}

      {state.approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} onDecide={approve} />
      ))}

      {!state.ended && (
        <RemoteComposer
          input={input}
          inputRef={inputRef}
          onChangeInput={setInput}
          onSend={() => sendPrompt()}
          onInterrupt={interrupt}
          onCommands={openCommands}
          onRunCommand={(text) => sendPrompt(text)}
          commands={commands}
          thinking={thinking}
          disabled={!state.hostConnected}
          sending={sending}
          attachments={attachments}
          mentions={mentions}
          onRemoveMention={(path) => setMentions((cur) => cur.filter((m) => m.path !== path))}
          mentionQuery={canMention ? mentionQuery : null}
          files={state.files}
          onPickMention={pickMention}
        />
      )}
    </KeyboardAware>
  );
}

function SessionHeader({ session, state, link, agent, onBack, onOptions }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const a = agentStyle(agent, c);
  const meta = state.meta || {};
  const working = state.agentState === 'thinking';
  const waiting = !working && state.background.length > 0;
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
        : `${a.label} · ${working ? 'trabajando' : waiting ? 'esperando' : 'en vivo'}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: insets.top + 8, height: insets.top + 64 }}>
      <IconButton onPress={onBack} label="Volver a las sesiones">
        <Icon name="arrow-left" size={20} color={c.inkBody} />
      </IconButton>
      <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
        <Text numberOfLines={1} style={{ maxWidth: '100%', fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>
          {meta.title || session.title || 'Sesión remota'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {!state.ended && !slow && state.hostConnected && (working || waiting ? <LiveDot size={6} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} />)}
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
            {status}
          </Text>
        </View>
      </View>
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
        {`Conectado con ${a.label}. Pídele algo o toca los tres puntos para ver sus comandos.`}
      </Text>
    </FadeUp>
  );
}

function TranscriptRow({ item, agent, waitingTool, busy }) {
  const c = useColors();
  const { t, s } = useScale();
  const { toast } = useDialogs();
  const mdStyles = useMemo(() => markdownStyles(c, t), [c, t]);
  const mdRules = useMemo(() => markdownRules(c, t, () => toast('Código copiado', { icon: 'check' })), [c, t, toast]);
  if (item.kind === 'user') return <UserRow item={item} busy={busy} />;
  if (item.kind === 'tools') return <ToolCard items={item.items} waitingTool={waitingTool} />;
  if (item.kind === 'command') return <CommandCard item={item} agent={agent} />;
  if (item.kind === 'notice') {
    // Respuesta del host a un comando: monoespaciada, para que se lea como
    // salida del equipo y no como algo que dijo el modelo.
    return (
      <FadeUp style={{ marginVertical: s(9) }}>
        <Text selectable style={{ padding: 12, borderRadius: RADIUS, backgroundColor: c.surface1, fontFamily: FONTS.mono, fontSize: 12.5, lineHeight: 19, color: c.inkBody }}>
          {item.text}
        </Text>
      </FadeUp>
    );
  }
  if (item.kind === 'error') {
    return (
      <View style={{ marginVertical: s(9), padding: 12, borderRadius: RADIUS, backgroundColor: c.dangerSoft }}>
        <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.danger }}>
          {item.text}
        </Text>
      </View>
    );
  }
  return (
    <FadeUp style={{ marginVertical: s(9) }}>
      {item.text ? (
        <Markdown style={mdStyles} rules={mdRules}>
          {item.text}
        </Markdown>
      ) : item.open ? (
        <ShimmerText text={`${agentStyle(agent, c).label} está pensando…`} style={{ fontFamily: FONTS.uiMedium, fontSize: 15 }} />
      ) : null}
    </FadeUp>
  );
}

const TASK_LABEL = { local_bash: 'comando', local_agent: 'subagente', remote_agent: 'agente remoto' };

const elapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min`;
};

// El turno terminó pero el agente dejó algo corriendo y retomará solo cuando
// acabe: sin esto la sesión parecía parada.
function WaitingStrip({ tasks, agent }) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
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
          {!!t.since && <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkMuted }}>{elapsed(now - t.since)}</Text>}
        </View>
      ))}
    </FadeUp>
  );
}

const TONE_COLOR = { ok: 'good', wait: 'accent', warn: 'accentDeep', bad: 'danger' };
const COMMAND_ROWS = 12;

// Resultado de un «/» del IDE (/status, /cost, /doctor…): allí es una tarjeta
// con controles, aquí llega resumido en filas o como texto de Claude Code.
function CommandCard({ item, agent }) {
  const c = useColors();
  const { s } = useScale();
  const a = agentStyle(agent, c);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? item.rows : item.rows.slice(0, COMMAND_ROWS);
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
      {item.rows.length > COMMAND_ROWS && (
        <Pressable onPress={() => setExpanded((v) => !v)} style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.accent }}>{expanded ? 'Ver menos' : `Ver ${item.rows.length - COMMAND_ROWS} más`}</Text>
        </Pressable>
      )}
      {!!item.text && (
        <Text selectable style={{ paddingHorizontal: 12, paddingTop: 8, fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody }}>{item.text}</Text>
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
  const extras = [
    ...files.map((f) => ({ icon: f.kind === 'image' ? 'image' : 'file', label: f.name })),
    ...(item.images > 0 ? [{ icon: 'image', label: item.images === 1 ? '1 imagen' : `${item.images} imágenes` }] : []),
    ...mentions.map((m) => ({ glyph: '@', label: typeof m === 'string' ? m : m.name })),
  ];
  return (
    <FadeUp style={{ alignItems: 'flex-end', marginVertical: s(9), opacity: item.local && !item.sent ? 0.6 : 1 }}>
      <View style={{ maxWidth: '84%', backgroundColor: c.surface3, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS }}>
        {extras.length > 0 && (
          <View style={{ gap: 4, marginBottom: text ? 8 : 0 }}>
            {extras.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {x.glyph ? (
                  <Text style={{ width: 14, textAlign: 'center', fontFamily: FONTS.monoMedium, fontSize: 12.5, color: c.inkSoft }}>@</Text>
                ) : (
                  <Icon name={x.icon} size={14} color={c.inkSoft} />
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

/** Agrupa las herramientas consecutivas en una sola tarjeta. */
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

function ToolLine({ it, waitingTool, trailing, onPress }) {
  const c = useColors();
  const waiting = it.running && waitingTool && it.tool === waitingTool;
  const { verb, target, mono } = toolParts(it, waiting);
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={describeRemoteTool(it)}
      style={({ pressed }) => ({ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed && onPress ? 0.7 : 1 })}
    >
      <Icon name={it.error ? 'warning' : TOOL_ICON[verb] || 'layers'} size={15} color={it.error ? c.danger : c.inkMuted} />
      {it.running ? (
        <View style={{ width: 56 }}>
          <ShimmerText text={verb} style={{ fontFamily: FONTS.ui, fontSize: 13.5 }} />
        </View>
      ) : (
        <Text style={{ width: 56, fontFamily: FONTS.ui, fontSize: 13.5, color: it.error ? c.danger : c.inkMuted }}>{verb}</Text>
      )}
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: mono ? FONTS.mono : FONTS.ui, fontSize: mono ? 12.5 : 13.5, color: c.inkBody }}>
        {target}
      </Text>
      {trailing}
    </Pressable>
  );
}

/** Las herramientas de un tramo en una sola línea que va cambiando a la que
    corre ahora; al tocarla se despliega el historial con la salida de cada una. */
function ToolCard({ items, waitingTool }) {
  const c = useColors();
  const { s } = useScale();
  const [expanded, setExpanded] = useState(false);
  const [shown, setShown] = useState(null);
  const last = items[items.length - 1];
  const toggle = () => setExpanded((v) => !v);

  if (!expanded) {
    return (
      <View style={{ marginVertical: s(4) }}>
        <FadeUp key={last.key} distance={4}>
          <ToolLine
            it={last}
            waitingTool={waitingTool}
            onPress={toggle}
            trailing={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {items.length > 1 && <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkFaint }}>{items.length}</Text>}
                <Icon name="chevron-right" size={13} color={c.inkFaint} />
              </View>
            }
          />
        </FadeUp>
      </View>
    );
  }

  return (
    <FadeUp style={{ marginVertical: s(4) }}>
      {items.map((it) => {
        const open = shown === it.key;
        return (
          <View key={it.key}>
            <ToolLine
              it={it}
              waitingTool={waitingTool}
              onPress={it.result ? () => setShown(open ? null : it.key) : undefined}
              trailing={!!it.result && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} color={c.inkFaint} />}
            />
            {open && (
              <Text selectable style={{ marginBottom: 6, padding: 10, borderRadius: RADIUS_SM, backgroundColor: c.surface1, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.inkBody }}>
                {it.result}
              </Text>
            )}
          </View>
        );
      })}
      <Pressable onPress={toggle} style={{ height: 30, justifyContent: 'center' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Contraer</Text>
      </Pressable>
    </FadeUp>
  );
}

function ApprovalCard({ approval, onDecide }) {
  const c = useColors();
  const isCommand = approval.risk === 'command';
  const btn = { flex: 1, height: 44, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center' };
  return (
    <FadeUp accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={isCommand ? 'terminal' : 'pencil'} size={16} color={c.accent} />
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{isCommand ? '¿Ejecutar este comando?' : '¿Aplicar este cambio?'}</Text>
      </View>
      <Text selectable style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS_SM, backgroundColor: c.bg, fontFamily: FONTS.mono, fontSize: 13, color: c.ink }}>
        {approval.summary || approval.tool}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={() => onDecide(approval.id, 'deny')} style={({ pressed }) => [btn, { backgroundColor: c.raised, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.onRaised }}>Rechazar</Text>
        </Pressable>
        <Pressable onPress={() => onDecide(approval.id, 'allow')} style={({ pressed }) => [btn, { backgroundColor: c.primary, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.onPrimary }}>Permitir</Text>
        </Pressable>
      </View>
    </FadeUp>
  );
}

/// Hoja de comandos: accesos grandes (adjuntar, archivo, estado, terminar…) y
/// los comandos "/" del host con un filtro.
function CommandsSheet({ commands, tiles, onPick }) {
  const c = useColors();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.replace(/^\//, '').toLowerCase();
    return commands.filter((x) => !needle || x.name.toLowerCase().includes(needle) || String(x.description || '').toLowerCase().includes(needle)).slice(0, 80);
  }, [commands, q]);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {tiles.map((tile) => (
          <Pressable
            key={tile.value}
            onPress={() => onPick(tile.value)}
            style={({ pressed }) => ({
              flexGrow: 1,
              flexBasis: '30%',
              height: 72,
              borderRadius: RADIUS,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: tile.danger ? `rgba(240,140,124,${pressed ? 0.16 : 0.1})` : pressed ? c.surface4 : c.surface3,
            })}
          >
            {tile.glyph ? (
              <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 18, lineHeight: 20, color: c.inkBody }}>{tile.glyph}</Text>
            ) : (
              <Icon name={tile.icon} size={20} color={tile.danger ? c.danger : c.inkBody} />
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
            {cmd.group && cmd.group !== list[i - 1]?.group && (
              <Text style={{ paddingHorizontal: 12, paddingTop: i ? 12 : 0, paddingBottom: 4, fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.inkMuted }}>
                {GROUP_LABEL[cmd.group] || cmd.group}
              </Text>
            )}
            <Pressable
              onPress={() => onPick(`cmd:${cmd.name}`)}
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
  disabled,
  sending,
  attachments,
  mentions,
  onRemoveMention,
  mentionQuery,
  files,
  onPickMention,
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
            accessibilityLabel="Comandos"
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
          >
            <Icon name="slash" size={18} color={c.ink70} />
          </Pressable>
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={onChangeInput}
            placeholder={disabled ? 'Host sin conexión…' : 'Pídele algo al agente…'}
            placeholderTextColor={c.inkMuted}
            selectionColor={c.accent}
            accessibilityLabel="Mensaje para el agente"
            multiline
            style={{ flex: 1, minHeight: 40, maxHeight: 140, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 10, fontFamily: FONTS.ui, fontSize: 15, lineHeight: 20, color: c.ink }}
          />
          <Pressable
            onPress={showStop ? onInterrupt : onSend}
            disabled={showStop ? disabled : !canSend}
            accessibilityLabel={showStop ? 'Interrumpir al agente' : 'Enviar'}
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
