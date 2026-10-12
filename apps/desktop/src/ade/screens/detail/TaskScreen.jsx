// TaskScreen.jsx — una Task: objetivo, estado derivado, TODOS sus intentos e hilos.
// Comparar, competir N, reintentar y continuar con otro agente se ven, pero no están disponibles:
// el botón dice qué slice los habilitará (ver ActionButton).
import { useMemo } from 'react';
import { useNow } from '../../state/useNow';
import { useTaskDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { AttemptLine } from '../../components/rows';
import { AttentionCard } from '../../components/AttentionCard';
import { ActionButton } from '../../components/ActionButton';
import { NavLink } from '../../components/NavLink';
import { EmptyState } from '../../components/states';
import { buildAttentionViews } from '../../domain-view/attention';
import { latestAttempt } from '../../domain-view/projects';
import { formatAgo } from '../../domain-view/format';
import { routes } from '../../navigation/routes';
import { TASK_DERIVED_LABELS } from '../../vocab/vocabulario';

export function TaskScreen({ taskId }) {
  const q = useTaskDetail(taskId);
  const now = useNow();
  const route = routes.task(taskId);
  return <DetailBoundary route={route} query={q}>{(d) => <TaskBody route={route} d={d} now={now} />}</DetailBoundary>;
}

function TaskBody({ route, d, now }) {
  const { task, project, attempts, threads, attention } = d;
  const ult = latestAttempt(task, attempts);
  const vistas = useMemo(() => buildAttentionViews(attention, { projects: [project], tasks: [task], attempts }), [attention, project, task, attempts]);
  return (
    <ScreenFrame
      route={route} entities={{ project, task }} title={task.title}
      subtitle={<span className={`ade-chip ade-chip--${task.derivedState}`}>{TASK_DERIVED_LABELS[task.derivedState]}</span>}
    >
      <Section title="Objetivo" id="t-obj"><p className="ade-prose">{task.objective}</p></Section>

      {vistas.length > 0 && (
        <Section title="Requiere tu atención" count={vistas.length} id="t-attn">
          <div className="ade-inbox__cards">{vistas.map((v) => <AttentionCard key={v.item.id} view={v} now={now} compact />)}</div>
        </Section>
      )}

      <Section
        title="Intentos" count={attempts.length} id="t-att"
        aside={(
          <div className="ade-toolbar">
            <ActionButton intent="retry_attempt" args={{ attemptId: ult?.id }} />
            <ActionButton intent="continue_with_other_agent" args={{ attemptId: ult?.id }} />
            <ActionButton intent="race_attempts" args={{ taskId: task.id }} />
            <ActionButton intent="compare_attempts" args={{ taskId: task.id }} />
          </div>
        )}
      >
        {attempts.length === 0
          ? <EmptyState title="Esta tarea aún no tiene intentos">Un intento es una ejecución concreta de un agente con su propio worktree.</EmptyState>
          : <div className="ade-attemptlist">{attempts.map((a) => <AttemptLine key={a.id} attempt={a} now={now} />)}</div>}
      </Section>

      <Section title="Hilos" count={threads.length} id="t-th">
        {threads.length === 0 ? <EmptyState title="Sin hilos" compact /> : threads.map((h) => (
          <div key={h.id} className="ade-row" data-testid={`thread-${h.id}`}>
            <div className="ade-row__main">
              <NavLink route={routes.thread(h.id)} className="ade-row__title">{h.title}</NavLink>
              <div className="ade-row__meta">
                <span>{h.messageCount} {h.messageCount === 1 ? 'mensaje' : 'mensajes'}</span>
                <span>{h.attemptIds.length} {h.attemptIds.length === 1 ? 'intento' : 'intentos'}</span>
                {h.lastMessageAt && <span>{formatAgo(h.lastMessageAt, now)}</span>}
              </div>
            </div>
          </div>
        ))}
      </Section>
    </ScreenFrame>
  );
}
