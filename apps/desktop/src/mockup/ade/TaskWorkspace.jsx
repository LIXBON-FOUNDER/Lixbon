// TaskWorkspace.jsx — vista central del ADE: conversación + timeline operativo + estado + evidencias + controles.
// No es una pared de mensajes: las herramientas y las ediciones se agrupan y se pliegan; arriba va el "pulso" del trabajo.
import { useEffect, useRef, useState } from 'react';
import { useStore, attemptById, taskOf, projectOf, attemptsOfTask, attentionFor, timelineOf } from '../store';
import { Mark, StatePill, Agent, Loc, I, Seg, AttnFlag, money } from '../ui';
import { stateLabel, agentShort, hostOf, meta, MODES } from '../vocab';
import { PROOF_PACKS } from '../data';
import AttentionCard from './AttentionCard';
import Composer from './Composer';

function Crumbs({ a, task, project }) {
  return (
    <nav className="crumbs" aria-label="Location">
      <span>{project.name}</span><I n="right" size={10} />
      <span>{task.title}</span><I n="right" size={10} />
      <span className="crumbs__here">Attempt {a.label}</span>
      {task.run && <span className="chip chip--tag chip--dim" title="This Task is a child of a coordinator Run">child of “{task.run}”</span>}
    </nav>
  );
}

function Header({ a, task, project, siblings }) {
  const s = useStore();
  const human = a.control === 'human';
  const failed = a.tests && a.tests.total - a.tests.pass;
  const inspectorOpen = s.mockUi.inspectorOpen;
  const primary = a.state === 'waiting'
    ? { label: 'Review decision', icon: 'warn', run: () => s.setView('attention') }
    : a.state === 'review_ready'
      ? { label: 'Review evidence', icon: 'eye', run: () => PROOF_PACKS[a.id] ? s.openProof(a.id) : s.openReview(a.id) }
      : { label: 'Open in IDE', icon: 'code', run: () => { s.setMockUi({ ideReviewOpen: false }); s.setSurface('ide'); } };
  return <header className="tw__head">
    <div className="tw__titlerow"><h1 className="tw__title">{task.title}</h1><StatePill attempt={a} />
      {human && <span className="chip chip--accent">You are driving</span>}
      {failed > 0 && <span className="chip chip--danger">{failed} checks failed</span>}
      {a.integrationStatus === 'pending' && <span className="chip chip--warn">Pending integration · simulated</span>}
      <span className="sp" />
      <button className="btn btn--accent" onClick={primary.run}><I n={primary.icon} size={14} />{primary.label}</button>
      <details className="hier-actions"><summary className="btn btn--ghost">Actions <I n="down" size={12} /></summary><div className="menu">
        <button className="menu__i" onClick={() => human ? s.setOverlay({ type: 'return', attemptId: a.id }) : s.takeOver(a.id)} disabled={a.state === 'offline'}><I n="user" />{human ? 'Return to Agent' : 'Take Over'}</button>
        {a.state === 'working' && <button className="menu__i" onClick={() => s.simulate(a.id,{state:'paused',latest:'Paused at a safe boundary'})}><I n="stop" />Pause</button>}
        <button className="menu__i" onClick={() => s.setView('compare')}><I n="split" />Compare Attempts</button>
        <button className="menu__i" onClick={() => PROOF_PACKS[a.id] ? s.openProof(a.id) : s.openReview(a.id)}><I n="eye" />Review result</button>
      </div></details>
    </div>
    <div className="tw__lede">
      <span className="tw__where">{project.name} · Task{task.run && <> · {task.run}</>}</span>
      {!inspectorOpen && <span className="tw__obj" title={task.objective}>{task.objective}</span>}
    </div>
    <div className="tw__attline">
      {siblings.length > 1
        ? <AttemptStrip task={task} />
        : <span className="tw__one"><b>Attempt {a.label}</b><Agent attempt={a} /></span>}
      <span className="sp" />
      <span className="tw__host" title="Execution host"><I n="server" size={12} />{hostOf(a.host).name}</span>
      <button className="btn btn--text btn--sm" data-hierarchy-toggle="contextOpen" aria-expanded={s.mockUi.contextOpen} onClick={() => s.setMockUi({contextOpen:!s.mockUi.contextOpen})}>Context <I n="down" size={12} /></button>
    </div>
    {s.mockUi.contextOpen && <div className="hier-detail"><Loc attempt={a} parts={['branch','worktree','host']} forceHost /><span className="chip">{a.policy}</span><span className="chip">effort {a.effort}</span><span className="chip">ContextPackage {a.ctx}</span></div>}
    {s.mismatch && <div className="callout callout--danger"><b>Location mismatch</b> — expected {a.branch}; runtime reports {a.branch}-fix. <button className="btn" onClick={()=>s.setMismatch(false)}>Inspect</button></div>}
  </header>;
}

