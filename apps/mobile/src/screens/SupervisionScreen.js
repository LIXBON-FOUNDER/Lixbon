// SupervisionScreen.js — prototipo de supervisión remota (LXO-227, datos de
// ejemplo): desde el teléfono se ve qué pide atención, qué está en marcha y en
// qué host, y se responde, aprueba o revisa lo que cabe en una pantalla. Lo
// complejo se abre en Desktop; sin conexión no se finge nada.
//
// Pantallas: inicio (atención, trabajo activo, uso, avisos) → tarea (contexto,
// agente, intentos) → pregunta / aprobación / revisión; más hosts, avisos y uso.
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { ChatHeader, Eyebrow, FadeUp, Meter, PillButton, Row, RowIcon, Section, useColors } from '../components/ui';
import { ago, attention, connectionState, decide, desktopHandoff, duration, hostState, isReviewStale, pushPayload, unreadCount } from '../supervision/model.js';
import { FONTS, RADIUS } from '../theme';

const KIND = {
  question: { label: 'Pregunta', icon: 'message' },
  approval: { label: 'Aprobación', icon: 'key' },
  review: { label: 'Revisión', icon: 'eye' },
  failed: { label: 'Intento fallido', icon: 'warning' },
  done: { label: 'Terminada', icon: 'check' },
};

const AGENT = { claude: 'Claude Code', codex: 'Codex', lixbon: 'Lixbon' };

const STATE_LABEL = { online: 'En línea', stale: 'Desactualizado', offline: 'Sin conexión' };

const TASK_STATUS = {
  running: 'En curso',
  paused: 'En pausa',
  waiting: 'Esperándote',
  review: 'En revisión',
  failed: 'Falló',
  done: 'Terminada',
};

const ATTEMPT_STATUS = { running: 'En curso', done: 'Terminado', failed: 'Falló' };

const ROUTE_TITLE = {
  task: 'Tarea',
  question: 'Pregunta',
  approval: 'Aprobación',
  review: 'Revisión',
  hosts: 'Hosts',
  notifications: 'Avisos',
  usage: 'Uso',
};

// Sin conexión y desactualizado nunca usan el rojo de los fallos.
function stateColor(state, c) {
  return state === 'online' ? c.good : state === 'stale' ? c.warn : c.inkFaint;
}

