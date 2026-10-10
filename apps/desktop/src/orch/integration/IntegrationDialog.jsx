// IntegrationDialog.jsx — confirmación explícita de la persona antes de integrar una rama.
// No integra nunca por su cuenta: no llama al host al montarse y solo envía confirm: true
// cuando la persona marca la confirmación y pulsa el botón. Si la rama destino se movió,
// pide una segunda confirmación antes de reintentar con accept_moved_target = found_commit.
// Los textos van por props para reutilizarlo en otras confirmaciones (p. ej. publicar un PR).

import { useRef, useState } from 'react';
import {
  integrateTask as defaultIntegrate, OUTCOMES, ACCEPT_MOVED_TARGET_PARAM, field, shortSha, errorText,
} from './integrateTask';
import './integration.css';

const fmt = (v, ...x) => (typeof v === 'function' ? v(...x) : v);

const DEFAULT_LABELS = {
  title: 'Integrar tarea',
  task: 'Tarea',
  branch: 'Rama',
  target: 'Destino',
  squash: 'Combinar los commits en uno (squash)',
  confirm: (target) => `Confirmo que quiero integrar esta rama en ${target}`,
  action: 'Integrar',
  busy: 'Integrando…',
  merged: (into) => `Integrada en ${into}`,
  commit: 'Commit resultante',
  alreadyMerged: 'Esta rama ya estaba integrada. No se hizo nada.',
  conflict: (into) => `Conflicto al integrar en ${into}. Se abortó el merge.`,
  conflictNote: 'No se cambió nada en la rama destino.',
  conflictFiles: 'Archivos en conflicto:',
  targetMoved: (into) => `La rama ${into} se movió fuera de la integración del orquestador.`,
  targetMovedNote: 'No se integró nada. Revisa la rama destino antes de volver a intentarlo.',
  expected: 'Esperado',
  found: 'Encontrado',
  acceptMoved: (into, found) => `Acepto que la rama destino cambió y quiero integrar contra ${found}`,
  retry: 'Integrar contra la rama actual',
  errorNote: 'No se integró nada.',
  reviewRequired: 'Falta aceptar el diff del head actual de esta rama. No se integró nada.',
  openReview: 'Revisar diff',
  currentHead: 'HEAD actual de la rama',
  noHead: 'la rama ya no existe',
  lastReview: (d, h) => `Última revisión: ${d === 'accepted' ? 'aceptada' : 'rechazada'} sobre ${h}`,
  noReview: 'Todavía no hay ninguna revisión de esta tarea.',
};