const LIFECYCLE_STAGES = ['Prepare', 'Execute', 'Verify', 'Review', 'Integrate'];

function lifecycleIndex(a) {
  if (a.state === 'review_ready') return 3;
  if (a.state === 'completed') return 4;
  if (a.state === 'failed') return 2;
  if (a.state === 'waiting' || a.state === 'offline') return 1;
  if (a.state === 'working' && a.phase === 'tool' && /test|check|lint|build/i.test(a.toolLabel || '')) return 2;
  if (a.state === 'queued' || a.state === 'starting') return 0;
  return 1;
}

function momentCopy(a, attention, proof) {
  if (a.state === 'waiting') return {
    tone: 'warn', eyebrow: 'Needs a decision', title: 'A decision is holding this Attempt',
    detail: attention?.question || attention?.reason || a.latest || 'The agent is waiting for your response.',
  };
  if (a.state === 'review_ready') {
    const skipped = proof?.validation.filter((item) => item.status === 'skipped').length || 0;
    return {
      tone: 'good', eyebrow: 'Result ready · human review', title: 'The result is ready for review',
      detail: `Evidence is attached. Check the validation and${skipped ? ` ${skipped} skipped check${skipped === 1 ? '' : 's'}` : ' known risks'} before deciding how to integrate it.`,
    };
  }
  if (a.state === 'failed') return {
    tone: 'danger', eyebrow: 'Validation stopped', title: 'This Attempt needs recovery',
    detail: a.latest || 'The latest validation did not pass.',
  };
  if (a.state === 'offline') return {
    tone: 'warn', eyebrow: 'Host unavailable', title: 'The Attempt cannot continue yet',
    detail: a.latest || 'Reconnect the execution host to continue.',
  };
  if (a.state === 'working') return {
    tone: 'info', eyebrow: 'Running · live attempt', title: 'The agent is verifying the current changes',
    detail: a.latest || 'The Attempt is working through its current step.',
  };
  return {
    tone: 'muted', eyebrow: a.state === 'queued' ? 'Queued' : 'Ready to start',
    title: a.state === 'queued' ? 'The Attempt is waiting for a slot' : 'The task is ready to begin',
    detail: a.latest || 'Review the task context before continuing.',
  };
}

