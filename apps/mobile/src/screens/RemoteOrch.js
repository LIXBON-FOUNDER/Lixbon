// RemoteOrch.js — el orquestador de agentes del IDE, visto desde el control
// remoto de la app. El IDE manda un snapshot (`state.orch`) cada vez que cambia
// y atiende las acciones que se le piden (`orch` + action): parar una tarea,
// ver su terminal o su diff, cambiar el modelo de un rol… Aquí solo se pinta
// y se pide, con los componentes de la app (tarjetas, hojas, interruptores).
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import Icon from '../components/Icon';
import WaveText from '../components/WaveText';
import { useDialogs } from '../components/dialogs';
import { Card, Eyebrow, PillButton, Segmented, Toggle, useColors } from '../components/ui';
import { FONTS, RADIUS } from '../theme';

const FINAL = ['done', 'failed', 'stopped', 'exited'];
const isFinal = (st) => FINAL.includes(st);
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini', lixbon: 'Lixbon', coordinador: 'Coordinador' };
const STATUS = { starting: 'Arrancando', running: 'Trabajando', waiting: 'Esperando respuesta', done: 'Terminada', failed: 'Fallida', stopped: 'Detenida', exited: 'Cerrada' };
const ROLE = { explorador: 'Explorador', implementador: 'Implementador', revisor: 'Revisor', escalado: 'Escalado' };
const KIND = { phase: 'Fase', done: 'Entrega', question: 'Pregunta', reply: 'Respuesta', note: 'Nota', exited: 'Cerrada' };
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

function tree(tasks, run) {
  const list = tasks.filter((t) => t.run === run);
  const kids = new Map();
  for (const t of list) {
    const k = t.parent || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t);
  }
  const out = [];
  const walk = (p) => (kids.get(p) || []).sort((a, b) => a.created - b.created).forEach((t) => { out.push(t); walk(t.id); });
  walk('');
  return out;
}

function pendingQuestions(messages) {
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.reply_to));
  return messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
}

/** Estado de una tarea: caja redondeada que cambia con el estado. */
function Status({ status, size = 14 }) {
  const c = useColors();
  const ring = (color) => ({ width: size, height: size, borderRadius: 4, borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' });
  if (status === 'running' || status === 'starting') {
    return (
      <View style={ring(c.accent)}>
        {status === 'running' && <View style={{ width: size * 0.4, height: size * 0.4, borderRadius: 2, backgroundColor: c.accent }} />}
      </View>
    );
  }
  if (status === 'stopped') return <View style={ring(c.inkFaint)} />;
  const bg = status === 'done' ? c.good : status === 'waiting' ? c.warn : status === 'failed' || status === 'exited' ? c.danger : c.surface5;
  return <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: bg }} />;
}

function Pill({ children, tone }) {
  const c = useColors();
  const bg = tone === 'ok' ? 'rgba(134,214,148,0.14)' : tone === 'ask' ? c.warnSoft : c.surface4;
  const fg = tone === 'ok' ? c.good : tone === 'ask' ? c.warn : c.inkSoft;
  return (
    <View style={{ paddingHorizontal: 7, height: 20, borderRadius: 5, backgroundColor: bg, justifyContent: 'center' }}>
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 11, color: fg }}>{children}</Text>
    </View>
  );
}

function Link({ icon, label, onPress, danger }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.6 : 1 })}>
      {icon && <Icon name={icon} size={14} color={danger ? c.danger : c.inkSoft} />}
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: danger ? c.danger : c.inkSoft }}>{label}</Text>
    </Pressable>
  );
}

const mono = (c) => ({ fontFamily: FONTS.mono, fontSize: 11.5, lineHeight: 17, color: c.inkBody });

// ── Detalle de una tarea ────────────────────────────────────────────────────

