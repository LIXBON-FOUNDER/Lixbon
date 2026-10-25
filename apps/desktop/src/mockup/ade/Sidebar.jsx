// Sidebar.jsx — navegación espacial ORCA-like con semántica Lixbon: Project → Task → Attempt (worktree + agente).
// Reglas de la maqueta (ver docs/mockup/DISENO.md):
//  · 1 Attempt  → la Task se comprime en UNA fila (sin capa extra).  N Attempts → la Task se vuelve grupo.
//  · Estado de ejecución (forma) y Attention (marcador ámbar) son ejes distintos. Unread es un tercer eje (punto).
//  · Orden ESTABLE: un cambio de estado nunca reordena filas (memoria espacial).
//  · El host solo aparece si es remoto/offline (o si se activa "Always show host").
import { useMemo, useState } from 'react';
import { useStore, attemptsOfTask, fleetCounts, hostCount } from '../store';
import { PROJECTS, USAGE, PROVIDERS } from '../data';
import { Mark, AttnFlag, Agent, Loc, I, Seg, Meter } from '../ui';
import { stateLabel, agentShort, isRemote, hostOf, meta } from '../vocab';

const CHIPS = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'review', label: 'Review ready' },
  { id: 'active', label: 'Active' },
  { id: 'failed', label: 'Failed' },
];

function matches(s, a, t, p) {
  const { q, chips, hostId } = s.filter;
  const hay = `${p.name} ${t.title} ${a.branch || ''} ${agentShort(a)} ${hostOf(a.host).name}`.toLowerCase();
  if (q && !hay.includes(q.toLowerCase())) return false;
  if (hostId && a.host !== hostId) return false;
  if (!chips.length) return true;
  return chips.some((c) => (c === 'attention' ? s.attention.some((x) => x.attemptId === a.id) : c === 'review' ? a.state === 'review_ready' : c === 'active' ? ['working', 'starting'].includes(a.state) : a.state === 'failed'));
}

function AttemptRow({ a, task, single, selected, onSelect }) {
  const s = useStore();
  const attn = s.attention.filter((x) => x.attemptId === a.id);
  const showHost = s.filter.showHostAlways || isRemote(a) || a.state === 'offline';
  const m = meta(a);
  return (
    <button type="button" className={`sb-row ${single ? 'sb-row--task' : 'sb-row--att'} ${selected ? 'is-sel' : ''}`} onClick={() => onSelect(a.id)} aria-current={selected ? 'true' : undefined}
      title={`${task.title} · Attempt ${a.label}\n${stateLabel(a)}\n${a.branch || 'plan only'} · ${hostOf(a.host).name}`}>
      <span className="sb-row__lead"><Mark attempt={a} size={14} /></span>
      <span className="sb-row__main">
        <span className="sb-row__l1">
          {a.unread && <i className="unread-dot" title="Unread activity" />}
          <span className={`sb-row__title ${a.unread ? 'is-unread' : ''}`}>{single ? task.title : <Agent attempt={a} size={14} />}</span>
          <span className="sp" />
          {attn.length > 0 && <AttnFlag n={attn.length} risk={attn.some((x) => x.risk === 'high') ? 'high' : undefined} />}
        </span>
        <span className="sb-row__l2">
          <span className={`mk-tone-${m.tone} sb-row__state`}>{stateLabel(a)}</span>
          {single && <><span className="sb-dot">·</span><Agent attempt={a} size={12} /></>}
          {a.state === 'working' && a.minutes > 0 && <><span className="sb-dot">·</span><span>{a.minutes}m</span></>}
          {a.origin === 'CLI' && <><span className="sb-dot">·</span><span title="Started from the CLI (lxo)">CLI</span></>}
        </span>
        <span className="sb-row__l3">
          <Loc attempt={a} parts={showHost ? ['branch', 'host'] : ['branch']} compact forceHost={showHost} />
        </span>
      </span>
    </button>
  );
}

