// Inspector.jsx — panel derecho. No repite el sidebar: responde "¿qué debía lograr esto, con qué contexto y bajo qué permisos?".
import { useState } from 'react';
import { useStore, attemptById, taskOf, attemptsOfTask } from '../store';
import { I, Section, Agent, Loc, Seg } from '../ui';
import { REVIEW_FILES, PROOF_PACKS, TASKS } from '../data';

function TaskTab({ a, task }) {
  const s = useStore();
  const children = task.run ? s.tasks.filter((t) => t.run === task.run && t.id !== task.id) : [];
  return (
    <>
      <Section title="Objective"><p className="insp__p">{task.objective}</p></Section>
      {task.criteria.length > 0 && <Section title="Acceptance criteria"><ul className="insp__ul">{task.criteria.map((c) => <li key={c}><I n="check" size={11} />{c}</li>)}</ul></Section>}
      {task.constraints.length > 0 && <Section title="Constraints"><ul className="insp__ul insp__ul--c">{task.constraints.map((c) => <li key={c}>{c}</li>)}</ul></Section>}
      {task.decisions.length > 0 && <Section title="Decisions so far"><ul className="insp__ul insp__ul--c">{task.decisions.map((c) => <li key={c}>{c}</li>)}</ul></Section>}
      {task.run && (
        <Section title="Coordinator" aside={<span className="chip chip--tag chip--dim">Run</span>}>
          <p className="insp__p">Part of <b>{task.run}</b>. Sibling Tasks: {children.map((c) => c.title).join(', ') || '—'}.</p>
          <p className="muted insp__p">Open design question: how coordinator → child Tasks appear in the sidebar. For now it is shown here and in Mission Map.</p>
        </Section>
      )}
      {a.id === 'att_oa_b' && <Section title="Linked"><div className="row"><span className="chip"><I n="pr" size={11} />PR #72</span><span className="chip chip--good">CI ✓</span><span className="chip chip--warn">3 review comments</span></div></Section>}
    </>
  );
}

function ChangesTabI({ a }) {
  const s = useStore();
  const files = REVIEW_FILES[a.id];
  const rv = s.review(a.id);
  return (
    <>
      <Section title="Since base" aside={<span>{a.files} files</span>}>
        <div className="insp__stat"><b className="good">+{a.add}</b><b className="danger">−{a.del}</b>{a.tests && <span className="chip chip--good">tests {a.tests.pass}/{a.tests.total}</span>}</div>
      </Section>
      <Section title="Files">
        {files ? <ul className="insp__files">{files.slice(0, 8).map((f) => <li key={f.path} className={rv.reviewed[f.path] ? 'is-done' : ''}><span className={`risk-dot risk-dot--${f.risk}`} title={`${f.risk} risk`} /><span className="mono trunc grow">{f.path}</span><span className="good">+{f.add}</span><span className="danger">−{f.del}</span></li>)}{files.length > 8 && <li className="muted">+{files.length - 8} more in Review</li>}</ul>
          : <p className="muted insp__p">{a.files} files changed. Detailed list lives in Review.</p>}
      </Section>
      <Section title="Review">
        <div className="row">
          <button type="button" className="btn btn--merged btn--sm" onClick={() => s.setView(PROOF_PACKS[a.id] ? 'proof' : 'review')}>Proof Pack</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setView('review')}>Review changes</button>
        </div>
        <p className="muted insp__p">{Object.values(rv.reviewed).filter(Boolean).length} reviewed · {rv.comments.filter((c) => !c.sent).length} pending comments</p>
      </Section>
    </>
  );
}

