import { useCoreQuery } from './useCoreQuery';

/**
 * ¿Este Attempt es el último de su Task? Lee `attempts_by_task`. `known` es falso mientras no hay historial NI error: quien lo
 * usa no debe mostrar nada entonces, para que un botón no aparezca y desaparezca. Si la lectura falla se da por último (`known`
 * y `isLatest`): el Core vuelve a comprobarlo y rechaza la petición si no lo es.
 */
export function useLatestAttempt(attempt, enabled) {
  const history = useCoreQuery('attempts_by_task', { task_id: attempt?.task_id ?? null }, { enabled });
  const items = Array.isArray(history.data?.items) ? history.data.items : null;
  if (!items && !history.error) return { known: false, isLatest: false };
  const latest = items ? Math.max(attempt.n, ...items.map((item) => Number(item.n) || 0)) : attempt.n;
  return { known: true, isLatest: latest <= attempt.n };
}