function TaskBlock({ task, project }) {
  const s = useStore();
  const [showAll, setShowAll] = useState(false);
  const all = attemptsOfTask(s, task.id);
  const atts = all.filter((a) => matches(s, a, task, project));
  if (!atts.length) return null;
  const selAtt = s.sel.attemptId;

  if (all.length === 1) {
    const a = all[0];
    return <AttemptRow a={a} task={task} single selected={selAtt === a.id} onSelect={(id) => s.select(id)} />;
  }
  const open = s.expanded[task.id] !== false;
  const attnTotal = all.reduce((n, a) => n + s.attention.filter((x) => x.attemptId === a.id).length, 0);
  const visible = showAll ? atts : atts.slice(0, 3);
  const hasSel = all.some((a) => a.id === selAtt);
  return (
    <div className="sb-group">
      <button type="button" className={`sb-grouphead ${hasSel && !open ? 'is-sel' : ''}`} onClick={() => s.toggleExpanded(task.id)} aria-expanded={open}>
        <I n={open ? 'down' : 'right'} size={12} />
        <span className="sb-row__title">{task.title}</span>
        <span className="sb-count" title={`${all.length} attempts`}>{all.length}</span>
        <span className="sp" />
        {!open && attnTotal > 0 && <AttnFlag n={attnTotal} />}
        {!open && all.map((a) => <Mark key={a.id} attempt={a} size={11} />)}
      </button>
      {open && (
        <div className="sb-children">
          {visible.map((a) => <AttemptRow key={a.id} a={a} task={task} selected={selAtt === a.id} onSelect={(id) => s.select(id)} />)}
          {atts.length > 3 && !showAll && <button type="button" className="sb-more" onClick={() => setShowAll(true)}>+{atts.length - 3} agents</button>}
        </div>
      )}
    </div>
  );
}

function ExternalWorktree() {
  const [state, setState] = useState('detected');
  const toast = useStore((s) => s.toast);
  if (state !== 'detected') return null;
  return (
    <div className="sb-ext">
      <span className="sb-ext__n" title="External worktree · C:\worktrees\foo"><I n="branch" size={11} /><span className="mono trunc">feature/foo</span><small>external</small></span>
      <span className="row">
        <button type="button" className="btn btn--text btn--sm" onClick={() => { setState('adopted'); toast('Adopted feature/foo. No files moved, Git untouched.', 'good'); }}>Adopt</button>
        <button type="button" className="btn btn--text btn--sm" onClick={() => setState('ignored')}>Ignore</button>
      </span>
    </div>
  );
}