function ContextTab({ a }) {
  const sibs = useStore((s) => attemptsOfTask(s, a.taskId));
  const rows = [
    ['Task objective', 'Implement …', true, true],
    ['Constraints', '2 rules', true, true],
    ['Decisions', '2 items', true, true],
    ['Thread summary', 'relevant turns only', true, true],
    ['Repo state', 'base main@3574524 → head', true, true],
    ['Selected artifacts', '1 report', true, true],
    ['Previous Attempt summaries', sibs.length > 1 ? `Attempt ${sibs.find((x) => x.id !== a.id)?.label}` : 'none', true, sibs.length > 1],
    ['Test state', '141/141', true, true],
    ['Raw transcript', 'not synced by default', false, false],
  ];
  return (
    <>
      <Section title={`ContextPackage ${a.ctx}`} aside={<span className="chip chip--tag chip--dim">neutral · versioned</span>}>
        <p className="insp__p">What the next agent receives — not “a transcript pretending to be another model”.</p>
        <table className="tbl tbl--ctx"><thead><tr><th>Part</th><th>Ref.</th><th>Sent</th></tr></thead>
          <tbody>{rows.map(([k, v, r, m]) => <tr key={k}><td>{k}<small>{v}</small></td><td>{r ? '✓' : '—'}</td><td>{m ? '✓' : '—'}</td></tr>)}</tbody></table>
      </Section>
      <Section title="Redaction"><div className="callout callout--good">3 secrets redacted · policy <b>strict</b></div></Section>
      {sibs.length > 1 && <Section title="Shared with"><div className="row" style={{ flexWrap: 'wrap' }}>{sibs.filter((x) => x.id !== a.id).map((x) => <span key={x.id} className="chip">Attempt {x.label} · {x.ctx}</span>)}</div><p className="muted insp__p">Same package ⇒ the comparison is fair.</p></Section>}
    </>
  );
}

function AutonomyTab({ a }) {
  const [yaml, setYaml] = useState(false);
  return (
    <>
      <Section title="Autonomy" aside={<span className="chip">{a.policy}</span>}>
        <ul className="zones">
          <li className="zone zone--safe"><b>Safe</b><span>read project · write own worktree · tests · lint · build</span></li>
          <li className="zone zone--ask"><b>Ask</b><span>network · push · publish · DB migrations · installs outside env</span></li>
          <li className="zone zone--deny"><b>Deny</b><span>secrets · production · delete outside worktree</span></li>
        </ul>
        <p className="muted insp__p">Fewer prompts without training you to approve blindly: routine inside the contract, a person at the border.</p>
      </Section>
      <Section title="Effective contract" aside={<button type="button" className="btn btn--text btn--sm" onClick={() => setYaml((v) => !v)}>{yaml ? 'Hide' : 'Show'} YAML</button>}>
        {yaml && <pre className="yaml">{`autonomy:\n  files:\n    read: project\n    write: worktree\n  shell:\n    allow: [npm test, npm run lint]\n    ask:   [git push, network:any, schema:migrate]\n    deny:  [rm:outside-worktree, secrets:read]\n  integration: human_only`}</pre>}
      </Section>
    </>
  );
}

export default function Inspector({ leaving = false }) {
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const [tab, setTab] = useState('task');
  if (!a) return null;
  const task = taskOf(s, a);
  return (
    <aside className={`insp ${leaving ? 'is-leaving' : ''}`} aria-label="Inspector" inert={leaving}>
      <div className="insp__tabs">
        <Seg value={tab} onChange={setTab} options={[{ id: 'task', label: 'Task' }, { id: 'changes', label: 'Changes' }, { id: 'context', label: 'Context' }, { id: 'autonomy', label: 'Autonomy' }]} />
        <button type="button" className="btn btn--text btn--icon insp__close" aria-label="Close details" title="Close details (Esc)"
          onClick={() => { s.setMockUi({ inspectorOpen: false }); requestAnimationFrame(() => document.querySelector('[data-hierarchy-toggle="inspectorOpen"]')?.focus()); }}><I n="x" size={13} /></button>
      </div>
      <div className="insp__body">
        {tab === 'task' && <TaskTab a={a} task={task} />}
        {tab === 'changes' && <ChangesTabI a={a} />}
        {tab === 'context' && <ContextTab a={a} />}
        {tab === 'autonomy' && <AutonomyTab a={a} />}
      </div>
    </aside>
  );
}