export function IntegrationDialog({ task, branch, target, integrate = defaultIntegrate, allowSquash = true, labels, onDone, onOpenReview }) {
  const L = { ...DEFAULT_LABELS, ...(labels || {}) };
  const [confirmed, setConfirmed] = useState(false);
  const [acceptMoved, setAcceptMoved] = useState(false);
  const [squash, setSquash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);

  const outcome = field(result, 'outcome');
  const done = outcome === OUTCOMES.merged || outcome === OUTCOMES.alreadyMerged;

  async function run(withAcceptMoved) {
    if (!confirmed || inFlight.current || done) return;
    if (withAcceptMoved && (!acceptMoved || !field(result, 'foundCommit'))) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const args = { task, confirm: true };
      if (allowSquash) args.squash = squash;
      // Lleva exactamente el found_commit que la persona vio y aceptó.
      if (withAcceptMoved) args[ACCEPT_MOVED_TARGET_PARAM] = field(result, 'foundCommit');
      const r = await integrate(args);
      setResult(r);
      setAcceptMoved(false); // un nuevo target_moved exige volver a aceptar
      onDone?.(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const into = field(result, 'into') ?? target;
  const message = field(result, 'message');
  const hint = field(result, 'hint');
  const conflicts = field(result, 'conflicts');
  const found = shortSha(field(result, 'foundCommit'));

  return (
    <section className="integration" aria-label={L.title}>
      <h3 className="integration__title">{L.title}</h3>
      <dl className="integration__details">
        <dt>{L.task}</dt><dd data-testid="integration-task">{task}</dd>
        <dt>{L.branch}</dt><dd data-testid="integration-branch">{branch}</dd>
        <dt>{L.target}</dt><dd data-testid="integration-target">{target}</dd>
      </dl>
      {allowSquash && (
        <label className="integration__check">
          <input type="checkbox" checked={squash} disabled={busy || done} onChange={(e) => setSquash(e.target.checked)} />
          {L.squash}
        </label>
      )}
      <label className="integration__check">
        <input type="checkbox" checked={confirmed} disabled={busy || done} onChange={(e) => setConfirmed(e.target.checked)} />
        {fmt(L.confirm, target)}
      </label>
      {outcome !== OUTCOMES.targetMoved && (
        <button type="button" className="integration__action" disabled={!confirmed || busy || done} onClick={() => run(false)}>
          {busy ? L.busy : L.action}
        </button>
      )}

      {outcome === OUTCOMES.merged && (
        <div className="integration__result integration__result--ok" role="status" data-testid="integration-result">
          <strong>{fmt(L.merged, into)}</strong>
          <div>{L.commit}: <code data-testid="integration-commit">{shortSha(field(result, 'resultCommit'))}</code></div>
          {message && <p className="integration__muted">{message}</p>}
          {hint && <p className="integration__muted">{hint}</p>}
        </div>
      )}
      {outcome === OUTCOMES.alreadyMerged && (
        <div className="integration__result" role="status" data-testid="integration-result">{L.alreadyMerged}</div>
      )}
      {outcome === OUTCOMES.conflict && (
        <div className="integration__error" role="alert" data-testid="integration-result">
          <p><strong>{fmt(L.conflict, into)}</strong></p>
          <p>{L.conflictNote}</p>
          {Array.isArray(conflicts) && conflicts.length > 0 && (
            <>
              <p>{L.conflictFiles}</p>
              <ul className="integration__files" data-testid="integration-conflicts">
                {conflicts.map((f) => <li key={f}><code>{f}</code></li>)}
              </ul>
            </>
          )}
          {message && <p>{message}</p>}
          {hint && <p className="integration__muted">{hint}</p>}
        </div>
      )}
      {outcome === OUTCOMES.targetMoved && (
        <div className="integration__error" role="alert" data-testid="integration-result">
          <p><strong>{fmt(L.targetMoved, into)}</strong></p>
          <p>{L.expected}: <code data-testid="integration-expected">{shortSha(field(result, 'expectedCommit'))}</code>
            {' · '}{L.found}: <code data-testid="integration-found">{found}</code></p>
          {message && <p>{message}</p>}
          <p>{L.targetMovedNote}</p>
          <label className="integration__check">
            <input type="checkbox" checked={acceptMoved} disabled={busy} onChange={(e) => setAcceptMoved(e.target.checked)} />
            {fmt(L.acceptMoved, into, found)}
          </label>
          <button type="button" className="integration__action" disabled={!confirmed || !acceptMoved || busy} onClick={() => run(true)}>
            {busy ? L.busy : L.retry}
          </button>
        </div>
      )}
      {outcome === OUTCOMES.reviewRequired && (
        <div className="integration__error" role="alert" data-testid="integration-result">
          <p><strong>{L.reviewRequired}</strong></p>
          <p>{L.currentHead}: {field(result, 'headCommit')
            ? <code data-testid="integration-head">{shortSha(field(result, 'headCommit'))}</code>
            : <span data-testid="integration-head">{L.noHead}</span>}</p>
          <p data-testid="integration-last-review">{field(result, 'lastReview')
            ? fmt(L.lastReview, field(result, 'lastReview').decision, shortSha(field(result, 'lastReview').head_commit))
            : L.noReview}</p>
          {message && <p className="integration__muted">{message}</p>}
          {onOpenReview && (
            <button type="button" className="integration__action" onClick={() => onOpenReview(task)}>{L.openReview}</button>
          )}
        </div>
      )}
      {outcome === OUTCOMES.error && (
        <div className="integration__error" role="alert" data-testid="integration-result">
          {message && <p>{message}</p>}
          <p>{L.errorNote}</p>
        </div>
      )}
      {error !== null && (
        <div className="integration__error" role="alert" data-testid="integration-error">
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}

export default IntegrationDialog;