function Activity({ task, orch }) {
  const c = useColors();
  const name = (id) => orch.tasks.find((x) => x.id === id)?.title || id;
  const mine = orch.messages.filter((m) => m.from === task.id || m.to === task.id);
  const open = pendingQuestions(orch.messages).filter((q) => q.to === task.id || q.from === task.id);
  const body = { fontFamily: FONTS.ui, fontSize: 14, lineHeight: 21, color: c.inkBody };
  return (
    <View style={{ gap: 18 }}>
      {open.map((q) => (
        <View key={q.id} style={{ padding: 12, borderRadius: RADIUS, backgroundColor: c.warnSoft, gap: 6 }}>
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 11.5, color: c.warn }}>Pregunta de {name(q.from)} para {name(q.to)}</Text>
          <Text style={[body, { color: c.ink }]}>{q.body}</Text>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>La responde el coordinador; si necesita tu decisión, te la pedirá en la conversación.</Text>
        </View>
      ))}
      {!!task.spec && <View style={{ gap: 8 }}><Eyebrow>Encargo</Eyebrow><Text selectable style={body}>{task.spec}</Text></View>}
      {!!task.summary && (
        <View style={{ gap: 8 }}>
          <Eyebrow>Resumen final</Eyebrow>
          <Text selectable style={body}>{task.summary}</Text>
          {task.files?.length > 0 && <Text style={[mono(c), { color: c.inkMuted }]}>{task.files.join(' · ')}</Text>}
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Eyebrow>Fases</Eyebrow>
        {task.phases?.length ? task.phases.map((p, i) => {
          const st = p.done ? 'done' : isFinal(task.status) ? 'stopped' : 'running';
          return (
            <View key={i} style={{ gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                <Status status={st} size={12} />
                <Text style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>{p.name}</Text>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>{p.done ? 'terminada' : st === 'running' ? 'en curso' : 'sin cerrar'}</Text>
              </View>
              {!!p.note && <Text style={{ marginLeft: 21, fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{p.note}</Text>}
            </View>
          );
        }) : <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Aún no ha informado de ninguna fase.</Text>}
      </View>
      <View style={{ gap: 10 }}>
        <Eyebrow>Mensajes</Eyebrow>
        {mine.length ? mine.slice().reverse().map((m) => (
          <View key={m.id} style={{ gap: 3 }}>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>
              <Text style={{ fontFamily: FONTS.uiSemiBold, color: c.inkSoft }}>{KIND[m.kind] || m.kind}</Text> {name(m.from)} → {name(m.to)}
            </Text>
            <Text selectable style={[body, { fontSize: 13.5 }]}>{m.body}</Text>
          </View>
        )) : <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Sin mensajes todavía.</Text>}
      </View>
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
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{live ? 'En vivo · se actualiza sola' : 'La terminal ya se cerró'}</Text>
        <Link icon="refresh" label="Actualizar" onPress={() => send('term', { task: task.id })} />
      </View>
      <ScrollView horizontal={false} nestedScrollEnabled style={{ maxHeight: 420, borderRadius: RADIUS, backgroundColor: c.codeBg }} contentContainerStyle={{ padding: 12 }}>
        <Text selectable style={[mono(c), { color: '#D6D6D3' }]}>{term ? term.text || 'Sin salida todavía.' : 'Cargando…'}</Text>
      </ScrollView>
    </View>
  );
}

function Diff({ task, state, send }) {
  const c = useColors();
  const d = state.orchDiff[task.id];
  useEffect(() => { send('diff', { task: task.id }); }, [task.id, task.updated, send]);
  if (!d) return <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Cargando…</Text>;
  const lines = (d.diff || '').split('\n').slice(0, 1500);
  return (
    <View style={{ gap: 10 }}>
      <Text selectable style={[mono(c), { padding: 10, borderRadius: RADIUS, backgroundColor: c.surface2, color: c.inkSoft }]}>{d.stat || 'Sin commits nuevos en la rama.'}</Text>
      {lines.length > 1 && (
        <View style={{ borderRadius: RADIUS, backgroundColor: c.codeBg, paddingVertical: 8 }}>
          {lines.map((l, i) => {
            const add = l.startsWith('+') && !l.startsWith('+++');
            const del = l.startsWith('-') && !l.startsWith('---');
            return (
              <Text
                key={i}
                style={[mono(c), {
                  paddingHorizontal: 10, fontSize: 11,
                  color: add ? '#9BD59A' : del ? '#E79A86' : l.startsWith('@@') ? '#8EC5FF' : l.startsWith('diff ') ? '#F2F2EE' : '#BDBDB8',
                  backgroundColor: add ? 'rgba(110,158,62,0.14)' : del ? 'rgba(196,85,61,0.14)' : 'transparent',
                }]}
              >
                {l || ' '}
              </Text>
            );
          })}
        </View>
      )}
      {(d.truncated || (d.diff || '').split('\n').length > 1500) && (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>El diff es muy largo: se muestra solo el principio.</Text>
      )}
    </View>
  );
}

function TaskDetail({ task, state, send, onBack }) {
  const c = useColors();
  const { confirm } = useDialogs();
  const orch = state.orch;
  const [tab, setTab] = useState('activity');
  const final = isFinal(task.status);
  const now = useNow(!final);
  const parent = task.parent ? orch.tasks.find((x) => x.id === task.parent) : null;
  const stop = async () => {
    const ok = await confirm({ title: 'Detener la tarea', message: `«${task.title}» dejará de trabajar. El coordinador recibe el aviso.`, confirmLabel: 'Detener', danger: true });
    if (ok) send('stop', { task: task.id });
  };
  return (
    <View style={{ gap: 14 }}>
      <Link icon="arrow-left" label="Runs" onPress={onBack} />
      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Status status={task.status} size={18} />
          <Text style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}>{task.title || task.id}</Text>
        </View>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 19, color: c.inkMuted }}>
          {STATUS[task.status] || task.status} · {elapsed(task, now)} · {task.role ? `${ROLE[task.role] || task.role} · ` : ''}{AGENTS[task.agent] || task.agent}
          {task.model ? ` (${task.model}${task.effort ? `, ${task.effort}` : ''})` : ''}
          {parent ? ` · hija de ${parent.title || parent.id}` : ' · coordinador'}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          {!!task.branch && <Text style={[mono(c), { fontSize: 11, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, backgroundColor: c.surface3, color: c.inkSoft }]}>{task.branch}</Text>}
          {task.merged && <Pill tone="ok">fusionada</Pill>}
          {!!task.pr_url && <Link icon="external" label="Ver PR" onPress={() => Linking.openURL(task.pr_url)} />}
          {!final && parent && <Link icon="stop" label="Detener" danger onPress={stop} />}
        </View>
      </Card>
      <Segmented
        stretch
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'activity', label: 'Actividad' },
          ...(task.parent ? [{ value: 'term', label: 'Terminal' }] : []),
          ...(task.branch ? [{ value: 'diff', label: 'Cambios' }] : []),
        ]}
      />
      {tab === 'activity' && <Activity task={task} orch={orch} />}
      {tab === 'term' && <Terminal task={task} state={state} send={send} />}
      {tab === 'diff' && <Diff task={task} state={state} send={send} />}
    </View>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────

