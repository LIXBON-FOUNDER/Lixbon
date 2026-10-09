// RemoteOrch.js — el orquestador de agentes del IDE, visto desde el control
// remoto. El IDE manda un snapshot (`state.orch`) cada vez que cambia y atiende
// las acciones que se le piden (`orch` + action): parar una tarea, ver su
// terminal o su diff, cambiar el modelo de un rol… Aquí solo se pinta y se
// pide: el run en curso arriba con sus fases y agentes, los anteriores debajo,
// el detalle de cada agente como línea de tiempo y los ajustes en secciones.
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

import Icon from '../components/Icon';
import { LiveDot } from '../components/RemoteSessionList';
import ShimmerText from '../components/ShimmerText';
import { useDialogs } from '../components/dialogs';
import { Eyebrow, FadeUp, IconButton, PillButton, Row, Section, Segmented, Toggle, useColors } from '../components/ui';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

const FINAL = ['done', 'failed', 'stopped', 'exited'];
const isFinal = (st) => FINAL.includes(st);
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini', lixbon: 'Lixbon', coordinador: 'Coordinador' };
const STATUS = { starting: 'arrancando', running: 'trabajando', waiting: 'esperando', done: 'entregó', failed: 'falló', stopped: 'detenida', exited: 'cerrada' };
const ROLE = { explorador: 'Explorador', implementador: 'Implementador', revisor: 'Revisor', escalado: 'Escalado' };
const KIND = { phase: 'Fase', done: 'Entregó su informe', question: 'Preguntó', reply: 'Respuesta', note: 'Nota', exited: 'Se cerró' };
const EFFORT = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };

function useNow(active, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const elapsed = (task, now) => dur((isFinal(task.status) ? task.updated : now) - task.created);
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ago = (ms) => {
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? 'hoy' : days === 1 ? 'ayer' : `${days} d`;
};
const roleName = (t) => (t.role ? ROLE[t.role] || t.role : t.parent ? t.title || t.id : 'Coordinador');

function tree(tasks, run) {
  const list = tasks.filter((t) => t.run === run);
  const kids = new Map();
  for (const t of list) {
    const k = t.parent || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t);
  }
  const out = [];
  const walk = (p) =>
    (kids.get(p) || [])
      .sort((a, b) => a.created - b.created)
      .forEach((t) => {
        out.push(t);
        walk(t.id);
      });
  walk('');
  return out;
}

function pendingQuestions(messages) {
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.reply_to));
  return messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
}

/** Estado de un agente en 16px: entregó (check), trabaja (punto que late),
    espera (punto ámbar), falló (rojo) o en cola (aro). */
function StatusMark({ status }) {
  const c = useColors();
  let mark;
  if (status === 'done') mark = <Icon name="check" size={15} color={c.accent} strokeWidth={2} />;
  else if (status === 'running' || status === 'starting') mark = <LiveDot size={8} />;
  else if (status === 'waiting') mark = <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.warn }} />;
  else if (status === 'failed' || status === 'exited') mark = <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.danger }} />;
  else mark = <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: c.inkFaint }} />;
  return <View style={{ width: 16, alignItems: 'center' }}>{mark}</View>;
}

const mono = (c) => ({ fontFamily: FONTS.mono, fontSize: 12, lineHeight: 18, color: c.inkBody });

// ── Detalle de un agente ────────────────────────────────────────────────────

