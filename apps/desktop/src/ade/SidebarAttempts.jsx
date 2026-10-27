import { createContext, useContext, useEffect, useId } from 'react';
import { useCoreQuery } from './useCoreQuery';
import { COPY, attemptStatusInfo } from './adeLabels';
import { attemptTime } from './attemptFormat';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { validTaskV2 } from './coreModelContract';

// Sidebar adaptativo Project → Task → Attempt (LXO-120).
//
// Task y Attempt son entidades distintas aunque se compriman: con 1 Attempt la fila de la Task se
// muestra plegada con el Attempt como chip secundario; con N se muestra expandida y cada Attempt es
// su propio `treeitem` de nivel 3. Expandir/plegar es estado de la vista, nunca del Core.
// Solo se muestra lo que trae `attempt_brief` (sin worktree, rama ni resumen): el sidebar no pide
// `attempt_detail` por Attempt. Sin modelo vNext la fila queda como en F2 y no se inventa nada.

export const attemptKey = (projectId, taskId, attemptId) => `a:${projectId}\u0000${taskId}\u0000${attemptId}`;
export const taskKeyOfAttemptKey = (key) => {
  const [projectId, taskId] = key.slice(2).split('\u0000');
  return `t:${projectId}\u0000${taskId}`;
};

export const AttemptTreeContext = createContext(null);

/** `{count, latest}` de una fila de `task_list_v2`, o `null` si no cumple el contrato. */
export function attemptSummaryOf(item) {
  if (!validTaskV2(item)) return null;
  return { count: item.attempt_count, latest: item.current_attempt ?? null, state: item.state, intent: item.intent };
}

export function AttemptChip({ attempt }) {
  const info = attemptStatusInfo(attempt.status);
  const time = info.raw === 'failed' ? attemptTime(attempt) : null;
  return (
    <span className="ps__attempt-chip" data-attempt-id={attempt.id}>
      <StatusText info={info} className="ps__astatus" prefix={`Intento #${attempt.n} · `} />
      {time && <time className="ps__atime" dateTime={time.iso}>{time.label}</time>}
    </span>
  );
}

export function AttemptMeta({ attempt }) {
  return (
    <>
      <span>Proveedor {attempt.provider}</span>
      <span>Modelo {attempt.model ?? 'No informado'}</span>
      {attempt.role && <span>Rol {attempt.role}</span>}
    </>
  );
}

export function NoAttempts() {
  return <span className="ps__astatus ps__astatus--neutral" data-testid="task-no-attempts">{COPY.noAttempts}</span>;
}

function AttemptRow({ projectId, taskId, attempt, position, setSize }) {
  const tree = useContext(AttemptTreeContext);
  const metaId = useId();
  const key = attemptKey(projectId, taskId, attempt.id);
  const info = attemptStatusInfo(attempt.status);
  const selected = tree.selection.projectId === projectId && tree.selection.taskId === taskId
    && tree.selection.attemptId === attempt.id;
  const activate = () => tree.onActivateAttempt({ projectId, taskId, attemptId: attempt.id });
  return (
    <li
      role="treeitem"
      aria-level={3}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-selected={selected}
      aria-label={`Intento #${attempt.n} de la Task ${taskId}. ${info.label}`}
      aria-describedby={metaId}
      data-attempt-id={attempt.id}
      data-task-id={taskId}
      data-status={attempt.status}
      tabIndex={tree.isActiveKey(key) ? 0 : -1}
      ref={tree.registerRef(key)}
      className={`ps__item ps__item--attempt${selected ? ' is-selected' : ''}`}
      onFocus={(event) => { if (event.target === event.currentTarget) tree.onFocusKey(key); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
          return;
        }
        tree.onKeyDown(event, key);
      }}
      onClick={(event) => { event.stopPropagation(); activate(); }}
    >
      <span className="ps__line">
        <AttemptChip attempt={attempt} />
        <span className="ps__id mono">{attempt.id}</span>
      </span>
      <span className="ps__meta" id={metaId}><AttemptMeta attempt={attempt} /></span>
    </li>
  );
}

/** Attempts de una Task expandida (`attempts_by_task`, solo `attempt_brief`), el más reciente primero. */
export function TaskAttemptGroup({ projectId, taskId, taskTitle, expectedCount }) {
  const tree = useContext(AttemptTreeContext);
  const state = useCoreQuery('attempts_by_task', { task_id: taskId }, { enabled: tree.active, pollMs: tree.pollMs });
  const attempts = Array.isArray(state.data?.items) ? [...state.data.items].sort((a, b) => b.n - a.n) : null;
  const ids = attempts ? attempts.map((attempt) => attempt.id).join('\u0000') : '';
  const { onAttemptIds } = tree;
  const taskKeyValue = `t:${projectId}\u0000${taskId}`;
  useEffect(() => {
    onAttemptIds(taskKeyValue, ids ? ids.split('\u0000') : []);
    return () => onAttemptIds(taskKeyValue, null);
  }, [onAttemptIds, taskKeyValue, ids]);

  if (!attempts) {
    if (state.error) {
      return (
        <CoreModelNotice
          className="ps__notice"
          error={state.error}
          onRetry={state.retry}
          onBack={() => tree.onBackToProject(projectId)}
        />
      );
    }
    return <div className="ps__state" role="status">Cargando intentos de {taskTitle}.</div>;
  }
  return (
    <>
      <ul className="ps__attempts" role="group" aria-label={`Intentos de ${taskTitle}`}>
        {attempts.map((attempt, index) => (
          <AttemptRow key={attempt.id} projectId={projectId} taskId={taskId} attempt={attempt} position={index + 1} setSize={attempts.length} />
        ))}
      </ul>
      {Number.isSafeInteger(expectedCount) && expectedCount !== attempts.length && (
        <p className="ps__hint" role="status">El resumen de la Task indica {expectedCount} intentos y el historial devolvió {attempts.length}; se muestra el historial.</p>
      )}
    </>
  );
}
