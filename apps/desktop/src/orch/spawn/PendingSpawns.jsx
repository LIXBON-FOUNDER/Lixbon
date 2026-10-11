// PendingSpawns.jsx — lanzamientos que pidió el coordinador y esperan la decisión de la persona.
// Lista con cuenta regresiva + detalle con la política efectiva que mandó el host (no se re-resuelve).
// Aprobar envía el argv exactamente como se ve; ack_unverified solo si se marcó la casilla.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EffectivePolicyView } from '../policy/EffectivePolicyView';
import { WorktreeEnv } from './WorktreeEnv';
import { AGENT_LABELS, ROLE_LABELS } from '../../store/orchStore';
import { defaultSpawnApi, integrateIntoLabel, pendingPolicy, resolvedReason, spawnField, SPAWN_OUTCOMES, toMs } from './spawnContract';
import './spawn.css';

const NOTICES = {
  [SPAWN_OUTCOMES.approved]: 'Lanzamiento aprobado.',
  [SPAWN_OUTCOMES.rejected]: 'Lanzamiento rechazado. El coordinador recibe el aviso.',
  [SPAWN_OUTCOMES.expired]: 'Este lanzamiento ya venció o su coordinador ya no sigue (run borrado o terminado). No se lanzó.',
  [SPAWN_OUTCOMES.launchFailed]: 'Aprobado, pero el host no pudo lanzar el agente. No se reintenta solo.',
  [SPAWN_OUTCOMES.alreadyResolved]: 'Este lanzamiento ya estaba decidido. No se hizo nada.',
};
const errText = (e) => (typeof e === 'string' ? e : e?.message || String(e));
const idOf = (x) => spawnField(x, 'pendingId');

/** Aviso para un resultado del host (respuesta del comando o evento). */
export function noticeFor(r) {
  const outcome = spawnField(r, 'outcome');
  const reason = resolvedReason(r);
  if (outcome === SPAWN_OUTCOMES.launchFailed) {
    return { tone: 'failed', title: NOTICES[outcome], text: reason || 'El host no dio el motivo.', id: idOf(r) };
  }
  const tone = outcome === SPAWN_OUTCOMES.approved || outcome === SPAWN_OUTCOMES.rejected ? 'ok' : 'warn';
  const base = NOTICES[outcome] || `Respuesta del host: ${outcome}`;
  return { tone, text: outcome === SPAWN_OUTCOMES.rejected && reason ? `${base} Motivo: ${reason}` : base };
}

/** Estado de los pendientes: lista al montar, eventos del host y decisiones. */
export function usePendingSpawns(api = defaultSpawnApi) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(() => new Set());
  const [notice, setNotice] = useState(null); // { tone, text, title? }
  const [errors, setErrors] = useState({}); // pending_id -> error del host (p. ej. argv distinto); el pendiente sigue
  const inFlight = useRef(new Set());
  const itemsRef = useRef([]);
  itemsRef.current = items;

  const remove = useCallback((id) => {
    setItems((xs) => xs.filter((x) => idOf(x) !== id));
    setErrors((e) => { if (!(id in e)) return e; const n = { ...e }; delete n[id]; return n; });
  }, []);

  useEffect(() => {
    let alive = true;
    api.list().then((xs) => {
      if (!alive || !Array.isArray(xs)) return;
      setItems((cur) => { const seen = new Set(cur.map(idOf)); return [...cur, ...xs.filter((x) => !seen.has(idOf(x)))]; });
    }).catch(() => { /* sin host (vite solo) */ });
    const off = api.subscribe({
      onPending: (p) => setItems((xs) => (xs.some((x) => idOf(x) === idOf(p)) ? xs : [...xs, p])),
      onResolved: (r) => {
        const id = idOf(r);
        const outcome = spawnField(r, 'outcome');
        // Un fallo de lanzamiento siempre se avisa, aunque lo haya aprobado otra ventana.
        if (outcome === SPAWN_OUTCOMES.launchFailed) setNotice(noticeFor(r));
        // Si estaba en pantalla y venció (o se borró su run) se dice por qué desaparece.
        else if (outcome === SPAWN_OUTCOMES.expired && itemsRef.current.some((x) => idOf(x) === id) && !inFlight.current.has(id)) setNotice(noticeFor(r));
        remove(id);
      },
    });
    return () => { alive = false; off?.(); };
  }, [api, remove]);

  const decide = useCallback(async (id, fn) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusy((s) => new Set(s).add(id));
    setNotice(null);
    setErrors((e) => { if (!(id in e)) return e; const n = { ...e }; delete n[id]; return n; });
    try {
      const r = await fn();
      setNotice(noticeFor(r));
      remove(id);
    } catch (e) {
      // Error de uso (argv distinto, falta ack, bloqueado ahora): el host no lanzó y sigue pendiente.
      const text = errText(e);
      setErrors((x) => ({ ...x, [id]: text }));
      setNotice({ tone: 'error', text });
    } finally {
      inFlight.current.delete(id);
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [remove]);

  const approve = useCallback((item, launch) => decide(idOf(item), () => api.approve({ pending_id: idOf(item), argv: launch.argv, ack_unverified: launch.ack_unverified === true })), [api, decide]);
  const reject = useCallback((item, reason) => decide(idOf(item), () => api.reject({ pending_id: idOf(item), reason })), [api, decide]);

  return { items, busy, notice, errors, approve, reject, clearNotice: () => setNotice(null) };
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
  const ms = toMs(expiresAt) - now;
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

export function PendingSpawnDetail({ item, busy, error, onApprove, onReject }) {
  const [reason, setReason] = useState('');
  const policy = useMemo(() => pendingPolicy(item), [item]);
  const summary = spawnField(item, 'specSummary');
  const into = integrateIntoLabel(spawnField(item, 'integrateInto'));
  const cwd = spawnField(item, 'cwd');
  const shared = spawnField(item, 'shared');
  return (
    <div className="spawns__detail" aria-label="Detalle del lanzamiento pendiente">
      <p className="spawns__lead">
        El coordinador <b>{spawnField(item, 'parentTask')}</b> quiere lanzar esta tarea. No arranca hasta que la apruebes.
      </p>
      {summary && <p className="spawns__summary">{summary}</p>}
      {cwd && (
        <p className="spawns__summary" data-testid="spawn-cwd">
          {shared ? 'Correrá en la carpeta del coordinador' : 'Correrá en un worktree nuevo'}: <span className="mono spawns__path" title={cwd}>{cwd}</span>
        </p>
      )}
      {into && <p className="spawns__summary" data-testid="spawn-integrate-into">Se integrará en <span className="mono">{into}</span></p>}
      <WorktreeEnv env={spawnField(item, 'env')} />
      {error && (
        <div className="spawns__error" role="alert" data-testid="spawn-error">
          <b>El host no lanzó nada y el lanzamiento sigue pendiente.</b> <span>{error}</span>
        </div>
      )}
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
    <div className={`spawns__notice spawns__notice--${notice.tone}`} role={notice.tone === 'error' || notice.tone === 'failed' ? 'alert' : 'status'} data-testid="spawn-notice">
      <span>{notice.title && <b className="spawns__notice-title">{notice.title} </b>}{notice.text}</span>
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
      {item && <PendingSpawnDetail key={sel} item={item} busy={s.busy.has(sel)} error={s.errors[sel]} onApprove={s.approve} onReject={s.reject} />}
    </>
  );
}