function Activity({ task, orch }) {
  const c = useColors();
  const name = (id) => roleName(orch.tasks.find((x) => x.id === id) || { id, title: id });
  const open = pendingQuestions(orch.messages).filter((q) => q.to === task.id || q.from === task.id);
  const timeline = useMemo(() => {
    const events = [
      ...(task.phases || []).map((p) => ({ at: p.at, title: p.done ? `Fase terminada · ${p.name}` : `Empezó la fase · ${p.name}`, detail: p.note })),
      ...orch.messages
        .filter((m) => m.from === task.id || m.to === task.id)
        .map((m) => ({
          at: m.at,
          title: m.from === task.id ? KIND[m.kind] || m.kind : `${KIND[m.kind] || m.kind} de ${name(m.from)}`,
          detail: m.body,
          ask: m.kind === 'question' && open.some((q) => q.id === m.id),
        })),
    ];
    return events.filter((e) => e.at).sort((a, b) => a.at - b.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.phases, orch.messages, task.id]);

  return (
    <View style={{ gap: 22 }}>
      {!!task.spec && (
        <View style={{ gap: 6 }}>
          <Eyebrow>Encargo</Eyebrow>
          <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.inkBody }}>
            {task.spec}
          </Text>
        </View>
      )}
      {timeline.length > 0 ? (
        <View style={{ gap: 18 }}>
          {timeline.map((e, i) => (
            <FadeUp key={i} delay={Math.min(i, 8) * 30} style={{ flexDirection: 'row', gap: 14 }}>
              <Text style={{ width: 42, paddingTop: 2, fontFamily: FONTS.mono, fontSize: 12, color: e.ask ? c.warn : c.inkMuted }}>{clock(e.at)}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: e.ask ? c.warn : c.ink }}>{e.title}</Text>
                {!!e.detail && (
                  <Text selectable numberOfLines={6} style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 19, color: c.inkMuted }}>
                    {e.detail}
                  </Text>
                )}
              </View>
            </FadeUp>
          ))}
        </View>
      ) : (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>Aún no ha informado de nada.</Text>
      )}
      {!!task.summary && (
        <View style={{ gap: 6 }}>
          <Eyebrow>Informe final</Eyebrow>
          <Text selectable style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.inkBody }}>
            {task.summary}
          </Text>
          {task.files?.length > 0 && <Text style={[mono(c), { color: c.inkMuted }]}>{task.files.join(' · ')}</Text>}
        </View>
      )}
      {open.length > 0 && (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 19, color: c.inkMuted }}>
          Las preguntas las responde el coordinador; si necesita tu decisión, te la pide en la conversación.
        </Text>
      )}
    </View>
  );
}

function Terminal({ task, state, send }) {
  const c = useColors();
  const term = state.orchTerm[task.id];
  const live = state.orch.live.includes(task.id);
  useEffect(() => {
    send('term', { task: task.id });
    if (!live) return undefined;
    const id = setInterval(() => send('term', { task: task.id }), 3000);
    return () => clearInterval(id);
  }, [task.id, live, send]);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{live ? 'En vivo · se actualiza sola' : 'La terminal ya se cerró'}</Text>
        <PillButton size="sm" outline icon="refresh" label="Actualizar" onPress={() => send('term', { task: task.id })} />
      </View>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 460, borderRadius: RADIUS, backgroundColor: c.codeBg }} contentContainerStyle={{ padding: 12 }}>
        <Text selectable style={mono(c)}>
          {term ? term.text || 'Sin salida todavía.' : 'Cargando…'}
        </Text>
      </ScrollView>
    </View>
  );
}

function Diff({ task, state, send }) {
  const c = useColors();
  const d = state.orchDiff[task.id];
  useEffect(() => {
    send('diff', { task: task.id });
  }, [task.id, task.updated, send]);
  if (!d) return <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>Cargando…</Text>;
  const lines = (d.diff || '').split('\n').slice(0, 1500);
  return (
    <View style={{ gap: 10 }}>
      <Text selectable style={[mono(c), { padding: 12, borderRadius: RADIUS, backgroundColor: c.sheet, color: c.inkSoft }]}>
        {d.stat || 'Sin commits nuevos en la rama.'}
      </Text>
      {lines.length > 1 && (
        <View style={{ borderRadius: RADIUS, backgroundColor: c.codeBg, paddingVertical: 8 }}>
          {lines.map((l, i) => {
            const add = l.startsWith('+') && !l.startsWith('+++');
            const del = l.startsWith('-') && !l.startsWith('---');
            return (
              <Text
                key={i}
                style={[
                  mono(c),
                  {
                    paddingHorizontal: 10,
                    fontSize: 11.5,
                    color: add ? c.good : del ? c.danger : l.startsWith('@@') ? c.info : l.startsWith('diff ') ? c.ink : c.inkSoft,
                    backgroundColor: add ? 'rgba(134,214,148,0.1)' : del ? 'rgba(240,140,124,0.1)' : 'transparent',
                  },
                ]}
              >
                {l || ' '}
              </Text>
            );
          })}
        </View>
      )}
      {(d.truncated || (d.diff || '').split('\n').length > 1500) && (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>El diff es muy largo: se muestra solo el principio.</Text>
      )}
    </View>
  );
}

