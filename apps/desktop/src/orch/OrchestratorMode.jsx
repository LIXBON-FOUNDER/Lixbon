// OrchestratorMode.jsx — modo Orquestador: runs y árbol de agentes a la
// izquierda; la tarea elegida (terminal en vivo, fases, diff y acciones) en el centro.
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useOrchStore, taskTree, isFinal, AGENT_LABELS, STATUS_LABELS } from '../store/orchStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { Segmented } from '../components/Segmented';
import { Select } from '../components/Select';
import { DiffView } from '../sections/SourceControl/DiffView';
import { AgentTerminal } from './AgentTerminal';
import { IconPlus, IconTrash, IconGitBranch } from '../components/Icons';

const agentLabel = (id) => AGENT_LABELS[id] || id;
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleDateString('es');
};

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** El run es del repo activo si su raíz está en esa carpeta (o la contiene: la
    carpeta abierta puede ser una subcarpeta del repositorio). */
const inRepo = (task, root) => {
  if (!task || !root) return false;
  const a = norm(task.repo);
  const b = norm(root);
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
};

/** Preguntas sin respuesta todavía. */
function pendingQuestions(messages = []) {
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.reply_to));
  return messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
}

function StatusDot({ status }) {
  return <span className={`orch__dot orch__dot--${status}`} title={STATUS_LABELS[status] || status} />;
}

function TaskRow({ task, selected, onSelect, asking }) {
  const phase = task.phases?.[task.phases.length - 1];
  return (
    <button className={`orch__task ${selected ? 'is-active' : ''}`} style={{ paddingLeft: 12 + task.depth * 16 }} onClick={() => onSelect(task.id)}>
      <StatusDot status={task.status} />
      <span className="orch__task-main">
        <span className="orch__task-title">{task.title || task.id}</span>
        <span className="orch__task-meta">
          <span className="mono">{task.id}</span> · {agentLabel(task.agent)}
          {phase ? ` · ${phase.name}${phase.done ? ' ✓' : '…'}` : ''}
        </span>
      </span>
      {asking && <span className="orch__badge orch__badge--ask" title="Tiene una pregunta sin responder">?</span>}
      {task.merged && <span className="orch__badge" title="Fusionada en su padre">✓</span>}
    </button>
  );
}

function NewRun({ onDone }) {
  const snap = useOrchStore((s) => s.snap);
  const newRun = useOrchStore((s) => s.newRun);
  const root = useAppStore((s) => s.workspaceRoot);
  const [objective, setObjective] = useState('');
  const [agent, setAgent] = useState(snap?.settings?.default_agent || 'claude');
  const [sending, setSending] = useState(false);
  const agents = Object.keys(snap?.settings?.launchers || {}).map((id) => ({ value: id, label: agentLabel(id) }));

  const start = async () => {
    if (!objective.trim() || !root) return;
    setSending(true);
    const res = await newRun(objective.trim(), agent, root);
    setSending(false);
    if (res) { setObjective(''); onDone?.(); }
  };

  return (
    <div className="orch__new">
      <span className="orch__new-title">Nuevo run</span>
      <span className="orch__hint">
        Un agente coordinador recibe el objetivo, lo divide en tareas y lanza agentes hijos, cada uno en su rama y su worktree.
        {!root && ' Abre antes una carpeta de trabajo (un repositorio git).'}
      </span>
      <textarea
        className="stextarea"
        rows={4}
        placeholder="Objetivo, p. ej.: Añadir inicio de sesión con GitHub, con tests y documentación"
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start(); }}
      />
      <div className="orch__new-row">
        <span className="orch__hint">Coordinador</span>
        <Select value={agent} onChange={setAgent} options={agents} title="Agente coordinador" />
        <div className="panelhead__fill" />
        <button className="btn btn--primary" disabled={!objective.trim() || !root || sending} onClick={start}>
          {sending ? 'Lanzando…' : 'Lanzar coordinador'}
        </button>
      </div>
      <span className="orch__hint">
        También puedes coordinar desde cualquier agente con la skill instalada: pídele «orquesta esto con lxo».
      </span>
    </div>
  );
}