export default function SupervisionScreen({ sup, onMenu }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { sheet, toast } = useDialogs();
  const { state, now, route } = sup;
  const gutter = width < 360 ? 12 : 16;

  const conn = connectionState(state, now);

  const openDesktop = async (task) => {
    if (conn === 'offline') {
      toast('Sin conexión: no se puede avisar a Desktop', { icon: 'cloud-off' });
      return;
    }
    const host = desktopHandoff(task, state.hosts, now);
    if (!host) {
      toast('No hay ningún Desktop conectado');
      return;
    }
    const ok = await sheet({
      title: 'Abrir en Desktop',
      items: [
        { label: `Abrir en ${host.name}`, description: `${task.title} · ${task.target.branch}`, icon: 'monitor', value: 'go' },
      ],
    });
    // Prototipo: el traspaso real es Mobile F6 (LXO-50); aquí solo se cuenta.
    if (ok) toast(`Se abriría en ${host.name}`, { icon: 'monitor' });
  };

  const ctx = { sup, conn, openDesktop };

  const pickHost = async () => {
    const value = await sheet({
      title: 'Host',
      items: [
        { label: 'Todos los hosts', icon: 'layers', value: 'all', selected: state.hostFilter === 'all' },
        ...state.hosts.map((h) => {
          const hs = hostState(h, now);
          return { label: h.name, description: `${STATE_LABEL[hs]} · ${ago(h.lastSeenAt, now)}`, icon: 'monitor', value: h.id, selected: state.hostFilter === h.id };
        }),
      ],
    });
    if (value) sup.dispatch({ type: 'hostFilter', value });
  };

  const scenario = async () => {
    const value = await sheet({
      title: 'Prototipo · escenario',
      items: [
        { label: 'En línea', description: 'Datos al día', icon: 'activity', value: 'online', selected: conn === 'online' },
        { label: 'Desactualizado', description: 'Última sincronización hace 3 min', icon: 'clock', value: 'stale', selected: conn === 'stale' },
        { label: 'Sin conexión', description: 'El teléfono no llega al gateway', icon: 'cloud-off', value: 'offline', selected: conn === 'offline' },
        { divider: true },
        { label: 'Restablecer los datos de ejemplo', icon: 'refresh', value: 'reset' },
      ],
    });
    if (value === 'reset') {
      sup.dispatch({ type: 'reset' });
      sup.home();
    } else if (value) sup.dispatch({ type: 'connection', value });
  };

  const atHome = route.name === 'home';
  const filteredHost = state.hosts.find((h) => h.id === state.hostFilter);
  const title = atHome ? (filteredHost ? filteredHost.name : 'Todos los hosts') : ROUTE_TITLE[route.name];

  return (
    <View style={{ flex: 1 }}>
      <ChatHeader
        title={title}
        onTitle={atHome ? pickHost : undefined}
        dot={atHome ? (conn === 'online' ? 'live' : 'idle') : null}
        leadingIcon={atHome ? 'menu' : 'arrow-left'}
        onLeading={atHome ? onMenu : sup.pop}
        trailing="dots"
        trailingLabel="Escenario del prototipo"
        onTrailing={scenario}
      />
      <ScrollView
        key={sup.stack.length}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 4, paddingBottom: insets.bottom + 32, gap: 18 }}
        showsVerticalScrollIndicator={false}
      >
        <ConnectionBanner ctx={ctx} />
        {route.name === 'home' && <Home ctx={ctx} />}
        {route.name === 'task' && <TaskView ctx={ctx} taskId={route.taskId} />}
        {route.name === 'question' && <QuestionView ctx={ctx} taskId={route.taskId} />}
        {route.name === 'approval' && <ApprovalView ctx={ctx} taskId={route.taskId} />}
        {route.name === 'review' && <ReviewView ctx={ctx} taskId={route.taskId} />}
        {route.name === 'hosts' && <HostsView ctx={ctx} />}
        {route.name === 'notifications' && <NotificationsView ctx={ctx} />}
        {route.name === 'usage' && <UsageView ctx={ctx} />}
      </ScrollView>
    </View>
  );
}

// ── Piezas comunes ──────────────────────────────────────────────────────────

function Dot({ color, size = 7 }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/// Estado como punto de color con texto (nunca una píldora).
function StateText({ state, children }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dot color={stateColor(state, c)} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{children || STATE_LABEL[state]}</Text>
    </View>
  );
}

function Body({ children, muted = false, style }) {
  const c = useColors();
  return <Text style={[{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: muted ? c.inkMuted : c.inkBody }, style]}>{children}</Text>;
}

function Mono({ children, style, ...rest }) {
  const c = useColors();
  return <Text {...rest} style={[{ fontFamily: FONTS.mono, fontSize: 12.5, color: c.inkBody }, style]}>{children}</Text>;
}

function Title({ children }) {
  const c = useColors();
  return <Text style={{ fontFamily: FONTS.serif, fontSize: 24, lineHeight: 29, color: c.ink }}>{children}</Text>;
}

function Notice({ tone = 'warn', icon, children, action, onAction }) {
  const c = useColors();
  const fg = tone === 'warn' ? c.warn : tone === 'info' ? c.info : c.inkMuted;
  const bg = tone === 'warn' ? c.warnSoft : tone === 'info' ? c.surface3 : c.surface2;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: RADIUS, backgroundColor: bg }}>
      {icon ? <Icon name={icon} size={17} color={fg} /> : null}
      <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13.5, lineHeight: 19, color: tone === 'warn' ? fg : c.inkBody }}>{children}</Text>
      {action ? <PillButton size="sm" outline label={action} onPress={onAction} /> : null}
    </View>
  );
}

