import { useEffect, useState } from 'react';
import { COPY, attemptStatusInfo, reviewFreshnessInfo } from './adeLabels';
import { AttemptActivity } from './AttemptActivity';
import { AutonomyEditor } from './AutonomyEditor';
import { AttemptAnswer } from './AttemptAnswer';
import { AttemptApproval } from './AttemptApproval';
import { AttemptCapabilities } from './AttemptCapabilities';
import { AttemptChanges } from './AttemptChanges';
import { AttemptContextLine } from './AttemptContextLine';
import { AttemptIntegration } from './AttemptIntegration';
import { AttemptLineage } from './AttemptLineage';
import { AttemptProofPack } from './AttemptProofPack';
import { AttemptQueue } from './AttemptQueue';
import { AttemptShareWorktree } from './AttemptShareWorktree';
import { AttemptResume } from './AttemptResume';
import { AttemptRetry } from './AttemptRetry';
import { AttemptStop } from './AttemptStop';
import { AttemptUsage } from './AttemptUsage';
import { attemptDuration, formatDurationMs, formatUtc } from './attemptFormat';
import { ATTEMPT_DETAIL_V2 } from './coreModelContract';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { PathText } from './PathText';
import { AttemptOwnership } from './AttemptOwnership';
import { AttemptTransfer } from './AttemptTransfer';
import { useCoreQuery } from './useCoreQuery';
import { formatCost, formatTokens } from './usageModel';
import { evidenceForAttempt, knownEvidence } from './attemptEvidence';
import { StatusIcon } from '@lixbon/icons/status';

/**
 * LXO-122 · Detalle de UN Attempt (solo lectura), de `attempt_detail`. Nada se inventa: lo que el
 * contrato no trae se muestra «no disponible». Rutas y URIs son texto (PathText), nunca enlaces.
 * La sesión del proveedor es opaca: solo id interno, vínculo y si se puede reanudar.
 *
 * LXO-244: se pide `attempt_detail_v2` solo si el Core la anuncia (`core_model.queries`); el Core redacta la URL del PR. Con un Core
 * anterior se lee `attempt_detail` y se AVISA (`attempt_detail_v2_unsupported`). En ambos casos la URL de un Artifact `pull_request` nunca se pinta.
 */
/** Estados de un intento que todavía puede cambiar solo: se sondea más a menudo. */
const ACTIVE_ATTEMPT_STATUSES = ['starting', 'running', 'waiting', 'awaiting_terminal_approval'];
const ACTIVE_POLL_MS = 3000;
const yesNo = (value) => (value === true ? 'sí' : value === false ? 'no' : COPY.notAvailable);
const text = (value) => (typeof value === 'string' && value.trim() ? value : COPY.notAvailable);

function When({ ms }) {
  const time = formatUtc(ms);
  return time ? <time dateTime={time.iso}>{time.label}</time> : <span className="ade-missing">{COPY.notAvailable}</span>;
}

