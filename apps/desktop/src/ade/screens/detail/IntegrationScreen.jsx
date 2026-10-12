// IntegrationScreen.jsx — integración del resultado de un intento al proyecto.
// La elegibilidad (¿se puede integrar?) la decide el Core; aquí solo se muestra y se pide con
// confirmación explícita. La integración real la hace el host (orch_integrate), no el ADE.
import { useNow } from '../../state/useNow';
import { useAttemptDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { ActionButton } from '../../components/ActionButton';
import { NavButton } from '../../components/NavLink';
import { eligibilityText } from '../../domain-view/integrationText';
import { formatAgo, shortCommit } from '../../domain-view/format';
import { routes } from '../../navigation/routes';
import { INTEGRATION_OUTCOME_LABELS, REVIEW_STATE_LABELS } from '../../vocab/vocabulario';

export function IntegrationScreen({ attemptId }) {
  const q = useAttemptDetail(attemptId);
  const now = useNow();
  const route = routes.integration(attemptId);
  return <DetailBoundary route={route} query={q}>{(d) => <IntegrationBody route={route} d={d} now={now} />}</DetailBoundary>;
}

function IntegrationBody({ route, d, now }) {
  const { attempt, task, project, worktree, review, integration } = d;
  const { allowed, reason } = integration.eligibility;
  return (
    <ScreenFrame route={route} entities={{ project, task, attempt }} title={`Integración · ${task.title}`}>
      <Section title="Destino" id="i-dest">
        <dl className="ade-facts">
          <dt>Rama del intento</dt><dd className="mono">{worktree?.branch ?? '—'}</dd>
          <dt>Destino</dt><dd className="mono">{integration.into ?? '—'}</dd>
          <dt>Revisión</dt><dd>{REVIEW_STATE_LABELS[review.state]}</dd>
          <dt>Resultado</dt>
          <dd>
            {integration.outcome ? INTEGRATION_OUTCOME_LABELS[integration.outcome] : 'Sin integrar'}
            {integration.resultCommit && <span className="mono"> · {shortCommit(integration.resultCommit)}</span>}
            {integration.at && <span className="ade-muted"> · {formatAgo(integration.at, now)}</span>}
          </dd>
        </dl>
      </Section>
      <Section title="Integrar" id="i-do">
        {allowed ? (
          <>
            <p>Se integrará el commit <span className="mono">{shortCommit(worktree?.headCommit)}</span> en <span className="mono">{integration.into}</span>. Es una decisión tuya y exige confirmación.</p>
            <div className="ade-toolbar">
              <ActionButton intent="integrate_attempt" args={{ attemptId: attempt.id, headCommit: worktree?.headCommit, confirm: true }} label="Integrar" variant="primary" confirm />
            </div>
          </>
        ) : (
          <>
            <p className="ade-muted" data-testid="not-eligible">{eligibilityText(reason)}</p>
            <div className="ade-toolbar">
              <ActionButton intent="integrate_attempt" args={{ attemptId: attempt.id, headCommit: worktree?.headCommit, confirm: true }} label="Integrar" disabled />
              {reason === 'review_required' && <NavButton route={routes.review(attempt.id)} variant="primary">Ir a revisar</NavButton>}
            </div>
          </>
        )}
      </Section>
    </ScreenFrame>
  );
}
