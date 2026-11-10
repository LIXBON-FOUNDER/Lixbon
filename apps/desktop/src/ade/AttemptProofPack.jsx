import { useId, useState } from 'react';
import { describeCommandError, reviewAttempt } from './attemptCommands';
import { attemptStatusInfo } from './adeLabels';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { Mark } from './ProvenanceMark';
import { useCoreQuery } from './useCoreQuery';
import './AttemptCompare.css';

/**
 * LXO-155 · Proof Pack de un intento: la evidencia ANTES del diff, con la procedencia de cada dato, y la decisión de aceptar o rechazar sobre
 * la revisión EXACTA que se ve (`attempt_proof_pack` / `attempt_review`).
 *
 * El HEAD que se muestra es el mismo que viaja al aceptar. Si la rama se mueve, el Core no registra nada: se avisa, se recarga y Aceptar
 * queda bloqueado hasta ver el HEAD nuevo. Revisar no es integrar: aceptar no mezcla nada y rechazar no borra el intento ni su worktree.
 * Un resumen del agente se ve como suyo y nunca convierte las pruebas en verificadas.
 */
const BLOCKS = Object.freeze({
  pending_approval: 'El intento espera tu aprobación: todavía no hay nada que revisar.',
  not_current_attempt: 'Solo se decide sobre el intento actual de la tarea: la rama es la suya.',
  not_final: 'El intento sigue en marcha: espera a que termine para decidir sobre un HEAD que ya no cambie.',
  no_revision: 'No hay una revisión que decidir (sin rama o sin cambios que leer).',
});
const GAPS = Object.freeze({
  revision: 'la revisión', changes: 'los cambios', summary: 'el resumen del agente', artifacts: 'los artefactos', tests: 'los resultados de pruebas',
});
const short = (commit) => (typeof commit === 'string' ? commit.slice(0, 12) : '');

function Row({ label, evidence, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-provenance={evidence.provenance}>
        <Mark provenance={evidence.provenance} reason={evidence.reason} />
        {evidence.provenance !== 'unknown' && <div className="cmp-value">{children}</div>}
      </dd>
    </>
  );
}

function AcceptanceNotice({ acceptance }) {
  if (acceptance.state === 'none') return null;
  const text = {
    accepted: 'Aceptaste esta revisión exacta.',
    stale: `La aceptación anterior era de otro HEAD (${short(acceptance.decided_head)}) y la rama se movió: ya no vale para el de ahora.`,
    rejected: acceptance.head_matches ? 'Rechazaste esta revisión.' : `Rechazaste el HEAD ${short(acceptance.decided_head)}; la rama ha cambiado desde entonces.`,
  }[acceptance.state];
  return (
    <p className={`ade-notice ade-notice--${acceptance.state === 'stale' ? 'warn' : 'info'}`} role="status" data-testid="proof-acceptance" data-state={acceptance.state}>{text}</p>
  );
}