/// Siempre arriba: si los datos están al día, viejos o sin conexión, y lo que
/// queda en cola. Desactualizado y sin conexión no son fallos.
function ConnectionBanner({ ctx }) {
  const { sup, conn } = ctx;
  const { state, now } = sup;
  const queued = state.outbox.length;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 }}>
        <Eyebrow>Prototipo · datos de ejemplo</Eyebrow>
        {conn === 'online' ? <StateText state="online">{`Al día · ${ago(state.syncedAt, now)}`}</StateText> : null}
      </View>
      {conn === 'stale' && (
        <Notice icon="clock" action="Actualizar" onAction={() => sup.dispatch({ type: 'refresh' })}>
          {`Datos de ${ago(state.syncedAt, now)}. Pueden haber cambiado: actualiza antes de decidir.`}
        </Notice>
      )}
      {conn === 'offline' && (
        <Notice icon="cloud-off" tone="muted">
          {`Sin conexión. Ves lo último que llegó (${ago(state.syncedAt, now)}). Las respuestas quedan en cola; aprobar y revisar esperan a reconectar.`}
        </Notice>
      )}
      {queued > 0 && (
        <Notice icon="clock" tone="info">
          {queued === 1 ? '1 respuesta en cola: se manda al reconectar.' : `${queued} respuestas en cola: se mandan al reconectar.`}
        </Notice>
      )}
    </View>
  );
}

/// Dónde actúa la tarea: host, destino, política y agente, visibles antes de
/// cualquier decisión.
function ContextBlock({ ctx, task }) {
  const c = useColors();
  const { state, now } = ctx.sup;
  const host = state.hosts.find((h) => h.id === task.hostId);
  const project = state.projects.find((p) => p.id === task.projectId);
  const hs = hostState(host, now);
  const elevated = task.policy.level === 'elevated';
  const line = (label, value, extra) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 34 }}>
      <Text style={{ width: 74, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{label}</Text>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{value}{extra}</View>
    </View>
  );
  return (
    <View style={{ padding: 14, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 2 }}>
      {line('Host', <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{host ? host.name : '—'}</Text>, <StateText state={hs}>{hs === 'online' ? 'En línea' : `${STATE_LABEL[hs]} · ${ago(host.lastSeenAt, now)}`}</StateText>)}
      {line('Destino', <Mono>{`${project ? project.name : ''} · ${task.target.branch}`}</Mono>)}
      {line('Política', (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Dot color={elevated ? c.warn : c.inkFaint} />
          <Text style={{ fontFamily: elevated ? FONTS.uiMedium : FONTS.ui, fontSize: 14, color: elevated ? c.warn : c.inkBody }}>{task.policy.label}</Text>
        </View>
      ))}
      {line('Agente', <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>{AGENT[task.agent] || task.agent}</Text>)}
    </View>
  );
}

/// Pie de una decisión según el veredicto: mandar, dejar en cola, actualizar
/// primero, abrir en Desktop o no se puede (con el motivo a la vista).
function DecisionFooter({ ctx, task, kind, primary, secondary, onRefresh }) {
  const { sup, conn } = ctx;
  const host = sup.state.hosts.find((h) => h.id === task.hostId);
  const verdict = decide(kind, { task, host, connection: conn, now: sup.now });
  const queued = task.pending && task.pending.queuedAt;

  if (queued) {
    return <Notice icon="clock" tone="info">{`En cola: «${task.pending.queuedLabel}». Se manda al reconectar; hasta entonces no está respondida.`}</Notice>;
  }
  return (
    <View style={{ gap: 10 }}>
      {verdict.reason ? <Notice icon={verdict.mode === 'desktop' ? 'monitor' : verdict.mode === 'queue' ? 'clock' : 'warning'} tone={verdict.mode === 'queue' ? 'info' : 'warn'}>{verdict.reason}</Notice> : null}
      {verdict.mode === 'desktop' && <PillButton size="lg" icon="monitor" label="Abrir en Desktop" onPress={() => ctx.openDesktop(task)} />}
      {verdict.mode === 'refresh' && <PillButton size="lg" icon="refresh" label="Actualizar" onPress={onRefresh || (() => sup.dispatch({ type: 'refresh' }))} />}
      {(verdict.mode === 'send' || verdict.mode === 'queue') && primary ? (
        <PillButton size="lg" accent={verdict.mode === 'send'} outline={verdict.mode === 'queue'} label={verdict.mode === 'queue' ? `${primary.label} (en cola)` : primary.label} disabled={primary.disabled} onPress={primary.onPress} />
      ) : null}
      {secondary ? <PillButton outline danger={secondary.danger} label={secondary.label} disabled={secondary.disabled} onPress={secondary.onPress} /> : null}
    </View>
  );
}

