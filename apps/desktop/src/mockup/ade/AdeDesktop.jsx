// AdeDesktop.jsx — Desktop ADE (Control Plane): sidebar ORCA-like · canvas · inspector · status bar.
import { useEffect, useState } from 'react';
import { useStore, fleetCounts, attemptById, taskOf, projectOf } from '../store';
import { USAGE, PROVIDERS } from '../data';
import { Seg, I, AttnFlag, Kbd, StatePill } from '../ui';
import Sidebar from './Sidebar';
import TaskWorkspace from './TaskWorkspace';
import Inspector from './Inspector';
import AttentionInbox from './AttentionInbox';
import CompareAttempts from './CompareAttempts';
import ProofPack from './ProofPack';
import ReviewViewer from './ReviewViewer';
import MissionMap from './MissionMap';
import { HostsView, UsageView } from './Fleet';
import Overlays from './Overlays';

export function SurfaceSwitch() {
  const surface = useStore((s) => s.surface);
  const setSurface = useStore((s) => s.setSurface);
  return <Seg value={surface === 'ide' ? 'ide' : 'ade'} onChange={setSurface} options={[{ id: 'ide', label: 'IDE', icon: 'code' }, { id: 'ade', label: 'ADE', icon: 'nodes' }]} />;
}

function TopBar() {
  const s = useStore();
  const c = fleetCounts(s);
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const proj = projectOf(s, task);
  return (
    <header className="topbar">
      <SurfaceSwitch />
      <nav className="topbar__ctx" aria-label="Active work">
        <span>{proj.name}</span>
      </nav>
      <span className="sp" />
      {s.view === 'workspace' && <button className="btn btn--ghost btn--sm" data-hierarchy-toggle="inspectorOpen" aria-expanded={s.mockUi.inspectorOpen} onClick={() => s.setMockUi({ inspectorOpen: !s.mockUi.inspectorOpen })}><I n="sliders" size={14} />Details</button>}
      <div className="view-tabs">
        {[['workspace', 'Workspace', 'panel'], ['attention', 'Attention', 'warn'], ['compare', 'Compare', 'split'], ['map', 'Map', 'nodes'], ['hosts', 'Hosts', 'server'], ['usage', 'Usage', 'chart']].map(([id, l, ic]) => (
          <button key={id} type="button" className={`${s.view === id || (id === 'workspace' && ['proof', 'review'].includes(s.view)) ? 'is-on' : ''}`} onClick={() => s.setView(id)} title={l}>
            <I n={ic} size={13} />{l}{id === 'attention' && c.attention > 0 && <AttnFlag n={c.attention} />}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setOverlay({ type: 'jump' })}><I n="search" size={12} />Jump <Kbd>Ctrl J</Kbd></button>
      <button type="button" className="btn btn--text btn--icon" onClick={() => s.setSurface('mobile')} title="Open Mobile Remote preview" aria-label="Open Mobile preview"><I n="device" size={14} /></button>
      <button type="button" className="btn btn--text btn--icon" onClick={() => s.setSurface('cli')} title="Open CLI preview (lxo)" aria-label="Open CLI preview"><I n="terminal" size={14} /></button>
    </header>
  );
}

/** Subnavegación del ADE dentro del marco del Desktop: dónde estás (Project › Task › Attempt) y las seis vistas. */
export function ViewBar() {
  const s = useStore();
  const c = fleetCounts(s);
  const a = attemptById(s, s.sel.attemptId);
  const task = taskOf(s, a);
  const proj = projectOf(s, task);
  const views = [['workspace', 'Workspace', 'panel'], ['attention', 'Attention', 'warn'], ['compare', 'Compare', 'split'], ['map', 'Map', 'nodes'], ['hosts', 'Hosts', 'server'], ['usage', 'Usage', 'chart']];
  return (
    <div className="viewbar" role="toolbar" aria-label="Vistas del ADE">
      <nav className="viewbar__crumb" aria-label="Active work"><span>{proj.name}</span><I n="right" size={10} /><span>{task.title}</span><I n="right" size={10} /><b>Attempt {a.label}</b></nav>
      <span className="sp" />
      <div className="view-tabs">
        {views.map(([id, l, ic]) => (
          <button key={id} type="button" className={`${s.view === id || (id === 'workspace' && ['proof', 'review'].includes(s.view)) ? 'is-on' : ''}`} onClick={() => s.setView(id)} title={l}>
            <I n={ic} size={13} /><span className="lbl">{l}</span>{id === 'attention' && c.attention > 0 && <AttnFlag n={c.attention} />}
          </button>
        ))}
      </div>
      {s.view === 'workspace' && <button className="btn btn--ghost btn--sm" data-hierarchy-toggle="inspectorOpen" aria-expanded={s.mockUi.inspectorOpen} onClick={() => s.setMockUi({ inspectorOpen: !s.mockUi.inspectorOpen })}><I n="sliders" size={13} />Details</button>}
    </div>
  );
}

function StatusBar() {
  const s = useStore();
  const c = fleetCounts(s);
  const a = attemptById(s, s.sel.attemptId);
  return (
    <footer className="statusbar">
      <button type="button" onClick={() => s.setView('hosts')}><i className="host__dot online" />Desktop-PC</button>
      <span className="mono"><I n="branch" size={11} />{a.branch || 'plan · no worktree'}{a.files ? ` · ${a.files} changed` : ''}</span>
      <button type="button" onClick={() => s.setView('workspace')}>{c.active} agents active</button>
      <button type="button" onClick={() => s.setView('attention')}>{c.attention} need you</button>
      <span className="sp" />
      {USAGE.slice(0, 2).map((u) => <button key={u.provider} type="button" onClick={() => s.setView('usage')}>{PROVIDERS[u.provider].name} {u.pct}%</button>)}
      <span className="muted">Mock · no real Core</span>
    </footer>
  );
}

const LEAVE_MS = 140;

export default function AdeDesktop({ live = true, embedded = false }) {
  const s = useStore();
  const { view } = s;
  // El inspector se desmonta tras su animación de salida; la columna se conserva mientras sale para que el lienzo no salte antes de tiempo.
  const wantInsp = view === 'workspace' && s.mockUi.inspectorOpen;
  const [insp, setInsp] = useState({ mounted: wantInsp, leaving: false });
  useEffect(() => {
    if (wantInsp) { setInsp({ mounted: true, leaving: false }); return undefined; }
    setInsp((p) => (p.mounted ? { mounted: true, leaving: true } : p));
    const id = setTimeout(() => setInsp({ mounted: false, leaving: false }), LEAVE_MS);
    return () => clearTimeout(id);
  }, [wantInsp]);
  // Un gesto de teclado que se repite no se anima: se marca el origen de la última entrada para el CSS.
  useEffect(() => {
    const root = document.documentElement;
    const kbd = () => { root.dataset.input = 'kbd'; };
    const ptr = () => { root.dataset.input = 'ptr'; };
    window.addEventListener('keydown', kbd, true); window.addEventListener('pointerdown', ptr, true);
    return () => { window.removeEventListener('keydown', kbd, true); window.removeEventListener('pointerdown', ptr, true); };
  }, []);
  useEffect(() => {
    if (!live) return undefined;
    const getClose = () => { const st = useStore.getState(); const key=st.mockUi.contextOpen ? 'contextOpen' : st.mockUi.resourcesOpen ? 'resourcesOpen' : st.mockUi.inspectorOpen ? 'inspectorOpen' : null; st.setMockUi({ inspectorOpen: false, contextOpen: false, resourcesOpen: false }); document.querySelectorAll('details.hier-actions[open]').forEach(d=>{ d.open=false; d.querySelector('summary')?.focus(); }); if(key) requestAnimationFrame(()=>document.querySelector('[data-hierarchy-toggle="'+key+'"]')?.focus()); };
    const onKey = (e) => {
      const m = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { getClose(); }
      if (m && (e.key === 'j' || e.key === 'k')) { e.preventDefault(); s.setOverlay({ type: 'jump' }); }
      if (m && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); s.setView('attention'); }
      if (m && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); useStore.getState().openReview(useStore.getState().sel.attemptId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live]); // eslint-disable-line

  useEffect(() => {
    const canvas = document.getElementById('ade-canvas');
    if (canvas && view === 'workspace') canvas.scrollTop = 0;
  }, [view, s.sel.attemptId]);

  const canvas = {
    workspace: <TaskWorkspace />, attention: <AttentionInbox />, compare: <CompareAttempts />, proof: <ProofPack />, review: <ReviewViewer />,
    hosts: <HostsView />, usage: <UsageView />, map: <MissionMap />,
  }[view] || <TaskWorkspace />;

  return (
    <div className={`ade mkr ${embedded ? 'ade--embedded' : ''}`} data-surface="ade">
      {!embedded && <TopBar />}
      <div className={`ade__body ${insp.mounted ? 'has-insp' : ''}`}>
        <Sidebar />
        <main className="ade__main" id="ade-canvas">
          {embedded && <ViewBar />}
          {['proof', 'review', 'compare'].includes(view) && (
            <button type="button" className="btn btn--text btn--sm ade__back" onClick={() => s.setView('workspace')}><I n="left" size={12} />Back to workspace</button>
          )}
          <div key={view} className="ade__view">{canvas}</div>
        </main>
        {insp.mounted && <Inspector leaving={insp.leaving} />}
      </div>
      {!embedded && <StatusBar />}
      {live && !embedded && <Overlays />}
    </div>
  );
}

