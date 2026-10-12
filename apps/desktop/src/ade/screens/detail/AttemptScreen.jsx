// AttemptScreen.jsx — un intento: agente, estado, pregunta pendiente, política, worktree, artefactos,
// revisión e integración, con los atajos al IDE. Es el nodo central de la cadena de navegación:
// Attention → Project → Task → Attempt → Thread / Worktree / Artifacts / Diff → IDE.
import { useNow } from '../../state/useNow';
import { useAttemptDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { StatusPill } from '../../components/StatusMark';
import { AgentLabel } from '../../components/AgentLabel';
import { PolicySummary } from '../../components/PolicySummary';
import { InlineAnswer } from '../../components/InlineAnswer';
import { HostShortcuts } from '../../components/HostShortcuts';
import { ActionButton } from '../../components/ActionButton';
import { NavButton, NavLink } from '../../components/NavLink';
import { attemptDuration, countdown, formatAgo, shortCommit } from '../../domain-view/format';
import { routes } from '../../navigation/routes';
import {
  FAILURE_REASON_LABELS, INTEGRATION_OUTCOME_LABELS, REVIEW_STATE_LABELS, attemptStateInfo,
} from '../../vocab/vocabulario';

const ARTEFACTO = { report: 'Informe', diff: 'Diff', log: 'Registro', test_report: 'Pruebas' };

export function AttemptScreen({ attemptId }) {
  const q = useAttemptDetail(attemptId);
  const now = useNow();
  const route = routes.attempt(attemptId);
  return <DetailBoundary route={route} query={q}>{(d) => <AttemptBody route={route} d={d} now={now} />}</DetailBoundary>;
}

function AttemptBody({ route, d, now }) {
  const { attempt, task, project, worktree, artifacts, review, integration, threads } = d;
  const info = attemptStateInfo(attempt.state);
  const vence = attempt.approvalDeadline ? countdown(attempt.approvalDeadline, now) : '';

  return (
    <ScreenFrame
      route={route} entities={{ project, task, attempt }} title={`${task.title} · Intento ${attempt.ordinal}`}
      subtitle={<span className="ade-screen__meta"><StatusPill state={attempt.state} /><AgentLabel agent={attempt.agent} /><span>{attemptDuration(attempt, now)}</span></span>}
      actions={(
        <>
          {attempt.state === 'pending_approval' && (
            <>
              <ActionButton intent="approve_spawn" args={{ attemptId: attempt.id, confirmedCommand: attempt.policy.command }} label="Aprobar" variant="primary" />
              <ActionButton intent="reject_spawn" args={{ attemptId: attempt.id }} label="Rechazar" />
            </>
          )}
          {!info.final && attempt.state !== 'pending_approval' && <ActionButton intent="stop_attempt" args={{ attemptId: attempt.id }} />}
        </>
      )}
    >
      <Section title="Estado" id="a-state">
        <dl className="ade-facts">
          <dt>Estado</dt><dd>{info.label}{info.propuesta && <span className="ade-tag" title="Etiqueta propuesta: aún no hay etiqueta canónica">propuesta</span>}</dd>
          {attempt.phase && (<><dt>Fase</dt><dd>{attempt.phase}</dd></>)}
          {attempt.note && (<><dt>Nota</dt><dd>{attempt.note}</dd></>)}
          {vence && (<><dt>Plazo</dt><dd>{vence}</dd></>)}
          {attempt.failureReason && (<><dt>Motivo del fallo</dt><dd>{FAILURE_REASON_LABELS[attempt.failureReason] || attempt.failureReason}</dd></>)}
          {attempt.summary && (<><dt>Resumen</dt><dd>{attempt.summary}</dd></>)}
          <dt>Actualizado</dt><dd>{formatAgo(attempt.updatedAt, now)}</dd>
        </dl>
      </Section>

      {attempt.pendingQuestion && (
        <Section title="Pregunta del agente" id="a-q">
          <blockquote className="ade-question">{attempt.pendingQuestion.text}</blockquote>
          <InlineAnswer attemptId={attempt.id} />
        </Section>
      )}

      <Section title="Política efectiva" id="a-pol"><PolicySummary policy={attempt.policy} /></Section>

      <Section title="Worktree" id="a-wt">
        {worktree ? (
          <dl className="ade-facts" data-testid="worktree">
            <dt>Rama</dt><dd className="mono">{worktree.branch}</dd>
            <dt>Ruta</dt><dd className="mono ade-wrap">{worktree.path}</dd>
            <dt>Base → cabeza</dt><dd className="mono">{shortCommit(worktree.baseCommit)} → {shortCommit(worktree.headCommit)}</dd>
            <dt>Cambios sin confirmar</dt><dd>{worktree.dirty ? 'Sí' : 'No'}</dd>
          </dl>
        ) : <p className="ade-muted">Este intento aún no tiene worktree (se crea al aprobarlo).</p>}
      </Section>

      <Section title="Artefactos" count={artifacts.length} id="a-art">
        {artifacts.length === 0 ? <p className="ade-muted">Todavía no ha producido artefactos.</p> : (
          <ul className="ade-plainlist">
            {artifacts.map((a) => <li key={a.id}><span className="ade-chip">{ARTEFACTO[a.kind] || a.kind}</span> {a.title} <span className="ade-muted">{formatAgo(a.createdAt, now)}</span></li>)}
          </ul>
        )}
      </Section>

      <Section title="Revisión e integración" id="a-rev">
        <dl className="ade-facts">
          <dt>Revisión</dt>
          <dd><span className={`ade-chip ade-chip--rev-${review.state}`}>{REVIEW_STATE_LABELS[review.state]}</span>{review.state === 'stale' && <span className="ade-muted"> · la rama cambió tras revisarla</span>}</dd>
          <dt>Integración</dt>
          <dd>{integration.outcome ? INTEGRATION_OUTCOME_LABELS[integration.outcome] : 'Sin integrar'}</dd>
        </dl>
        <div className="ade-toolbar">
          {attempt.state === 'done' && <NavButton route={routes.review(attempt.id)} variant="primary">Revisar</NavButton>}
          {attempt.state === 'done' && <NavButton route={routes.integration(attempt.id)}>Integración</NavButton>}
        </div>
      </Section>

      <Section title="Hilos" count={threads.length} id="a-th">
        {threads.length === 0 ? <p className="ade-muted">Sin hilos.</p> : threads.map((h) => <div key={h.id}><NavLink route={routes.thread(h.id)}>{h.title}</NavLink> <span className="ade-muted">· {h.messageCount} mensajes</span></div>)}
      </Section>

      <Section title="Ir al IDE" id="a-ide"><HostShortcuts attemptId={attempt.id} /></Section>
    </ScreenFrame>
  );
}
