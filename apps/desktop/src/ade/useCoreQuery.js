import { useCallback, useEffect, useRef, useState } from 'react';
import { queryAdeCore } from './coreQueries';

const POLL_MS = 15_000;
const QUERY_TIMEOUT_MS = 10_000;

function coreArgs(query, args) {
  if (query === 'projects_overview') return { archived: args.archived ?? 'exclude' };
  if (query === 'attention_list') {
    return { projectId: args.project_id, category: args.category, severity: args.severity };
  }
  if (query === 'tasks_by_project') return { projectId: args.project_id };
  return { projectId: args.project_id, taskId: args.task_id };
}

export function classifyCoreError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
  if (/_unavailable|degraded|almac[eé]n.*no disponible/i.test(message)) return 'degraded';
  if (/(ade_query_timeout|timeout|disconnected|connection refused|failed to fetch|ipc.*closed|closed.*ipc|transport.*closed)/i.test(message)) return 'disconnected';
  return 'error';
}

function isEmptyResult(query, data) {
  return (query === 'projects_overview' && data.projects.length === 0)
    || (query === 'attention_list' && data.items.length === 0)
    || (query === 'tasks_by_project' && data.tasks.length === 0);
}

export function useCoreQuery(query, args, { enabled = true, pollMs = POLL_MS } = {}) {
  const argsJson = JSON.stringify(args);
  const requestKey = `${query}:${argsJson}`;
  const [snapshot, setSnapshot] = useState({ key: null, status: 'idle', data: null, error: null, reason: null, updatedAt: null });
  const [retryToken, setRetryToken] = useState(0);
  const cache = useRef({ key: requestKey, data: null, updatedAt: null });
  if (cache.current.key !== requestKey) cache.current = { key: requestKey, data: null, updatedAt: null };

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let inFlight = false;

    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const previous = cache.current.key === requestKey ? cache.current : { data: null, updatedAt: null };
      setSnapshot({ key: requestKey, status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null, reason: null, updatedAt: previous.updatedAt });
      let timeoutId;
      try {
        const queryTimeout = new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('ade_query_timeout: Core no respondió a tiempo')), QUERY_TIMEOUT_MS);
        });
        const data = await Promise.race([
          queryAdeCore(query, coreArgs(query, JSON.parse(argsJson))),
          queryTimeout,
        ]);
        if (!alive) return;
        const updatedAt = Date.now();
        cache.current = { key: requestKey, data, updatedAt };
        setSnapshot({ key: requestKey, status: isEmptyResult(query, data) ? 'empty' : 'ready', data, error: null, reason: null, updatedAt });
      } catch (error) {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
        const reason = classifyCoreError(error);
        setSnapshot({
          key: requestKey,
          status: previous.data ? 'stale' : reason,
          data: previous.data,
          error: message,
          reason: previous.data ? reason : null,
          updatedAt: previous.updatedAt,
        });
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        inFlight = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, pollMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [query, argsJson, requestKey, enabled, pollMs, retryToken]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);
  if (!enabled) return { status: 'idle', data: null, error: null, reason: null, updatedAt: null, retry };
  if (snapshot.key !== requestKey) return { status: 'loading', data: null, error: null, reason: null, updatedAt: null, retry };
  return { ...snapshot, retry };
}
