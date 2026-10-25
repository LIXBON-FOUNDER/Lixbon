// PreviewWorkspace.jsx — el Intento elegido: qué pasa ahora, su ciclo de vida, su actividad y cómo hablarle.
// No es una pared de mensajes: órdenes y ediciones se agrupan y se pliegan; arriba va el momento del trabajo.
import { useEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { usePreviewStore, attemptById, taskOf, projectOf, attemptsOfTask, attentionFor, timelineOf } from './previewStore';
import { PROOF_PACKS } from './previewData';
import { Mark, StatePill, Agent, Loc, I, AttnFlag, Tabs } from './PreviewUi';
import { stateLabel, agentName, hostOf, policyName, attemptName, money, kTokens } from './previewVocab';
import { AttentionCard } from './PreviewAttention';
import { PreviewComposer } from './PreviewComposer';

// Cada fase tiene dueño: así se ve dónde entra una persona (los roles del equipo como compuertas).
const STAGES = [
  { label: 'Preparar', owner: 'coordinador' },
  { label: 'Ejecutar', owner: 'agente' },
  { label: 'Verificar', owner: 'pruebas' },
  { label: 'Revisar', owner: 'tú' },
  { label: 'Integrar', owner: 'tú' },
];

function stageIndex(a) {
  if (a.state === 'review_ready') return 3;
  if (a.state === 'completed') return 4;
  if (a.state === 'failed') return 2;
  if (a.state === 'waiting' || a.state === 'offline') return 1;
  if (a.state === 'working' && a.phase === 'tool' && /test|check|lint|build/i.test(a.toolLabel || '')) return 2;
  if (a.state === 'queued' || a.state === 'starting') return 0;
  return 1;
}

function momentCopy(a, attention) {
  if (a.state === 'waiting') return { tone: 'waiting', title: 'Una decisión retiene este Intento', detail: attention?.question || attention?.reason || a.latest };
  if (a.state === 'review_ready') return { tone: 'review', title: 'El resultado está listo para revisar', detail: 'La evidencia va adjunta. Mira lo que falló o no se verificó antes de decidir.' };
  if (a.state === 'failed') return { tone: 'failed', title: 'Este Intento necesita recuperarse', detail: a.latest };
  if (a.state === 'offline') return { tone: 'faint', title: 'El Intento no puede seguir todavía', detail: a.latest || 'Reconecta el host para seguir.' };
  if (a.state === 'working') return { tone: 'active', title: a.latest || 'El agente está trabajando', detail: null };
  if (a.state === 'completed') return { tone: 'done', title: a.latest || 'Terminado', detail: null };
  if (a.state === 'paused') return { tone: 'neutral', title: a.latest || 'En pausa', detail: null };
  return { tone: 'neutral', title: a.state === 'queued' ? 'Esperando un hueco libre' : 'Listo para empezar', detail: a.latest };
}

function Header({ a, task, project, siblings }) {
  const s = usePreviewStore();
  const ref = useRef(null);
  const [menu, setMenu] = useState(false);
  const human = a.control === 'human';
  const failedChecks = a.tests ? a.tests.total - a.tests.pass : 0;
  const openReview = () => s.setView(PROOF_PACKS[a.id] ? 'proof' : 'review');
  const primary = a.state === 'waiting'
    ? { label: 'Ver la decisión', icon: 'warn', run: () => s.setView('attention') }
    : a.state === 'review_ready'
      ? { label: 'Revisar la evidencia', icon: 'eye', run: openReview }
      : { label: 'Abrir en el Editor', icon: 'code', run: () => useWorkbenchStore.getState().setMode('editor') };
  const pick = (fn) => () => { setMenu(false); fn(); };
  return (
    <header className="pv-ws__head">
      <div className="pv-ws__titlerow">
        <h1 className="pv-ws__title">{task.title}</h1>
        <StatePill attempt={a} />
        {human && <span className="pv-tag pv-tag--accent">Tienes el control</span>}
        {failedChecks > 0 && <span className="pv-tag pv-tone-failed">{failedChecks} comprobaciones fallan</span>}
        {a.integrationStatus === 'pending' && <span className="pv-tag pv-tone-waiting">Integración pendiente</span>}
        <span className="panelhead__fill" />
        <button type="button" className="btn btn--accent" onClick={primary.run}><I n={primary.icon} size={14} />{primary.label}</button>
        <button ref={ref} type="button" className="btn btn--ghost" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>Acciones <I n="down" size={12} /></button>
        <Popover anchorRef={ref} open={menu} onClose={() => setMenu(false)} align="right">
          <div className="menu" role="menu">
            <button type="button" className="menu__item" role="menuitem" disabled={a.state === 'offline'} onClick={pick(() => (human ? s.setOverlay({ type: 'return', attemptId: a.id }) : s.takeOver(a.id)))}>
              <span className="menu__main">{human ? 'Devolver al agente' : 'Tomar el control'}</span>
            </button>
            {a.state === 'working' && <button type="button" className="menu__item" role="menuitem" onClick={pick(() => s.patchAttempt(a.id, { state: 'paused', latest: 'En pausa en un punto seguro' }))}><span className="menu__main">Pausar</span></button>}
            <button type="button" className="menu__item" role="menuitem" onClick={pick(() => s.setView('compare'))}><span className="menu__main">Comparar Intentos</span></button>
            <button type="button" className="menu__item" role="menuitem" onClick={pick(openReview)}><span className="menu__main">Revisar el resultado</span></button>
            <button type="button" className="menu__item" role="menuitem" onClick={pick(() => s.openFork(a.id))}><span className="menu__main">Nuevo Intento en paralelo…</span></button>
          </div>
        </Popover>
      </div>
      <div className="pv-ws__lede">
        <span>{project.name} · Task{task.run && <> · hija de «{task.run}»</>}</span>
        <span className="pv-ws__objective" title={task.objective}>{task.objective}</span>
      </div>
      <div className="pv-ws__attline">
        {siblings.length > 1 ? <AttemptStrip task={task} /> : <span className="pv-ws__one"><b>{attemptName(a)}</b><Agent attempt={a} /></span>}
        <span className="panelhead__fill" />
        <span className="pv-ws__host" title="Host que ejecuta"><I n="server" size={12} />{hostOf(a.host).name}</span>
        <button type="button" className="lk" aria-expanded={s.contextOpen} onClick={s.toggleContext}>Contexto <I n={s.contextOpen ? 'up' : 'down'} size={12} /></button>
      </div>
      {s.contextOpen && (
        <div className="pv-ws__context">
          <Loc attempt={a} parts={['branch', 'worktree', 'host']} forceHost />
          <span className="pv-tag">{policyName(a.policy)}</span>
          {a.effort && <span className="pv-tag">esfuerzo {a.effort}</span>}
          <span className="pv-tag">ContextPackage {a.ctx}</span>
        </div>
      )}
    </header>
  );
}

function Moment({ a }) {
  const s = usePreviewStore();
  const attention = attentionFor(s, a.id)[0];
  const copy = momentCopy(a, attention);
  const active = stageIndex(a);
  const blocked = ['waiting', 'failed', 'offline'].includes(a.state);
  const facts = a.state === 'waiting' ? [] : [
    a.minutes ? { value: `${a.minutes} min`, label: 'en marcha' } : null,
    { value: `${a.files || 0}`, label: 'archivos' },
    a.tests ? { value: `${a.tests.pass}/${a.tests.total}`, label: 'pruebas' } : null,
  ].filter(Boolean);
  return (
    <section className={`pv-moment pv-tone-${copy.tone}`} aria-live="polite" aria-label={copy.title}>
      <div className="pv-moment__row">
        <Mark attempt={a} size={14} />
        <b className="pv-moment__title">{copy.title}</b>
        {copy.detail && <span className="pv-moment__detail">{copy.detail}</span>}
        <span className="panelhead__fill" />
        {facts.map((f) => <span key={f.label} className="pv-moment__fact"><b className="mono">{f.value}</b> {f.label}</span>)}
      </div>
      <ol className="pv-stages" aria-label="Ciclo de vida del Intento">
        {STAGES.map((st, i) => {
          const current = i === active;
          const done = i < active;
          return (
            <li key={st.label} className={`pv-stage${done ? ' is-done' : ''}${current ? ' is-current' : ''}${current && blocked ? ' is-blocked' : ''}`} aria-current={current ? 'step' : undefined}>
              <span className="pv-stage__dot">{done ? <I n="check" size={10} /> : i + 1}</span>
              <span className="pv-stage__label">{st.label}</span>
              <span className="pv-stage__owner">{st.owner}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function AttemptStrip({ task }) {
  const s = usePreviewStore();
  const atts = attemptsOfTask(s, task.id);
  return (
    <div className="pv-strip" role="tablist" aria-label="Intentos de esta Task">
      {atts.map((x) => {
        const on = s.sel.attemptId === x.id;
        const n = attentionFor(s, x.id).length;
        return (
          <button key={x.id} type="button" role="tab" aria-selected={on} className={`pv-strip__t${on ? ' is-on' : ''}`} onClick={() => s.select(x.id)}>
            <span className="pv-strip__l mono">{x.label}</span>
            <Agent attempt={x} detail={false} />
            <Mark attempt={x} size={12} />
            <span className="pv-strip__state">{stateLabel(x)}</span>
            {n > 0 && <AttnFlag n={n} />}
            {s.choice[task.id] === x.id && <span className="pv-tag pv-tone-done">elegido</span>}
          </button>
        );
      })}
      <button type="button" className="lk pv-strip__add" onClick={() => s.openFork(s.sel.attemptId)}><I n="plus" size={12} />Nuevo Intento</button>
    </div>
  );
}

const DELIVERED = { queue: 'De la cola', steer: 'Corrección', stop: 'Detener y enviar', review: 'Revisión' };

function Event({ e, a }) {
  const [open, setOpen] = useState(e.kind === 'tools' && e.items?.some((i) => i.ok === null));
  if (e.kind === 'user') {
    return (
      <div className="pv-ev pv-ev--user">
        <div className="pv-ev__bubble">
          <div className="pv-ev__meta"><I n="user" size={11} /> Tú <span className="pv-muted">desde {e.from}</span>{DELIVERED[e.delivered] && <span className="pv-tag">{DELIVERED[e.delivered]}</span>}<span className="panelhead__fill" /><span className="pv-muted mono">{e.time}</span></div>
          <p>{e.text}</p>
          {e.comments && <ul className="pv-ev__comments">{e.comments.map((c) => <li key={c.id}><span className="mono">{c.path}</span> {c.text}</li>)}</ul>}
        </div>
      </div>
    );
  }
  if (e.kind === 'agent') {
    return (
      <div className="pv-ev pv-ev--agent">
        <div className="pv-ev__meta"><Agent attempt={a} detail={false} /><span className="panelhead__fill" /><span className="pv-muted mono">{e.time}</span></div>
        <p>{e.text}</p>
      </div>
    );
  }
  if (e.kind === 'tools' || e.kind === 'edits') {
    const tools = e.kind === 'tools';
    const running = tools && e.items.some((i) => i.ok === null);
    const fails = tools ? e.items.filter((i) => i.ok === false).length : 0;
    const add = tools ? 0 : e.files.reduce((n, f) => n + f.add, 0);
    const del = tools ? 0 : e.files.reduce((n, f) => n + f.del, 0);
    return (
      <div className="pv-ev pv-ev--group">
        <button type="button" className="pv-ev__g" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <I n={open ? 'down' : 'right'} size={11} />
          <I n={tools ? 'terminal' : 'filecode'} size={12} />
          <b>{tools ? e.title : `Editó ${e.files.length} archivos`}</b>
          {tools && !running && <span className={fails ? 'pv-bad' : 'pv-good'}>{fails ? `${fails} fallaron` : 'todo bien'}</span>}
          {running && <Mark kind="working" tone="active" size={12} />}
          {!tools && <><span className="pv-good mono">+{add}</span><span className="pv-bad mono">−{del}</span></>}
          <span className="panelhead__fill" /><span className="pv-muted mono">{e.time}</span>
        </button>
        {open && (
          <ul className="pv-ev__list">
            {tools
              ? e.items.map((i, k) => <li key={k}><span className={i.ok === null ? 'pv-tone-active' : i.ok ? 'pv-good' : 'pv-bad'}>{i.ok === null ? '…' : i.ok ? '✓' : '✕'}</span><code>{i.cmd}</code><span className="pv-muted mono">{i.ms ? `${(i.ms / 1000).toFixed(1)} s` : 'en curso'}</span></li>)
              : e.files.map((f) => <li key={f.path}><code>{f.path}</code><span className="pv-good mono">+{f.add}</span><span className="pv-bad mono">−{f.del}</span></li>)}
          </ul>
        )}
      </div>
    );
  }
  if (e.kind === 'check') return <div className="pv-ev pv-ev--check"><span className={e.status === 'pass' ? 'pv-good' : 'pv-bad'}>{e.status === 'pass' ? '✓' : '✕'}</span><b>{e.name}</b><span className="pv-muted mono">{e.detail}</span><span className="panelhead__fill" /><span className="pv-muted mono">{e.time}</span></div>;
  if (e.kind === 'checkpoint') return <div className="pv-ev pv-ev--checkpoint"><span /><i>{e.text}</i><span /></div>;
  return <div className={`pv-ev pv-ev--system pv-tone-${e.tone === 'good' ? 'done' : e.tone === 'warn' ? 'waiting' : 'neutral'}`}><I n="history" size={11} /> {e.text} <span className="pv-muted mono">{e.time}</span></div>;
}

/** Actividad con reproducción: el deslizador muestra el Intento tal como estaba en cada evento. */
function ActivityTab({ a }) {
  const s = usePreviewStore();
  const events = timelineOf(s, a);
  const [upTo, setUpTo] = useState(null);
  const end = useRef(null);
  const live = upTo == null;
  useEffect(() => { setUpTo(null); }, [a.id]);
  useEffect(() => { if (live) end.current?.scrollIntoView?.({ block: 'end' }); }, [events.length, a.id, live]);
  const shown = live ? events : events.slice(0, upTo + 1);
  return (
    <div className="pv-activity">
      <div className="pv-replay">
        <I n="history" size={12} />
        <label className="pv-replay__label" htmlFor={`pv-replay-${a.id}`}>Reproducir</label>
        <input
          id={`pv-replay-${a.id}`}
          type="range"
          min={0}
          max={Math.max(0, events.length - 1)}
          value={live ? events.length - 1 : upTo}
          onChange={(ev) => { const v = Number(ev.target.value); setUpTo(v >= events.length - 1 ? null : v); }}
          aria-valuetext={live ? 'Ahora' : `Hasta las ${events[upTo]?.time}`}
        />
        {live ? <span className="pv-muted">Ahora</span> : (
          <>
            <span className="pv-replay__at">Viendo el Intento a las <b className="mono">{events[upTo]?.time}</b> · {upTo + 1} de {events.length}</span>
            <button type="button" className="lk is-accent" onClick={() => setUpTo(null)}>Volver a ahora</button>
          </>
        )}
      </div>
      <div className="pv-activity__scroll scroll">
        {shown.map((e) => <Event key={e.id} e={e} a={a} />)}
        {live && a.state === 'working' && (
          <div className="pv-ev pv-ev--live"><Mark attempt={a} size={13} /><span>{a.phase === 'tool' ? `Ejecutando ${a.toolLabel || 'una orden'}` : a.phase === 'thinking' ? 'Pensando' : 'Escribiendo'}…</span><span className="pv-muted">{a.latest}</span></div>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}

function ChangesTab({ a }) {
  const s = usePreviewStore();
  const pp = PROOF_PACKS[a.id];
  const files = timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files);
  return (
    <div className="pv-pad scroll">
      <div className="pv-callout">
        <span>Empieza por la evidencia, no por el diff.</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setView(pp ? 'proof' : 'review')}>{pp ? 'Abrir el Proof Pack' : 'Revisar los cambios'}</button>
      </div>
      <table className="pv-table">
        <thead><tr><th>Archivo</th><th className="num">+</th><th className="num">−</th></tr></thead>
        <tbody>
          {files.map((f) => <tr key={f.path}><td className="mono">{f.path}</td><td className="num pv-good mono">+{f.add}</td><td className="num pv-bad mono">−{f.del}</td></tr>)}
          {!files.length && <tr><td colSpan="3" className="pv-muted">{a.files} archivos, +{a.add} / −{a.del}. La lista completa está en la revisión.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function TerminalTab({ a }) {
  const lines = a.phase === 'tool'
    ? [`$ ${a.toolLabel}`, ` RUN  v2.1.4  …/worktrees/${a.id}`, ' ✓ runtime/attempt.int.test.ts (12)', ' ✓ runtime/events.int.test.ts (9)', ' ✓ runtime/worktree.int.test.ts (11)', ' … runtime/session.int.test.ts']
    : ['$ git status -sb', `## ${a.branch || 'sin worktree'}`, ' M src/runtime/session.ts', '$ _'];
  return (
    <div className="pv-term">
      <div className="pv-term__note pv-muted">Terminal simulada · en el producto es el PTY del Intento</div>
      <pre className="mono">{lines.map((l, i) => <div key={i} className={l.includes('✓') ? 'pv-good' : l.startsWith('$') ? 'pv-term__prompt' : ''}>{l}</div>)}</pre>
    </div>
  );
}

function ArtifactsTab({ a }) {
  const s = usePreviewStore();
  const pp = PROOF_PACKS[a.id];
  const rows = [
    { icon: 'eye', name: 'Proof Pack', sub: pp ? `Evidencia de ${pp.revision}` : 'Aún no: el Intento no ha terminado', run: pp ? () => s.setView('proof') : null },
    { icon: 'book', name: 'Informe del Intento', sub: 'report.md · 2,1 KB', run: () => s.toast('Abrir report.md (simulado).') },
    { icon: 'terminal', name: 'Registro de pruebas', sub: 'test-integration.log · 48 KB', run: () => s.toast('Abrir el registro (simulado).') },
    { icon: 'image', name: 'Capturas', sub: `${pp?.screenshots.length || 0} capturas`, run: null },
  ];
  return (
    <div className="pv-pad scroll">
      <ul className="pv-artifacts">
        {rows.map((r) => (
          <li key={r.name}>
            <I n={r.icon} size={14} />
            <span className="pv-artifacts__main"><b>{r.name}</b><small>{r.sub}</small></span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!r.run} onClick={r.run || undefined}>Abrir</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pulse({ a }) {
  return (
    <div className="pv-pulse" aria-label="Recursos del Intento">
      <span><b className="mono">{money(a.cost)}</b> · {kTokens(a.tokens)} tokens</span>
      <span><b className="mono">+{a.add}</b> / <b className="mono">−{a.del}</b> en {a.files} archivos</span>
      <span>{a.worktree ? 'Worktree propio' : 'Solo lectura · sin worktree'} en {hostOf(a.host).name}</span>
    </div>
  );
}

export function PreviewWorkspace() {
  const s = usePreviewStore();
  const a = attemptById(s, s.sel.attemptId);
  const [tab, setTab] = useState('activity');
  if (!a) return <div className="changes__empty">Elige un Intento en el navegador.</div>;
  const task = taskOf(s, a);
  const project = projectOf(task);
  const attn = attentionFor(s, a.id);
  const siblings = attemptsOfTask(s, task.id);
  return (
    <div className="pv-ws">
      <Header a={a} task={task} project={project} siblings={siblings} />
      <Moment a={a} />
      {attn.length > 0 && (
        <div className="pv-ws__attn" aria-label="Este Intento espera tu decisión">
          {attn.map((x) => <AttentionCard key={x.id} item={x} compact />)}
        </div>
      )}
      <div className="pv-ws__tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Detalle del Intento"
          options={[{ id: 'activity', label: 'Actividad' }, { id: 'changes', label: 'Cambios' }, { id: 'terminal', label: 'Terminal' }, { id: 'artifacts', label: 'Artefactos' }]}
        />
        <span className="panelhead__fill" />
        <Pulse a={a} />
      </div>
      <div className="pv-ws__body">
        {tab === 'activity' && <ActivityTab a={a} />}
        {tab === 'changes' && <ChangesTab a={a} />}
        {tab === 'terminal' && <TerminalTab a={a} />}
        {tab === 'artifacts' && <ArtifactsTab a={a} />}
      </div>
      <PreviewComposer attemptId={a.id} />
      <span className="pv-sr" aria-live="polite">{agentName(a)} · {stateLabel(a)}</span>
    </div>
  );
}
