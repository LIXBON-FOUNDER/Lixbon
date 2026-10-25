// MobileApp.jsx — Mobile Remote: superficie de Attention + decisión + control remoto. NO es un mini-IDE.
// La ejecución sigue en el host (Desktop-PC, MacBook, VPS…); el teléfono observa y decide sobre el MISMO estado del Core.
import { useState } from 'react';
import { useStore, attemptById, taskOf, attemptsOfTask, attentionFor, timelineOf, fleetCounts } from '../store';
import { PROOF_PACKS, USAGE, PROVIDERS, PROJECTS, CURRENT_HOST } from '../data';
import { Mark, StatePill, AttnFlag, Agent, Loc, I, RiskTag, Meter, money, ProvMark } from '../ui';
import { DecisionButtons } from '../ade/AttentionCard';
import { stateLabel, agentShort, hostOf, KIND_META, MODES, isBusy } from '../vocab';

const TITLE = { home: 'Lixbon', tasks: 'Work', attention: 'Attention', hosts: 'More', task: 'Task', approval: 'Decision', review: 'Review' };

function useScreen() {
  const m = useStore((s) => s.mobile);
  return m.stack.length ? m.stack[m.stack.length - 1] : { screen: m.tab, params: {} };
}

function Att({ a, onClick, right }) {
  const s = useStore();
  const t = taskOf(s, a);
  const n = attentionFor(s, a.id).length;
  return (
    <button type="button" className="mrow" onClick={onClick}>
      <Mark attempt={a} size={18} />
      <span className="mrow__m">
        <b>{t.title}</b>
        <small>{agentShort(a)} · {stateLabel(a)}{a.state === 'working' && a.minutes ? ` · ${a.minutes}m` : ''}</small>
        <small className="muted trunc">{a.latest}</small>
      </span>
      {right}{n > 0 && <AttnFlag n={n} />}<I n="right" size={13} />
    </button>
  );
}

function AttnRow({ x, onClick }) {
  const s = useStore();
  const a = attemptById(s, x.attemptId);
  const t = a && taskOf(s, a);
  return (
    <button type="button" className={`mrow mrow--attn mrow--${x.kind}`} onClick={onClick}>
      <span className="mrow__ic"><I n={KIND_META[x.kind]?.icon || 'warn'} size={15} /></span>
      <span className="mrow__m"><b>{x.title}</b><small>{t?.title} · {a && agentShort(a)} · {a && hostOf(a.host).name}</small></span>
      <RiskTag risk={x.risk} /><span className="muted mrow__ago">{x.ago}</span>
    </button>
  );
}

function Home() {
  const s=useStore(); const c=fleetCounts(s);
  return <div className="mscroll"><div className="mcard"><div className="mcard__k">Everything is up to date</div><div className="mcard__t">No decisions pending</div><p className="muted">{c.active} agents working on their hosts. You can check progress whenever you need.</p><button className="btn btn--accent btn--block" onClick={()=>s.mTab('tasks')}>See work</button></div></div>;
}

function Tasks() {
  const s = useStore();
  const [f, setF] = useState('all');
  return (
    <div className="mscroll">
      <div className="mchips">{[['all', 'All'], ['active', 'Active'], ['review', 'Review'], ['failed', 'Failed']].map(([id, l]) => <button key={id} type="button" className={f === id ? 'is-on' : ''} onClick={() => setF(id)}>{l}</button>)}</div>
      {PROJECTS.map((p) => {
        const list = s.attempts.filter((a) => taskOf(s, a).projectId === p.id).filter((a) => f === 'all' || (f === 'active' && a.state === 'working') || (f === 'review' && a.state === 'review_ready') || (f === 'failed' && a.state === 'failed'));
        if (!list.length) return null;
        return <div key={p.id} className="msec"><h3>{p.name}</h3>{s.tasks.filter(t=>t.projectId===p.id).map(t=>{ const attempts=list.filter(a=>a.taskId===t.id); return attempts.length ? <details className="mwork" key={t.id}><summary><b>{t.title}</b><span>{attempts.length} Attempt{attempts.length > 1 ? 's' : ''}</span><I n="down" /></summary>{attempts.map(a=><Att key={a.id} a={a} onClick={()=>s.mOpen('task',{attemptId:a.id})} />)}</details> : null; })}</div>;
      })}
    </div>
  );
}

