import ReviewViewer from '../ade/ReviewViewer';
// IdeDesktop.jsx — Desktop IDE (Execution Plane). Mismo Core, otra representación.
// Regla de diseño: la barra de contexto Task → Attempt → branch → worktree → agent → host NUNCA se oculta,
// para que sea imposible creer que se edita un branch mientras el agente modifica otro.
import { useMemo, useState } from 'react';
import { useStore, attemptById, taskOf, projectOf, attentionFor, timelineOf } from '../store';
import { REPO_TREE, CODE, DIFFS, REVIEW_FILES, DIAGNOSTICS, PROVIDERS } from '../data';
import { I, StatePill, Agent, Loc, AttnFlag, Mark, Kbd } from '../ui';
import { SurfaceSwitch } from '../ade/AdeDesktop';
import Composer from '../ade/Composer';
import AttentionCard from '../ade/AttentionCard';
import Overlays from '../ade/Overlays';
import { agentShort, stateLabel, isBusy } from '../vocab';

const KW = /\b(import|from|export|const|let|async|await|function|return|if|else|throw|new|type|interface|class|extends|try|catch)\b/g;
function highlight(line) {
  const out = [];
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0; let m;
  const kw = (t, k) => { let l = 0; let mm; KW.lastIndex = 0; const parts = []; while ((mm = KW.exec(t))) { parts.push(t.slice(l, mm.index), <span key={`${k}${mm.index}`} className="tk-k">{mm[0]}</span>); l = mm.index + mm[0].length; } parts.push(t.slice(l)); return parts; };
  while ((m = re.exec(line))) {
    out.push(...kw(line.slice(last, m.index), `a${last}`));
    out.push(<span key={`s${m.index}`} className={m[1] ? 'tk-c' : 'tk-s'}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  out.push(...kw(line.slice(last), `z${last}`));
  return out;
}

function changedPaths(a, s) {
  const rf = REVIEW_FILES[a.id];
  if (rf) return Object.fromEntries(rf.map((f) => [f.path, 'M']));
  const tl = timelineOf(s, a).filter((e) => e.kind === 'edits').flatMap((e) => e.files).map((f) => f.path);
  return Object.fromEntries(tl.map((p) => [p, 'M']));
}

function Tree({ nodes, depth = 0, open, onOpenFile, active, changed, aiFile }) {
  const [closed, setClosed] = useState({});
  return (
    <ul className="ftree">
      {nodes.map((n) => {
        if (n.dir) {
          const isOpen = n.open ? !closed[n.name + depth] : !!closed[n.name + depth];
          return (
            <li key={n.name}>
              <button type="button" className="ftree__r" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setClosed((c) => ({ ...c, [n.name + depth]: !c[n.name + depth] }))}>
                <I n={isOpen ? 'down' : 'right'} size={10} /><I n={isOpen ? 'folderopen' : 'folder'} size={13} />{n.name}
              </button>
              {isOpen && <Tree nodes={n.children} depth={depth + 1} onOpenFile={onOpenFile} active={active} changed={changed} aiFile={aiFile} />}
            </li>
          );
        }
        return (
          <li key={n.path}>
            <button type="button" className={`ftree__r ${active === n.path ? 'is-on' : ''}`} style={{ paddingLeft: 22 + depth * 12 }} onClick={() => onOpenFile(n.path)}>
              <I n="file" size={13} /><span className="trunc grow">{n.name}</span>
              {aiFile === n.path && <span className="chip chip--tag chip--accent" title="The agent is editing this file right now">AI</span>}
              {changed[n.path] && <b className="ftree__m" title="Changed by this Attempt">{changed[n.path]}</b>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ContextBar({ a, task, project, embedded }) {
  const s = useStore();
  const human = a.control === 'human';
  return (
    <div className="ctxbar" role="region" aria-label="Task, Attempt, branch, worktree, agent and host">
      <div className="ctxbar__l">
        <span className="ctxbar__k">Task</span><b>{task.title}</b>
        <I n="right" size={10} /><span className="ctxbar__k">Attempt</span><b>{a.label}</b>
        <StatePill attempt={a} size={11} />
      </div>
      <div className="ctxbar__m"><Agent attempt={a} size={15} /><Loc attempt={a} parts={['branch', 'worktree', 'host']} forceHost /></div>
      <span className="sp" />
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setSurface('ade')}><I n="nodes" size={12} />Open in ADE</button>
      <button type="button" className="btn btn--merged btn--sm" onClick={() => { s.openReview(a.id); }}><I n="eye" size={12} />Review changes</button>
      {human
        ? <button type="button" className="btn btn--accent btn--sm" onClick={() => s.setOverlay({ type: 'return', attemptId: a.id })}><I n="arrow" size={12} />Return to Agent</button>
        : <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.takeOver(a.id)} disabled={a.state === 'offline' || !a.worktree}><I n="user" size={12} />Take Over</button>}
    </div>
  );
}

function BottomPanel({ a }) {
  const [tab, setTab] = useState('terminal');
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState([]);
  const prompt = a.worktree ? `PS ${a.worktree.replace('%LOCALAPPDATA%', '~\\AppData\\Local')}>` : 'PS (no worktree)>';
  return (
    <div className="ibottom">
      <div className="tabs">
        {[['terminal', 'Terminal'], ['problems', `Problems`, DIAGNOSTICS.length], ['tests', 'Tests'], ['debug', 'Debug']].map(([id, l, n]) => (
          <button key={id} type="button" className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{l}{n ? <i>{n}</i> : null}</button>
        ))}
        <span className="sp" /><span className="muted ibottom__scope">scoped to {a.branch || 'plan'}</span>
      </div>
      <div className="ibottom__b">
        {tab === 'terminal' && (
          <div className="term">
            <div className="muted">{prompt} git status -sb</div>
            <div>## {a.branch || 'plan'} · {a.files} changed</div>
            {a.phase === 'tool' && <div className="accent">▶ agent: {a.toolLabel} …</div>}
            {lines.map((l, i) => <div key={i} className={l.startsWith(prompt) ? 'muted' : ''}>{l}</div>)}
            <label className="term__in"><span className="muted">{prompt}</span><input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && cmd.trim()) { setLines((x) => [...x, `${prompt} ${cmd}`, '(simulated terminal — nothing executed)']); setCmd(''); } }} aria-label="Terminal input" /></label>
          </div>
        )}
        {tab === 'problems' && <ul className="probs">{DIAGNOSTICS.map((d, i) => <li key={i}><span className={d.sev === 'warn' ? 'warn' : 'info'}>{d.sev === 'warn' ? '⚠' : 'ℹ'}</span><span className="grow">{d.msg}</span><span className="mono muted">{d.file}:{d.line}</span></li>)}</ul>}
        {tab === 'tests' && <div className="pad"><div className="row"><span className="good">✓</span>{a.tests ? `${a.tests.pass}/${a.tests.total} passing` : 'No test run yet'}<span className="muted">· from this worktree</span></div></div>}
        {tab === 'debug' && <div className="pad"><p className="muted">No active debug session. Launch config: <span className="mono">Attach to runtime (node:9229)</span></p><button type="button" className="btn btn--ghost btn--sm" onClick={() => useStore.getState().toast('Debugging starts in this worktree (simulated).')}><I n="play" size={12} />Start debugging <Kbd>F5</Kbd></button></div>}
      </div>
    </div>
  );
}

function Sidecar({ a, task }) {
  const s = useStore();
  const attn = attentionFor(s, a.id);
  const ev = timelineOf(s, a).slice(-5);
  return (
    <aside className="side" aria-label="Agent sidecar">
      <header className="side__h"><Agent attempt={a} /><span className="sp" /><StatePill attempt={a} size={11} /></header>
      <div className="side__sub muted">{task.title} · Attempt {a.label} · {a.latest}</div>
      {attn.map((x) => <AttentionCard key={x.id} item={x} compact />)}
      <div className="side__tl">
        {ev.map((e) => (
          <div key={e.id} className={`side__e side__e--${e.kind}`}>
            <span className="muted">{e.time}</span>
            <span>{e.kind === 'user' ? <><b>You</b> {e.text}</> : e.kind === 'agent' ? e.text : e.kind === 'tools' ? `Ran ${e.items.length} command(s)` : e.kind === 'edits' ? `Edited ${e.files.length} files` : e.kind === 'check' ? `✓ ${e.name} ${e.detail}` : e.text}</span>
          </div>
        ))}
      </div>
      <Composer attemptId={a.id} compact from="IDE" />
    </aside>
  );
}

function IdeInner({ live = true, embedded = false }) {
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const project = projectOf(s, task);
  const changed = useMemo(() => changedPaths(a, s), [a.id, s.timelines[a.id]]); // eslint-disable-line
  const defaultFile = Object.keys(changed).find((p) => CODE[p]) || Object.keys(changed)[0] || 'src/runtime/session.ts';
  const [open, setOpen] = useState([defaultFile]);
  const [active, setActive] = useState(defaultFile);
  const [panel, setPanel] = useState('explorer');
  const [sel, setSel] = useState('');
  const [delegate, setDelegate] = useState(null);
  const ai = a.state === 'working' ? (a.phase === 'writing' ? Object.keys(changed)[0] : null) : null;

  const openFile = (p) => { setOpen((o) => (o.includes(p) ? o : [...o, p])); setActive(p); };
  const src = CODE[active] || `// ${active}\n// (content elided in the mockup)\nexport {};`;
  const addLines = new Set((DIFFS[active] || []).filter((l) => l.t === 'add').map((l) => l.n));
  const diagLines = Object.fromEntries(DIAGNOSTICS.filter((d) => d.file === active).map((d) => [d.line, d]));
  const human = a.control === 'human';
  const aiBanner = a.worktree && changed[active];

  return (
    <div className="ide mkr" data-surface="ide">
      {!embedded && <header className="topbar"><SurfaceSwitch /><span className="muted">{project.name} — IDE</span><span className="sp" />
        <button type="button" className="btn btn--text btn--icon" onClick={() => s.setSurface('mobile')} aria-label="Mobile preview"><I n="device" size={14} /></button>
        <button type="button" className="btn btn--text btn--icon" onClick={() => s.setSurface('cli')} aria-label="CLI preview"><I n="terminal" size={14} /></button></header>}
      <ContextBar a={a} task={task} project={project} embedded={embedded} />
      {s.mismatch && <div className="callout callout--danger ide__warn"><b>⚠ Location mismatch</b> — IDE opened <span className="mono">{a.branch}</span>, runtime reports <span className="mono">{a.branch}-fix</span>. Editing is blocked until you inspect.</div>}
      <div className={`hier-ide-tools ${s.mockUi.ideReviewOpen ? 'is-review' : ''}`}><button className="btn btn--ghost btn--sm" onClick={()=>s.setMockUi({ideReviewOpen:!s.mockUi.ideReviewOpen})}><I n="eye" />{s.mockUi.ideReviewOpen ? 'Edit code' : 'Review changes'}</button><span className="sp" />{[['explorerOpen','Explorer','folder'],['terminalOpen','Terminal','terminal'],['sidecarOpen','Agent','chat']].map(([key,label,icon])=><button key={key} className="btn btn--text btn--sm hier-ide-toggle" aria-expanded={s.mockUi[key]} onClick={()=>s.setMockUi({[key]:!s.mockUi[key]})}><I n={icon} />{label}</button>)}</div>
      {s.mockUi.ideReviewOpen ? <div className="hier-ide-review"><ReviewViewer key={a.id} embedded /></div> : <div className="ide__body" style={{gridTemplateColumns: '44px ' + (s.mockUi.explorerOpen ? '220px ' : '') + 'minmax(0,1fr)' + (s.mockUi.sidecarOpen ? ' 310px' : '')}}>
        <nav className="abar" aria-label="Activity bar">
          {[['explorer', 'file'], ['scm', 'branch'], ['search', 'search'], ['debug', 'play']].map(([id, ic]) => (
            <button key={id} type="button" className={panel === id ? 'is-on' : ''} onClick={() => setPanel(id)} aria-label={id} title={id}><I n={ic} size={17} />{id === 'scm' && a.files > 0 && <i>{a.files}</i>}</button>
          ))}
        </nav>
        {s.mockUi.explorerOpen && <aside className="exp">
          <div className="exp__h">{panel === 'scm' ? 'SOURCE CONTROL' : panel === 'search' ? 'SEARCH' : panel === 'debug' ? 'RUN & DEBUG' : 'EXPLORER'}</div>
          <div className="exp__wt"><I n="branch" size={11} /><span className="trunc">{a.worktree ? `worktree · ${a.id}` : 'no worktree (read-only plan)'}</span></div>
          {panel === 'explorer' && (a.worktree ? <Tree nodes={REPO_TREE} onOpenFile={openFile} active={active} changed={changed} aiFile={ai} /> : <div className="empty" style={{ margin: 8 }}>Plan-only Attempt: nothing to edit. <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.openFork(a.id)}>Fork with a worktree</button></div>)}
          {panel === 'scm' && (
            <div className="scm">
              <div className="callout callout--info" style={{ margin: 8 }}>This worktree belongs to <b>{task.title}</b> · Attempt {a.label} ({agentShort(a)}).</div>
              <ul className="insp__files" style={{ padding: '0 10px' }}>{Object.keys(changed).map((p) => <li key={p}><b className="ftree__m">M</b><button type="button" className="mono trunc grow" onClick={() => { setPanel('explorer'); openFile(p); }}>{p}</button></li>)}</ul>
              <div style={{ padding: 10 }}><input className="input" placeholder={isBusy(a) && !human ? 'Agent is committing…' : 'Message'} disabled={isBusy(a) && !human} /><button type="button" className="btn btn--ghost btn--sm btn--block" style={{ marginTop: 6 }} disabled={isBusy(a) && !human}>Commit</button></div>
              {isBusy(a) && !human && <p className="muted" style={{ padding: '0 10px', fontSize: 11.5 }}>The agent owns commits while it works. <b>Take Over</b> to commit by hand.</p>}
            </div>
          )}
          {panel === 'search' && <div style={{ padding: 8 }}><input className="input" placeholder="Search in worktree…" /></div>}
          {panel === 'debug' && <div style={{ padding: 8 }}><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast('Debug (simulated)')}><I n="play" size={12} />Attach to runtime</button></div>}
        </aside>}

        <section className="edw">
          <div className="etabs">{open.map((p) => <button key={p} type="button" className={active === p ? 'is-on' : ''} onClick={() => setActive(p)}><I n="file" size={12} />{p.split('/').pop()}{changed[p] && <b className="ftree__m">M</b>}<span className="etabs__x" role="button" aria-label="Close" onClick={(e) => { e.stopPropagation(); const n = open.filter((x) => x !== p); setOpen(n); if (active === p) setActive(n[0] || ''); }}>×</span></button>)}</div>
          {human && <div className="callout callout--good ide__banner"><b>You are driving.</b> The agent is paused at a safe boundary; changes you make become part of the Attempt. <button type="button" className="btn btn--accent btn--sm" onClick={() => s.setOverlay({ type: 'return', attemptId: a.id })}>Return to Agent</button></div>}
          {false && aiBanner && !human && (
            <div className="aibanner"><I n="nodes" size={13} /><b>AI WORK</b><span>{task.title} · {a.label} · {agentShort(a)}</span><span className="muted">{a.state === 'working' ? `working in ${a.branch}` : stateLabel(a).toLowerCase()}</span><span className="sp" /><button type="button" className="btn btn--text btn--sm" onClick={() => s.setSurface('ade')}>Open in ADE</button></div>
          )}
          <div className="editor" onMouseUp={() => { const t = window.getSelection()?.toString().trim(); setSel(t || ''); }}>
            {active ? src.split('\n').map((l, i) => (
              <div key={i} className={`eline ${addLines.has(i + 1) ? 'is-ai' : ''} ${diagLines[i + 1] ? 'has-diag' : ''}`} title={diagLines[i + 1]?.msg}>
                <span className="eline__g">{addLines.has(i + 1) ? <i title="Added by this Attempt" /> : null}</span><span className="eline__n">{i + 1}</span><code>{highlight(l) }</code>
              </div>
            )) : <div className="empty" style={{ margin: 16 }}>Open a file from the Explorer.</div>}
            {sel && !delegate && <button type="button" className="delegate-btn btn btn--accent btn--sm" onClick={() => setDelegate({ text: sel })}><I n="split" size={12} />Delegate selection…</button>}
          </div>
          {delegate && (
            <div className="delegate">
              <b>Delegate</b><span className="muted"> — creates a Task + Attempt in its own worktree; you keep editing.</span>
              <pre className="mono">{delegate.text.slice(0, 160)}</pre>
              <div className="row"><input className="input grow" placeholder="Instruction, e.g. “Add a timeout and tests for this”" id="dg" />
                <button type="button" className="btn btn--accent btn--sm" onClick={() => { const v = document.getElementById('dg').value || 'Improve this selection'; s.createTask({ projectId: project.id, title: v.slice(0, 40), provider: 'codex', host: 'desktop', objective: `${v}\n\n${delegate.text.slice(0, 200)}` }); setDelegate(null); setSel(''); s.setSurface('ide'); }}>Delegate to Codex</button>
                <button type="button" className="btn btn--text btn--sm" onClick={() => { setDelegate(null); setSel(''); }}>Cancel</button></div>
              <div className="muted" style={{ fontSize: 11 }}>ContextPackage preview: file + selection + Task constraints · secrets redacted</div>
            </div>
          )}
          {s.mockUi.terminalOpen && <BottomPanel a={a} />}
        </section>
        {s.mockUi.sidecarOpen && <Sidecar a={a} task={task} />}
      </div>}
      {!embedded && <footer className="statusbar">
        <span className="mono"><I n="branch" size={11} />{a.branch || 'plan'}</span><span>{a.worktree ? 'own worktree' : 'no worktree'}</span><span>{a.files || Object.keys(changed).length} changed</span>
        <span className="sp" /><span>{stateLabel(a)}</span><span>{agentShort(a)}</span><span className="muted">Mock · no real Core</span>
      </footer>}
      {live && !embedded && <Overlays />}
    </div>
  );
}

/** Reinicia pestañas/archivo abierto al cambiar de Attempt (cada worktree tiene su propio árbol y sus propios cambios). */
export default function IdeDesktop(props) {
  const id = useStore((s) => s.sel.attemptId);
  return <IdeInner key={id} {...props} />;
}