export default function Sidebar() {
  const s = useStore();
  const [filterOpen, setFilterOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const c = fleetCounts(s);
  const byKind = useMemo(() => {
    const k = {};
    s.attention.forEach((x) => { const key = x.kind === 'permission' ? 'permissions' : x.kind === 'review' ? 'reviews' : x.kind === 'question' ? 'questions' : x.kind === 'failed' ? 'failures' : x.kind === 'conflict' ? 'conflicts' : 'host'; k[key] = (k[key] || 0) + 1; });
    return Object.entries(k).map(([key, n]) => `${n} ${n === 1 ? key.replace(/s$/, '') : key}`).join(' · ');
  }, [s.attention]);
  const { chips } = s.filter;
  const filteringAll = !!(s.filter.q || chips.length || s.filter.hostId);
  const noMatches = filteringAll && !PROJECTS.some((p) => s.tasks.filter((t) => t.projectId === p.id).some((t) => attemptsOfTask(s, t.id).some((a) => matches(s, a, t, p))));

  return (
    <aside className="sb" aria-label="Projects, Tasks and Attempts">
      <div className="sb__head">
        <span className="sb__brand">LIXBON <i>ADE</i></span>
        <span className="sp" />
        <div className="sb__new">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewOpen((v) => !v)} aria-haspopup="menu"><I n="plus" size={12} />New</button>
          {newOpen && (
            <div className="menu" style={{ top: 30, right: 0 }} role="menu" onMouseLeave={() => setNewOpen(false)}>
              <button type="button" className="menu__i" role="menuitem" onClick={() => { setNewOpen(false); s.setOverlay({ type: 'newtask' }); }}>New Task…<small>A durable objective. Starts its first Attempt.</small></button>
              <button type="button" className="menu__i" role="menuitem" onClick={() => { setNewOpen(false); s.openFork(s.sel.attemptId); }}>New Attempt for current Task…<small>Another execution of the same Task.</small></button>
              <div className="menu__sep" />
              <button type="button" className="menu__i" role="menuitem" onClick={() => { setNewOpen(false); s.toast('Open existing worktree… (simulated)'); }}>Open existing worktree…</button>
              <button type="button" className="menu__i" role="menuitem" onClick={() => { setNewOpen(false); s.toast('Adopt external worktree… (simulated)'); }}>Adopt external worktree…</button>
              <button type="button" className="menu__i" role="menuitem" onClick={() => { setNewOpen(false); s.toast('Quick Chat… (simulated) — no Task is created'); }}>Quick Chat…</button>
            </div>
          )}
        </div>
      </div>

      <div className="sb__search">
        <label className="sb__q"><I n="search" size={13} />
          <input value={s.filter.q} onChange={(e) => s.setFilter({ q: e.target.value })} placeholder="Search work…" aria-label="Search work" />
          <button type="button" className="kbd" onClick={() => s.setOverlay({ type: 'jump' })} title="Jump palette">Ctrl J</button>
        </label>
        <button type="button" className={`btn btn--ghost btn--icon ${chips.length || s.filter.hostId ? 'is-on' : ''}`} onClick={() => setFilterOpen((v) => !v)} aria-label="Filter" title="Filter"><I n="sliders" size={13} /></button>
      </div>
      {filterOpen && (
        <div className="sb__filter">
          <div className="row" style={{ flexWrap: 'wrap', gap: 5 }}>
            {CHIPS.map((ch) => (
              <button key={ch.id} type="button" className={`chip-btn ${chips.includes(ch.id) ? 'is-on' : ''}`} onClick={() => s.setFilter({ chips: chips.includes(ch.id) ? chips.filter((x) => x !== ch.id) : [...chips, ch.id] })}>{ch.label}</button>
            ))}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 5 }}>
            {s.hosts.map((h) => (
              <button key={h.id} type="button" className={`chip-btn ${s.filter.hostId === h.id ? 'is-on' : ''}`} onClick={() => s.setFilter({ hostId: s.filter.hostId === h.id ? null : h.id })}>{h.name}</button>
            ))}
          </div>
          <label className="row muted" style={{ fontSize: 11.5 }}><input type="checkbox" checked={s.filter.showHostAlways} onChange={(e) => s.setFilter({ showHostAlways: e.target.checked })} /> Always show host</label>
        </div>
      )}

      <button type="button" className={`sb__attn ${s.view === 'attention' ? 'is-sel' : ''}`} onClick={() => s.setView('attention')}>
        <span className="sb__attnflag"><AttnFlag /></span>
        <span className="grow"><b>{c.attention} need{c.attention === 1 ? 's' : ''} you</b><small>{byKind || 'Nothing needs you'}</small></span>
        <I n="right" size={12} />
      </button>

      <div className="sb__tree" role="tree">
        {PROJECTS.map((p) => {
          const tasks = s.tasks.filter((t) => t.projectId === p.id);
          const atts = s.attempts.filter((a) => tasks.some((t) => t.id === a.taskId));
          const active = atts.filter((a) => a.state === 'working').length;
          const attn = s.attention.filter((x) => atts.some((a) => a.id === x.attemptId)).length;
          const offline = atts.some((a) => hostOf(a.host).status === 'offline');
          const filtering = !!(s.filter.q || s.filter.chips.length || s.filter.hostId);
          const open = filtering || !!s.expanded[p.id];
          const rendered = tasks.map((t) => <TaskBlock key={t.id} task={t} project={p} />);
          const anyVisible = tasks.some((t) => attemptsOfTask(s, t.id).some((a) => matches(s, a, t, p)));
          if (!anyVisible && (s.filter.q || s.filter.chips.length || s.filter.hostId)) return null;
          return (
            <div key={p.id} className="sb-project" role="treeitem" aria-expanded={!!open}>
              <button type="button" className="sb-proj" onClick={() => s.toggleExpanded(p.id)}>
                <I n={open ? 'down' : 'right'} size={12} />
                <span className="sb-proj__n">{p.name}</span>
                {offline && <span className="chip chip--tag chip--dim" title="A host for this project is offline">host ○</span>}
                <span className="sp" />
                {!open && attn > 0 && <AttnFlag n={attn} />}
                <span className="sb-proj__c muted">{active > 0 ? `${active} active` : atts.length ? 'idle' : 'sleeping'}</span>
              </button>
              {open && (
                <div className="sb-proj__body">
                  <div className="sb-main"><I n="branch" size={11} /><span className="mono">{p.branch}</span><span className="muted"> · human workspace</span></div>
                  {rendered}
                  {p.id === 'lixbon' && <ExternalWorktree />}
                </div>
              )}
            </div>
          );
        })}
        {noMatches && (
          <div className="sb-empty" role="status">
            <b>No work matches</b>
            <span>{s.filter.q ? `“${s.filter.q}”` : 'These filters'} finds nothing in any Project.</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setFilter({ q: '', chips: [], hostId: null })}>Clear search</button>
          </div>
        )}
      </div>

      <div className="sb__foot">
        <button type="button" className="sb-hosts" onClick={() => s.setView('hosts')} title="Hosts">
          {s.hosts.map((h) => (
            <span key={h.id} className={`sb-host ${h.status === 'offline' ? 'is-off' : ''}`}><i />{h.short}<b>{hostCount(s, h.id)}</b></span>
          ))}
        </button>
        <button type="button" className="sb-usage" onClick={() => s.setView('usage')} title="Usage">
          {USAGE.slice(0, 2).map((u) => (
            <span key={u.provider} className="sb-use"><span>{PROVIDERS[u.provider].name}</span><Meter pct={u.pct} /><b>{u.pct}%</b></span>
          ))}
        </button>
      </div>
    </aside>
  );
}
