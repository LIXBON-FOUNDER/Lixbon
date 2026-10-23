import { COPY, attemptStatusInfo, reviewFreshnessInfo } from './adeLabels';
import { AttemptActivity } from './AttemptActivity';
import { attemptDuration, formatUtc } from './attemptFormat';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { PathText } from './PathText';
import { useCoreQuery } from './useCoreQuery';

/**
 * LXO-122 · Detalle de UN Attempt (solo lectura), de `attempt_detail`. Nada se inventa: lo que el
 * contrato no trae se muestra «no disponible». Rutas y URIs son texto (PathText), nunca enlaces.
 * La sesión del proveedor es opaca: solo id interno, vínculo y si se puede reanudar.
 */
const yesNo = (value) => (value === true ? 'sí' : value === false ? 'no' : COPY.notAvailable);
const text = (value) => (typeof value === 'string' && value.trim() ? value : COPY.notAvailable);

function When({ ms }) {
  const time = formatUtc(ms);
  return time ? <time dateTime={time.iso}>{time.label}</time> : <span className="ade-missing">{COPY.notAvailable}</span>;
}

function Row({ label, children }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

export function AttemptDetail({ attemptId, taskId, coreModel, onSelectTask, onBack, active = true }) {
  const enabled = Boolean(active && attemptId && coreModel?.vNext);
  const state = useCoreQuery('attempt_detail', { attempt_id: attemptId }, { enabled });
  const attempt = state.data?.attempt ?? null;

  let body;
  if (!coreModel?.vNext) {
    body = coreModel?.mode === 'unknown'
      ? <p role="status">Comprobando el modelo del Core.</p>
      : <CoreModelNotice error="core_model_inactive: modo legacy" />;
  } else if (attempt && taskId && attempt.task_id !== taskId) {
    body = <CoreModelNotice error={`model_not_found: el Attempt ${attempt.id} es de la Task ${attempt.task_id}, no de ${taskId}`} onBack={onBack} />;
  } else if (attempt) {
    const duration = attemptDuration(attempt);
    const session = attempt.provider_session;
    const worktree = attempt.worktree;
    const review = attempt.review;
    const artifacts = Array.isArray(attempt.artifacts) ? attempt.artifacts : [];
    body = (
      <>
        <dl>
          <Row label="Intento"><span className="mono">{attempt.id}</span> · #{attempt.n}</Row>
          <Row label="Task">
            <button type="button" className="lk" onClick={() => onSelectTask?.(attempt.task_id)}><span className="mono">{attempt.task_id}</span></button>
          </Row>
          <Row label="Estado"><StatusText info={attemptStatusInfo(attempt.status)} /></Row>
          <Row label="Proveedor">{[attempt.provider, attempt.model].filter(Boolean).join(' · ') || COPY.notAvailable}{attempt.external ? ' · externo' : ''}</Row>
          <Row label="Rol / perfil / esfuerzo">{[text(attempt.role), text(attempt.profile), text(attempt.effort)].join(' / ')}</Row>
          <Row label="Creado"><When ms={attempt.created_at} /></Row>
          <Row label="Iniciado"><When ms={attempt.started_at} /></Row>
          <Row label="Terminado"><When ms={attempt.ended_at} /></Row>
          <Row label="Duración">{duration === COPY.notAvailable ? COPY.durationUnavailable : duration}</Row>
          <Row label="Integrado">{yesNo(attempt.integrated)}</Row>
          {attempt.failure_reason && <Row label="Motivo del fallo">{attempt.failure_reason}</Row>}
          <Row label="Resumen">{text(attempt.summary)}</Row>
        </dl>

        <h4 className="ssec__label">Sesión del proveedor</h4>
        {session ? (
          <dl data-testid="attempt-session">
            <Row label="Sesión"><span className="mono">{text(session.id)}</span></Row>
            <Row label="Vínculo">{text(session.binding)} · vinculada: {yesNo(session.bound)}</Row>
            <Row label="Reanudable">{yesNo(session.resumable)}</Row>
            <Row label="Estado de la sesión">{text(session.status)}</Row>
            {session.opened_by_attempt_id && session.opened_by_attempt_id !== attempt.id && (
              <Row label="Abierta por"><span className="mono">{session.opened_by_attempt_id}</span></Row>
            )}
          </dl>
        ) : <p className="ade-missing">{COPY.notAvailable}</p>}

        <h4 className="ssec__label">Worktree</h4>
        {worktree ? (
          <dl data-testid="attempt-worktree">
            <Row label="Ubicación"><PathText path={worktree.path} /></Row>
            <Row label="Host">{typeof worktree.machine === 'string' && worktree.machine.trim() ? worktree.machine : <span className="ade-missing">{COPY.hostUnavailable}</span>}</Row>
            <Row label="Rama"><span className="mono">{text(worktree.branch)}</span> ← <span className="mono">{text(worktree.base_branch)}</span></Row>
            <Row label="Estado">{text(worktree.state)} · origen {text(worktree.provenance)} · rama conservada: {yesNo(worktree.branch_kept)}</Row>
          </dl>
        ) : <p className="ade-missing">{COPY.noWorktree}</p>}

        <h4 className="ssec__label">Artefactos</h4>
        {artifacts.length ? (
          <ul className="ade-attempt__artifacts" data-testid="attempt-artifacts">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                {text(artifact.kind)}: <PathText path={artifact.uri} repoRoot={worktree?.path ?? null} />
                {' · '}sha256 {artifact.sha256 ? <code className="mono">{artifact.sha256.slice(0, 12)}</code> : COPY.notAvailable}
                {' · '}{Number.isSafeInteger(artifact.bytes) ? `${artifact.bytes} bytes` : `tamaño ${COPY.notAvailable}`}
              </li>
            ))}
          </ul>
        ) : <p className="ade-missing">{COPY.noArtifacts}</p>}

        <h4 className="ssec__label">Revisión</h4>
        {review ? (
          <dl data-testid="attempt-review">
            <Row label="Veredicto">{text(review.verdict)}</Row>
            <Row label="Commits"><span className="mono">{text(review.base_commit)}</span> → <span className="mono">{text(review.head_commit)}</span></Row>
            <Row label="Frescura"><StatusText info={reviewFreshnessInfo(review)} /></Row>
          </dl>
        ) : <p className="ade-missing">{COPY.noReview}</p>}

        <AttemptActivity attemptId={attempt.id} coreModel={coreModel} active={active} />
      </>
    );
  } else if (state.error) {
    body = <CoreModelNotice error={state.error} onRetry={state.retry} onBack={onBack} />;
  } else {
    body = <p role="status">Cargando el intento.</p>;
  }
  return (
    <section className="ade-attempt" aria-label={COPY.attemptDetail} data-testid="attempt-detail">
      <h3 className="ssec__label">{COPY.attemptDetail}</h3>
      {body}
    </section>
  );
}
