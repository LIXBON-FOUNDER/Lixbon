// ReviewScreen.jsx — revisión de un intento sobre un commit concreto.
// El diff completo lo pinta el IDE (TaskDiffView); aquí se ve el resumen y se decide. Aceptar solo vale
// sobre el commit que se muestra: si la rama cambió, el Core responde `stale` y hay que revisar de nuevo.
import { useNow } from '../../state/useNow';
import { useAttemptDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { ActionButton } from '../../components/ActionButton';
import { StatusPill } from '../../components/StatusMark';
import { AgentLabel } from '../../components/AgentLabel';
import { NavButton } from '../../components/NavLink';
import { formatAgo, shortCommit } from '../../domain-view/format';
import { routes } from '../../navigation/routes';
import { REVIEW_STATE_LABELS } from '../../vocab/vocabulario';

export function ReviewScreen({ attemptId }) {
  const q = useAttemptDetail(attemptId);
  const now = useNow();
  const route = routes.review(attemptId);
  return <DetailBoundary route={route} query={q}>{(d) => <ReviewBody route={route} d={d} now={now} />}</DetailBoundary>;
}

function ReviewBody({ route, d, now }) {
  const { attempt, task, project, worktree, review, artifacts } = d;
  const head = review.currentHeadCommit;
  const revisable = attempt.state === 'done' && Boolean(head);
  const stat = review.diffStat;
  const diffs = artifacts.filter((a) => a.kind === 'diff' || a.kind === 'report');

  return (
    <ScreenFrame
      route={route} entities={{ project, task, attempt }} title={`Revisión · ${task.title}`}
      subtitle={<span className="ade-screen__meta"><StatusPill state={attempt.state} /><AgentLabel agent={attempt.agent} /></span>}
    >
      <Section title="Estado de la revisión" id="r-state">
        <dl className="ade-facts">
          <dt>Revisión</dt><dd><span className={`ade-chip ade-chip--rev-${review.state}`}>{REVIEW_STATE_LABELS[review.state]}</span></dd>
          <dt>Commit actual</dt><dd className="mono">{shortCommit(head) || '—'}</dd>
          {review.headCommit && (<><dt>Commit revisado</dt><dd className="mono">{shortCommit(review.headCommit)}{review.state === 'stale' && <span className="ade-tag ade-tag--warn">desactualizado</span>}</dd></>)}
          {review.at && (<><dt>Revisada</dt><dd>{formatAgo(review.at, now)}{review.by ? ` · ${review.by.kind === 'human' ? 'por una persona' : review.by.kind}${review.by.client ? ` (${review.by.client})` : ''}` : ''}</dd></>)}
          {worktree && (<><dt>Rama</dt><dd className="mono">{worktree.branch}</dd></>)}
        </dl>
      </Section>

      <Section title="Resumen del diff" id="r-diff">
        {stat ? (
          <p className="ade-diffstat" data-testid="diffstat">
            <b>{stat.files}</b> archivos · <span className="ade-add">+{stat.additions}</span> <span className="ade-del">−{stat.deletions}</span>
          </p>
        ) : <p className="ade-muted">Sin resumen del diff.</p>}
        {diffs.length > 0 && <ul className="ade-plainlist">{diffs.map((a) => <li key={a.id}>{a.title}</li>)}</ul>}
        <ActionButton intent="open_diff" args={{ attemptId: attempt.id, headCommit: head }} label="Abrir diff completo en el IDE" />
      </Section>

      <Section title="Tu decisión" id="r-decide">
        {!revisable ? <p className="ade-muted">Solo se revisa un intento terminado y con rama.</p> : (
          <div className="ade-toolbar">
            <ActionButton intent="review_attempt" args={{ attemptId: attempt.id, decision: 'accepted', headCommit: head }} label="Aceptar este commit" variant="primary" confirm />
            <ActionButton intent="review_attempt" args={{ attemptId: attempt.id, decision: 'rejected', headCommit: head }} label="Rechazar" confirm />
            {review.state === 'accepted' && <NavButton route={routes.integration(attempt.id)}>Ir a integrar</NavButton>}
          </div>
        )}
        <p className="ade-muted">Aceptar vale solo para el commit <span className="mono">{shortCommit(head)}</span>. Si la rama cambia, habrá que revisar de nuevo.</p>
      </Section>
    </ScreenFrame>
  );
}
