// CliTerminal.jsx — `lxo` como cliente de primera clase del MISMO Core: mismos conceptos, mismos ids, mismos estados.
// Lo que se envía aquí aparece en la cola del Composer del ADE; lo que se aprueba en el móvil se ve aquí.
import { useEffect, useRef, useState } from 'react';
import { useStore, attemptById, taskOf, projectOf, attentionFor, timelineOf, fleetCounts } from '../store';
import { PROOF_PACKS, USAGE, PROJECTS, PROVIDERS } from '../data';
import { cliState, meta, agentShort, hostOf, MODES, isBusy } from '../vocab';
import { I } from '../ui';

const T = ({ a, children }) => <span className={`mk-tone-${meta(a).tone} cl-st`}>{children}</span>;
const pad = (s, n) => String(s).padEnd(n);

function tokenize(line) {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
function resolveAttempt(s, ref) {
  if (!ref) return attemptById(s, s.sel.attemptId);
  const r = ref.toLowerCase();
  return s.attempts.find((a) => a.id === r) || s.attempts.find((a) => a.taskId === r || a.taskId === `t_${r}`) || s.attempts.find((a) => taskOf(s, a).title.toLowerCase().includes(r) && true) || s.attempts.find((a) => (a.branch || '').includes(r));
}
const flag = (args, ...names) => names.some((n) => args.includes(n));
const val = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const HELP = [
  ['lxo', 'interactive home for the selected Attempt'], ['lxo status', 'fleet summary: working · needs you · hosts'], ['lxo tasks', 'Projects → Tasks → Attempts'], ['lxo agents', 'who is running what, where'],
  ['lxo attention', 'what needs a decision (resolve with --allow-once / --deny / --answer)'], ['lxo send [id] "text"', 'Queue by default · --steer · --stop · --fork'], ['lxo open [id]', 'ADE (default) or --ide'], ['lxo review [id]', 'Proof Pack · --accept · --reject'],
];

export function runCommand(line, s, ask) {
  const argv = tokenize(line.trim());
  if (!argv.length) return { out: null };
  if (argv[0] === 'clear') return { clear: true };
  if (argv[0] !== 'lxo') return { out: <div className="danger">command not found: {argv[0]} — try <b>lxo help</b></div> };
  const [, cmd, ...rest] = argv;
  const c = fleetCounts(s);
  if (!cmd) return { menu: true };

  if (cmd === 'help' || cmd === '--help') return { out: <div>{HELP.map(([k, d]) => <div key={k}><span className="cl-k">{pad(k, 24)}</span><span className="muted">{d}</span></div>)}</div> };

  if (cmd === 'status') {
    const a = attemptById(s, s.sel.attemptId); const t = taskOf(s, a);
    return { out: (
      <div>
        <div><b>LIXBON</b> <span className="muted">·</span> Desktop-PC <span className="good">online</span> <span className="muted">·</span> {c.active} agents working <span className="muted">·</span> <span className="warn">{c.attention} need you</span> <span className="muted">·</span> {c.review} review ready</div>
        <div className="muted">hosts: {s.hosts.map((h) => `${h.name} ${h.status === 'online' ? '●' : '○'}`).join('  ')}</div>
        <div>&nbsp;</div>
        {s.attempts.filter((x) => ['working', 'waiting', 'review_ready', 'failed'].includes(x.state)).map((x) => (
          <div key={x.id}><T a={x}>{pad(cliState(x), 18)}</T>{pad(taskOf(s, x).title, 22)}{pad(agentShort(x), 16)}<span className="muted">{pad(x.id, 14)}{pad(hostOf(x.host).name, 12)}{x.branch || 'plan'}</span>{attentionFor(s, x.id).length > 0 && <span className="warn"> !</span>}</div>
        ))}
        <div>&nbsp;</div><div className="muted">selected → {projectOf(s, t).name} / {t.title} / Attempt {a.label}</div>
      </div>
    ) };
  }

  if (cmd === 'tasks') {
    const pf = val(rest, '--project');
    return { out: (
      <div>
        <div className="muted">{pad('PROJECT', 14)}{pad('TASK', 22)}{pad('ATTEMPTS', 10)}{pad('STATE', 18)}HOST</div>
        {s.tasks.filter((t) => !pf || t.projectId === pf.toLowerCase()).map((t) => { const as = s.attempts.filter((a) => a.taskId === t.id); const a = as[0]; return (
          <div key={t.id}>{pad(projectOf(s, t).name, 14)}{pad(t.title, 22)}{pad(as.map((x) => x.label).join(','), 10)}<T a={a}>{pad(cliState(a), 18)}</T><span className="muted">{hostOf(a.host).name}</span></div>
        ); })}
      </div>
    ) };
  }

  if (cmd === 'agents') {
    return { out: (
      <div>
        <div className="muted">{pad('AGENT', 18)}{pad('TASK', 22)}{pad('ATT', 5)}{pad('STATE', 18)}{pad('HOST', 12)}COST</div>
        {s.attempts.map((a) => <div key={a.id}>{pad(agentShort(a), 18)}{pad(taskOf(s, a).title, 22)}{pad(a.label, 5)}<T a={a}>{pad(cliState(a), 18)}</T>{pad(hostOf(a.host).name, 12)}<span className="muted">${a.cost.toFixed(2)}</span></div>)}
        <div>&nbsp;</div>
        {USAGE.map((u) => <div key={u.provider} className="muted">{pad(PROVIDERS[u.provider].name, 14)}{u.pct}% of {u.windowLabel} · resets {u.reset}</div>)}
      </div>
    ) };
  }

  if (cmd === 'attention') {
    if (rest[0] === 'resolve') {
      const id = rest[1];
      const it = s.attention.find((x) => x.id === id || x.id.endsWith(id || '§'));
      if (!it) return { out: <div className="danger">no such attention item: {id}. See <b>lxo attention</b>.</div> };
      const dec = flag(rest, '--deny') ? 'deny' : flag(rest, '--allow-attempt') ? 'allow_attempt' : flag(rest, '--allow-once') ? 'allow_once' : val(rest, '--answer') ? 'answer' : flag(rest, '--retry') ? 'retry' : 'snooze';
      if (it.kind === 'permission' && it.risk === 'high' && dec !== 'deny') return { out: <div className="warn">High-risk approval needs an explicit confirmation outside this command. Open <b>lxo open {it.attemptId}</b> and review the command.</div> };
      s.resolveAttention(it.id, dec, { from: 'CLI', answer: val(rest, '--answer') });
      return { out: <div className="good">✓ {it.title}: {dec} <span className="muted">· the agent continues on its host</span></div> };
    }
    if (!s.attention.length) return { out: <div className="good">Nothing needs you.</div> };
    return { out: (
      <div>
        <div className="muted">{pad('ID', 14)}{pad('KIND', 12)}{pad('RISK', 8)}{pad('TASK', 20)}WHAT</div>
        {s.attention.map((x) => { const a = attemptById(s, x.attemptId); return <div key={x.id}>{pad(x.id.replace('at_', ''), 14)}{pad(x.kind, 12)}<span className={x.risk === 'high' ? 'danger' : x.risk === 'medium' ? 'warn' : 'muted'}>{pad(x.risk, 8)}</span>{pad(a ? taskOf(s, a).title : '—', 20)}{x.title}</div>; })}
        <div className="muted">resolve: lxo attention resolve &lt;id&gt; --allow-once | --deny | --answer "…"</div>
      </div>
    ) };
  }

  if (cmd === 'open') {
    const ide = flag(rest, '--ide');
    const a = resolveAttempt(s, rest.find((x) => !x.startsWith('--')));
    if (!a) return { out: <div className="danger">no such Attempt</div> };
    const t = taskOf(s, a);
    s.select(a.id);
    if (ide) s.setMockUi({ ideReviewOpen: false });
    return { out: <div className="good">→ opening {ide ? 'IDE' : 'ADE'}  <span className="muted">lixbon://project/{t.projectId}/task/{t.id}/attempt/{a.id}</span></div>, open: ide ? 'ide' : 'ade' };
  }

  if (cmd === 'send') {
    const nonFlags = rest.filter((x, i) => !x.startsWith('--') && rest[i - 1] !== '--answer');
    const text = nonFlags[nonFlags.length - 1];
    const ref = nonFlags.length > 1 ? nonFlags[0] : undefined;
    const a = resolveAttempt(s, ref);
    if (!a || !text) return { out: <div className="danger">usage: lxo send [attempt] "instruction" [--queue|--steer|--stop|--fork]</div> };
    const mode = flag(rest, '--fork') ? 'fork' : flag(rest, '--stop') ? 'stop' : flag(rest, '--steer') ? 'steer' : 'queue';
    if (mode === 'fork') { const id = s.fork({ attemptId: a.id, provider: a.provider === 'codex' ? 'claude' : 'codex', model: PROVIDERS[a.provider === 'codex' ? 'claude' : 'codex'].models[0], host: a.host, text, from: 'CLI', navigate: false }); return { out: <div className="good">✓ forked → {id} <span className="muted">same ContextPackage {a.ctx}</span></div> }; }
    if (mode === 'stop' && isBusy(a) && !flag(rest, '--yes')) return { out: <div className="warn">Stop &amp; Send interrupts the running turn (tools already run are NOT reverted). Re-run with <b>--yes</b> to confirm.</div> };
    const r = s.send({ attemptId: a.id, text, mode: isBusy(a) ? mode : undefined, from: 'CLI' });
    const n = (useStore.getState().pending[a.id] || []).length;
    return { out: <div className="good">✓ {!isBusy(a) ? 'sent' : r.mode === 'queue' ? `queued #${n}` : r.mode} <span className="muted">→ {taskOf(s, a).title} · Attempt {a.label} ({agentShort(a)}) — visible in ADE, IDE and phone</span></div> };
  }

  if (cmd === 'review') {
    const a = resolveAttempt(s, rest.find((x) => !x.startsWith('--')));
    if (!a) return { out: <div className="danger">no such Attempt</div> };
    const pp = PROOF_PACKS[a.id];
    if (flag(rest, '--accept', '--reject')) {
      if (!pp) return { out: <div className="danger">No Proof Pack for this Attempt yet.</div> };
      if (flag(rest, '--accept')) return { ask: { text: `Accept ${taskOf(s, a).title} · Attempt ${a.label} @ ${pp.revision}? [y/N]`, run: () => { s.decide(a.id, 'accepted', 'CLI'); return <div className="good">✓ accepted @ {pp.revision}</div>; } } };
      s.decide(a.id, 'rejected', 'CLI'); return { out: <div className="warn">✕ rejected</div> };
    }
    if (!pp) return { out: <div className="muted">No Proof Pack yet — {a.files} files, +{a.add}/−{a.del}. State: {cliState(a)}.</div> };
    return { out: (
      <div>
        <div><b>PROOF PACK</b> <span className="muted">· {taskOf(s, a).title} · Attempt {a.label} @ {pp.revision}</span></div>
        <div>{pp.files} files  <span className="good">+{pp.add}</span> <span className="danger">−{pp.del}</span></div>
        {pp.validation.map((v) => <div key={v.name}><span className={v.status === 'pass' ? 'good' : v.status === 'fail' ? 'danger' : 'muted'}>{v.status === 'pass' ? '✓' : v.status === 'fail' ? '✕' : '–'}</span> {pad(v.name, 28)}<span className="muted">{v.result}</span></div>)}
        {pp.unverified.map((u) => <div key={u} className="warn">? not verified: {u}</div>)}
        {pp.risks.map((r) => <div key={r.text} className={r.level === 'high' ? 'danger' : 'warn'}>! {r.level}: {r.text}</div>)}
        <div className="muted">full diff → <b>lxo open {a.id}</b>   accept → <b>lxo review {a.id} --accept</b></div>
      </div>
    ) };
  }

  if (cmd === 'task' && rest[0] === 'show') {
    const a = resolveAttempt(s, rest[1]);
    if (!a) return { out: <div className="danger">no such Task</div> };
    const t = taskOf(s, a);
    return { out: <div><b>{t.title}</b> <span className="muted">{projectOf(s, t).name}</span><div>{t.objective}</div>{s.attempts.filter((x) => x.taskId === t.id).map((x) => <div key={x.id}><T a={x}>{pad(cliState(x), 18)}</T>{pad(`Attempt ${x.label}`, 11)}{pad(agentShort(x), 16)}<span className="muted">{x.branch || 'plan'} · {hostOf(x.host).name}</span></div>)}</div> };
  }
  return { out: <div className="danger">unknown command: lxo {cmd} — try <b>lxo help</b></div> };
}

const MENU = ['View activity', 'Send instruction', 'Open ADE', 'Open IDE', 'Review changes', 'Fork attempt'];

function HomeCard({ s, idx }) {
  const a = attemptById(s, s.sel.attemptId);
  const t = taskOf(s, a);
  return (
    <div className="cl-card">
      <div><b className="cl-brand">LIXBON</b></div>
      <div>&nbsp;</div>
      <div><span className="muted">{pad('Project:', 10)}</span>{projectOf(s, t).name}</div>
      <div><span className="muted">{pad('Task:', 10)}</span>{t.title}</div>
      <div><span className="muted">{pad('Attempt:', 10)}</span>{agentShort(a)} <span className="muted">({a.label})</span></div>
      <div><span className="muted">{pad('Host:', 10)}</span>{hostOf(a.host).name} <span className="muted">· {a.branch || 'plan'}</span></div>
      <div><span className="muted">{pad('Status:', 10)}</span><T a={a}>{cliState(a)}</T>{attentionFor(s, a.id).length > 0 && <span className="warn">  ! needs you</span>}</div>
      <div>&nbsp;</div>
      {MENU.map((m, i) => <div key={m} className={i === idx ? 'cl-sel' : ''}>{i === idx ? '›' : ' '} {m}</div>)}
      <div className="muted">↑/↓ move · Enter select · Esc quit</div>
    </div>
  );
}

export default function CliTerminal() {
  const s = useStore();
  const [hist, setHist] = useState(() => useStore.getState().cli.buffer || [{ id: 0, cmd: null, out: <div className="muted">Lixbon CLI · same Core as the Desktop · try <b>lxo</b>, <b>lxo status</b> or <b>lxo attention</b></div> }]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('shell'); // shell | menu | prompt | ask
  const [idx, setIdx] = useState(0);
  const [prompt, setPrompt] = useState(null);
  const [recall, setRecall] = useState({ list: [], at: -1 });
  const end = useRef(null);
  const inp = useRef(null);
  useEffect(() => { useStore.setState((st) => ({ cli: { ...st.cli, buffer: hist } })); end.current?.scrollIntoView?.({ block: 'end' }); }, [hist, mode, idx]);
  useEffect(() => { inp.current?.focus(); }, [mode]);
  const push = (cmd, out) => setHist((h) => [...h, { id: h.length, cmd, out }]);
  // Los botones "Try" del panel lateral escriben aquí el comando a ejecutar.
  useEffect(() => {
    if (!s.cli.run) return;
    const c = s.cli.run;
    useStore.setState((st) => ({ cli: { ...st.cli, run: null } }));
    setMode('shell'); setPrompt(null); exec(c);
  }, [s.cli.run]); // eslint-disable-line

  function exec(line) {
    const r = runCommand(line, useStore.getState(), null);
    if (r.clear) { setHist([]); return; }
    if (r.menu) { push(line, null); setMode('menu'); setIdx(0); return; }
    if (r.ask) { push(line, <div className="warn">{r.ask.text}</div>); setPrompt({ kind: 'ask', run: r.ask.run }); setMode('prompt'); return; }
    push(line, r.out);
    if (r.open) setTimeout(() => useStore.getState().setSurface(r.open), 650);
  }
  function menuSelect(i) {
    const st = useStore.getState();
    const a = attemptById(st, st.sel.attemptId);
    const label = MENU[i];
    if (label === 'View activity') {
      push(null, <div>{timelineOf(st, a).slice(-6).map((e) => <div key={e.id}><span className="muted">{e.time} </span>{e.kind === 'user' ? <><b>you</b> ({e.from}) {e.text}</> : e.kind === 'agent' ? e.text : e.kind === 'tools' ? `ran ${e.items.length} command(s)` : e.kind === 'edits' ? `edited ${e.files.length} files` : e.kind === 'check' ? `✓ ${e.name} ${e.detail}` : e.text}</div>)}</div>);
    } else if (label === 'Send instruction') { setPrompt({ kind: 'send', attemptId: a.id }); setMode('prompt'); push(null, <div>Instruction for <b>{taskOf(st, a).title}</b> · Attempt {a.label}. <span className="muted">Enter = {isBusy(a) ? 'Queue' : 'Send'} · prefix <b>!</b> = Steer · <b>!!</b> = Stop &amp; Send</span></div>); }
    else if (label === 'Open ADE' || label === 'Open IDE') { const surf = label === 'Open ADE' ? 'ade' : 'ide'; if (surf === 'ide') st.setMockUi({ ideReviewOpen: false }); push(null, <div className="good">→ opening {surf.toUpperCase()} <span className="muted">same Task, same Attempt</span></div>); setMode('shell'); setTimeout(() => st.setSurface(surf), 650); }
    else if (label === 'Review changes') { push(null, runCommand(`lxo review ${a.id}`, st).out); }
    else if (label === 'Fork attempt') { const np = a.provider === 'codex' ? 'claude' : 'codex'; const id = st.fork({ attemptId: a.id, provider: np, model: PROVIDERS[np].models[0], host: a.host, from: 'CLI', navigate: false }); push(null, <div className="good">✓ forked → {id} <span className="muted">own worktree · ContextPackage {a.ctx} shared</span></div>); }
  }

  function onKey(e) {
    if (mode === 'menu') {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % MENU.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i + MENU.length - 1) % MENU.length); }
      else if (e.key === 'Enter') { e.preventDefault(); menuSelect(idx); }
      else if (e.key === 'Escape' || e.key === 'q') { e.preventDefault(); setMode('shell'); }
      return;
    }
    if (e.key === 'Enter') {
      const line = input; setInput('');
      if (mode === 'prompt') {
        if (prompt.kind === 'ask') { const ok = /^y/i.test(line.trim()); push(line, ok ? prompt.run() : <div className="muted">cancelled</div>); setPrompt(null); setMode('shell'); return; }
        const st = useStore.getState(); const a = attemptById(st, prompt.attemptId);
        const m = line.startsWith('!!') ? 'stop' : line.startsWith('!') ? 'steer' : 'queue'; const text = line.replace(/^!+\s*/, '');
        if (text) { const r = st.send({ attemptId: a.id, text, mode: isBusy(a) ? m : undefined, from: 'CLI' }); push(line, <div className="good">✓ {isBusy(a) ? r.mode : 'sent'} <span className="muted">→ {taskOf(st, a).title} · Attempt {a.label} — same Task as in ADE / phone</span></div>); }
        setPrompt(null); setMode('menu'); return;
      }
      if (line.trim()) { setRecall((r) => ({ list: [...r.list, line], at: -1 })); exec(line); } else push('', null);
    } else if (e.key === 'ArrowUp' && mode === 'shell') { e.preventDefault(); setRecall((r) => { const at = r.at < 0 ? r.list.length - 1 : Math.max(0, r.at - 1); setInput(r.list[at] || ''); return { ...r, at }; }); }
    else if (e.key === 'Escape' && mode === 'prompt') { setPrompt(null); setMode('menu'); setInput(''); }
  }

  return (
    <div className="cli" onClick={() => inp.current?.focus()}>
      <div className="cli__title"><I n="terminal" size={13} />lxo — PowerShell<span className="sp" /><span className="muted">C:\dev\lixbon</span></div>
      <div className="cli__out" role="log" aria-live="polite">
        {hist.map((h) => (
          <div key={h.id} className="cli__blk">
            {h.cmd != null && <div className="cl-p"><span className="muted">PS&gt;</span> {h.cmd}</div>}
            {h.out}
          </div>
        ))}
        {mode === 'menu' && <HomeCard s={s} idx={idx} />}
        <div className="cl-p cli__in">
          <span className="muted">{mode === 'menu' ? '' : mode === 'prompt' ? '›' : 'PS>'}</span>
          <input ref={inp} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} spellCheck={false} autoComplete="off" aria-label="Terminal input" placeholder={mode === 'menu' ? '(use ↑ ↓ Enter)' : mode === 'prompt' ? '' : 'lxo status'} />
        </div>
        <div ref={end} />
      </div>
    </div>
  );
}

export function CliHints({ onRun }) {
  return (
    <aside className="clihints">
      <h3>Try</h3>
      {['lxo', 'lxo status', 'lxo tasks', 'lxo agents', 'lxo attention', 'lxo review att_oa_b', 'lxo send runtime "also add edge-case tests"', 'lxo send runtime "keep SQLite" --steer', 'lxo open oauth --ide'].map((c) => <button key={c} type="button" onClick={() => onRun(c)}><code>{c}</code></button>)}
      <h3>Same model, same words</h3>
      <p>Project · Task · Attempt · Agent · Worktree · Attention · Review · Host. A <code>lxo send</code> lands in the ADE composer queue tagged <b>CLI</b>; an approval from the phone shows up here.</p>
    </aside>
  );
}


