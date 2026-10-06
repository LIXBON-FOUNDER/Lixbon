// OrchestratorMode.jsx — modo Orquestador: runs y árbol de agentes a la
// izquierda; la tarea elegida (terminal en vivo, fases, diff y acciones) en el centro.
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useOrchStore, taskTree, isFinal, AGENT_LABELS, STATUS_LABELS, ROLE_LABELS } from '../store/orchStore';
import { Panel } from '../layout/Panel';
import { Gutter } from '../layout/Gutter';
import { Collapse } from '../layout/Collapse';
import { Segmented } from '../components/Segmented';
import { DiffView } from '../sections/SourceControl/DiffView';
import { AgentTerminal } from './AgentTerminal';
import { IconTrash, IconGitBranch } from '../components/Icons';
import { useFileViewStore } from '../store/fileViewStore';

const agentLabel = (id) => AGENT_LABELS[id] || id;
const KIND_LABELS = { phase: 'Fase', done: 'Entrega', question: 'Pregunta', reply: 'Respuesta', note: 'Nota', exited: 'Cerrada' };
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

const duration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};

// Vuelve a pintar cada pocos segundos lo que muestra tiempo transcurrido.
function useNow(active, ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

const elapsed = (task, now) => duration((isFinal(task.status) ? task.updated : now) - task.created);

export function StatusIcon({ status, size = 14 }) {
  const busy = status === 'running' || status === 'starting';
  return (
    <span className={`orchst orchst--${status}`} style={{ width: size, height: size }} title={STATUS_LABELS[status] || status}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
        {busy && (
          <>
            <circle className="orchst__track" cx="8" cy="8" r="6.2" />
            <circle className="orchst__arc" cx="8" cy="8" r="6.2" />
            {status === 'running' && <circle className="orchst__core" cx="8" cy="8" r="2.3" />}
          </>
        )}
        {status === 'waiting' && (
          <>
            <circle className="orchst__ping" cx="8" cy="8" r="3" />
            <circle className="orchst__core" cx="8" cy="8" r="3" />
          </>
        )}
        {status === 'done' && (
          <>
            <circle className="orchst__fill" cx="8" cy="8" r="7" />
            <path className="orchst__check" d="M4.9 8.2l2.1 2.1 4.2-4.5" />
          </>
        )}
        {(status === 'failed' || status === 'exited') && (
          <>
            <circle className="orchst__fill" cx="8" cy="8" r="7" />
            <path className="orchst__mark" d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
          </>
        )}
        {status === 'stopped' && (
          <>
            <circle className="orchst__track" cx="8" cy="8" r="6.2" />
            <rect className="orchst__stop" x="5.6" y="5.6" width="4.8" height="4.8" rx="1" />
          </>
        )}
      </svg>
    </span>
  );
}

function TaskRow({ task, selected, onSelect, asking, now }) {
  const phase = task.phases?.[task.phases.length - 1];
  const final = isFinal(task.status);
  return (
    <button className={`orch__task orch__task--${task.status} ${selected ? 'is-active' : ''}`} style={{ paddingLeft: 12 + task.depth * 16 }} onClick={() => onSelect(task.id)}>
      <StatusIcon status={task.status} />
      <span className="orch__task-main">
        <span className="orch__task-title">{task.title || task.id}</span>
        <span className="orch__task-meta">
          {task.role ? `${ROLE_LABELS[task.role] || task.role} · ` : ''}{agentLabel(task.agent)}{task.model ? ` · ${task.model}` : ''}
          {phase && !final ? <> · <span className="orch__task-phase">{phase.name}</span></> : ''}
        </span>
      </span>
      {asking && <span className="orch__badge orch__badge--ask" title="Tiene una pregunta sin responder">?</span>}
      {task.merged && <span className="orch__badge" title="Fusionada en su padre">fusionada</span>}
      <span className="orch__task-time mono">{elapsed(task, now)}</span>
    </button>
  );
}

function RunProgress({ tasks }) {
  const kids = tasks.filter((t) => t.parent);
  if (!kids.length) return null;
  const done = kids.filter((t) => t.status === 'done').length;
  const bad = kids.filter((t) => t.status === 'failed' || t.status === 'exited').length;
  return (
    <div className="orch__progress" title={`${done} de ${kids.length} tareas terminadas${bad ? `, ${bad} con problemas` : ''}`}>
      <div className="orch__progress-bar">
        <span className="is-done" style={{ width: `${(done / kids.length) * 100}%` }} />
        <span className="is-bad" style={{ width: `${(bad / kids.length) * 100}%` }} />
      </div>
      <span className="orch__progress-text mono">{done}/{kids.length}</span>
    </div>
  );
}

function HowTo() {
  return (
    <div className="orch__new">
      <span className="orch__new-title">Cómo se orquesta</span>
      <span className="orch__hint">
        Escribe <span className="mono">/orquestar &lt;objetivo&gt;</span> en el chat del modo Agente, o en cualquier agente con la
        skill instalada (Claude Code, Cursor, OpenCode, Codex). Ese chat pasa a ser el <b>coordinador</b>: reparte el objetivo,
        elige qué agente y qué modelo hace cada tarea, espera sus informes, integra y te cuenta el resultado. Tú solo hablas con él.
      </span>
      <span className="orch__hint">
        Aquí puedes seguir qué hace cada agente: su terminal en vivo, sus fases, sus mensajes, su informe y sus cambios.
      </span>
    </div>
  );
}

function Activity({ task, messages, tasks }) {
  const openReport = () => {
    useWorkbenchStore.getState().setMode('editor');
    useFileViewStore.getState().open(task.report);
  };
  const mine = messages.filter((m) => m.from === task.id || m.to === task.id);
  const open = pendingQuestions(messages).filter((q) => q.to === task.id || q.from === task.id);
  const name = (id) => (tasks[id] ? `${tasks[id].title || id}` : id);

  return (
    <div className="orch__activity scroll">
      {open.map((q) => (
        <div key={q.id} className="orch__question">
          <span className="orch__q-eyebrow">Pregunta de {name(q.from)} para {name(q.to)}</span>
          <p>{q.body}</p>
          <span className="orch__hint">La responde el coordinador; si necesita tu decisión, te la pedirá en el chat.</span>
        </div>
      ))}

      {task.spec && (
        <section className="orch__block">
          <span className="ssec__label">Encargo</span>
          <p className="orch__spec">{task.spec}</p>
        </section>
      )}

      {task.report && (
        <section className="orch__block">
          <span className="ssec__label">Informe</span>
          <button className="lk is-accent orch__report" onClick={openReport} title={task.report}>Abrir {task.report.split(/[\\/]/).pop()}</button>
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
            {task.phases.map((p, i) => {
              const state = p.done ? 'done' : isFinal(task.status) ? 'stopped' : 'running';
              return (
                <li key={i} className={`is-${state}`}>
                  <StatusIcon status={state} size={13} />
                  <span className="orch__phase-name">{p.name}</span>
                  <span className="orch__phase-state">{p.done ? 'terminada' : state === 'running' ? 'en curso' : 'sin cerrar'} · {ago(p.at)}</span>
                  {p.note && <span className="orch__phase-note">{p.note}</span>}
                </li>
              );
            })}
          </ol>
        ) : <span className="orch__hint">Aún no ha informado de ninguna fase.</span>}
      </section>

      <section className="orch__block">
        <span className="ssec__label">Mensajes</span>
        {mine.length ? (
          <ul className="orch__msgs">
            {mine.slice().reverse().map((m) => (
              <li key={m.id} className={`orch__msg orch__msg--${m.kind}`}>
                <span className="orch__msg-head"><span className="orch__msg-kind">{KIND_LABELS[m.kind] || m.kind}</span>{name(m.from)} → {name(m.to)} · {ago(m.at)}</span>
                <span>{m.body}</span>
              </li>
            ))}
          </ul>
        ) : <span className="orch__hint">Sin mensajes todavía.</span>}
      </section>

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
  const [tab, setTab] = useState(task.parent ? 'term' : 'activity');
  const live = snap.live.includes(task.id);
  const parent = task.parent ? snap.tasks[task.parent] : null;
  const final = isFinal(task.status);
  const now = useNow(!final, 1000);

  useEffect(() => { if (!task.branch && tab === 'diff') setTab('term'); }, [task.id, task.branch, tab]);

  return (
    <>
      <div className="panelhead orch__head">
        <StatusIcon status={task.status} size={18} />
        <div className="orch__head-text">
          <span className="panelhead__title">{task.title || task.id}</span>
          <span className="panelhead__meta">
            <span className={`orch__state orch__state--${task.status}`}>{STATUS_LABELS[task.status] || task.status} · {elapsed(task, now)}</span>
            <span className="mono">{task.id}</span> · {task.role ? `${ROLE_LABELS[task.role] || task.role} · ` : ''}{agentLabel(task.agent)}{task.model ? ` (${task.model}${task.effort ? `, ${task.effort}` : ''})` : ''}
            {parent ? ` · hija de ${parent.title || parent.id}` : ' · coordinador'}
            {task.branch && <> · <IconGitBranch size={11} /> <span className="mono">{task.branch}</span></>}
          </span>
        </div>
        <div className="panelhead__fill" />
        {task.pr_url && <a className="lk" href={task.pr_url} target="_blank" rel="noreferrer">Ver PR</a>}
        {task.merged && <span className="orch__pill is-ok">Fusionada</span>}
        {!final && parent && (
          <button className="lk is-danger" title="Solo para emergencias: el coordinador recibe el aviso" onClick={() => call('stop', { task: task.id }, 'Tarea detenida')}>Detener</button>
        )}
      </div>
      <div className="orch__tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          width={96}
          options={[
            ...(task.parent ? [{ value: 'term', label: 'Terminal' }] : []),
            { value: 'activity', label: 'Actividad' },
            ...(task.branch ? [{ value: 'diff', label: 'Cambios' }] : []),
          ]}
        />
        {task.worktree && <span className="mono orch__hint orch__path" title={task.worktree}>{task.worktree}</span>}
      </div>
      <div className="orch__body">
        {tab === 'term' && task.parent && <AgentTerminal key={task.id} task={task.id} live={live} />}
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
        Un chat pasa a ser el coordinador de un equipo de agentes (Claude Code, Codex, Cursor, OpenCode…): reparte el
        objetivo, elige agente y modelo para cada tarea, espera sus informes, integra y te cuenta el resultado.
      </p>
      <button className="btn btn--primary" onClick={() => openSettings('orch')}>Activar en Ajustes</button>
    </div>
  );
}

export function OrchestratorMode() {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const open = useWorkbenchStore((s) => s.modePanels.orch?.left ?? true);
  const { snap, selected, select, init, call } = useOrchStore();
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
  const anyLive = useMemo(() => Object.values(snap?.tasks || {}).some((t) => !isFinal(t.status)), [snap]);
  const now = useNow(anyLive);

  if (!snap) return <div className="wb"><div className="changes__empty">Cargando el orquestador…</div></div>;
  if (!snap.settings?.enabled) return <div className="wb wb--orch"><Disabled /></div>;

  return (
    <div className="wb wb--orch">
      <Collapse open={open} size={Math.max(sizes.side, 300) + 6}>
        <Panel id="orchtree" className="sidepanel orch__side">
          <div className="panelhead">
            <span className="panelhead__title">{allRepos ? 'Runs · todos los repos' : `Runs · ${root ? root.split(/[\\/]/).pop() : 'sin carpeta'}`}</span>
          </div>
          <div className="orch__runs scroll">
            {!runs.length && <div className="changes__empty">Todavía no hay runs en este repositorio. Escribe /orquestar &lt;objetivo&gt; en el chat.</div>}
            {runs.map((r) => (
              <section key={r.id} className="orch__run">
                <div className="orch__run-head">
                  <span className="orch__run-title" title={r.objective}>{r.objective}</span>
                  <RunProgress tasks={taskTree(snap.tasks, r.id)} />
                  <button className="ic" title="Quitar este run de la lista (no borra ramas)" onClick={() => call('remove_run', { run: r.id })}><IconTrash size={12} /></button>
                </div>
                {taskTree(snap.tasks, r.id).map((t) => (
                  <TaskRow key={t.id} task={t} now={now} selected={t.id === selected} asking={asking.has(t.id)} onSelect={select} />
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
        {task ? <TaskView key={task.id} task={task} snap={snap} /> : <HowTo />}
      </Panel>
    </div>
  );
}
