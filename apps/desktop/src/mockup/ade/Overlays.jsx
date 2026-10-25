// Overlays.jsx — Jump Palette, Fork as Attempt, Stop & Send, Return to Agent, New Task. Todo simulado.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, attemptById, taskOf, attemptsOfTask } from '../store';
import { PROJECTS, PROVIDERS, USAGE, REPO_TREE } from '../data';
import { Mark, I, Kbd, Agent } from '../ui';
import { stateLabel, agentShort, hostOf, MODES } from '../vocab';

function Scrim({ children, onClose, top }) {
  return (
    <div className={`scrim ${top ? 'scrim--top' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()} role="dialog" aria-modal="true">
      {children}
    </div>
  );
}

function Jump({ onClose }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [hot, setHot] = useState(0);
  const inp = useRef(null);
  useEffect(() => { inp.current?.focus(); }, []);
  const entries = useMemo(() => {
    const out = [];
    s.attempts.forEach((a) => {
      const t = s.tasks.find((x) => x.id === a.taskId);
      const p = PROJECTS.find((x) => x.id === t.projectId);
      out.push({ key: a.id, icon: <Mark attempt={a} size={13} />, label: `${p.name} / ${t.title} / ${agentShort(a)}`, sub: `${a.branch || 'plan only'} · ${hostOf(a.host).name}`, right: stateLabel(a), hay: `${p.name} ${t.title} ${agentShort(a)} ${a.branch} ${hostOf(a.host).name} ${stateLabel(a)} ${a.state}`, run: () => s.select(a.id) });
    });
    s.attention.forEach((x) => out.push({ key: x.id, icon: <I n="warn" size={13} />, label: `Attention: ${x.title}`, sub: s.tasks.find((t) => t.id === attemptById(s, x.attemptId)?.taskId)?.title, right: x.kind, hay: `attention waiting approval ${x.kind} ${x.title}`, run: () => s.setView('attention') }));
    const walk = (nodes) => nodes.forEach((n) => (n.dir ? walk(n.children) : out.push({ key: n.path, icon: <I n="file" size={13} />, label: `File: ${n.path}`, sub: 'open in IDE', right: '', hay: `file ${n.path}`, run: () => s.setSurface('ide') })));
    walk(REPO_TREE);
    out.push({ key: 'pr72', icon: <I n="pr" size={13} />, label: 'PR #72 OAuth refresh', sub: 'Lixbon · CI ✓', right: '', hay: 'pr 72 oauth refresh', run: () => s.select('att_oa_b') });
    [['hosts', 'Hosts', 'hosts'], ['usage', 'Usage', 'usage'], ['map', 'Mission Map', 'map'], ['attention', 'Attention', 'attention'], ['compare', 'Compare Attempts', 'compare']].forEach(([id, l, v]) => out.push({ key: `cmd-${id}`, icon: <I n="right" size={13} />, label: `Go to ${l}`, sub: 'command', right: '', hay: `go ${l} ${id}`, run: () => s.setView(v) }));
    return out;
  }, [s.attempts, s.attention]); // eslint-disable-line
  const list = q.trim() ? entries.filter((e) => q.toLowerCase().split(/\s+/).every((w) => e.hay.toLowerCase().includes(w))).slice(0, 9) : entries.filter((e) => e.key.startsWith('att_')).slice(0, 7);
  useEffect(() => setHot(0), [q]);
  return (
    <Scrim top onClose={onClose}>
      <div className="jump" onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHot((h) => Math.min(list.length - 1, h + 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); }
        if (e.key === 'Enter' && list[hot]) { list[hot].run(); onClose(); }
        if (e.key === 'Escape') onClose();
      }}>
        <div className="jump__q"><I n="search" size={14} /><input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a Project, Task, Attempt, branch, host, file, PR…   try “waiting approval” or “claude on macbook”" aria-label="Jump" /><Kbd>Esc</Kbd></div>
        <ul>
          {list.map((e, i) => (
            <li key={e.key}><button type="button" className={i === hot ? 'is-hot' : ''} onMouseEnter={() => setHot(i)} onClick={() => { e.run(); onClose(); }}>
              {e.icon}<span className="grow"><span className="trunc">{e.label}</span><small>{e.sub}</small></span><span className="muted">{e.right}</span></button></li>
          ))}
          {!list.length && <li className="muted" style={{ padding: 12 }}>No matches. Jump also finds items hidden by sidebar filters.</li>}
        </ul>
      </div>
    </Scrim>
  );
}

function Fork({ ov, onClose }) {
  const s = useStore();
  const src = attemptById(s, ov.attemptId);
  const task = taskOf(s, src);
  const [prov, setProv] = useState(src.provider === 'claude' ? 'codex' : 'claude');
  const [model, setModel] = useState(PROVIDERS[prov].models[0]);
  const [host, setHost] = useState(src.host);
  const [policy, setPolicy] = useState(src.policy);
  const [text, setText] = useState(ov.text || '');
  const use = USAGE.find((u) => u.provider === prov);
  const hot = use && use.pct >= 70;
  const branch = src.readonly ? null : `${task.branchBase}-${prov}`;
  return (
    <Scrim onClose={onClose}>
      <div className="modal">
        <h2>Fork as Attempt</h2>
        <p>Keep <b>{task.title} · Attempt {src.label}</b> running and start a parallel one from the same <b>ContextPackage {src.ctx}</b>.</p>
        <div className="grid2">
          <label className="field-l">Agent<select value={prov} onChange={(e) => { setProv(e.target.value); setModel(PROVIDERS[e.target.value].models[0]); }}>{Object.values(PROVIDERS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field-l">Model<select value={model} onChange={(e) => setModel(e.target.value)}>{PROVIDERS[prov].models.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="field-l">Run on<select value={host} onChange={(e) => setHost(e.target.value)}>{s.hosts.map((h) => <option key={h.id} value={h.id} disabled={h.status === 'offline'}>{h.name} — {h.status === 'online' ? 'Ready' : 'Offline'}</option>)}</select></label>
          <label className="field-l">Policy<select value={policy} onChange={(e) => setPolicy(e.target.value)}>{['Workspace Safe', 'Read-only', 'Ask for everything'].map((p) => <option key={p}>{p}</option>)}</select></label>
        </div>
        {hot && (
          <div className="callout callout--warn">⚠ {PROVIDERS[prov].name} {use.windowLabel}: {use.pct}% used (resets in {use.reset}). Codex has {100 - USAGE[1].pct}% free.
            <div className="row" style={{ marginTop: 6 }}><button type="button" className="btn btn--ghost btn--sm" onClick={() => { setProv('codex'); setModel('Sol'); }}>Switch to Codex</button><span className="muted">Never switched silently — use {PROVIDERS[prov].name} anyway by starting.</span></div></div>
        )}
        <label className="field-l">Instruction (optional)<textarea className="input" style={{ height: 64, padding: 8 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Same Task objective unless you add a twist…" /></label>
        <div className="callout">
          <I n="branch" size={12} /> New worktree: <span className="mono">{branch || 'none (read-only / plan)'}</span> on {hostOf(host).name}. Attempt {src.label} is <b>not</b> touched.
        </div>
        <div className="modal__actions"><button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--accent" onClick={() => s.fork({ attemptId: src.id, provider: prov, model, host, policy, text: text.trim() || undefined })}>Start Attempt {String.fromCharCode(65 + attemptsOfTask(s, task.id).length)}</button></div>
      </div>
    </Scrim>
  );
}

function ConfirmStop({ ov, onClose }) {
  const s = useStore();
  const a = attemptById(s, ov.attemptId);
  return (
    <Scrim onClose={onClose}>
      <div className="modal">
        <h2>Stop &amp; Send?</h2>
        <div className="callout callout--warn">{MODES.stop.desc}</div>
        <p>The running turn on <b>{agentShort(a)}</b> stops at once. Your message is then sent as a new turn:</p>
        <blockquote className="quote">{ov.text}</blockquote>
        <p className="muted">Prefer to keep the work? Use <b>Queue</b> (after the turn) or <b>Steer</b> (at a safe point).</p>
        <div className="modal__actions"><button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--ghost" onClick={() => { s.send({ attemptId: a.id, text: ov.text, mode: 'steer', from: ov.from }); onClose(); }}>Steer instead</button>
          <button type="button" className="btn btn--danger" onClick={() => { s.send({ attemptId: a.id, text: ov.text, mode: 'stop', from: ov.from }); onClose(); }}>Stop &amp; Send</button></div>
      </div>
    </Scrim>
  );
}

function Return({ ov, onClose }) {
  const s = useStore();
  const [note, setNote] = useState('');
  return (
    <Scrim onClose={onClose}>
      <div className="modal">
        <h2>Return to Agent</h2>
        <p>Hand the work back with the context updated. No new chat is created — same Task, same Attempt, same worktree.</p>
        <ul className="insp__ul"><li><I n="check" size={11} />3 files changed by you · +42 / −7</li><li><I n="check" size={11} />ContextPackage refreshed to the next version</li><li><I n="check" size={11} />Actor change recorded (you → agent)</li></ul>
        <label className="field-l">Note to the agent (optional)<textarea className="input" style={{ height: 56, padding: 8 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="I fixed the path handling by hand; finish the tests." /></label>
        <div className="modal__actions"><button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn--accent" onClick={() => { s.returnToAgent(ov.attemptId, note.trim()); onClose(); }}>Return to Agent</button></div>
      </div>
    </Scrim>
  );
}

function NewTask({ onClose }) {
  const s = useStore();
  const [project, setProject] = useState(s.sel.projectId);
  const [title, setTitle] = useState('');
  const [prov, setProv] = useState('codex');
  const [host, setHost] = useState('desktop');
  const [text, setText] = useState('');
  const use = USAGE.find((u) => u.provider === prov);
  return (
    <Scrim onClose={onClose}>
      <div className="modal">
        <h2>New Task</h2>
        <p>A Task is a durable <b>objective</b>. Starting it creates its first Attempt.</p>
        <div className="grid2">
          <label className="field-l">Project<select value={project} onChange={(e) => setProject(e.target.value)}>{PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field-l">Agent<select value={prov} onChange={(e) => setProv(e.target.value)}>{Object.values(PROVIDERS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field-l" style={{ gridColumn: '1 / -1' }}>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Rate-limit middleware" autoFocus /></label>
          <label className="field-l">Run on<select value={host} onChange={(e) => setHost(e.target.value)}>{s.hosts.map((h) => <option key={h.id} value={h.id} disabled={h.status === 'offline'}>{h.name} — {h.status === 'online' ? 'Ready' : 'Offline'}</option>)}</select></label>
          <label className="field-l">Isolation<select disabled><option>Own worktree (default for writing)</option></select></label>
        </div>
        {use.pct >= 70 && <div className="callout callout--warn">⚠ {PROVIDERS[prov].name} is at {use.pct}% of its {use.windowLabel}. <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProv('codex')}>Switch to Codex</button></div>}
        <label className="field-l">Objective<textarea className="input" style={{ height: 70, padding: 8 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should be true when this is done?" /></label>
        <div className="modal__actions"><button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--accent" disabled={!title.trim()} onClick={() => { s.createTask({ projectId: project, title: title.trim(), provider: prov, host, objective: text.trim() }); onClose(); }}>Create Task &amp; start</button></div>
      </div>
    </Scrim>
  );
}

export default function Overlays() {
  const ov = useStore((s) => s.overlay);
  const close = useStore((s) => s.setOverlay);
  if (!ov) return null;
  const onClose = () => close(null);
  if (ov.type === 'jump') return <Jump onClose={onClose} />;
  if (ov.type === 'fork') return <Fork ov={ov} onClose={onClose} />;
  if (ov.type === 'confirmstop') return <ConfirmStop ov={ov} onClose={onClose} />;
  if (ov.type === 'return') return <Return ov={ov} onClose={onClose} />;
  if (ov.type === 'newtask') return <NewTask onClose={onClose} />;
  return null;
}