/// Cuenta el resultado de una decisión tal cual: mandada, en cola o no.
function useReport(ctx) {
  const { toast } = useDialogs();
  return (verdict, sentLabel) => {
    if (verdict.mode === 'send') {
      toast(sentLabel, { icon: 'check' });
      ctx.sup.pop();
    } else if (verdict.mode === 'queue') toast('En cola: se manda al reconectar', { icon: 'clock' });
    else toast(verdict.reason || 'No se pudo');
  };
}

// ── Inicio ──────────────────────────────────────────────────────────────────

function Home({ ctx }) {
  const c = useColors();
  const { sup } = ctx;
  const { state, now } = sup;
  const tasks = state.hostFilter === 'all' ? state.tasks : state.tasks.filter((t) => t.hostId === state.hostFilter);
  const items = attention(tasks);
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'paused');
  const unread = unreadCount(state.notifications);
  const busiest = [...state.usage].sort((a, b) => b.percent - a.percent)[0];

  return (
    <>
      <FadeUp style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 4 }}>
          <Eyebrow>Atención</Eyebrow>
          <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{items.length}</Text>
        </View>
        {items.length === 0 ? (
          <View style={{ padding: 16, borderRadius: RADIUS, backgroundColor: c.sheet }}>
            <Body muted>Nada te espera. Los agentes siguen solos.</Body>
          </View>
        ) : (
          <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>
            {items.map((it) => {
              const task = state.tasks.find((t) => t.id === it.taskId);
              const project = state.projects.find((p) => p.id === task.projectId);
              const host = state.hosts.find((h) => h.id === task.hostId);
              const queued = task.pending && task.pending.queuedAt;
              return (
                <AttentionRow
                  key={it.taskId}
                  kind={it.kind}
                  title={task.title}
                  detail={`${KIND[it.kind].label}${queued ? ' · en cola' : ''} · ${project.name} · ${host.name}`}
                  meta={ago(it.since, now)}
                  elevated={task.policy.level === 'elevated'}
                  onPress={() => sup.push({ name: 'task', taskId: task.id })}
                />
              );
            })}
          </View>
        )}
      </FadeUp>

      <FadeUp delay={40} style={{ gap: 8 }}>
        <Eyebrow style={{ paddingHorizontal: 4 }}>Trabajo activo</Eyebrow>
        <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>
          {active.length === 0 ? (
            <Body muted style={{ padding: 14 }}>Ningún agente trabajando.</Body>
          ) : (
            active.map((task) => {
              const host = state.hosts.find((h) => h.id === task.hostId);
              const hs = hostState(host, now);
              const attempt = task.attempts[task.attempts.length - 1];
              const last = task.events[task.events.length - 1];
              return (
                <Pressable
                  key={task.id}
                  onPress={() => sup.push({ name: 'task', taskId: task.id })}
                  style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 11, gap: 4, backgroundColor: pressed ? c.pressed : 'transparent' })}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>{task.title}</Text>
                    <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkMuted }}>{duration(attempt.startedAt, now)}</Text>
                  </View>
                  <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                    {`${AGENT[task.agent]} · ${task.status === 'paused' ? 'En pausa · ' : ''}${last.text}`}
                  </Text>
                  {/* Un host que no responde no convierte la tarea en fallida. */}
                  {hs !== 'online' && <StateText state={hs}>{`${host.name}: ${STATE_LABEL[hs].toLowerCase()} · último dato ${ago(last.at, now)}`}</StateText>}
                </Pressable>
              );
            })
          )}
        </View>
      </FadeUp>

      <FadeUp delay={80} style={{ gap: 8 }}>
        <Eyebrow style={{ paddingHorizontal: 4 }}>Más</Eyebrow>
        <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>
          <Row title="Avisos" icon="bell" value={unread ? `${unread} sin leer` : 'Al día'} onPress={() => sup.push({ name: 'notifications' })} />
          <Row
            title="Uso"
            icon="gauge"
            detail={`${busiest.label} al ${busiest.percent} %`}
            right={<Meter width={56} value={busiest.percent / 100} color={busiest.percent >= 90 ? c.danger : c.accent} />}
            onPress={() => sup.push({ name: 'usage' })}
          />
          <Row title="Hosts" icon="monitor" value={`${state.hosts.filter((h) => hostState(h, now) === 'online').length} de ${state.hosts.length} en línea`} onPress={() => sup.push({ name: 'hosts' })} />
        </View>
      </FadeUp>
    </>
  );
}