function TaskScreen({ attemptId }) {
  const s = useStore();
  const a = attemptById(s, attemptId);
  const t = taskOf(s, a);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('queue');
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const sibs = attemptsOfTask(s, t.id);
  const attn = attentionFor(s, a.id);
  const pend = s.pending[a.id] || [];
  const busy = isBusy(a);
  const ev = timelineOf(s, a).filter((e) => e.kind !== 'checkpoint').slice(-4);
  return (
    <>
    <div className="mscroll">
      <div className="mcard">
        <div className="mcard__t">{t.title}</div>
        <div className="row"><Agent attempt={a} size={18} /></div>
        <div className="row"><StatePill attempt={a} /><span className="muted">{a.minutes ? `${a.minutes}m` : ''}</span></div>
        <dl className="mfacts">
          <dt>Host</dt><dd>{hostOf(a.host).name}{hostOf(a.host).status === 'offline' ? ' · offline' : ''}</dd>
          <dt>Branch</dt><dd className="mono">{a.branch || 'plan · no worktree'}</dd>
          <dt>Latest</dt><dd>{a.latest}</dd>
        </dl>
      </div>
      {sibs.length > 1 && <div className="mchips">{sibs.map((x) => <button key={x.id} type="button" className={x.id === a.id ? 'is-on' : ''} onClick={() => s.mOpen('task', { attemptId: x.id })}>Attempt {x.label} · {PROVIDERS[x.provider].name}</button>)}</div>}
      {attn.map((x) => <button key={x.id} type="button" className="mbanner" onClick={() => s.mOpen('approval', { id: x.id })}><AttnFlag n={1} risk={x.risk} /><span className="grow"><b>{x.title}</b><small>Tap to decide</small></span><I n="right" size={13} /></button>)}
      <div className="msec"><h3>Timeline</h3>
        <ul className="mtl">{ev.map((e) => <li key={e.id}><time>{e.time}</time><span>{e.kind === 'user' ? <><b>You</b> · {e.text}</> : e.kind === 'agent' ? e.text : e.kind === 'tools' ? `Ran ${e.items.length} command(s)` : e.kind === 'edits' ? `Edited ${e.files.length} files` : e.kind === 'check' ? `✓ ${e.name} ${e.detail}` : e.text}</span></li>)}</ul></div>
      {pend.length > 0 && <details className="msec mwork"><summary>Pending instructions · {pend.length}<I n="down" /></summary>
        {pend.map((p, i) => <div key={p.id} className="mpend"><span className={`chip chip--tag ${p.mode === 'queue' ? 'chip--accent' : 'chip--merged'}`}>{p.mode}</span><span className="grow">{p.text}</span>{p.from !== 'Mobile' && <span className="chip chip--tag chip--dim">{p.from}</span>}<button type="button" aria-label="Remove" onClick={() => s.removePending(a.id, p.id)}><I n="x" size={13} /></button></div>)}</details>}
      <div className="mactions">
        {a.state === 'working' && <button type="button" className="btn btn--ghost" onClick={() => { s.simulate(a.id, { state: 'paused', latest: 'Paused from phone' }); s.toast('Paused at the next safe boundary on ' + hostOf(a.host).name); }}>Pause</button>}
        {a.state === 'paused' && <button type="button" className="btn btn--ghost" onClick={() => { s.simulate(a.id, { state: 'working', phase: 'thinking', latest: 'Resumed from phone' }); }}>Resume</button>}
        {busy && <button type="button" className="btn btn--danger" onClick={() => setConfirm(true)}>Stop</button>}
        <button type="button" className="btn btn--merged" onClick={() => s.mOpen('review', { attemptId: a.id })}>Review</button>
        {attn[0] && <button type="button" className="btn btn--accent" onClick={() => s.mOpen('approval', { id: attn[0].id })}>Open Attention</button>}
      </div>
    </div>
      <div className="mcomposer"><div className="mnote"><I n="shield" size={12} /> {a.policy} · {hostOf(a.host).name}</div>
        <textarea rows={2} placeholder={busy ? 'Message the agent…' : 'Message the agent (it is idle)…'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
        <div className="row">
          {busy ? <button type="button" className="mmode" onClick={() => setSheet(true)}><b>{MODES[mode].label}</b><small>{MODES[mode].sub}</small><I n="down" size={11} /></button> : <span className="muted">Idle · sends a new turn</span>}
          <span className="sp" />
          <button type="button" className="btn btn--accent btn--icon mcomposer__send" disabled={!text.trim()} aria-label="Send" onClick={() => { if (busy && mode === 'stop') { setConfirm('send'); return; } s.send({ attemptId: a.id, text, mode: busy ? mode : undefined, from: 'Mobile' }); setText(''); }}><I n="up" size={15} /></button>
        </div>
      </div>
      {sheet && (
        <div className="msheet" onClick={() => setSheet(false)}><div onClick={(e) => e.stopPropagation()}>
          <h4>When the agent is busy</h4>
          {['queue', 'steer', 'stop'].map((id) => <button key={id} type="button" className={`msheet__i ${mode === id ? 'is-on' : ''}`} onClick={() => { setMode(id); setSheet(false); }}><b>{MODES[id].label}</b><small>{id === 'steer' && !PROVIDERS[a.provider].steer ? 'No native Steer on this agent → will queue' : MODES[id].desc}</small></button>)}
          <button type="button" className="msheet__i" onClick={() => { setSheet(false); s.fork({ attemptId: a.id, provider: a.provider === 'codex' ? 'claude' : 'codex', model: PROVIDERS[a.provider === 'codex' ? 'claude' : 'codex'].models[0], host: a.host, text: text || undefined, from: 'Mobile', navigate: false }); setText(''); }}><b>Fork as new Attempt</b><small>Advanced · runs in parallel on {hostOf(a.host).name}</small></button>
        </div></div>
      )}
      {confirm && (
        <div className="msheet" onClick={() => setConfirm(false)}><div onClick={(e) => e.stopPropagation()}>
          <h4>{confirm === 'send' ? 'Stop & Send?' : 'Stop this Attempt?'}</h4>
          <p className="muted">Tools already run and files already written are not reverted. The work stays in its worktree on {hostOf(a.host).name}.</p>
          <div className="mactions"><button type="button" className="btn btn--ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button type="button" className="btn btn--danger" onClick={() => { if (confirm === 'send') { s.send({ attemptId: a.id, text, mode: 'stop', from: 'Mobile' }); setText(''); } else { s.simulate(a.id, { state: 'paused', latest: 'Stopped from phone' }); s.toast('Stopped. Worktree preserved.', 'warn'); } setConfirm(false); }}>{confirm === 'send' ? 'Stop & Send' : 'Stop'}</button></div>
        </div></div>
      )}
    </>
  );
}

function Approval({ id }) {
  const s = useStore();
  const x = s.attention.find((i) => i.id === id);
  const [read, setRead] = useState(false);
  if (!x) return <div className="mscroll"><div className="mcard"><div className="mcard__t good">Decision sent ✓</div><p className="muted">The agent continues on its host. You can close this.</p><button type="button" className="btn btn--ghost btn--block" onClick={() => s.mBack()}>Back</button></div></div>;
  const a = attemptById(s, x.attemptId);
  const t = taskOf(s, a);
  const high = x.risk === 'high';
  return (
    <div className="mscroll">
      <div className={`mcard mcard--${x.kind === 'permission' ? 'warn' : x.kind === 'review' ? 'merged' : 'danger'}`}>
        <div className="mcard__k">{x.kind === 'permission' ? 'Permission required' : KIND_META[x.kind].label}</div>
        <div className="mcard__t">{x.title}</div>
        <dl className="mfacts">
          <dt>Task</dt><dd>{t.title}</dd><dt>Agent</dt><dd>{agentShort(a)}</dd><dt>Executes on</dt><dd>{hostOf(a.host).name}</dd>
          {x.command && <><dt>Command</dt><dd><code className="mcmd">{x.command}</code></dd><dt>Risk</dt><dd>{x.riskLabel} <RiskTag risk={x.risk} /></dd><dt>Reason</dt><dd>{x.reason}</dd><dt>Scope</dt><dd>{x.scope}</dd></>}
        </dl>
        {x.question && <p className="mq">{x.question}</p>}
        {x.summary && <p className="mq">{x.summary}</p>}
        {high && <label className="mread"><input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I read the whole command. High-impact actions are never “always allowed”.</label>}
        {x.kind === 'review'
          ? <div className="mactions mactions--col"><button type="button" className="btn btn--merged btn--lg" onClick={() => s.mOpen('review', { attemptId: a.id })}>Open review summary</button></div>
          : high
            ? <div className="mactions mactions--col"><button type="button" className="btn btn--danger btn--lg" onClick={() => s.resolveAttention(x.id, 'deny', { from: 'Mobile' })}>Deny</button><button type="button" className="btn btn--ghost btn--lg" disabled={!read} onClick={() => s.resolveAttention(x.id, 'allow_once', { from: 'Mobile' })}>Allow once</button></div>
            : <DecisionButtons item={x} from="Mobile" block size="lg" />}
      </div>
      <p className="mnote">The decision is sent to <b>{hostOf(a.host).name}</b>. Execution never moves to the phone.</p>
    </div>
  );
}

function ReviewSummary({ attemptId }) {
  const s = useStore();
  const a = attemptById(s, attemptId);
  const t = taskOf(s, a);
  const pp = PROOF_PACKS[a.id];
  return (
    <div className="mscroll">
      <div className="mcard">
        <div className="mcard__k">Proof Pack</div>
        <div className="mcard__t">{t.title} · Attempt {a.label}</div>
        <div className="row"><Agent attempt={a} size={16} />{pp && <span className="chip mono">@ {pp.revision}</span>}</div>
        {pp ? (
          <>
            <p className="mq">{pp.approach}</p>
            <div className="mgrid">{pp.validation.map((v) => <span key={v.name} className={`mval mval--${v.status}`}>{v.status === 'pass' ? '✓' : v.status === 'fail' ? '✕' : '–'} {v.name} <small>{v.result}</small></span>)}</div>
            <dl className="mfacts"><dt>Files</dt><dd>{pp.files} · <b className="good">+{pp.add}</b> <b className="danger">−{pp.del}</b></dd><dt>Needs eyes</dt><dd>{pp.review.length} security-sensitive files</dd></dl>
            {pp.risks.slice(0, 2).map((r) => <div key={r.text} className={`callout callout--${r.level === 'high' ? 'danger' : 'warn'}`}>{r.text}</div>)}
            {pp.unverified[0] && <div className="callout">Not verified: {pp.unverified[0]}</div>}
            {pp.screenshots.length > 0 && <div className="mshots">{pp.screenshots.map((l, i) => <span key={l} style={{ '--h': i * 70 }}>{l}</span>)}</div>}
            {pp.questions[0] && <p className="mq"><b>Open question:</b> {pp.questions[0]}</p>}
          </>
        ) : <p className="muted">No Proof Pack yet: {a.files} files, +{a.add}/−{a.del}. It is assembled when the Attempt finishes.</p>}
      </div>
      <div className="mactions mactions--col">
        <button type="button" className="btn btn--accent btn--lg" disabled={!pp || pp.risks.some(r => r.level === 'high') || pp.validation.some(v => v.status === 'fail')} onClick={() => { s.decide(a.id, 'accepted', 'Mobile'); s.mBack(); }}>Accept @ {pp?.revision || '—'}</button>
        <button type="button" className="btn btn--danger btn--lg" onClick={() => { s.decide(a.id, 'rejected', 'Mobile'); s.mBack(); }}>Reject</button>
        <button type="button" className="btn btn--ghost btn--lg" onClick={() => { s.openReview(a.id); s.toast('Full review is open in the Desktop IDE.'); }}>Continue review on Desktop</button>
      </div>
      <p className="mnote">Sensitive results or failed checks need the full review on Desktop. Accepting a revision leaves integration pending.</p>
    </div>
  );
}

function Hosts() {
  const s = useStore();
  return (
    <div className="mscroll">
      <div className="msec"><h3>Hosts</h3>
        {s.hosts.map((h) => { const n = s.attempts.filter((a) => a.host === h.id); return (
          <div key={h.id} className={`mhost ${h.status === 'offline' ? 'is-off' : ''}`}><i className={`host__dot ${h.status}`} /><span className="grow"><b>{h.name}</b><small>{h.status === 'online' ? 'Online' : 'Offline'} · {n.length} agent{n.length === 1 ? '' : 's'} · {h.note}</small></span></div>
        ); })}</div>
      <div className="msec"><h3>Usage today</h3>
        {USAGE.map((u) => <div key={u.provider} className="museage"><ProvMark id={u.provider} size={18} /><span className="grow"><b>{PROVIDERS[u.provider].name}</b><Meter pct={u.pct} /></span><span className="mono">{money(u.today)}</span></div>)}</div>
    </div>
  );
}

function Attention() {
  const s = useStore();
  const groups = [['Blocking work', ['permission','question']], ['Results to review', ['review']], ['Problems', ['failed','conflict','host']]];
  return (
    <div className="mscroll">
      {s.attention.length === 0 && <div className="mcard"><div className="mcard__t">All clear</div><p className="muted">Agents are working inside their contracts.</p></div>}
      <div className="mcard"><div className="mcard__k">Your next decisions</div><div className="mcard__t">{s.attention.length} need you</div><p className="muted">Resolve blockers first. Work keeps running on its host.</p></div>
      {groups.map(([label,kinds], index) => {
        const items = s.attention.filter((x) => kinds.includes(x.kind));
        return items.length ? (
          <details className="mattn-group" key={label} open={index === 0}>
            <summary><span>{label}</span><b>{items.length}</b><I n="down" size={14} /></summary>
            <div className="mattn-group__rows">{items.map((x) => <AttnRow key={x.id} x={x} onClick={() => s.mOpen('approval', { id: x.id })} />)}</div>
          </details>
        ) : null;
      })}
    </div>
  );
}

export default function MobileApp({ live = true }) {
  const s = useStore();
  const { screen, params } = useScreen();
  const m = s.mobile;
  const c = fleetCounts(s);
  const deep = m.stack.length > 0;
  const body = { home: <Home />, tasks: <Tasks />, attention: <Attention />, hosts: <Hosts />, task: <TaskScreen attemptId={params.attemptId} />, approval: <Approval id={params.id} />, review: <ReviewSummary attemptId={params.attemptId} /> }[screen];
  const time = `${String(Math.floor(s.clock / 60) % 24).padStart(2, '0')}:${String(s.clock % 60).padStart(2, '0')}`;
  return (
    <div className="phone mkr" data-surface="mobile">
      <div className="phone__status"><span>{time}</span><span className="phone__notch" /><span>5G ▮▮▮</span></div>
      <header className="phone__bar">
        {deep ? <button type="button" onClick={s.mBack} aria-label="Back"><I n="left" size={16} /></button> : <b className="phone__logo">LIXBON</b>}
        <span className="phone__title">{deep ? TITLE[screen] : TITLE[m.tab]}</span>
        <span className="sp" /><span className="mremote mremote--s"><i className="host__dot online" />Connected to Desktop-PC</span>
      </header>
      {live && s.push && !deep && (
        <button type="button" className="phone__push" onClick={() => { s.mOpen('approval', { id: s.attention.find((x) => x.attemptId === s.push.attemptId && x.kind === 'permission')?.id }); s.dismissPush(); }}>
          <span className="phone__pushic">L</span><span className="grow"><b>{s.push.title}</b><small>{s.push.body}</small></span><span className="muted">now</span>
        </button>
      )}
      <div className="phone__body">{body}</div>
      <nav className="phone__tabs" aria-label="Mobile navigation">
        {[['attention', 'Attention', 'warn'], ['tasks', 'Work', 'list'], ['hosts', 'More', 'gear']].map(([id, l, ic]) => (
          <button key={id} type="button" className={m.tab === id && !deep ? 'is-on' : ''} onClick={() => s.mTab(id)}><I n={ic} size={19} />{l}{id === 'attention' && c.attention > 0 && <b>{c.attention}</b>}</button>
        ))}
      </nav>
    </div>
  );
}

