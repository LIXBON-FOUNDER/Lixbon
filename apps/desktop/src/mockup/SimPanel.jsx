// SimPanel.jsx — controles de SIMULACIÓN (no son producto). Permiten "cambiar estados" y disparar eventos para evaluar el diseño.
import { useState } from 'react';
import { useStore, attemptById, taskOf } from './store';
import { I } from './ui';
import { stateLabel } from './vocab';

const STATES = [
  ['queued', {}, 'Queued'], ['working', { phase: 'writing' }, 'Working'], ['working', { phase: 'thinking' }, 'Thinking'], ['working', { phase: 'tool', toolLabel: 'npm test' }, 'Running tool'],
  ['waiting', { cause: 'answer' }, 'Waiting · answer'], ['waiting', { cause: 'dependency' }, 'Waiting · dependency'], ['waiting', { cause: 'rate_limit' }, 'Waiting · rate limit'],
  ['review_ready', {}, 'Review ready'], ['failed', {}, 'Failed'], ['completed', {}, 'Completed'], ['paused', {}, 'Paused'], ['offline', {}, 'Offline'],
];

// Escenarios guardados del Workspace (antes eran un selector «Preview» dentro de la cabecera del producto).
const PREVIEW_STATES = [
  { attemptId: 'att_rt_a', label: 'Running' },
  { attemptId: 'att_mr_a', label: 'Decision' },
  { attemptId: 'att_oa_b', label: 'Review ready' },
];

export default function SimPanel() {
  const [open, setOpen] = useState(false);
  const s = useStore();
  const a = attemptById(s, s.sel.attemptId);
  const t = taskOf(s, a);
  return (
    <div className="sim">
      <button type="button" className={`btn btn--ghost btn--sm ${open ? 'is-on' : ''}`} onClick={() => setOpen((v) => !v)}><I n="sliders" size={12} />Simulate</button>
      {open && (
        <div className="sim__pop menu" role="dialog" aria-label="Simulation controls">
          <div className="menu__h">Selected: {t.title} · Attempt {a.label} — {stateLabel(a)}</div>
          <div className="sim__grid">
            {STATES.map(([state, extra, label]) => (
              <button key={label} type="button" className="chip-btn" onClick={() => s.simulate(a.id, { state, phase: undefined, cause: undefined, ...extra, latest: label })}>{label}</button>
            ))}
          </div>
          <div className="menu__sep" />
          <div className="menu__h">Preview a Task state</div>
          <div className="sim__grid" role="group" aria-label="Preview a Task state">
            {PREVIEW_STATES.map((p) => (
              <button key={p.attemptId} type="button" className={`chip-btn ${a.id === p.attemptId ? 'is-on' : ''}`} aria-pressed={a.id === p.attemptId}
                onClick={() => { s.setFilter({ q: '', chips: [], hostId: null }); s.setMockUi({ inspectorOpen: false, contextOpen: false, resourcesOpen: false, ideReviewOpen: false }); s.previewState(p.attemptId); s.setSurface('ade'); setOpen(false); }}>{p.label}</button>
            ))}
          </div>
          <div className="menu__sep" />
          <button type="button" className="menu__i" onClick={() => s.requestPermission(a.id)}>Agent asks for a permission<small>Raises Attention + a push on the phone</small></button>
          <button type="button" className="menu__i" onClick={() => s.endTurn(a.id)}>Current turn ends<small>Delivers the next queued instruction, or → Review ready</small></button>
          <button type="button" className="menu__i" onClick={() => s.setMismatch(!s.mismatch)}>{s.mismatch ? 'Clear' : 'Show'} “location mismatch”<small>UI branch ≠ runtime branch (never silently wrong)</small></button>
          <button type="button" className="menu__i" onClick={() => s.toggleHost('laptop')}>Toggle Laptop host<small>Reconnect / disconnect</small></button>
          <button type="button" className="menu__i" onClick={() => { s.worstCase(); setOpen(false); }}>Worst-case data<small>Very long names, emoji, non-Latin text, huge counts (stress test)</small></button>
          <button type="button" className="menu__i" onClick={() => { s.resetAll(); setOpen(false); }}>Reset all mock data</button>
        </div>
      )}
    </div>
  );
}