function AttentionRow({ kind, title, detail, meta, elevated, onPress }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: pressed ? c.pressed : 'transparent' })}>
      <RowIcon name={KIND[kind].icon} danger={kind === 'failed'} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={2} style={{ fontFamily: FONTS.uiMedium, fontSize: 15, lineHeight: 20, color: c.ink }}>{title}</Text>
        <Text numberOfLines={2} style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkMuted }}>{detail}</Text>
        {elevated && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Dot color={c.warn} size={6} />
            <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.warn }}>Política elevada</Text>
          </View>
        )}
      </View>
      <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkFaint }}>{meta}</Text>
    </Pressable>
  );
}

// ── Tarea ───────────────────────────────────────────────────────────────────

function TaskView({ ctx, taskId }) {
  const c = useColors();
  const { confirm } = useDialogs();
  const report = useReport(ctx);
  const { sup, conn } = ctx;
  const { state, now } = sup;
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return <Body muted>Esta tarea ya no existe.</Body>;
  const project = state.projects.find((p) => p.id === task.projectId);
  const host = state.hosts.find((h) => h.id === task.hostId);
  const live = conn === 'online' && hostState(host, now) === 'online';
  const pending = task.pending;

  const retry = async () => {
    const ok = await confirm({ title: '¿Reintentar?', message: `Empieza el intento ${task.attempts.length + 1} en ${host.name}, sobre ${task.target.branch}.`, confirmLabel: 'Reintentar' });
    if (ok) report(sup.decide({ type: 'retry', taskId }), 'Intento en marcha');
  };

  return (
    <>
      <FadeUp style={{ gap: 6 }}>
        <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{project.name}</Text>
        <Title>{task.title}</Title>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkMuted }}>{TASK_STATUS[task.status]}</Text>
      </FadeUp>

      <ContextBlock ctx={ctx} task={task} />

      {pending && (
        <Pressable
          onPress={() => sup.push({ name: pending.kind, taskId })}
          style={({ pressed }) => ({ padding: 14, borderRadius: RADIUS, backgroundColor: pressed ? c.surface4 : c.surface3, gap: 6 })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={KIND[pending.kind].icon} size={16} color={c.ink} />
            <Text style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 15, color: c.ink }}>{pending.title}</Text>
            <Icon name="chevron-right" size={16} color={c.inkMuted} />
          </View>
          <Body muted>{pending.queuedAt ? `En cola: «${pending.queuedLabel}»` : pending.kind === 'question' ? pending.question : pending.kind === 'approval' ? pending.why : pending.review.summary}</Body>
        </Pressable>
      )}

      {task.status === 'failed' && (
        <View style={{ gap: 10 }}>
          <Notice icon="warning">{task.attempts[task.attempts.length - 1].summary}</Notice>
          <PillButton size="lg" label="Reintentar" onPress={retry} />
        </View>
      )}

      <Section title="Agente">
        <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
          {task.events.slice(-3).map((e, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={{ width: 62, fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 19, color: c.inkFaint }}>{ago(e.at, now).replace('hace ', '')}</Text>
              <Body style={{ flex: 1, fontSize: 14 }}>{e.text}</Body>
            </View>
          ))}
        </View>
        {(task.status === 'running' || task.status === 'paused') && (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
            <PillButton
              size="sm"
              outline
              icon={task.status === 'paused' ? 'play' : 'pause'}
              label={task.status === 'paused' ? 'Reanudar' : 'Pausar'}
              disabled={!live}
              onPress={() => sup.dispatch({ type: task.status === 'paused' ? 'resume' : 'pause', taskId })}
            />
          </View>
        )}
        {(task.status === 'running' || task.status === 'paused') && !live && (
          <Body muted style={{ paddingHorizontal: 14, paddingBottom: 12, fontSize: 13 }}>Pausar y reanudar necesitan conexión con el host.</Body>
        )}
      </Section>

      <Section title="Intentos">
        {[...task.attempts].reverse().map((a) => (
          <View key={a.n} style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{`Intento ${a.n}`}</Text>
              <Dot color={a.status === 'failed' ? c.danger : a.status === 'running' ? c.accent : c.inkFaint} size={6} />
              <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{ATTEMPT_STATUS[a.status]}</Text>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkMuted }}>{duration(a.startedAt, a.endedAt || now)}</Text>
            </View>
            <Body muted style={{ fontSize: 13.5 }}>{a.summary}</Body>
          </View>
        ))}
      </Section>

      <Section title="Más detalle">
        <Row title="Abrir en Desktop" detail="Diff completo, terminal y editor" icon="monitor" onPress={() => ctx.openDesktop(task)} />
      </Section>
    </>
  );
}