export function AttemptProofPack({ attempt, onDecided, active = true }) {
  const uid = useId();
  const enabled = Boolean(active && attempt?.id && attempt.status !== 'pending_approval');
  const state = useCoreQuery('attempt_proof_pack', { attempt_id: attempt?.id }, { enabled });
  const [confirming, setConfirming] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [moved, setMoved] = useState(null);
  const [recorded, setRecorded] = useState(null);
  if (!enabled) return null;
  const pack = state.data ?? null;

  const decide = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      // El HEAD que se manda es el que se mostró, no uno releído ahora.
      const result = await reviewAttempt({ attemptId: attempt.id, decision, headCommit: pack.decision.head_commit, comment: decision === 'rejected' ? comment : undefined });
      setConfirming(null);
      if (result?.outcome === 'head_moved') {
        setMoved({ expected: result.expected_commit, found: result.found_commit });
        setRecorded(null);
      } else {
        setMoved(null);
        setRecorded(decision);
        setComment('');
        onDecided?.(result);
      }
      state.retry();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const head = pack?.decision.head_commit;
  // Con el HEAD movido, Aceptar/Rechazar no vuelven hasta que el Proof Pack muestre el HEAD nuevo.
  const stale = Boolean(moved && head === moved.expected);
  const canDecide = Boolean(pack?.decision.can_decide) && !stale && !busy;

  return (
    <section className="cmp pp" aria-labelledby={`${uid}-title`} data-testid="proof-pack">
      <div className="cmp__head">
        <h4 id={`${uid}-title`} className="ssec__label">Proof Pack</h4>
        <button type="button" className="lk" onClick={() => { setMoved(null); state.retry(); }} data-testid="proof-reload">Recargar</button>
      </div>
      {pack ? (
        <>
          <p className="cmp-note" data-testid="proof-completeness" data-state={pack.completeness.state}>
            {pack.completeness.state === 'complete' ? 'Evidencia completa para decidir' : 'Evidencia parcial: falta lo necesario para decidir'}
            {pack.completeness.gaps.length > 0 && <> · sin dato: {pack.completeness.gaps.map((g) => GAPS[g] ?? g).join(', ')}</>}
          </p>
          <dl className="pp__list">
            <Row label="Estado" evidence={pack.status}><StatusText info={attemptStatusInfo(pack.status.value.status)} /></Row>
            <Row label="Objetivo" evidence={pack.objective}>{pack.objective.value?.title}{pack.objective.value?.objective && pack.objective.value.objective !== pack.objective.value.title ? ` — ${pack.objective.value.objective}` : ''}</Row>
            <Row label="Revisión (base → HEAD)" evidence={pack.revision.head_commit}>
              <span className="mono">{pack.revision.base_commit.value ? short(pack.revision.base_commit.value) : 'sin base'}</span> → <span className="mono" data-testid="proof-head" title={head ?? pack.revision.head_commit.value}>{short(pack.revision.head_commit.value)}</span>
            </Row>
            <Row label="Archivos cambiados" evidence={pack.changes.files}>
              <strong>{pack.changes.files.value}</strong> {pack.changes.files.value === 1 ? 'archivo' : 'archivos'}
              {pack.changes.additions.provenance !== 'unknown' && <span className="cmp-diffstat"> +{pack.changes.additions.value} −{pack.changes.deletions.value}</span>}
              {pack.changes.list.length > 0 && (
                <details>
                  <summary>Ver archivos</summary>
                  <ul className="cmp-files">
                    {pack.changes.list.map((f) => (
                      <li key={f.path}><code className="mono">{f.path}</code>{f.additions === null ? ' · binario' : <span className="cmp-diffstat"> +{f.additions} −{f.deletions}</span>}</li>
                    ))}
                  </ul>
                  {pack.changes.truncated && <p className="cmp-note">Se muestran {pack.changes.list.length} de {pack.changes.total_files} archivos; el diff completo está en «Ver cambios».</p>}
                </details>
              )}
            </Row>
            <Row label="Resumen" evidence={pack.summary}><span className="cmp-summary">{pack.summary.value}</span></Row>
            <dt>Artefactos</dt>
            <dd data-provenance={pack.artifacts.provenance}>
              <Mark provenance={pack.artifacts.provenance} reason={pack.artifacts.reason} />
              {pack.artifacts.items.length > 0 && (
                <ul className="cmp-files">{pack.artifacts.items.map((x) => <li key={x.id}>{x.kind}: <code className="mono">{x.uri}</code></li>)}</ul>
              )}
            </dd>
            <Row label="Pruebas" evidence={pack.tests}>{String(pack.tests.value)}</Row>
          </dl>

          <AcceptanceNotice acceptance={pack.acceptance} />
          {recorded && <p role="status" data-testid="proof-recorded">{recorded === 'accepted' ? 'Revisión aceptada. Aceptar no integra nada: la integración es otra decisión.' : 'Revisión rechazada. El intento y su worktree siguen donde estaban.'}</p>}
          {moved && (
            <div className="ade-notice ade-notice--warn" role="alert" data-testid="proof-head-moved">
              <span>La rama se movió mientras mirabas: aceptaste <span className="mono">{short(moved.expected)}</span> pero ahora está en <span className="mono">{short(moved.found)}</span>. No se registró nada.</span>
              <button type="button" className="lk" onClick={() => { setMoved(null); state.retry(); }}>Ver la revisión actual</button>
            </div>
          )}

          {pack.decision.can_decide ? (
            confirming ? (
              <div className="nat__form" data-testid="proof-confirm">
                <p className="nat__hint">
                  {confirming === 'accepted' ? 'Vas a aceptar' : 'Vas a rechazar'} la revisión <span className="mono">{short(head)}</span> exacta. {confirming === 'accepted' ? 'No se integra nada.' : 'No se borra nada.'}
                </p>
                {confirming === 'rejected' && (
                  <label className="nat__field" htmlFor={`${uid}-comment`}>
                    <span>Comentario (opcional; no se guarda en el log de eventos)</span>
                    <textarea id={`${uid}-comment`} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="proof-comment" />
                  </label>
                )}
                <div className="nat__actions">
                  <button type="button" className="btn btn--primary btn--sm" disabled={busy || stale} onClick={() => decide(confirming)} data-testid="proof-confirm-yes">{busy ? 'Enviando…' : 'Confirmar'}</button>
                  <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(null); setError(null); }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <div className="nat__actions" role="group" aria-label="Decisión sobre la revisión">
                <button type="button" className="btn btn--primary btn--sm" disabled={!canDecide || pack.acceptance.state === 'accepted'} onClick={() => setConfirming('accepted')} data-testid="proof-accept">Aceptar</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={!canDecide} onClick={() => setConfirming('rejected')} data-testid="proof-reject">Rechazar</button>
              </div>
            )
          ) : (
            <p className="cmp-note" data-testid="proof-blocked" data-reason={pack.decision.reason}>{BLOCKS[pack.decision.reason]}</p>
          )}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="proof-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
        </>
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p role="status">Leyendo la evidencia.</p>
      )}
    </section>
  );
}