function TaskDetail({ task, state, send, onBack }) {
  const c = useColors();
  const { confirm } = useDialogs();
  const [tab, setTab] = useState('activity');
  const final = isFinal(task.status);
  const now = useNow(!final);
  const stop = async () => {
    const ok = await confirm({ title: '¿Detener esta tarea?', message: `«${task.title || roleName(task)}» deja de trabajar y el coordinador recibe el aviso.`, confirmLabel: 'Detener', danger: true });
    if (ok) send('stop', { task: task.id });
  };
  const sub = [AGENTS[task.agent] || task.agent, task.effort ? `esfuerzo ${(EFFORT[task.effort] || task.effort).toLowerCase()}` : task.model, task.branch].filter(Boolean).join(' · ');
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginHorizontal: -4 }}>
        <IconButton onPress={onBack} label="Volver al orquestador">
          <Icon name="arrow-left" size={20} color={c.inkBody} />
        </IconButton>
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}>
            {roleName(task)}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
            {sub} · {elapsed(task, now)}
          </Text>
        </View>
        {!final && task.parent ? (
          <IconButton onPress={stop} label="Detener la tarea">
            <View style={{ width: 12, height: 12, borderRadius: 2, borderWidth: 1.8, borderColor: c.danger }} />
          </IconButton>
        ) : task.pr_url ? (
          <IconButton onPress={() => Linking.openURL(task.pr_url)} label="Ver el pull request">
            <Icon name="external" size={18} color={c.inkBody} />
          </IconButton>
        ) : null}
      </View>
      <Segmented
        stretch
        size="lg"
        bg={c.sheet}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'activity', label: 'Actividad' },
          ...(task.parent ? [{ value: 'term', label: 'Terminal' }] : []),
          ...(task.branch ? [{ value: 'diff', label: 'Cambios' }] : []),
        ]}
      />
      {tab === 'activity' && <Activity task={task} orch={state.orch} />}
      {tab === 'term' && <Terminal task={task} state={state} send={send} />}
      {tab === 'diff' && <Diff task={task} state={state} send={send} />}
    </View>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────

function ActiveRun({ run, orch, now, onOpen }) {
  const c = useColors();
  const tasks = tree(orch.tasks, run.id);
  const root = tasks.find((x) => !x.parent);
  const kids = tasks.filter((x) => x.parent);
  const questions = pendingQuestions(orch.messages).filter((q) => tasks.some((t) => t.id === q.from));
  const asking = questions[0] && tasks.find((t) => t.id === questions[0].from);
  return (
    <FadeUp style={{ padding: 16, borderRadius: RADIUS, backgroundColor: c.sheet, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <LiveDot size={6} />
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
            {['En curso', run.repo, root && elapsed(root, now)].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <ShimmerText text={run.objective} base={c.ink} highlight={c.inkMuted} style={{ fontFamily: FONTS.uiMedium, fontSize: 16 }} />
      </View>
      {kids.length > 0 && (
        <View accessibilityLabel={`${kids.filter((k) => k.status === 'done').length} de ${kids.length} tareas entregadas`} style={{ flexDirection: 'row', gap: 4 }}>
          {kids.map((k) => (
            <View
              key={k.id}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                backgroundColor: k.status === 'done' ? c.accent : k.status === 'failed' || k.status === 'exited' ? c.danger : isFinal(k.status) ? c.surface5 : k.status === 'starting' ? c.surface5 : `rgba(${c.accentRgb},0.45)`,
              }}
            />
          ))}
        </View>
      )}
      {asking && (
        <Pressable
          onPress={() => onOpen(asking.id)}
          style={({ pressed }) => ({ padding: 12, borderRadius: RADIUS, backgroundColor: c.warnSoft, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.85 : 1 })}
        >
          <Icon name="warning" size={17} color={c.warn} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>El {roleName(asking).toLowerCase()} está esperando una respuesta</Text>
            <Text numberOfLines={2} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.ink70 }}>
              {questions[0].body}
            </Text>
          </View>
          <Icon name="chevron-right" size={16} color={c.inkMuted} />
        </Pressable>
      )}
      <View>
        {tasks.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onOpen(t.id)}
            style={({ pressed }) => ({ minHeight: 44, paddingLeft: t.depth > 1 ? (t.depth - 1) * 14 : 0, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.7 : 1 })}
          >
            <StatusMark status={t.status} />
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: t.status === 'starting' ? c.inkMuted : c.ink }}>
              {roleName(t)}
            </Text>
            <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
              {AGENTS[t.agent] || t.agent} · {STATUS[t.status] || t.status}
            </Text>
          </Pressable>
        ))}
      </View>
    </FadeUp>
  );
}