// ── Pregunta ────────────────────────────────────────────────────────────────

function QuestionView({ ctx, taskId }) {
  const c = useColors();
  const report = useReport(ctx);
  const task = ctx.sup.state.tasks.find((t) => t.id === taskId);
  const [choice, setChoice] = useState(null);
  const [text, setText] = useState('');
  if (!task || !task.pending || task.pending.kind !== 'question') return <Resolved ctx={ctx} />;
  const p = task.pending;
  const chosen = p.options.find((o) => o.id === choice);
  const answer = chosen ? chosen.label : text.trim();

  return (
    <>
      <Title>{p.title}</Title>
      <ContextBlock ctx={ctx} task={task} />
      <Body>{p.question}</Body>
      <View style={{ gap: 8 }} accessibilityRole="radiogroup">
        {p.options.map((o) => {
          const on = o.id === choice;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={() => setChoice(on ? null : o.id)}
              style={({ pressed }) => ({ flexDirection: 'row', gap: 12, padding: 14, borderRadius: RADIUS, backgroundColor: on ? c.accentSoft : pressed ? c.surface4 : c.sheet })}
            >
              <View style={{ width: 18, height: 18, marginTop: 1, borderRadius: 9, borderWidth: on ? 5 : 1.5, borderColor: on ? c.accent : c.inkFaint }} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>{o.label}</Text>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkMuted }}>{o.detail}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {!chosen && (
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="O escribe otra respuesta"
          placeholderTextColor={c.inkFaint}
          multiline
          style={{ minHeight: 48, maxHeight: 140, paddingHorizontal: 14, paddingVertical: 12, borderRadius: RADIUS, backgroundColor: c.bgInput, fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}
        />
      )}
      <DecisionFooter
        ctx={ctx}
        task={task}
        kind="question"
        primary={{ label: 'Responder', disabled: !answer, onPress: () => report(ctx.sup.decide({ type: 'answer', taskId, label: answer }), 'Respuesta enviada') }}
      />
    </>
  );
}

// ── Aprobación ──────────────────────────────────────────────────────────────

function ApprovalView({ ctx, taskId }) {
  const c = useColors();
  const report = useReport(ctx);
  const task = ctx.sup.state.tasks.find((t) => t.id === taskId);
  if (!task || !task.pending || task.pending.kind !== 'approval') return <Resolved ctx={ctx} />;
  const p = task.pending;

  return (
    <>
      <Title>{p.title}</Title>
      <ContextBlock ctx={ctx} task={task} />
      <View style={{ padding: 14, borderRadius: RADIUS, backgroundColor: c.codeBg, gap: 6 }}>
        <Eyebrow>Acción</Eyebrow>
        <Mono style={{ fontSize: 13.5, lineHeight: 20, color: c.ink }}>{p.action}</Mono>
      </View>
      <Body>{p.why}</Body>
      <View style={{ gap: 6 }}>
        {p.effects.map((e) => (
          <View key={e} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <Icon name="tick" size={15} color={c.inkMuted} />
            <Body muted style={{ flex: 1, fontSize: 14 }}>{e}</Body>
          </View>
        ))}
      </View>
      <DecisionFooter
        ctx={ctx}
        task={task}
        kind="approval"
        primary={{ label: 'Aprobar', onPress: () => report(ctx.sup.decide({ type: 'approve', taskId }), 'Aprobada') }}
        secondary={{ label: 'Rechazar', danger: true, onPress: () => report(ctx.sup.decide({ type: 'reject', taskId }), 'Rechazada') }}
      />
    </>
  );
}

// ── Revisión ────────────────────────────────────────────────────────────────

function ReviewView({ ctx, taskId }) {
  const c = useColors();
  const { prompt } = useDialogs();
  const report = useReport(ctx);
  const { sup } = ctx;
  const task = sup.state.tasks.find((t) => t.id === taskId);
  if (!task || !task.pending || task.pending.kind !== 'review') return <Resolved ctx={ctx} />;
  const r = task.pending.review;
    const stale = isReviewStale(r, task);
  const shown = r.files.slice(0, 5);

  const requestChanges = async () => {
    const value = await prompt({ title: 'Pedir cambios', placeholder: 'Qué debe cambiar', confirmLabel: 'Pedir cambios' });
    const label = (value || '').trim();
    if (label) report(sup.decide({ type: 'changes', taskId, label }), 'Cambios pedidos');
  };

  return (
    <>
      <Title>{task.title}</Title>
      <ContextBlock ctx={ctx} task={task} />
      {stale && <Notice icon="git">{`La rama avanzó a ${task.headSha} y esta revisión se generó sobre ${r.baseSha}. No se puede aceptar hasta regenerarla.`}</Notice>}
      <Body>{r.summary}</Body>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Stat label="Archivos" value={String(r.files.length)} />
        <Stat label="Añadidas" value={`+${r.additions}`} color={c.good} />
        <Stat label="Quitadas" value={`−${r.deletions}`} color={c.danger} />
      </View>

      <Section title="Comprobaciones">
        {r.checks.map((ch) => (
          <View key={ch.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 40 }}>
            <Dot color={ch.state === 'passed' ? c.good : ch.state === 'failed' ? c.danger : c.warn} />
            <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>{ch.name}</Text>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{ch.state === 'passed' ? 'Pasó' : ch.state === 'failed' ? 'Falló' : 'Corriendo'}</Text>
          </View>
        ))}
      </Section>

      {r.risks.length > 0 && (
        <View style={{ gap: 6 }}>
          {r.risks.map((x) => (
            <View key={x} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Dot color={c.warn} size={6} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.warn }}>{x}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Solo rutas y conteos: el diff se lee en Desktop. */}
      <Section title="Archivos">
        {shown.map((f) => (
          <View key={f.path} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 38 }}>
            <Mono style={{ flex: 1 }} numberOfLines={1}>{f.path}</Mono>
            <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.good }}>{`+${f.additions}`}</Text>
            <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.danger }}>{`−${f.deletions}`}</Text>
          </View>
        ))}
        {r.files.length > shown.length && <Body muted style={{ paddingHorizontal: 14, paddingVertical: 8, fontSize: 13 }}>{`y ${r.files.length - shown.length} más`}</Body>}
      </Section>

      <DecisionFooter
        ctx={ctx}
        task={task}
        kind="review"
        onRefresh={stale ? () => sup.dispatch({ type: 'refreshReview', taskId }) : undefined}
        primary={{ label: 'Aceptar', onPress: () => report(sup.decide({ type: 'accept', taskId }), 'Revisión aceptada') }}
        secondary={{ label: 'Pedir cambios', onPress: requestChanges }}
      />
    </>
  );
}

