import { useCallback, useEffect, useRef, useState } from 'react';
import { queryAdeCore } from './coreQueries';
import {
  classifyCoreError,
  createQueryReader,
  slotFor,
  statusForFailure,
} from './coreQueryPolicy';

const POLL_MS = 15_000;

/**
 * Mensaje de plazo agotado. Agotar el umbral NO dice que el Core esté desconectado: puede estar
 * escaneando (docs/core/RESOURCES.md). La foto que se conserva es la última que respondió.
 */
const TIMEOUT_MESSAGE = 'ade_query_timeout: el Core no respondió dentro del umbral del cliente';

function coreArgs(query, args) {
  if (query === 'projects_overview') return { archived: args.archived ?? 'exclude' };
  if (query === 'attention_list') {
    return {
      projectId: args.project_id,
      targetKind: args.target_kind,
      targetId: args.target_id,
      category: args.category,
      severity: args.severity,
    };
  }
  if (query === 'activity_list') {
    return {
      cursor: args.cursor ?? 0,
      limit: args.limit ?? 100,
      order: args.order ?? 'asc',
      projectId: args.project_id,
      runId: args.run_id,
      targetKind: args.target_kind,
      targetId: args.target_id,
    };
  }
  if (query === 'tasks_by_project') {
    return { projectId: args.project_id, status: args.status ?? 'active' };
  }
  if (query === 'resource_inventory') {
    // El sondeo viaja siempre: el Core decide si calcula `dirty`/`merged` y el eco se verifica.
    // El ADE exige `project_id`: el inventario se lee siempre acotado a un Project durable.
    if (typeof args.project_id !== 'string' || !args.project_id.trim()) {
      throw new Error('ade_query_invalid_request: resource_inventory exige project_id');
    }
    return { projectId: args.project_id, probe: args.probe ?? true };
  }
  if (query === 'core_model') return {};
  if (query === 'provider_capabilities') return { refresh: args.refresh === true };
  if (query === 'task_list_v2') return { projectId: args.project_id, cursor: args.cursor ?? null };
  if (query === 'task_detail_v2' || query === 'attempts_by_task') return { taskId: args.task_id };
  if (query === 'attempt_detail') return { attemptId: args.attempt_id };
  if (query === 'task_detail') return { projectId: args.project_id, taskId: args.task_id };
  // Sin caída silenciosa: una query sin traducción explícita es un error, no un `task_detail`.
  throw new Error(`ade_query_forbidden: ${query} no es una query read-only del ADE`);
}

export { classifyCoreError };

function isEmptyResult(query, data) {
  // Un payload sin la lista contractual NO es «vacío»: es inválido, y `validateResponse` ya lo
  // rechaza antes de llegar aquí. Se comprueba sin lanzar: una excepción aquí dejaría la lectura
  // viva sin foto y sin estado.
  if (!data || typeof data !== 'object') return false;
  return (query === 'projects_overview' && Array.isArray(data.projects) && data.projects.length === 0)
    || (query === 'attention_list' && Array.isArray(data.items) && data.items.length === 0)
    || (query === 'activity_list' && Array.isArray(data.items) && data.items.length === 0)
    || (query === 'tasks_by_project' && Array.isArray(data.tasks) && data.tasks.length === 0);
}

/** Core query results are JSON DTOs; object key order does not change their meaning. */
function sameData(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameData(value, right[index]));
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}

/**
 * Lectura de una query del Core con UMBRAL VISUAL de espera (LXO-101).
 *
 * El umbral marca cuándo el cliente deja de ESPERAR, no cuándo termina el escaneo del Core. La
 * política (peticiones outstanding, umbral, aplazamiento y recuperación) vive en
 * `coreQueryPolicy.js`; aquí solo se traduce a estado de pantalla:
 *
 *  · La petición NO se abandona al pasarse el umbral visual: si el Core contesta antes del tope
 *    de abandono, esa respuesta se aplica (recuperación) y el escaneo no se duplica. Pasado el
 *    tope de `abandonAfter(query)` (120 s para `resource_inventory`) `coreQueryPolicy.js` sí la
 *    abandona: libera el hueco y la respuesta posterior se descarta.
 *  · `inFlight` dice si hay una petición viva para esta clave: mientras la hay, reintentar se
 *    engancharía a ella y no abriría otra lectura.
 *  · Mientras una petición sigue viva no se abre otra para la misma clave, y para
 *    `resource_inventory` no se abre ninguna en todo el cliente: cada una es un escaneo
 *    secuencial del disco y del git del Core. Lo que no cabe se APLAZA hasta que se libere hueco.
 *  · Al agotarse el umbral se conserva la última foto y se avisa (`stale` si había foto, `error`
 *    si no la había). Nunca se declara una desconexión sin evidencia de transporte roto.
 */
