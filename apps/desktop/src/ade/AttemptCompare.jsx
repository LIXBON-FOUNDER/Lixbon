import { useId } from 'react';
import { attemptStatusInfo } from './adeLabels';
import { formatDurationMs } from './attemptFormat';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';
import './AttemptCompare.css';

/**
 * LXO-154 · Comparar 2–4 Attempts con la evidencia estructurada del Core (`attempt_compare`). SOLO LECTURA: no puntúa, no elige ganador, no
 * integra y no recalcula git ni pruebas. Elegir un intento aquí no muta nada: abrirlo lleva a su detalle, donde están la revisión y la
 * integración.
 *
 * La procedencia de CADA dato se ve con glifo, texto y forma de borde (no solo color): `✓ Verificado` (lo comprobó el Core), `⚠ Lo dice el
 * agente` (declarado, sin comprobar) y `? Sin dato` (con su motivo; nunca un cero).
 */
const PROVENANCE_VIEW = Object.freeze({
  verified: { glyph: '✓', label: 'Verificado por el Core' },
  agent_reported: { glyph: '⚠', label: 'Lo dice el agente' },
  unknown: { glyph: '?', label: 'Sin dato' },
});

const REASONS = Object.freeze({
  no_worktree: 'aún no tiene worktree',
  not_current_attempt: 'ya no es el intento actual de su tarea: la rama es la del actual',
  branch_unavailable: 'la rama ya no existe',
  no_base: 'no hay commit base',
  repo_unavailable: 'el repositorio no está disponible',
  git_unavailable: 'git no pudo calcularlo',
  truncated: 'la lista se recortó: las sumas no valen',
  binary_files: 'hay archivos binarios sin cuentas de líneas',
  not_reviewed: 'no se ha revisado',
  no_summary: 'el agente no dejó resumen',
  none_recorded: 'no hay artefactos registrados',
  not_collected: 'el Core aún no recoge resultados de pruebas',
});

const RELATION_TEXT = Object.freeze({
  same_task: 'Intentos de la misma tarea.',
  fork_family: 'Un intento y las bifurcaciones que nacieron de él.',
});

const SOURCE_TEXT = Object.freeze({ review: 'de la revisión', live_branch: 'HEAD actual de la rama', live_branch_merge_base: 'HEAD actual, base por merge-base' });
const short = (commit) => (typeof commit === 'string' ? commit.slice(0, 12) : '');

function Mark({ provenance, reason }) {
  const view = PROVENANCE_VIEW[provenance];
  return (
    <span className={`cmp-prov cmp-prov--${provenance}`} data-testid="cmp-prov">
      <span aria-hidden="true">{view.glyph}</span> {view.label}
      {provenance === 'unknown' && reason && <span className="cmp-prov__reason"> — {REASONS[reason] ?? reason}</span>}
    </span>
  );
}

/** Una celda: la marca de procedencia y, si hay dato, su contenido. */
function Cell({ evidence, render, id }) {
  // El contenido solo se construye si hay dato: un dato que falta no tiene valor que pintar.
  return (
    <td data-provenance={evidence.provenance} data-cell={id}>
      <Mark provenance={evidence.provenance} reason={evidence.reason} />
      {evidence.provenance !== 'unknown' && <div className="cmp-value">{render()}</div>}
    </td>
  );
}

function selectionText(s) {
  const parts = [s.provider, s.model, s.effort, s.role].filter(Boolean);
  return `${parts.join(' · ')}${s.external ? ' · externo' : ''}`;
}

function Files({ changes }) {
  const { files, additions, deletions } = changes;
  return (
    <>
      <strong>{files.value}</strong> {files.value === 1 ? 'archivo' : 'archivos'}
      {additions.provenance !== 'unknown' && deletions.provenance !== 'unknown' && <span className="cmp-diffstat"> +{additions.value} −{deletions.value}</span>}
      {changes.list.length > 0 && (
        <details>
          <summary>Ver archivos</summary>
          <ul className="cmp-files">
            {changes.list.map((f) => (
              <li key={f.path}><code className="mono">{f.path}</code>{f.additions === null ? ' · binario' : <span className="cmp-diffstat"> +{f.additions} −{f.deletions}</span>}</li>
            ))}
          </ul>
          {changes.truncated && <p className="cmp-note">Se muestran {changes.list.length} de {changes.total_files} archivos.</p>}
        </details>
      )}
    </>
  );
}

const ROWS = [
  { id: 'status', label: 'Estado', evidence: (a) => a.status, render: (a) => (<><StatusText info={attemptStatusInfo(a.status.value.status)} />{a.status.value.failure_reason ? ` · ${a.status.value.failure_reason}` : ''}</>) },
  { id: 'selection', label: 'Proveedor, modelo y esfuerzo', evidence: (a) => a.selection, render: (a) => selectionText(a.selection.value) },
  { id: 'host', label: 'Host', evidence: (a) => a.host, render: (a) => <span className="mono">{a.host.value}</span> },
  {
    id: 'duration',
    label: 'Duración',
    evidence: (a) => a.timing,
    render: (a) => (Number.isSafeInteger(a.timing.value.duration_ms) ? formatDurationMs(a.timing.value.duration_ms) : <span className="ade-missing">no disponible</span>),
  },
  {
    id: 'revision',
    label: 'Commit base → resultado',
    evidence: (a) => a.revision.head_commit,
    render: (a) => (
      <>
        <span className="mono">{a.revision.base_commit.value ? short(a.revision.base_commit.value) : 'sin base'}</span> → <span className="mono">{short(a.revision.head_commit.value)}</span>
        {a.revision.source && <span className="cmp-note"> ({SOURCE_TEXT[a.revision.source] ?? a.revision.source})</span>}
      </>
    ),
  },
  { id: 'changes', label: 'Archivos cambiados', evidence: (a) => a.changes.files, render: (a) => <Files changes={a.changes} /> },
  { id: 'summary', label: 'Resumen', evidence: (a) => a.summary, render: (a) => <span className="cmp-summary">{a.summary.value}</span> },
  { id: 'tests', label: 'Pruebas', evidence: (a) => a.tests, render: (a) => String(a.tests.value) },
  {
    id: 'review',
    label: 'Revisión de la persona',
    evidence: (a) => a.review,
    render: (a) => `${a.review.value.verdict} (${a.review.value.status})`,
  },
];