function Runs({ state, send, onOpen }) {
  const c = useColors();
  const { confirm } = useDialogs();
  const orch = state.orch;
  const asking = useMemo(() => new Set(pendingQuestions(orch.messages).map((q) => q.from)), [orch.messages]);
  const now = useNow(orch.tasks.some((x) => !isFinal(x.status)), 5000);
  if (!orch.runs.length) {
    return (
      <View style={{ alignItems: 'center', gap: 12, paddingVertical: 40, paddingHorizontal: 16 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkSoft, textAlign: 'center' }}>Todavía no hay runs. Escribe en la conversación:</Text>
        <Text style={[mono(c), { paddingHorizontal: 10, paddingVertical: 6, borderRadius: RADIUS, backgroundColor: c.surface3, color: c.ink }]}>/orquestar &lt;objetivo&gt;</Text>
      </View>
    );
  }
  const remove = async (r) => {
    const ok = await confirm({ title: 'Quitar el run', message: 'Se quita de la lista; las ramas se quedan en el repositorio.', confirmLabel: 'Quitar', danger: true });
    if (ok) send('remove_run', { run: r.id });
  };
  return (
    <View style={{ gap: 14 }}>
      {orch.runs.map((r) => {
        const tasks = tree(orch.tasks, r.id);
        const kids = tasks.filter((x) => x.parent);
        const done = kids.filter((x) => x.status === 'done').length;
        const bad = kids.filter((x) => x.status === 'failed' || x.status === 'exited').length;
        const root = tasks.find((x) => !x.parent);
        const working = root && !isFinal(root.status);
        return (
          <View key={r.id} style={{ borderRadius: RADIUS, backgroundColor: c.surface1, padding: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 10 }}>
              <View style={{ flex: 1, gap: 4 }}>
                {working
                  ? <WaveText text={r.objective} color={c.ink} accent={c.accent} style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5 }} />
                  : <Text numberOfLines={2} style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{r.objective}</Text>}
                <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>{r.repo}{kids.length ? ` · ${done} de ${kids.length} tareas` : ''}</Text>
                {kids.length > 0 && (
                  <View style={{ flexDirection: 'row', height: 4, borderRadius: 3, backgroundColor: c.surface4, overflow: 'hidden', marginTop: 2 }}>
                    <View style={{ width: `${(done / kids.length) * 100}%`, backgroundColor: c.good }} />
                    <View style={{ width: `${(bad / kids.length) * 100}%`, backgroundColor: c.danger }} />
                  </View>
                )}
              </View>
              <Pressable onPress={() => remove(r)} hitSlop={10} accessibilityLabel="Quitar este run">
                <Icon name="trash" size={16} color={c.inkFaint} />
              </Pressable>
            </View>
            {tasks.map((x) => {
              const phase = x.phases?.[x.phases.length - 1];
              return (
                <Pressable
                  key={x.id}
                  onPress={() => onOpen(x.id)}
                  style={({ pressed }) => ({
                    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 7,
                    paddingRight: 8, paddingLeft: 8 + x.depth * 16, borderRadius: RADIUS, backgroundColor: pressed ? c.surface3 : 'transparent',
                  })}
                >
                  <Status status={x.status} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkBody }}>{x.title || x.id}</Text>
                    <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>
                      {x.role ? `${ROLE[x.role] || x.role} · ` : ''}{AGENTS[x.agent] || x.agent}{x.model ? ` · ${x.model}` : ''}{phase && !isFinal(x.status) ? ` · ${phase.name}` : ''}
                    </Text>
                  </View>
                  {asking.has(x.id) && <Pill tone="ask">?</Pill>}
                  <Text style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkFaint }}>{elapsed(x, now)}</Text>
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

function Row({ label, hint, children, badge }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 }}>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{label}</Text>
          {badge}
        </View>
        {!!hint && <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 18, color: c.inkMuted }}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

function Picker({ value, onPress }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 10, borderRadius: RADIUS, backgroundColor: pressed ? c.surface4 : c.surface3 })}>
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: c.ink }}>{value}</Text>
      <Icon name="chevron-down" size={13} color={c.inkMuted} />
    </Pressable>
  );
}