function Row({ label, children }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

export function AttemptDetail({ attemptId, taskId, projectId, coreModel, onSelectTask, onOpenAttempt, onBack, active = true, requestedTab = null, onSnapshot, evidence = null }) {
  const enabled = Boolean(active && attemptId && coreModel?.vNext);
  // Mientras el intento está activo se relee deprisa: «Detener», la cola y los avisos dependen de verlo `running` a tiempo (con el sondeo
  // normal, de 15 s, un intento corto terminaba antes de pintarse como activo).
  const [fast, setFast] = useState(false);
  const detailV2 = Array.isArray(coreModel?.queries) && coreModel.queries.includes(ATTEMPT_DETAIL_V2);
  const state = useCoreQuery(detailV2 ? ATTEMPT_DETAIL_V2 : 'attempt_detail', { attempt_id: attemptId }, { enabled, pollMs: fast ? ACTIVE_POLL_MS : undefined });
  const liveStatus = state.data?.attempt?.status;
  useEffect(() => { setFast(ACTIVE_ATTEMPT_STATUSES.includes(liveStatus)); }, [liveStatus]);
  const attempt = state.data?.attempt ?? null;
  useEffect(() => { onSnapshot?.(attempt?.task_id === taskId ? attempt : null); }, [attempt, taskId, onSnapshot]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !ACTIVE_ATTEMPT_STATUSES.includes(attempt?.status) || !Number.isSafeInteger(attempt?.started_at)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, attempt?.status, attempt?.started_at]);
  const [detailTab, setDetailTab] = useState('activity');
  useEffect(() => { if (requestedTab?.tab === 'changes') setDetailTab('changes'); }, [requestedTab]);

  let body;
  if (!coreModel?.vNext) {
    body = coreModel?.mode === 'unknown'
      ? <p role="status">Comprobando el modelo del Core.</p>
      : <CoreModelNotice error="core_model_inactive: modo legacy" />;
  } else if (attempt && taskId && attempt.task_id !== taskId) {
    body = (
      <div className="ade-notice ade-notice--error" role="alert" data-code="attempt_other_task">
        <span>{COPY.attemptOtherTask}</span>
        {onBack && <button type="button" className="lk" onClick={onBack}>{COPY.backToProject}</button>}
        {onSelectTask && <button type="button" className="lk" onClick={() => onSelectTask(attempt.task_id)}>{COPY.openAttemptTask}</button>}
        <details>
          <summary>{COPY.technicalDetail}</summary>
          <code>{`el Attempt ${attempt.id} es de la Task ${attempt.task_id}, no de ${taskId}`}</code>
        </details>
      </div>
    );
  } else if (attempt) {
    const duration = attemptDuration(attempt);
    const session = attempt.provider_session;
    const worktree = attempt.worktree;
    const review = attempt.review;
    const runningDuration = ['running', 'starting'].includes(attempt.status) && Number.isSafeInteger(attempt.started_at) && attempt.started_at > 0 && now >= attempt.started_at
      ? `${formatDurationMs(now - attempt.started_at)} en marcha` : null;
    const usage = attempt.usage;
    const pack = evidenceForAttempt(evidence, attempt.id, attempt.task_id);
    const knownCount = field => knownEvidence(field) && Number.isSafeInteger(field.value) && field.value >= 0;
    const tests = knownEvidence(pack?.tests) && typeof pack.tests.value === 'string' ? pack.tests.value : null;
    const tokens = Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0 && Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ? usage.input_tokens + usage.output_tokens : null;
    const artifacts = Array.isArray(attempt.artifacts) ? attempt.artifacts : [];
    body = (
      <>
        <header className={`ade-attempt-design-head${onSnapshot ? ' sr-only' : ''}`}><h2>Intento {attempt.n}</h2><span>{[attempt.provider, attempt.model].filter(Boolean).join(' · ')}</span><StatusText info={attemptStatusInfo(attempt.status)} /></header>
        <div className="ade-attempt-metrics">
          <span>{runningDuration || (duration === COPY.notAvailable ? COPY.durationUnavailable : `${duration} en total`)}</span>
          <span>{knownCount(pack?.changes?.files) ? <><b>{pack.changes.files.value}</b> archivos</> : 'Archivos · No informado'}{knownCount(pack?.changes?.additions) && knownCount(pack?.changes?.deletions) && <> <em className="is-add">+{pack.changes.additions.value}</em> <em className="is-del">−{pack.changes.deletions.value}</em></>}</span>
          <span>{tests ? `Pruebas · ${tests}` : 'Pruebas · No informado'}</span>
          <span title={usage?.source === 'provider_declared' ? 'Declarado por el proveedor' : undefined}><b>{typeof usage?.cost_usd === 'number' && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0 ? formatCost(usage.cost_usd) : 'Coste no informado'}</b> · {tokens === null ? 'Tokens no informados' : `${formatTokens(tokens)} tokens de entrada y salida`}</span>
        </div>
        <p className="ade-attempt-hostline"><StatusIcon kind="server" size={14}/>{worktree?.machine || COPY.hostUnavailable}{worktree?.path ? ' · worktree' : ''}{worktree?.branch && <> · <span>{worktree.branch}</span></>}</p>
        <nav className="ade-attempt-design-tabs" aria-label="Detalle del intento">{[['activity', 'Actividad'], ['changes', 'Cambios'], ['terminal', 'Terminal'], ['artifacts', 'Artefactos'], ['details', 'Acciones y detalles']].map(([id, label]) => <button type="button" key={id} aria-pressed={detailTab === id} className={detailTab === id ? 'is-active' : ''} onClick={() => setDetailTab(id)}>{label}</button>)}</nav>
        {attempt.status === 'pending_approval' && <AttemptApproval attemptId={attempt.id} onDecided={state.retry} />}
        {attempt.status === 'awaiting_terminal_approval' && <AttemptAnswer attemptId={attempt.id} onAnswered={state.retry} />}
        <div hidden={detailTab !== 'activity'} className="ade-attempt-design-feed"><AttemptActivity attemptId={attempt.id} coreModel={coreModel} embedded active={active && detailTab === 'activity'} /></div>
        {detailTab === 'terminal' && <p className="ade-attempt-design-empty">La terminal no está disponible para este intento.</p>}
        <div hidden={detailTab !== 'details'}>
        {!detailV2 && (
          <p className="ade-notice ade-notice--warn" role="status" data-code="attempt_detail_v2_unsupported">{COPY.attemptDetailV2Unsupported}</p>
        )}
        <AttemptContextLine attempt={attempt} />
        <AttemptOwnership key={`owner-${attempt.id}`} attempt={attempt} active={active} onChanged={state.retry} />
        <AttemptTransfer key={`transfer-${attempt.id}`} attempt={attempt} projectId={projectId} active={active} />
        <dl>
          <Row label="Intento"><span className="mono">{attempt.id}</span> · #{attempt.n}</Row>
          <Row label="Task">
            <button type="button" className="lk" onClick={() => onSelectTask?.(attempt.task_id)}><span className="mono">{attempt.task_id}</span></button>
          </Row>
          <Row label="Estado"><StatusText info={attemptStatusInfo(attempt.status)} /></Row>
          <Row label="Proveedor">{[attempt.provider, attempt.model].filter(Boolean).join(' · ') || COPY.notAvailable}{attempt.external ? ' · externo' : ''}</Row>
          <Row label="Rol / perfil / esfuerzo">{[text(attempt.role), text(attempt.profile), text(attempt.effort)].join(' / ')}</Row>
          <Row label="Creado"><When ms={attempt.created_at} /></Row>
          {attempt.adopted ? (
            <Row label="Origen"><span data-testid="attempt-adopted">Trabajo externo adoptado el <When ms={attempt.adopted_at} />. Lixbon no lo ejecutó: no hay inicio, fin ni duración.</span></Row>
          ) : (
            <>
              <Row label="Iniciado"><When ms={attempt.started_at} /></Row>
              <Row label="Terminado"><When ms={attempt.ended_at} /></Row>
              <Row label="Duración">{duration === COPY.notAvailable ? COPY.durationUnavailable : duration}</Row>
            </>
          )}
          <Row label="Integrado">{yesNo(attempt.integrated)}</Row>
          {attempt.failure_reason && <Row label="Motivo del fallo">{attempt.failure_reason}</Row>}
          <Row label="Resumen">{text(attempt.summary)}</Row>
        </dl>

        {/* LXO-141: la decisión de la persona sobre la aprobación inicial; solo mientras el Core la espera. */}
        {/* LXO-248: elegir ANTES de aprobar el worktree de otro intento (en serie, mismo proyecto). */}
        <AttemptShareWorktree attempt={attempt} onShared={state.retry} />
        {/* LXO-247: lo que el proveedor le pide a la persona (permiso o pregunta) mientras el intento espera; el Core lo entrega y reanuda. */}
        {/* Detener la ejecución en marcha (el Core no declara detenido a un Attempt cuyo proceso no pudo matar). */}
        <AttemptStop taskId={attempt.task_id} status={attempt.status} onStopped={state.retry} />
        {/* Reintentar un intento que terminó mal: un Attempt nuevo y limpio, que el Core lanza por su camino de siempre. */}
        <AttemptRetry attempt={attempt} onRetried={state.retry} />
        {/* Continuar la sesión del proveedor de un intento terminado con un mensaje nuevo (reanudación nativa). */}
        <AttemptResume attempt={attempt} onResumed={state.retry} />
        {/* Instrucciones para un intento ocupado (Queue explícito) y la cola pendiente, tal como la dice el Core. */}
        {/* De dónde salió el intento, los Forks que nacieron de él y la acción de bifurcar (abrir uno es siempre una elección explícita). */}
        <AttemptLineage attempt={attempt} onOpenAttempt={onOpenAttempt} active={active} />

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

        <h4 className="ssec__label">Capacidades del proveedor</h4>
        <AttemptCapabilities providerId={attempt.provider} session={session} active={active} />

        <h4 className="ssec__label">Worktree</h4>
        {worktree ? (
          <dl data-testid="attempt-worktree">
            <Row label="Ubicación"><PathText path={worktree.path} /></Row>
            <Row label="Host">{typeof worktree.machine === 'string' && worktree.machine.trim() ? worktree.machine : <span className="ade-missing">{COPY.hostUnavailable}</span>}</Row>
            <Row label="Rama"><span className="mono">{text(worktree.branch)}</span> ← <span className="mono">{text(worktree.base_branch)}</span></Row>
            <Row label="Estado">{text(worktree.state)} · origen {text(worktree.provenance)} · rama conservada: {yesNo(worktree.branch_kept)}</Row>
          </dl>
        ) : <p className="ade-missing">{COPY.noWorktree}</p>}

        <h4 className="ssec__label">Consumo declarado</h4>
        <AttemptUsage usage={attempt.usage} />
        </div>

        <div hidden={detailTab !== 'artifacts'}>
        <h4 className="ssec__label">Artefactos</h4>
        {artifacts.length ? (
          <ul className="ade-attempt__artifacts" data-testid="attempt-artifacts">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                {text(artifact.kind)}: {artifact.kind === 'pull_request'
                  ? <span className="ade-missing" data-testid="attempt-pr-url-hidden">{COPY.prUrlHidden}</span>
                  : <PathText path={artifact.uri} repoRoot={worktree?.path ?? null} />}
                {' · '}sha256 {artifact.sha256 ? <code className="mono">{artifact.sha256.slice(0, 12)}</code> : COPY.notAvailable}
                {' · '}{Number.isSafeInteger(artifact.bytes) ? `${artifact.bytes} bytes` : `tamaño ${COPY.notAvailable}`}
              </li>
            ))}
          </ul>
        ) : <p className="ade-missing">{COPY.noArtifacts}</p>}
        </div>

        <div hidden={detailTab !== 'changes'}>
        <h4 className="ssec__label">Cambios y revisión</h4>
        {/* LXO-155: la evidencia antes del diff, con su procedencia, y aceptar/rechazar sobre el HEAD exacto que se ve. */}
        <AttemptProofPack attempt={attempt} onDecided={state.retry} active={active && detailTab === 'changes'} />
        {/* LXO-156: integrar la revisión aceptada (fusionar o publicar un PR), con el destino a la vista. */}
        <AttemptIntegration attempt={attempt} onDone={state.retry} active={active && detailTab === 'changes'} />
        <AttemptChanges taskId={attempt.task_id} status={attempt.status} worktree={worktree} onReviewed={state.retry} />
        {review ? (
          <dl data-testid="attempt-review">
            <Row label="Veredicto">{text(review.verdict)}</Row>
            <Row label="Commits"><span className="mono">{text(review.base_commit)}</span> → <span className="mono">{text(review.head_commit)}</span></Row>
            <Row label="Frescura"><StatusText info={reviewFreshnessInfo(review)} mark={false} /></Row>
          </dl>
        ) : <p className="ade-missing">{COPY.noReview}</p>}
        </div>

        <div hidden={detailTab !== 'details'}>
        {/* Autonomía de ESTE intento (LXO-210): cerrada hasta que se pide. */}
        <AutonomyEditor attemptId={attempt.id} />
        </div>
        <AttemptQueue attempt={attempt} active={active} />
      </>
    );
  } else if (state.error) {
    body = <CoreModelNotice error={state.error} onRetry={state.retry} onBack={onBack} />;
  } else {
    body = <p role="status">Cargando el intento.</p>;
  }
  return (
    <section className="ade-attempt" aria-label={COPY.attemptDetail} data-testid="attempt-detail">
      {!attempt && <h3 className="ssec__label">{COPY.attemptDetail}</h3>}
      {body}
    </section>
  );
}
