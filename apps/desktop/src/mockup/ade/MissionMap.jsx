// MissionMap.jsx — vista AVANZADA y exploratoria: dependencias e intención entre Tasks paralelas. No sustituye a la navegación principal.
// Git detecta conflictos de líneas; el mapa intenta enseñar conflictos de INTENCIÓN (dos Tasks tocando lo mismo con supuestos distintos).
import { useMemo, useState } from 'react';
import { useStore, attemptsOfTask } from '../store';
import { EDGES, PROJECTS } from '../data';
import { Mark, AttnFlag, Seg } from '../ui';
import { stateLabel } from '../vocab';

const W = 224, H = 82;

export default function MissionMap() {
  const s = useStore();
  const [projectId, setProjectId] = useState(s.sel.projectId);
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const ids = new Set(tasks.map((t) => t.id));
  const edges = EDGES.filter((e) => ids.has(e.from) && ids.has(e.to));

  const layout = useMemo(() => {
    const depth = {};
    tasks.forEach((t) => { depth[t.id] = 0; });
    for (let k = 0; k < tasks.length; k += 1) edges.filter((e) => e.kind === 'child' || e.kind === 'blocks').forEach((e) => { depth[e.to] = Math.max(depth[e.to], depth[e.from] + 1); });
    const cols = {};
    tasks.forEach((t) => { (cols[depth[t.id]] = cols[depth[t.id]] || []).push(t); });
    const pos = {};
    Object.entries(cols).forEach(([d, list]) => list.forEach((t, i) => { pos[t.id] = { x: 200 + d * 400, y: 30 + i * 122, col: Number(d) }; }));
    const maxX = Math.max(...Object.values(pos).map((p) => p.x)) + W + 40;
    const maxY = Math.max(...Object.values(pos).map((p) => p.y)) + H + 30;
    return { pos, w: maxX, h: maxY };
  }, [projectId, tasks.length]); // eslint-disable-line

  // Enrutado: entre columnas por los lados; en la misma columna, un corchete por la izquierda (uno por arista, para que no se pisen).
  const route = (e, k) => {
    const a = layout.pos[e.from], b = layout.pos[e.to];
    const dy = e.kind === 'conflict' ? 16 : e.kind === 'blocks' ? -14 : 0;
    if (a.col === b.col) {
      const x1 = a.x, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, off = 56 + k * 36;
      return { d: `M${x1} ${y1} C ${x1 - off} ${y1}, ${x2 - off} ${y2}, ${x2} ${y2}`, lx: Math.min(x1, x2) - off * 0.75 - 6, ly: (y1 + y2) / 2, anchor: 'end' };
    }
    const fwd = a.col < b.col;
    const x1 = fwd ? a.x + W : a.x, y1 = a.y + H / 2 + dy, x2 = fwd ? b.x : b.x + W, y2 = b.y + H / 2 + dy;
    const c = Math.abs(x2 - x1) / 2;
    return { d: `M${x1} ${y1} C ${x1 + (fwd ? c : -c)} ${y1}, ${x2 - (fwd ? c : -c)} ${y2}, ${x2} ${y2}`, lx: x2 + (fwd ? -14 : 14), ly: y2 - 6, anchor: fwd ? 'end' : 'start' };
  };
  let sameIdx = 0;
  return (
    <div className="pad mm">
      <header className="v-head">
        <h1 className="v-title">Mission Map</h1><span className="chip chip--tag chip--warn">experimental</span>
        <span className="muted">Advanced view for high parallelism. Not the home.</span>
        <span className="sp" />
        <Seg value={projectId} onChange={setProjectId} options={PROJECTS.map((p) => ({ id: p.id, label: p.name }))} />
      </header>
      <div className="mm__canvas">
        <svg width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} role="img" aria-label="Task dependency map">
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="currentColor" /></marker>
          </defs>
          {edges.map((e, i) => {
            const same = layout.pos[e.from].col === layout.pos[e.to].col;
            const r = route(e, same ? sameIdx++ : 0);
            return (
              <g key={i} className={`mm__e mm__e--${e.kind}`}>
                <path d={r.d} fill="none" markerEnd="url(#arr)" />
              </g>
            );
          })}
          {tasks.map((t) => {
            const p = layout.pos[t.id];
            const atts = attemptsOfTask(s, t.id);
            const attn = atts.reduce((n, a) => n + s.attention.filter((x) => x.attemptId === a.id).length, 0);
            return (
              <foreignObject key={t.id} x={p.x} y={p.y} width={W} height={H}>
                <button type="button" className={`mm__n ${s.sel.taskId === t.id ? 'is-sel' : ''}`} onClick={() => s.select(atts[0].id)}>
                  <span className="mm__t trunc">{t.title}</span>
                  <span className="mm__a">{atts.map((a) => <span key={a.id} title={`Attempt ${a.label} · ${stateLabel(a)}`}><Mark attempt={a} size={12} /></span>)}<span className="sp" />{attn > 0 && <AttnFlag n={attn} />}</span>
                  {t.run && <span className="mm__r trunc">Run · {t.run}</span>}
                </button>
              </foreignObject>
            );
          })}
          {(() => { let k = 0; return edges.map((e, i) => {
            const same = layout.pos[e.from].col === layout.pos[e.to].col;
            const r = route(e, same ? k++ : 0);
            const label = e.files ? e.files[0].split('/').pop() + (e.files.length > 1 ? ` +${e.files.length - 1}` : '') : e.label;
            return label ? <g key={`l${i}`} className={`mm__e mm__e--${e.kind}`}><text x={r.lx} y={r.ly} textAnchor={r.anchor}>{label}</text></g> : null;
          }); })()}
        </svg>
      </div>
      <div className="mm__legend">
        <span><i className="l l--child" /> child of coordinator Run</span>
        <span><i className="l l--blocks" /> blocks (intent dependency)</span>
        <span><i className="l l--overlaps" /> overlaps files (no Git conflict yet)</span>
        <span><i className="l l--conflict" /> conflict</span>
      </div>
      {edges.some((e) => e.kind === 'overlaps') && <div className="callout callout--warn">Intent risk: <b>OAuth Refresh</b> and <b>Agent Runtime</b> both rewrite <span className="mono">src/auth/token.ts</span> / <span className="mono">session.ts</span> with different assumptions. Git sees no conflict yet.</div>}
    </div>
  );
}