function Settings({ state, send }) {
  const c = useColors();
  const { sheet } = useDialogs();
  const orch = state.orch;
  useEffect(() => { if (state.orchAgents === null) send('agents', {}); }, [state.orchAgents, send]);
  const claude = state.orchAgents?.find((a) => a.id === 'claude');
  const models = claude?.models?.length ? claude.models : ['haiku', 'sonnet', 'opus'];
  const efforts = claude?.efforts?.length ? claude.efforts : Object.keys(EFFORT);

  const pickModel = async (r) => {
    const model = await sheet({
      title: `Modelo del ${r.label.toLowerCase()}`,
      items: [...new Set([...models, r.model])].map((m) => ({ label: m, value: m, mono: true, selected: m === r.model })),
    });
    if (model && model !== r.model) send('settings', { role: r.id, model });
  };
  const pickEffort = async (r) => {
    const effort = await sheet({
      title: `Esfuerzo del ${r.label.toLowerCase()}`,
      items: [{ label: 'Por defecto', value: '__default', selected: !r.effort }, ...efforts.map((e) => ({ label: EFFORT[e] || e, value: e, selected: e === r.effort }))],
    });
    if (effort) send('settings', { role: r.id, effort: effort === '__default' ? '' : effort });
  };
  const sep = { height: 1, backgroundColor: c.surface3 };

  return (
    <View style={{ gap: 12 }}>
      <Card style={{ paddingVertical: 4 }}>
        <Row label="Orquestador activo" hint={orch.lxo_exists ? 'Los agentes del IDE pueden coordinarse con /orquestar.' : 'Falta lxo junto al ejecutable de Lixbon: reinstala la app de escritorio.'}>
          <Toggle value={orch.enabled} onChange={(on) => send('enable', { on })} label="Orquestador activo" />
        </Row>
      </Card>

      <Eyebrow style={{ marginTop: 8 }}>Roles del equipo</Eyebrow>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 18, color: c.inkMuted }}>El coordinador lanza a cada hija por rol, con el modelo y el esfuerzo que elijas aquí.</Text>
      <Card style={{ paddingVertical: 4 }}>
        {orch.roles.map((r, i) => (
          <View key={r.id}>
            {i > 0 && <View style={sep} />}
            <View style={{ paddingVertical: 12, gap: 10 }}>
              <View style={{ gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{r.label}</Text>
                  {r.read_only && <Pill tone="ok">Solo lectura</Pill>}
                </View>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 18, color: c.inkMuted }}>{r.purpose}</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Picker value={r.model} onPress={() => pickModel(r)} />
                <Picker value={r.effort ? `Esfuerzo ${(EFFORT[r.effort] || r.effort).toLowerCase()}` : 'Esfuerzo por defecto'} onPress={() => pickEffort(r)} />
              </View>
            </View>
          </View>
        ))}
      </Card>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <Eyebrow>Agentes instalados</Eyebrow>
        <Link icon="refresh" label="Volver a consultar" onPress={() => send('agents', { refresh: true })} />
      </View>
      <Card style={{ paddingVertical: 4 }}>
        {state.orchAgents === null && <Text style={{ paddingVertical: 12, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Consultando a cada agente…</Text>}
        {state.orchAgents?.length === 0 && <Text style={{ paddingVertical: 12, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>El IDE no encontró ningún agente compatible.</Text>}
        {state.orchAgents?.map((a, i) => (
          <View key={a.id}>
            {i > 0 && <View style={sep} />}
            <View style={{ paddingVertical: 12, gap: 3 }}>
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{a.label}</Text>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{a.strengths}</Text>
              <Text numberOfLines={2} style={[mono(c), { color: c.inkLabel, fontSize: 11 }]}>{a.models.length ? a.models.slice(0, 8).join(', ') : 'No lista modelos'}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Eyebrow style={{ marginTop: 8 }}>Notificaciones del IDE</Eyebrow>
      <Card style={{ paddingVertical: 4 }}>
        {[
          ['notify_phases', 'Fase terminada', 'Cada vez que un agente cierra una fase de su tarea.'],
          ['notify_done', 'Tarea entregada o cerrada', 'Cuando un agente entrega su informe o su terminal se cierra.'],
          ['notify_questions', 'Preguntas al coordinador', 'Cuando un agente se queda esperando una decisión.'],
        ].map(([k, label, hint], i) => (
          <View key={k}>
            {i > 0 && <View style={sep} />}
            <Row label={label} hint={hint}>
              <Toggle value={!!orch.settings[k]} onChange={(v) => send('settings', { [k]: v })} label={label} />
            </Row>
          </View>
        ))}
      </Card>
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

  useEffect(() => { if (state.orchError) toast(state.orchError.message); }, [state.orchError, toast]);

  let body;
  if (!orch) {
    body = (
      <View style={{ alignItems: 'center', gap: 12, paddingVertical: 48 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>Cargando el orquestador…</Text>
        <Link icon="refresh" label="Actualizar" onPress={() => send('refresh', {})} />
      </View>
    );
  } else if (!orch.enabled) {
    body = (
      <View style={{ alignItems: 'center', gap: 14, paddingVertical: 40, paddingHorizontal: 12 }}>
        <Pill>Experimental</Pill>
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 19, color: c.ink }}>Orquestador de agentes</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14, lineHeight: 21, color: c.inkSoft, textAlign: 'center' }}>
          Un chat pasa a ser el coordinador de un equipo de agentes (Claude Code, Codex, Gemini…): reparte el objetivo, elige agente y modelo para cada tarea, espera sus informes, integra y te cuenta el resultado. Está desactivado en el IDE.
        </Text>
        <PillButton label="Activar en el IDE" onPress={() => send('enable', { on: true })} />
      </View>
    );
  } else if (task) {
    body = <TaskDetail key={task.id} task={task} state={state} send={send} onBack={() => setTaskId(null)} />;
  } else {
    body = (
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'runs', label: 'Runs' }, { value: 'settings', label: 'Ajustes' }]} />
          {!!orch.workspace && <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>{orch.workspace}</Text>}
        </View>
        {view === 'runs' ? <Runs state={state} send={send} onOpen={setTaskId} /> : <Settings state={state} send={send} />}
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {body}
    </ScrollView>
  );
}