function Activity({ task, messages, tasks }) {
  const call = useOrchStore((s) => s.call);
  const [drafts, setDrafts] = useState({});
  const [note, setNote] = useState('');
  const mine = messages.filter((m) => m.from === task.id || m.to === task.id);
  const open = pendingQuestions(messages).filter((q) => q.to === task.id || q.from === task.id);
  const name = (id) => (tasks[id] ? `${tasks[id].title || id}` : id);

  const reply = async (q) => {
    const answer = (drafts[q.id] || '').trim();
    if (!answer) return;
    if (await call('reply', { question: q.id, answer }, 'Respuesta enviada')) setDrafts((d) => ({ ...d, [q.id]: '' }));
  };

  return (
    <div className="orch__activity scroll">
      {open.map((q) => (
        <div key={q.id} className="orch__question">
          <span className="orch__q-eyebrow">Pregunta de {name(q.from)} para {name(q.to)}</span>
          <p>{q.body}</p>
          <div className="orch__q-row">
            <div className="field field--strong">
              <input
                value={drafts[q.id] || ''}
                placeholder="Responder en su lugar…"
                onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') reply(q); }}
              />
            </div>
            <button className="btn btn--primary" onClick={() => reply(q)}>Responder</button>
          </div>
        </div>
      ))}

      {task.spec && (
        <section className="orch__block">
          <span className="ssec__label">Encargo</span>
          <p className="orch__spec">{task.spec}</p>
        </section>
      )}

      {task.summary && (
        <section className="orch__block">
          <span className="ssec__label">Resumen final</span>
          <p className="orch__spec">{task.summary}</p>
          {task.files?.length > 0 && <span className="mono orch__hint">{task.files.join(' · ')}</span>}
        </section>
      )}

      <section className="orch__block">
        <span className="ssec__label">Fases</span>
        {task.phases?.length ? (
          <ol className="orch__phases">
            {task.phases.map((p, i) => (
              <li key={i} className={p.done ? 'is-done' : ''}>
                <span className="orch__phase-name">{p.name}</span>
                <span className="orch__phase-state">{p.done ? 'terminada' : 'empezada'} · {ago(p.at)}</span>
                {p.note && <span className="orch__phase-note">{p.note}</span>}
              </li>
            ))}
          </ol>
        ) : <span className="orch__hint">Aún no ha informado de ninguna fase.</span>}
      </section>

      <section className="orch__block">
        <span className="ssec__label">Mensajes</span>
        {mine.length ? (
          <ul className="orch__msgs">
            {mine.slice().reverse().map((m) => (
              <li key={m.id} className={`orch__msg orch__msg--${m.kind}`}>
                <span className="orch__msg-head">{m.kind} · {name(m.from)} → {name(m.to)} · {ago(m.at)}</span>
                <span>{m.body}</span>
              </li>
            ))}
          </ul>
        ) : <span className="orch__hint">Sin mensajes todavía.</span>}
      </section>

      {!isFinal(task.status) && task.parent && (
        <section className="orch__block">
          <span className="ssec__label">Enviar instrucciones</span>
          <div className="orch__q-row">
            <div className="field field--strong">
              <input value={note} placeholder="La tarea lo leerá en su próximo lxo check" onChange={(e) => setNote(e.target.value)}
                onKeyDown={async (e) => { if (e.key === 'Enter' && note.trim() && await call('send', { to: task.id, body: note.trim() }, 'Enviado')) setNote(''); }} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function DiffTab({ task }) {
  const call = useOrchStore((s) => s.call);
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('inline');
  useEffect(() => {
    let alive = true;
    setData(null);
    call('diff', { task: task.id }).then((d) => { if (alive) setData(d || { error: true }); });
    return () => { alive = false; };
  }, [task.id, task.updated, call]);
  if (!data) return <div className="changes__empty">Cargando diff…</div>;
  if (data.error) return <div className="changes__empty">No se pudo obtener el diff de esta tarea.</div>;
  return (
    <div className="orch__diff scroll">
      <div className="orch__diff-head">
        <pre className="mono orch__stat">{data.stat || 'Sin commits nuevos en la rama.'}</pre>
        <Segmented size="sm" value={mode} onChange={setMode} width={84} options={[{ value: 'split', label: 'Lado a lado' }, { value: 'inline', label: 'En línea' }]} />
      </div>
      <DiffView mode={mode} patch={data.diff || ''} />
    </div>
  );
}

function TaskView({ task, snap }) {
  const call = useOrchStore((s) => s.call);
  const busy = useOrchStore((s) => s.busy);
  const [tab, setTab] = useState('term');
  const live = snap.live.includes(task.id);
  const parent = task.parent ? snap.tasks[task.parent] : null;
  const final = isFinal(task.status);
  const is = (cmd) => busy === `${cmd}:${task.id}`;

  useEffect(() => { if (!task.branch && tab === 'diff') setTab('term'); }, [task.id, task.branch, tab]);

  return (
    <>
      <div className="panelhead orch__head">
        <StatusDot status={task.status} />
        <div className="orch__head-text">
          <span className="panelhead__title">{task.title || task.id}</span>
          <span className="panelhead__meta">
            <span className="mono">{task.id}</span> · {agentLabel(task.agent)} · {STATUS_LABELS[task.status] || task.status}
            {parent ? ` · hija de ${parent.title || parent.id}` : ' · coordinador'}
            {task.branch && <> · <IconGitBranch size={11} /> <span className="mono">{task.branch}</span></>}
          </span>
        </div>
        <div className="panelhead__fill" />
        {task.pr_url && <a className="lk" href={task.pr_url} target="_blank" rel="noreferrer">Ver PR</a>}
        {parent && task.branch && !task.merged && (
          <button className="lk is-accent" disabled={is('merge')} onClick={() => call('merge', { task: task.id, force: !final }, `Fusionada en ${parent.title || parent.id}`)}>
            {is('merge') ? 'Fusionando…' : 'Fusionar en el padre'}
          </button>
        )}
        {parent && task.branch && !task.pr_url && (
          <button className="lk" disabled={is('pr')} onClick={() => call('pr', { task: task.id }, (r) => `PR abierto: ${r.url}`)}>{is('pr') ? 'Abriendo PR…' : 'Abrir PR'}</button>
        )}
        {!final && <button className="lk is-danger" onClick={() => call('stop', { task: task.id }, 'Tarea detenida')}>Detener</button>}
        {final && task.worktree && (
          <button className="lk" disabled={is('release')} onClick={() => call('release', { task: task.id }, 'Worktree liberado')}>Liberar worktree</button>
        )}
      </div>
      <div className="orch__tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          width={96}
          options={[
            { value: 'term', label: 'Terminal' },
            { value: 'activity', label: 'Actividad' },
            ...(task.branch ? [{ value: 'diff', label: 'Cambios' }] : []),
          ]}
        />
        {task.worktree && <span className="mono orch__hint orch__path" title={task.worktree}>{task.worktree}</span>}
      </div>
      <div className="orch__body">
        {tab === 'term' && (task.external
          ? <div className="changes__empty">Este coordinador corre fuera de Lixbon, en su propia terminal. Aquí ves su árbol, sus mensajes y sus hijas.</div>
          : <AgentTerminal key={task.id} task={task.id} live={live} />)}
        {tab === 'activity' && <Activity task={task} messages={snap.messages} tasks={snap.tasks} />}
        {tab === 'diff' && <DiffTab task={task} />}
      </div>
    </>
  );
}

function Disabled() {
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  return (
    <div className="orch__off">
      <span className="orch__badge-exp">Experimental</span>
      <h2>Orquestador de agentes</h2>
      <p>
        Reparte un objetivo entre varios agentes (Claude Code, Codex, OpenCode, Lixbon…). Un coordinador crea tareas hijas,
        cada una en su propia terminal, rama y worktree; te avisa al terminar cada fase y tú decides qué se fusiona.
      </p>
      <button className="btn btn--primary" onClick={() => openSettings('orch')}>Activar en Ajustes</button>
    </div>
  );
}

export function OrchestratorMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const open = useWorkbenchStore((s) => s.modePanels.orch?.left ?? true);
  const { snap, selected, select, init, call } = useOrchStore();
  const [creating, setCreating] = useState(false);
  const [allRepos, setAllRepos] = useState(false);
  const root = useAppStore((s) => s.workspaceRoot);

  useEffect(() => { init(); }, [init]);

  const allRuns = useMemo(() => Object.values(snap?.runs || {}).sort((a, b) => b.created - a.created), [snap]);
  const runs = useMemo(
    () => (allRepos ? allRuns : allRuns.filter((r) => inRepo(snap?.tasks?.[r.root], root))),
    [allRuns, allRepos, root, snap],
  );
  const hidden = allRuns.length - runs.length;
  const asking = useMemo(() => new Set(pendingQuestions(snap?.messages).map((q) => q.from)), [snap]);
  const task = selected && snap?.tasks?.[selected];

  if (!snap) return <div className="wb"><div className="changes__empty">Cargando el orquestador…</div></div>;
  if (!snap.settings?.enabled) return <div className="wb wb--orch"><Disabled /></div>;

  return (
    <div className="wb wb--orch">
      <Collapse open={open} size={Math.max(sizes.side, 300) + 6}>
        <Panel id="orchtree" className="sidepanel orch__side">
          <div className="panelhead">
            <span className="panelhead__title">{allRepos ? 'Runs · todos los repos' : `Runs · ${root ? root.split(/[\\/]/).pop() : 'sin carpeta'}`}</span>
            <div className="panelhead__fill" />
            <button className="ic" title="Nuevo run" onClick={() => { setCreating(true); select(null); }}><IconPlus size={14} /></button>
          </div>
          <div className="orch__runs scroll">
            {!runs.length && <div className="changes__empty">Todavía no hay runs en este repositorio. Crea uno, escribe /orquestar en el chat o pide a un agente con la skill que orqueste una tarea.</div>}
            {runs.map((r) => (
              <section key={r.id} className="orch__run">
                <div className="orch__run-head">
                  <span className="orch__run-title" title={r.objective}>{r.objective}</span>
                  <button className="ic" title="Quitar este run de la lista (no borra ramas)" onClick={() => call('remove_run', { run: r.id })}><IconTrash size={12} /></button>
                </div>
                {taskTree(snap.tasks, r.id).map((t) => (
                  <TaskRow key={t.id} task={t} selected={t.id === selected} asking={asking.has(t.id)} onSelect={(id) => { setCreating(false); select(id); }} />
                ))}
              </section>
            ))}
          </div>
          {(hidden > 0 || allRepos) && (
            <button className="lk orch__repos" onClick={() => setAllRepos((v) => !v)}>
              {allRepos ? 'Ver solo este repositorio' : `Ver también ${hidden} run${hidden === 1 ? '' : 's'} de otros repos`}
            </button>
          )}
          {!snap.lxo_exists && <div className="orch__warn">No se encontró <span className="mono">lxo</span> junto a Lixbon: los agentes no podrán hablar con el orquestador.</div>}
        </Panel>
        <Gutter sizeKey="side" />
      </Collapse>
      <Panel id="orchmain" className="wb__grow orch__main">
        {task && !creating ? <TaskView task={task} snap={snap} /> : <NewRun onDone={() => setCreating(false)} />}
      </Panel>
    </div>
  );
}
