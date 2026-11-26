import { useCoreQuery } from './useCoreQuery';
import { CoreModelNotice } from './CoreModelNotice';
import { ProviderMark } from '../orch/agent/ProviderMark';
import { providerName } from '../orch/agent/agentIdentity';
import { attemptLetter } from './attemptFormat';

export function AttemptSelector({ taskId, coreModel, selectedAttemptId, active, onSelect, onCompare }) {
  const state = useCoreQuery('attempts_by_task', { task_id: taskId }, { enabled: Boolean(active && coreModel?.vNext && taskId) });
  if (!coreModel?.vNext) return null;
  const items = state.data?.items;
  return <div className="ade-attempt-selector">
    <div role="group" aria-label="Intentos de la tarea">{Array.isArray(items) ? items.map((attempt) => <button type="button" key={attempt.id} aria-pressed={selectedAttemptId === attempt.id} onClick={() => onSelect(attempt.id)} title={`Intento ${attempt.n} · ${attempt.id}`}><ProviderMark provider={attempt.provider} size={16} /><span>{providerName(attempt.provider)}</span><small>{attemptLetter(attempt.n)}</small></button>) : <span>{state.error ? <CoreModelNotice error={state.error} onRetry={state.retry} /> : 'Cargando intentos…'}</span>}{items?.length === 0 && <span>Sin intentos todavía</span>}</div>
    <button type="button" className="lk" onClick={onCompare}>Historial y comparación</button>
  </div>;
}