function Stat({ label, value, color }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, padding: 12, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 2 }}>
      <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 17, color: color || c.ink }}>{value}</Text>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{label}</Text>
    </View>
  );
}

function Resolved({ ctx }) {
  return (
    <View style={{ gap: 12 }}>
      <Body muted>Esto ya está resuelto.</Body>
      <PillButton outline label="Volver" onPress={ctx.sup.pop} />
    </View>
  );
}

// ── Hosts ───────────────────────────────────────────────────────────────────

function HostsView({ ctx }) {
  const c = useColors();
  const { sup } = ctx;
  const { state, now } = sup;
  return (
    <>
      <Body muted>Elige un host para ver solo su trabajo. Un host desactualizado o sin conexión no hace fallar sus tareas: muestran el último dato que llegó.</Body>
      <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>
        <HostRow title="Todos los hosts" detail={`${state.tasks.length} tareas`} selected={state.hostFilter === 'all'} onPress={() => { sup.dispatch({ type: 'hostFilter', value: 'all' }); sup.home(); }} />
        {state.hosts.map((h) => {
          const hs = hostState(h, now);
          const count = state.tasks.filter((t) => t.hostId === h.id && t.status !== 'done').length;
          return (
            <HostRow
              key={h.id}
              title={h.name}
              detail={`${h.os} · ${h.kind === 'desktop' ? 'Desktop' : 'CLI'} · ${count} tareas`}
              state={hs}
              seen={hs === 'online' ? 'En línea' : `${STATE_LABEL[hs]} · ${ago(h.lastSeenAt, now)}`}
              selected={state.hostFilter === h.id}
              onPress={() => { sup.dispatch({ type: 'hostFilter', value: h.id }); sup.home(); }}
            />
          );
        })}
      </View>
    </>
  );
}

