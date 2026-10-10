// PendingSpawns.jsx — lanzamientos que pidió el coordinador y esperan la decisión de la persona.
// Lista con cuenta regresiva + detalle con la política efectiva que mandó el host (no se re-resuelve).
// Aprobar envía el argv exactamente como se ve; ack_unverified solo si se marcó la casilla.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EffectivePolicyView } from '../policy/EffectivePolicyView';
import { AGENT_LABELS, ROLE_LABELS } from '../../store/orchStore';
import { defaultSpawnApi, pendingPolicy, spawnField, SPAWN_OUTCOMES } from './spawnContract';
import './spawn.css';

const NOTICES = {
  [SPAWN_OUTCOMES.approved]: 'Lanzamiento aprobado.',
  [SPAWN_OUTCOMES.rejected]: 'Lanzamiento rechazado. El coordinador recibe el aviso.',
  [SPAWN_OUTCOMES.expired]: 'Este lanzamiento ya venció: nadie lo aprobó a tiempo y no se lanzó.',
  [SPAWN_OUTCOMES.alreadyResolved]: 'Este lanzamiento ya estaba decidido. No se hizo nada.',
};
const errText = (e) => (typeof e === 'string' ? e : e?.message || String(e));
const idOf = (x) => spawnField(x, 'pendingId');

/** Estado de los pendientes: lista al montar, eventos del host y decisiones. */
export function usePendingSpawns(api = defaultSpawnApi) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(() => new Set());
  const [notice, setNotice] = useState(null); // { tone, text }
  const inFlight = useRef(new Set());

  const remove = useCallback((id) => setItems((xs) => xs.filter((x) => idOf(x) !== id)), []);

  useEffect(() => {
    let alive = true;
    api.list().then((xs) => {
      if (!alive || !Array.isArray(xs)) return;
      setItems((cur) => { const seen = new Set(cur.map(idOf)); return [...cur, ...xs.filter((x) => !seen.has(idOf(x)))]; });
    }).catch(() => { /* sin host (vite solo) */ });
    const off = api.subscribe({
      onPending: (p) => setItems((xs) => (xs.some((x) => idOf(x) === idOf(p)) ? xs : [...xs, p])),
      onResolved: (r) => remove(idOf(r)),
    });
    return () => { alive = false; off?.(); };
  }, [api, remove]);

  const decide = useCallback(async (id, fn) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusy((s) => new Set(s).add(id));
    setNotice(null);
    try {
      const r = await fn();
      const outcome = spawnField(r, 'outcome');
      setNotice({ tone: outcome === SPAWN_OUTCOMES.approved || outcome === SPAWN_OUTCOMES.rejected ? 'ok' : 'warn', text: NOTICES[outcome] || `Respuesta del host: ${outcome}` });
      remove(id);
    } catch (e) {
      setNotice({ tone: 'error', text: errText(e) });
    } finally {
      inFlight.current.delete(id);
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [remove]);

  const approve = useCallback((item, launch) => decide(idOf(item), () => api.approve({ pending_id: idOf(item), argv: launch.argv, ack_unverified: launch.ack_unverified === true })), [api, decide]);
  const reject = useCallback((item, reason) => decide(idOf(item), () => api.reject({ pending_id: idOf(item), reason })), [api, decide]);

  return { items, busy, notice, approve, reject, clearNotice: () => setNotice(null) };
}

function useClock(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function countdown(expiresAt, now) {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'vencido';
  const s = Math.floor(ms / 1000);
  return `vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PendingSpawnList({ items, selected, onSelect, tasks = {} }) {
  const now = useClock(items.length > 0);
  if (!items.length) return null;
  return (
    <section className="spawns" aria-label="Lanzamientos pendientes">
      <div className="spawns__head">Lanzamientos pendientes <span className="spawns__count">{items.length}</span></div>
      {items.map((it) => {
        const id = idOf(it);
        const agent = spawnField(it, 'agent') || spawnField(it, 'provider');
        const role = spawnField(it, 'role');
        const parent = spawnField(it, 'parentTask');
        return (
          <button key={id} type="button" data-testid={`spawn-${id}`} className={`spawns__item ${selected === id ? 'is-active' : ''}`} onClick={() => onSelect(id)}>
            <span className="spawns__title">{role ? (ROLE_LABELS[role] || role) : 'Sin rol'} · {AGENT_LABELS[agent] || agent}</span>
            <span className="spawns__meta">
              pedido por {tasks[parent]?.title || parent} · <span className="mono" data-testid={`spawn-countdown-${id}`}>{countdown(spawnField(it, 'expiresAt'), now)}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function PendingSpawnDetail({ item, busy, onApprove, onReject }) {
  const [reason, setReason] = useState('');
  const policy = useMemo(() => pendingPolicy(item), [item]);
  const summary = spawnField(item, 'specSummary');
  return (
    <div className="spawns__detail" aria-label="Detalle del lanzamiento pendiente">
      <p className="spawns__lead">
        El coordinador <b>{spawnField(item, 'parentTask')}</b> quiere lanzar esta tarea. No arranca hasta que la apruebes.
      </p>
      {summary && <p className="spawns__summary">{summary}</p>}
      <EffectivePolicyView policy={policy} launchLabel={busy ? 'Enviando…' : 'Aprobar lanzamiento'} busy={busy} onLaunch={(l) => onApprove(item, l)} />
      <div className="spawns__reject">
        <label className="spawns__reason">
          Motivo del rechazo (opcional)
          <input type="text" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="button" className="lk is-danger" disabled={busy} onClick={() => onReject(item, reason)}>Rechazar</button>
      </div>
    </div>
  );
}

export function SpawnNotice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className={`spawns__notice spawns__notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="spawn-notice">
      <span>{notice.text}</span>
      {onClose && <button type="button" className="ic" aria-label="Cerrar aviso" onClick={onClose}>×</button>}
    </div>
  );
}

/** Lista + detalle juntos (lo usan las pruebas; OrchestratorMode usa las piezas por separado). */
export function PendingSpawnsPanel({ api, tasks }) {
  const s = usePendingSpawns(api);
  const [sel, setSel] = useState(null);
  const item = s.items.find((x) => idOf(x) === sel);
  return (
    <>
      <SpawnNotice notice={s.notice} onClose={s.clearNotice} />
      <PendingSpawnList items={s.items} selected={sel} onSelect={setSel} tasks={tasks} />
      {item && <PendingSpawnDetail key={sel} item={item} busy={s.busy.has(sel)} onApprove={s.approve} onReject={s.reject} />}
    </>
  );
}