function Runs({ state, send, onOpen }) {
  const c = useColors();
  const { sheet } = useDialogs();
  const orch = state.orch;
  const now = useNow(orch.tasks.some((x) => !isFinal(x.status)), 5000);
  const runs = orch.runs.map((r) => {
    const tasks = orch.tasks.filter((t) => t.run === r.id);
    const root = tasks.find((t) => !t.parent);
    return { ...r, root, active: !!root && !isFinal(root.status), failed: root && (root.status === 'failed' || root.status === 'exited') };
  });
  const active = runs.filter((r) => r.active);
  const past = runs.filter((r) => !r.active);

  if (!runs.length) {
    return (
      <FadeUp style={{ alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 16 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.inkMuted, textAlign: 'center' }}>Todavía no hay runs. Escribe en la conversación:</Text>
        <Text style={[mono(c), { paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS_SM, backgroundColor: c.sheet, color: c.ink }]}>/orquestar &lt;objetivo&gt;</Text>
      </FadeUp>
    );
  }

  const pastActions = async (r) => {
    const action = await sheet({
      title: r.objective,
      items: [
        ...(r.root ? [{ label: 'Ver el detalle', icon: 'chevron-right', value: 'open' }] : []),
        ...(r.root?.pr_url ? [{ label: 'Abrir el pull request', icon: 'external', value: 'pr' }] : []),
        { divider: true },
        { label: 'Quitar de la lista', icon: 'trash', danger: true, value: 'remove' },
      ],
    });
    if (action === 'open') onOpen(r.root.id);
    if (action === 'pr') Linking.openURL(r.root.pr_url);
    if (action === 'remove') send('remove_run', { run: r.id });
  };

  return (
    <View style={{ gap: 22 }}>
      {active.map((r) => (
        <ActiveRun key={r.id} run={r} orch={orch} now={now} onOpen={onOpen} />
      ))}
      {past.length > 0 && (
        <FadeUp delay={80}>
          <Eyebrow style={{ paddingHorizontal: 4, marginBottom: 4 }}>Anteriores</Eyebrow>
          {past.map((r) => {
            const pr = r.root?.pr_url && /\/pull\/(\d+)/.exec(r.root.pr_url)?.[1];
            return (
              <Pressable
                key={r.id}
                onPress={() => (r.root ? onOpen(r.root.id) : pastActions(r))}
                onLongPress={() => pastActions(r)}
                style={({ pressed }) => ({ minHeight: 58, paddingVertical: 8, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.7 : 1 })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkBody }}>
                    {r.objective}
                  </Text>
                  <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: r.failed ? c.danger : c.inkMuted }}>
                    {r.failed ? 'Fallida' : 'Cerrada'} · {ago(r.root?.updated || r.created)}
                  </Text>
                </View>
                {!!pr && (
                  <View style={{ height: 26, paddingHorizontal: 8, borderRadius: RADIUS_SM, backgroundColor: c.surface3, justifyContent: 'center' }}>
                    <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.ink70 }}>PR #{pr}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </FadeUp>
      )}
    </View>
  );
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

function Settings({ state, send, onBack }) {
  const c = useColors();
  const { sheet } = useDialogs();
  const orch = state.orch;
  useEffect(() => {
    if (state.orchAgents === null) send('agents', {});
  }, [state.orchAgents, send]);
  const claude = state.orchAgents?.find((a) => a.id === 'claude');
  const models = claude?.models?.length ? claude.models : ['haiku', 'sonnet', 'opus'];
  const efforts = claude?.efforts?.length ? claude.efforts : Object.keys(EFFORT);

  // Un toque por rol: primero el modelo y, si se elige, el esfuerzo en la
  // hoja siguiente, en vez de dos selectores por fila.
  const editRole = async (r) => {
    const model = await sheet({
      title: r.label,
      detail: r.purpose,
      items: [...new Set([...models, r.model])].map((m) => ({ label: m, value: m, mono: true, selected: m === r.model })),
    });
    if (!model) return;
    if (model !== r.model) send('settings', { role: r.id, model });
    const effort = await sheet({
      title: 'Esfuerzo',
      items: [{ label: 'Por defecto', value: '__default', selected: !r.effort }, ...efforts.map((e) => ({ label: EFFORT[e] || e, value: e, selected: e === r.effort }))],
    });
    if (effort) send('settings', { role: r.id, effort: effort === '__default' ? '' : effort });
  };

  return (
    <View style={{ gap: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginHorizontal: -4 }}>
        <IconButton onPress={onBack} label="Volver al orquestador">
          <Icon name="arrow-left" size={20} color={c.inkBody} />
        </IconButton>
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink }}>Ajustes del orquestador</Text>
      </View>

      <Section>
        <Row
          title="Orquestador activo"
          detail={orch.lxo_exists ? 'Los agentes del IDE se coordinan con /orquestar' : 'Falta lxo junto a Lixbon: reinstala la app de escritorio'}
          right={<Toggle value={orch.enabled} onChange={(on) => send('enable', { on })} label="Orquestador activo" />}
        />
      </Section>

      <Section title="Quién hace cada rol" delay={40}>
        {orch.roles.map((r) => (
          <Row
            key={r.id}
            title={r.label}
            value={`${r.model}${r.effort ? ` · ${EFFORT[r.effort] || r.effort}` : ''}`}
            onPress={() => editRole(r)}
          />
        ))}
      </Section>

      <Section title="Avisarme cuando" delay={80}>
        {[
          ['notify_questions', 'Un agente espera respuesta', 'Se queda parado hasta que decidas'],
          ['notify_phases', 'Termina una fase', 'Cada paso intermedio de una tarea'],
          ['notify_done', 'Entrega su informe', 'O cuando su terminal se cierra'],
        ].map(([k, label, hint]) => (
          <Row key={k} title={label} detail={hint} right={<Toggle value={!!orch.settings[k]} onChange={(v) => send('settings', { [k]: v })} label={label} />} />
        ))}
      </Section>

      <Section title="Agentes instalados" delay={120}>
        {state.orchAgents === null && <Row title="Consultando a cada agente…" />}
        {state.orchAgents?.length === 0 && <Row title="El IDE no encontró ningún agente compatible" />}
        {state.orchAgents?.map((a) => (
          <Row key={a.id} title={a.label} detail={a.strengths || (a.models.length ? a.models.slice(0, 6).join(', ') : 'No lista modelos')} />
        ))}
        <Row title="Volver a consultar" icon="refresh" onPress={() => send('agents', { refresh: true })} chevron={false} />
      </Section>

      <Text style={{ paddingHorizontal: 4, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
        Los agentes del IDE lo activan con <Text style={{ fontFamily: FONTS.mono, color: c.ink70 }}>/orquestar</Text>.
      </Text>
    </View>
  );
}

// ── Vista ───────────────────────────────────────────────────────────────────

export default function RemoteOrch({ state, sendCommand }) {
  const c = useColors();
  const { toast } = useDialogs();
  const [view, setView] = useState('runs');
  const [taskId, setTaskId] = useState(null);
  const send = useMemo(() => (action, args) => sendCommand({ type: 'orch', action, args }, { quiet: true }), [sendCommand]);
  const orch = state.orch;
  const task = taskId && orch?.tasks.find((x) => x.id === taskId);

  useEffect(() => {
    if (state.orchError) toast(state.orchError.message);
  }, [state.orchError, toast]);

  let body;
  if (!orch) {
    body = (
      <View style={{ alignItems: 'center', gap: 14, paddingVertical: 48 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkMuted }}>Cargando el orquestador…</Text>
        <PillButton size="sm" outline icon="refresh" label="Actualizar" onPress={() => send('refresh', {})} />
      </View>
    );
  } else if (!orch.enabled) {
    body = (
      <FadeUp style={{ alignItems: 'center', gap: 14, paddingVertical: 40, paddingHorizontal: 8 }}>
        <Text style={{ fontFamily: FONTS.serif, fontSize: 28, lineHeight: 33, color: c.ink, textAlign: 'center' }}>Orquestador de agentes</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 22, color: c.inkMuted, textAlign: 'center' }}>
          Un chat del IDE coordina a un equipo de agentes (Claude Code, Codex, Gemini…): reparte el objetivo, elige quién hace cada parte, espera sus informes y te cuenta el resultado.
        </Text>
        <PillButton label="Activar en el IDE" onPress={() => send('enable', { on: true })} style={{ marginTop: 6 }} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkFaint }}>Experimental</Text>
      </FadeUp>
    );
  } else if (task) {
    body = <TaskDetail key={task.id} task={task} state={state} send={send} onBack={() => setTaskId(null)} />;
  } else if (view === 'settings') {
    body = <Settings state={state} send={send} onBack={() => setView('runs')} />;
  } else {
    body = (
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
          <Text style={{ flex: 1, paddingLeft: 4, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{orch.workspace || ''}</Text>
          <IconButton onPress={() => setView('settings')} label="Ajustes del orquestador">
            <Icon name="gear" size={19} color={c.inkBody} />
          </IconButton>
        </View>
        <Runs state={state} send={send} onOpen={setTaskId} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {body}
    </ScrollView>
  );
}