function HostRow({ title, detail, state, seen, selected, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: pressed ? c.pressed : 'transparent' })}
    >
      <RowIcon name={state ? 'monitor' : 'layers'} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>{title}</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{detail}</Text>
        {state ? <StateText state={state}>{seen}</StateText> : null}
      </View>
      {selected ? <Icon name="check" size={17} color={c.accent} /> : null}
    </Pressable>
  );
}

// ── Avisos ──────────────────────────────────────────────────────────────────

function NotificationsView({ ctx }) {
  const c = useColors();
  const { sup } = ctx;
  const { state, now } = sup;
  const first = state.notifications[0];
  const firstTask = first && state.tasks.find((t) => t.id === first.taskId);
  const preview = first && pushPayload(first, firstTask, state.projects.find((p) => p.id === firstTask.projectId));

  return (
    <>
      <Notice icon="bell" tone="muted">Leer un aviso no resuelve lo que pide atención: eso sigue en el inicio hasta que decides.</Notice>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <PillButton size="sm" outline label="Marcar todo como leído" disabled={unreadCount(state.notifications) === 0} onPress={() => sup.dispatch({ type: 'readAll' })} />
      </View>
      <View style={{ borderRadius: RADIUS, backgroundColor: c.sheet, paddingVertical: 4, overflow: 'hidden' }}>
        {state.notifications.map((n) => {
          const task = state.tasks.find((t) => t.id === n.taskId);
          return (
            <Pressable
              key={n.id}
              onPress={() => {
                sup.dispatch({ type: 'read', id: n.id });
                sup.push({ name: 'task', taskId: n.taskId });
              }}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: pressed ? c.pressed : 'transparent' })}
            >
              <View style={{ width: 7 }}>{!n.read && <Dot color={c.accent} />}</View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ fontFamily: n.read ? FONTS.ui : FONTS.uiMedium, fontSize: 14.5, color: n.read ? c.inkBody : c.ink }}>{task.title}</Text>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{KIND[n.kind].label}</Text>
              </View>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkFaint }}>{ago(n.at, now)}</Text>
            </Pressable>
          );
        })}
      </View>

      {preview && (
        <View style={{ gap: 8 }}>
          <Eyebrow style={{ paddingHorizontal: 4 }}>Así llega el push</Eyebrow>
          <View style={{ padding: 14, borderRadius: RADIUS, backgroundColor: c.surface3, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="bell" size={14} color={c.inkMuted} />
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: c.inkMuted }}>Lixbon</Text>
            </View>
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>{preview.title}</Text>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>{preview.body}</Text>
          </View>
          <Body muted style={{ fontSize: 13, paddingHorizontal: 4 }}>Sin comandos, preguntas ni diffs: se ven al abrir la app.</Body>
        </View>
      )}
    </>
  );
}

// ── Uso ─────────────────────────────────────────────────────────────────────

function UsageView({ ctx }) {
  const c = useColors();
  const { state, now } = ctx.sup;
  const stale = ctx.conn !== 'online';
  const resetIn = (at) => {
    const m = Math.max(0, Math.round((at - now) / 60000));
    return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} d`;
  };
  return (
    <>
      <Body muted>Cuota de cada proveedor en un vistazo. Cada cifra dice de cuándo es.</Body>
      <View style={{ gap: 8 }}>
        {state.usage.map((u) => (
          <View key={u.id} style={{ padding: 14, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 10, opacity: stale ? 0.7 : 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>{u.label}</Text>
              <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 20, color: u.percent >= 90 ? c.danger : c.ink }}>{`${u.percent} %`}</Text>
            </View>
            <Meter value={u.percent / 100} color={u.percent >= 90 ? c.danger : c.accent} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{`${u.window} · se reinicia en ${resetIn(u.resetAt)}`}</Text>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: stale ? c.warn : c.inkFaint }}>{ago(stale ? state.syncedAt : u.syncedAt, now)}</Text>
            </View>
          </View>
        ))}
      </View>
    </>
  );
}