function StateMoment({ a }) {
  const s = useStore();
  const attention = attentionFor(s, a.id)[0];
  const proof = PROOF_PACKS[a.id];
  const copy = momentCopy(a, attention, proof);
  const activeStage = lifecycleIndex(a);
  const blocked = ['waiting', 'failed', 'offline'].includes(a.state);
  const facts = a.state === 'review_ready'
    ? [
      ...(a.tests ? [{ value: `${a.tests.pass}/${a.tests.total}`, label: 'unit tests' }] : []),
      { value: `${a.files}`, label: 'files changed' },
      ...(proof?.validation.some((item) => item.status === 'skipped') ? [{ value: '1', label: 'check skipped' }] : []),
    ]
    : a.state === 'waiting'
      ? [] // el riesgo y el alcance los muestra la tarjeta de decisión de debajo: no se repiten en la banda
      : [
        { value: `${a.minutes || 0}m`, label: 'elapsed' },
        { value: `${a.files || 0}`, label: 'files changed' },
        ...(a.tests ? [{ value: `${a.tests.pass}/${a.tests.total}`, label: 'checks reported' }] : []),
      ];

  return (
    <section key={a.id} className={`ade-moment mk-tone-${copy.tone}`} aria-label={copy.title} aria-live="polite">
      <div className="ade-moment__top">
        <div className="ade-moment__copy">
          <div className="ade-moment__eyebrow"><Mark attempt={a} size={13} /><span>{copy.eyebrow}</span></div>
          <h2>{copy.title}</h2>
          <p>{copy.detail}</p>
        </div>
        {facts.length > 0 && <div className="ade-moment__facts" aria-label="Attempt summary">
          {facts.map((fact) => <div className="ade-moment__fact" key={fact.label}><b>{fact.value}</b><span>{fact.label}</span></div>)}
        </div>}
      </div>
      <div className="ade-moment__footer">
        <ol className="ade-stage-list" aria-label="Attempt lifecycle">
          {LIFECYCLE_STAGES.map((stage, index) => {
            const current = index === activeStage;
            const done = index < activeStage;
            const stageBlocked = current && blocked;
            return <li key={stage} className={`ade-stage ${done ? 'is-done' : ''} ${current ? 'is-current' : ''} ${stageBlocked ? 'is-blocked' : ''}`} aria-current={current ? 'step' : undefined}>
              <span className="ade-stage__dot">{done ? '✓' : index + 1}</span><span className="ade-stage__label">{stage}</span>
            </li>;
          })}
        </ol>
        <button type="button" className="btn btn--text btn--sm ade-moment__resources" data-hierarchy-toggle="resourcesOpen" aria-expanded={s.mockUi.resourcesOpen} onClick={() => s.setMockUi({ resourcesOpen: !s.mockUi.resourcesOpen })}>Activity &amp; resources <I n="down" size={12} /></button>
      </div>
    </section>
  );
}

function AttemptStrip({ task }) {
  const s = useStore();
  const atts = attemptsOfTask(s, task.id);
  return (
    <div className="astrip" role="tablist" aria-label="Attempts of this Task">
      {atts.map((x) => (
        <button key={x.id} type="button" role="tab" aria-selected={s.sel.attemptId === x.id} className={`astrip__t ${s.sel.attemptId === x.id ? 'is-on' : ''}`} onClick={() => s.select(x.id)}>
          <span className="astrip__l">{x.label}</span><Agent attempt={x} size={14} /><Mark attempt={x} size={12} />
          <span className="muted">{stateLabel(x)}</span>
          {attentionFor(s, x.id).length > 0 && <AttnFlag n={attentionFor(s, x.id).length} />}
          {s.choice[task.id] === x.id && <span className="chip chip--tag chip--good">chosen</span>}
        </button>
      ))}
      <button type="button" className="astrip__add" onClick={() => s.openFork(s.sel.attemptId)} title="Fork as new Attempt"><I n="plus" size={12} />Fork as Attempt</button>
    </div>
  );
}

function Pulse({ a }) {
  return (
    <div className="pulse" aria-label="Workspace pulse">
      <div><b>{a.minutes ? `${a.minutes} m` : '—'}</b><span>elapsed</span></div>
      <div><b>{a.files} files</b><span className="good">+{a.add}</span> <span className="danger">−{a.del}</span></div>
      <div><b>{a.tests ? `${a.tests.pass}/${a.tests.total}` : '—'}</b><span>tests</span></div>
      <div><b>{money(a.cost)}</b><span>{(a.tokens / 1000).toFixed(0)}k tokens</span></div>
      <div><b>{hostOf(a.host).name}</b><span>{a.worktree ? 'own worktree' : 'read-only · no worktree'}</span></div>
    </div>
  );
}

const DELIVERED = { queue: 'Queued → delivered', steer: 'Steer', stop: 'Stop & Send', review: 'Review feedback', sent: null };