/** Los artefactos llevan la procedencia del conjunto, no la de cada uno. */
function ArtifactsCell({ artifacts }) {
  const evidence = { provenance: artifacts.provenance, reason: artifacts.reason };
  return (
    <td data-provenance={artifacts.provenance} data-cell="artifacts">
      <Mark provenance={evidence.provenance} reason={evidence.reason} />
      {artifacts.items.length > 0 && (
        <ul className="cmp-files">
          {artifacts.items.map((x) => <li key={x.id}>{x.kind}: <code className="mono">{x.uri}</code></li>)}
        </ul>
      )}
    </td>
  );
}

function Overlaps({ overlaps }) {
  return (
    <section aria-label="Archivos que tocaron varios intentos" data-testid="cmp-overlaps">
      <h4 className="ssec__label">Solapes</h4>
      {overlaps.total === 0
        ? <p className="cmp-note">{overlaps.complete ? 'Ningún archivo lo tocaron dos intentos.' : 'No se ven solapes, pero la lista de algún intento no está completa.'}</p>
        : (
          <>
            <ul className="cmp-files">
              {overlaps.items.map((o) => <li key={o.path}><code className="mono">{o.path}</code> · {o.attempt_ids.join(', ')}</li>)}
            </ul>
            {overlaps.total > overlaps.items.length && <p className="cmp-note">Se muestran {overlaps.items.length} de {overlaps.total} solapes.</p>}
          </>
        )}
      {overlaps.total > 0 && !overlaps.complete && <p className="cmp-note">Puede haber más: la lista de algún intento no está completa.</p>}
    </section>
  );
}

export function AttemptCompare({ attemptIds, onOpenAttempt, onClose, active = true }) {
  const uid = useId();
  const enabled = Boolean(active && Array.isArray(attemptIds) && attemptIds.length >= 2);
  const state = useCoreQuery('attempt_compare', { attempt_ids: attemptIds }, { enabled });
  const response = state.data ?? null;
  const count = attemptIds?.length ?? 0;

  return (
    <section className="cmp" aria-labelledby={`${uid}-title`} data-testid="attempt-compare">
      <div className="cmp__head">
        <h3 id={`${uid}-title`} className="ssec__label">Comparar {count} intentos</h3>
        {onClose && <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} data-testid="cmp-close">Cerrar</button>}
      </div>
      {response ? (
        <>
          <p className="cmp-note" data-testid="cmp-relation">{RELATION_TEXT[response.relation.kind]} Es solo una comparación: no cambia nada ni elige un ganador.</p>
          <ul className="cmp-legend" aria-label="Cómo se sabe cada dato">
            {Object.entries(PROVENANCE_VIEW).map(([key, view]) => (
              <li key={key} className={`cmp-prov cmp-prov--${key}`}><span aria-hidden="true">{view.glyph}</span> {view.label}</li>
            ))}
          </ul>
          <div className="cmp__scroll" role="region" aria-label="Tabla de comparación" tabIndex={0}>
            <table className="cmp__table" style={{ '--cmp-cols': response.attempts.length }} data-testid="cmp-table">
              <caption className="cmp-note">Comparación de {response.attempts.length} intentos, uno por columna.</caption>
              <thead>
                <tr>
                  <th scope="col">Dato</th>
                  {response.attempts.map((a) => (
                    <th key={a.attempt_id} scope="col" data-attempt={a.attempt_id}>
                      <span className="mono">{a.attempt_id}</span>
                      <span className="cmp-note"> · {a.is_current ? 'intento actual' : 'intento anterior'}{a.forked_from ? ` · bifurcado de ${a.forked_from}` : ''}</span>
                      {onOpenAttempt && (
                        <button type="button" className="lk" onClick={() => onOpenAttempt({ taskId: a.task_id, attemptId: a.attempt_id })} data-testid={`cmp-open-${a.attempt_id}`}>Abrir</button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.id} data-row={row.id}>
                    <th scope="row">{row.label}</th>
                    {response.attempts.map((a) => {
                      const evidence = row.evidence(a);
                      return <Cell key={a.attempt_id} evidence={evidence} id={row.id} render={() => row.render(a)} />;
                    })}
                  </tr>
                ))}
                <tr data-row="artifacts">
                  <th scope="row">Artefactos</th>
                  {response.attempts.map((a) => <ArtifactsCell key={a.attempt_id} artifacts={a.artifacts} />)}
                </tr>
              </tbody>
            </table>
          </div>
          <Overlaps overlaps={response.overlaps} />
        </>
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p role="status">Comparando los intentos.</p>
      )}
    </section>
  );
}