export function useCoreQuery(query, args, { enabled = true, pollMs = POLL_MS } = {}) {
  const argsJson = JSON.stringify(args);
  const requestKey = `${query}:${argsJson}`;
  const [snapshot, setSnapshot] = useState({ key: null, status: 'idle', data: null, error: null, reason: null, updatedAt: null, readEpoch: 0, inFlight: false });
  const [retryToken, setRetryToken] = useState(0);
  const cache = useRef({ key: requestKey, data: null, updatedAt: null, readEpoch: 0 });
  if (cache.current.key !== requestKey) cache.current = { key: requestKey, data: null, updatedAt: null, readEpoch: 0 };

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;

    /** La foto conocida de esta clave: la última respuesta que llegó, nunca una recortada. */
    const previousFor = () => (cache.current.key === requestKey
      ? cache.current
      : { data: null, updatedAt: null, readEpoch: 0 });

    /** Umbral agotado: se conserva la última foto y se avisa. La petición sigue viva. */
    const showThreshold = () => {
      if (!alive) return;
      const previous = previousFor();
      setSnapshot({
        key: requestKey,
        status: statusForFailure('timeout', previous.data !== null),
        data: previous.data,
        error: TIMEOUT_MESSAGE,
        reason: previous.data ? 'timeout' : null,
        inFlight: true,
        updatedAt: previous.updatedAt,
        readEpoch: previous.readEpoch,
      });
    };

    const applyOutcome = (outcome) => {
      if (!alive) return;
      const previous = previousFor();
      if (outcome.ok) {
        // Consumers use updatedAt as a semantic data version, so an identical poll reuses it.
        const unchanged = previous.data !== null && sameData(previous.data, outcome.data);
        const snapshotData = unchanged ? previous.data : outcome.data;
        const updatedAt = unchanged
          ? previous.updatedAt
          : Math.max(Date.now(), (previous.updatedAt ?? 0) + 1);
        // readEpoch avanza en cada lectura correcta, incluso idéntica: acota qué datos derivados (p. ej. páginas
        // posteriores) se obtuvieron antes de esa lectura. No cambia la semántica de data/updatedAt.
        const readEpoch = previous.readEpoch + 1;
        cache.current = { key: requestKey, data: snapshotData, updatedAt, readEpoch };
        setSnapshot({ key: requestKey, status: isEmptyResult(query, snapshotData) ? 'empty' : 'ready', data: snapshotData, error: null, reason: null, updatedAt, readEpoch, inFlight: false });
        return;
      }
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? 'Error desconocido del Core');
      const reason = classifyCoreError(outcome.error);
      setSnapshot({
        key: requestKey,
        status: statusForFailure(reason, previous.data !== null),
        data: previous.data,
        error: message,
        reason: previous.data ? reason : null,
        inFlight: false,
        updatedAt: previous.updatedAt,
        readEpoch: previous.readEpoch,
      });
    };

    const reader = createQueryReader({
      query,
      requestKey,
      // Hueco por Project para `resource_inventory`: un escaneo lento no aplaza a otro Project.
      slot: slotFor(query, JSON.parse(argsJson)?.project_id ?? null),
      launch: () => queryAdeCore(query, coreArgs(query, JSON.parse(argsJson))),
      pollMs,
      isHidden: () => document.visibilityState === 'hidden',
      onStart: (entry) => {
        const previous = previousFor();
        if (Date.now() >= entry.deadline) {
          // El umbral de esta petición ya venció: la foto sigue siendo la última conocida.
          showThreshold();
          return;
        }
        setSnapshot({ key: requestKey, status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null, reason: null, updatedAt: previous.updatedAt, readEpoch: previous.readEpoch, inFlight: true });
      },
      onThreshold: () => showThreshold(),
      onOutcome: (outcome) => applyOutcome(outcome),
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reader.refresh();
    };
    reader.start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      reader.stop();
    };
  }, [query, argsJson, requestKey, enabled, pollMs, retryToken]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);
  if (!enabled) return { status: 'idle', data: null, error: null, reason: null, updatedAt: null, readEpoch: 0, inFlight: false, retry };
  if (snapshot.key !== requestKey) return { status: 'loading', data: null, error: null, reason: null, updatedAt: null, readEpoch: 0, inFlight: true, retry };
  return { ...snapshot, retry };
}