function Event({ e, a }) {
  const [open, setOpen] = useState(e.kind === 'tools' && e.items?.some((i) => i.ok === null));
  if (e.kind === 'user') {
    return (
      <div className="ev ev--user">
        <div className="ev__bubble">
          <div className="ev__meta"><I n="user" size={11} /> You <span className="muted">via {e.from}</span>{DELIVERED[e.delivered] && <span className={`chip chip--tag ${e.delivered === 'stop' ? 'chip--warn' : 'chip--accent'}`}>{DELIVERED[e.delivered]}</span>}<span className="sp" /><span className="muted">{e.time}</span></div>
          <p>{e.text}</p>
          {e.comments && <ul className="ev__cm">{e.comments.map((c) => <li key={c.id}><span className="mono">{c.path}:{c.line}</span> {c.text}</li>)}</ul>}
        </div>
      </div>
    );
  }
  if (e.kind === 'agent') {
    return (
      <div className="ev ev--agent"><Agent attempt={a} label={false} size={18} /><div className="ev__bubble ev__bubble--agent"><div className="ev__meta">{agentShort(a)}<span className="sp" /><span className="muted">{e.time}</span></div><p>{e.text}</p></div></div>
    );
  }
  if (e.kind === 'tools') {
    const running = e.items.some((i) => i.ok === null);
    const fails = e.items.filter((i) => i.ok === false).length;
    return (
      <div className="ev ev--group">
        <button type="button" className="ev__g" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <I n={open ? 'down' : 'right'} size={11} /><I n="terminal" size={12} /><b>{running ? 'Running tool' : e.title}</b>
          {!running && <span className={fails ? 'danger' : 'good'}>{fails ? `${fails} failed` : 'all ok'}</span>}
          {running && <Mark kind="working" tone="info" size={12} />}
          <span className="sp" /><span className="muted">{e.time}</span>
        </button>
        {open && <ul className="ev__list">{e.items.map((i, k) => <li key={k}><span className={i.ok === null ? 'info' : i.ok ? 'good' : 'danger'}>{i.ok === null ? '…' : i.ok ? '✓' : '✕'}</span><code>{i.cmd}</code><span className="muted">{i.ms ? `${(i.ms / 1000).toFixed(1)}s` : 'running'}</span></li>)}</ul>}
      </div>
    );
  }
  if (e.kind === 'edits') {
    const add = e.files.reduce((n, f) => n + f.add, 0);
    const del = e.files.reduce((n, f) => n + f.del, 0);
    return (
      <div className="ev ev--group">
        <button type="button" className="ev__g" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <I n={open ? 'down' : 'right'} size={11} /><I n="filecode" size={12} /><b>Edited {e.files.length} files</b><span className="good">+{add}</span><span className="danger">−{del}</span><span className="sp" /><span className="muted">{e.time}</span>
        </button>
        {open && <ul className="ev__list">{e.files.map((f) => <li key={f.path}><code>{f.path}</code><span className="good">+{f.add}</span><span className="danger">−{f.del}</span></li>)}</ul>}
      </div>
    );
  }
  if (e.kind === 'check') return <div className="ev ev--check"><span className={e.status === 'pass' ? 'good' : 'danger'}>{e.status === 'pass' ? '✓' : '✕'}</span><b>{e.name}</b><span className="muted">{e.detail}</span><span className="sp" /><span className="muted">{e.time}</span></div>;
  if (e.kind === 'checkpoint') return <div className="ev ev--cp"><span /><i>{e.text}</i><span /></div>;
  return <div className={`ev ev--sys ev--sys-${e.tone || 'info'}`}><I n="history" size={11} /> {e.text} <span className="muted">{e.time}</span></div>;
}

