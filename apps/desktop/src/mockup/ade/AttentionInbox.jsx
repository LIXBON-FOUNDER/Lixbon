// AttentionInbox.jsx — "¿Qué necesita de mí AHORA?"  Lista de solicitudes + detalle de la seleccionada (patrón de triage).
// Attention es pequeña y accionable; Activity (telemetría) vive aparte, debajo de la lista, y no pide nada.
import { useEffect, useRef, useState } from 'react';
import { useStore, attemptById, taskOf } from '../store';
import AttentionCard from './AttentionCard';
import { I, RiskTag } from '../ui';
import { KIND_META, agentShort, hostOf } from '../vocab';

const GROUPS = [
  { id: 'block', title: 'Blocking an agent', kinds: ['permission', 'question', 'security'], hint: 'The agent cannot continue until you answer.' },
  { id: 'review', title: 'Ready for your review', kinds: ['review'], hint: 'Evidence first, diff second.' },
  { id: 'problems', title: 'Problems', kinds: ['failed', 'conflict', 'host'], hint: 'Something broke or is unreachable.' },
];
const RISK_ORDER = { high: 0, medium: 1, low: 2, none: 3 };
const KIND_TONE = { permission: 'warn', question: 'warn', review: 'merged', failed: 'danger', conflict: 'danger', host: 'faint', security: 'danger' };

export function ActivityFeed({ limit = 12 }) {
  const s = useStore();
  return (
    <aside className="feed" aria-label="Activity">
      <header className="feed__h"><h3>Activity</h3><span className="muted">telemetry · asks nothing of you</span></header>
      <ol>
        {s.activity.slice(0, limit).map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => x.attemptId && s.select(x.attemptId)}>
              <span className={`feed__dot feed__dot--${x.tone}`} /><span className="grow">{x.text}</span><time>{x.time}</time>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function RequestRow({ item, selected, selectable, picked, onPick, onOpen }) {
  const s = useStore();
  const a = attemptById(s, item.attemptId);
  const task = a && taskOf(s, a);
  const tone = KIND_TONE[item.kind] || 'warn';
  return (
    <li className={`atx__row ${selected ? 'is-sel' : ''} atx__row--${tone}`}>
      {selectable && <input type="checkbox" checked={!!picked} onChange={() => onPick(item.id)} aria-label={`Select ${item.title}`} />}
      <button type="button" className="atx__open" data-req={item.id} aria-current={selected ? 'true' : undefined} onClick={() => onOpen(item.id)}>
        <span className="atx__r1">
          <span className={`attn__k mk-tone-${tone}`}><I n={KIND_META[item.kind]?.icon || 'warn'} size={12} />{KIND_META[item.kind]?.label}</span>
          <RiskTag risk={item.risk} />
          <span className="sp" /><span className="muted">{item.ago}</span>
        </span>
        <span className="atx__t">{item.title}</span>
        {a && <span className="atx__m"><span className="trunc">{task.title} · Attempt {a.label}</span><span className="muted trunc">{agentShort(a)} · {hostOf(a.host).name}</span></span>}
      </button>
    </li>
  );
}

export default function AttentionInbox() {
  const s = useStore();
  const [picked, setPicked] = useState([]);
  const [selId, setSelId] = useState(null);
  const lastIdx = useRef(0);
  const items = [...s.attention];
  const groups = GROUPS.map((g) => ({ ...g, list: items.filter((x) => g.kinds.includes(x.kind)).sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) })).filter((g) => g.list.length);
  const flat = groups.flatMap((g) => g.list);
  const sel = flat.find((x) => x.id === selId) || flat[Math.min(lastIdx.current, flat.length - 1)] || null;
  useEffect(() => { if (sel) lastIdx.current = flat.findIndex((x) => x.id === sel.id); });
  const batchable = items.filter((x) => x.kind === 'permission' && x.risk === 'low');
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const approveBatch = () => { picked.forEach((id) => s.resolveAttention(id, 'allow_once', { from: 'ADE' })); s.toast(`Allowed ${picked.length} low-risk commands once.`, 'good'); setPicked([]); };

  // ↑/↓ recorren la lista (sin animación: es un gesto de teclado que se repite)
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const cur = e.target.dataset?.req;
    if (!cur) return;
    e.preventDefault();
    const i = flat.findIndex((x) => x.id === cur);
    const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    const box = e.currentTarget;
    setSelId(next.id);
    requestAnimationFrame(() => box.querySelector(`[data-req="${next.id}"]`)?.focus());
  };

  return (
    <div className="atx">
      <section className="atx__list" aria-label="Requests">
        <header className="atx__h">
          <h1>Attention</h1>
          <span className="muted">{items.length} need{items.length === 1 ? 's' : ''} a human decision</span>
          <span className="sp" />
          <button type="button" className="btn btn--text btn--sm" onClick={() => items.filter((i) => i.kind === 'host').forEach((i) => s.resolveAttention(i.id, 'snooze'))}>Snooze host alerts</button>
        </header>
        {batchable.length > 1 && (
          <div className="callout callout--info inbox__batch">
            <span><b>Batch triage</b> — {batchable.length} low-risk permissions are identical in kind.</span>
            <span className="sp" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicked(batchable.map((b) => b.id))}>Select all low-risk</button>
            <button type="button" className="btn btn--accent btn--sm" disabled={!picked.length} onClick={approveBatch}>Allow once ({picked.length})</button>
          </div>
        )}
        <div className="atx__scroll" onKeyDown={onKeyDown}>
          {items.length === 0 && <div className="empty">Nothing needs you. Agents are working inside their contracts.</div>}
          {groups.map((g) => (
            <section key={g.id} className="inbox__g">
              <h2 title={g.hint}>{g.title} <i>{g.list.length}</i></h2>
              <ul className="atx__ul">
                {g.list.map((x) => <RequestRow key={x.id} item={x} selected={sel?.id === x.id} selectable={x.kind === 'permission' && x.risk === 'low'} picked={picked.includes(x.id)} onPick={toggle} onOpen={setSelId} />)}
              </ul>
            </section>
          ))}
        </div>
        <p className="muted inbox__foot"><I n="shield" size={12} /> High-impact or destructive approvals are never batched. A temporary permission never silently becomes a global one.</p>
        <div className="atx__feed"><ActivityFeed limit={6} /></div>
      </section>

      <section className="atx__detail" aria-label="Selected request">
        {sel ? <AttentionCard item={sel} detail /> : <div className="empty">Select a request to see its command, scope and policy.</div>}
      </section>
    </div>
  );
}