function ActivityTab({ a }) {
  const s = useStore();
  const events = timelineOf(s, a);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [events.length, a.id]);
  return (
    <div className="tl">
      <div className="tl__scroll">
        {events.map((e) => <Event key={e.id} e={e} a={a} />)}
        {a.state === 'working' && (
          <div className="ev ev--live"><Mark attempt={a} size={13} /><span>{a.phase === 'tool' ? `Running ${a.toolLabel || 'tool'}` : a.phase === 'thinking' ? 'Thinking' : 'Writing'}…</span><span className="muted">{a.latest}</span></div>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}

function ChangesTab({ a }) {
  const s = useStore();
  const pp = PROOF_PACKS[a.id];
  return (
    <div className="pad">
      <div className="callout callout--info">Start from evidence, not from the diff. <button type="button" className="btn btn--merged btn--sm" onClick={() => s.setView(pp ? 'proof' : 'review')}>{pp ? 'Open Proof Pack' : 'Review changes'}</button></div>
      <table className="tbl"><thead><tr><th>File</th><th>+</th><th>−</th></tr></thead>
        <tbody>{timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files).map((f) => <tr key={f.path}><td className="mono">{f.path}</td><td className="good">+{f.add}</td><td className="danger">−{f.del}</td></tr>)}
          {!timelineOf(s, a).some((e) => e.kind === 'edits') && <tr><td colSpan="3" className="muted">{a.files} files, +{a.add} / −{a.del} (full list in Review).</td></tr>}</tbody></table>
    </div>
  );
}

function TerminalTab({ a }) {
  const lines = a.phase === 'tool' ? [`$ ${a.toolLabel}`, ' RUN  v2.1.4  C:/…/worktrees/lixbon/' + a.id, ' ✓ runtime/attempt.int.test.ts (12)', ' ✓ runtime/events.int.test.ts (9)', ' ✓ runtime/worktree.int.test.ts (11)', ' … runtime/session.int.test.ts'] : ['$ git status -sb', `## ${a.branch || 'plan'}`, ' M src/runtime/session.ts', '$ _'];
  return <pre className="term">{lines.map((l, i) => <div key={i} className={l.includes('✓') ? 'good' : l.startsWith('$') ? 'accent' : ''}>{l}</div>)}<span className="term__cur" /></pre>;
}

function ArtifactsTab({ a }) {
  const s = useStore();
  const pp = PROOF_PACKS[a.id];
  return (
    <div className="pad">
      <ul className="art">
        <li><I n="eye" size={14} /><span className="grow"><b>Proof Pack</b><small>{pp ? `Evidence for ${pp.revision}` : 'Not available yet — Attempt has not finished'}</small></span><button type="button" className="btn btn--ghost btn--sm" disabled={!pp} onClick={() => s.setView('proof')}>Open</button></li>
        <li><I n="book" size={14} /><span className="grow"><b>Attempt report</b><small>report.md · 2.1 KB</small></span><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast('Opening report.md (simulated)')}>Open</button></li>
        <li><I n="terminal" size={14} /><span className="grow"><b>Test log</b><small>test-integration.log · 48 KB</small></span><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast('Opening log (simulated)')}>Open</button></li>
        <li><I n="image" size={14} /><span className="grow"><b>Screenshots</b><small>{pp?.screenshots.length || 0} captured</small></span></li>
      </ul>
    </div>
  );
}

export default function TaskWorkspace() {
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const [tab, setTab] = useState('activity');
  if (!a) return <div className="empty">Select an Attempt in the sidebar.</div>;
  const task = taskOf(s, a);
  const project = projectOf(s, task);
  const attn = attentionFor(s, a.id);
  const siblings = attemptsOfTask(s, task.id);
  return (
    <div className="tw">
      <Header a={a} task={task} project={project} siblings={siblings} />
      <StateMoment a={a} />
      {s.mockUi.resourcesOpen && <Pulse a={a} />}

      {attn.length > 0 && (
        <div className="tw__attn" aria-label="This Attempt needs you">
          {attn.map((x) => <AttentionCard key={x.id} item={x} compact />)}
        </div>
      )}
      <div className="tw__tabs">
        <div className="tabs" role="tablist">
          {[['activity', 'Activity'], ['changes', 'Changes'], ['terminal', 'Terminal'], ['artifacts', 'Artifacts']].map(([id, l]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{l}</button>
          ))}
        </div>
        <span className="sp" />
        <span className="muted tw__latest">Latest · {a.latest}</span>
      </div>
      <div className="tw__body">
        {tab === 'activity' && <ActivityTab a={a} />}
        {tab === 'changes' && <ChangesTab a={a} />}
        {tab === 'terminal' && <TerminalTab a={a} />}
        {tab === 'artifacts' && <ArtifactsTab a={a} />}
      </div>
      <Composer attemptId={a.id} />
    </div>
  );
}
