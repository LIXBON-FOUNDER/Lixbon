import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ACTIVITY_DEFAULT_LIMIT, listAdeActivity } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';
import { ActivityTimeline } from './ActivityTimeline';
import { ACTIVITY_V1_MESSAGE_KEYS, translateActivityMessage } from './activityMessages';

const MESSAGE_KEYS = new Set(ACTIVITY_V1_MESSAGE_KEYS);
// Único key que el Core emite con `fallback: true`: su texto sale de `args` permitidos (reason, kind, event_version).
const UNKNOWN_EVENT_KEY = 'activity.unknown';
const VISUAL_TO_SEVERITY = Object.freeze({
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
});
const HEAD_FAILURES = new Set(['stale', 'disconnected', 'degraded', 'error']);

const emptyPages = (key, headData = null, readEpoch = 0) => ({
  key,
  headData,
  readEpoch,
  items: [],
  nextCursor: null,
  hasMore: false,
  hasLoadedPage: false,
  loading: false,
  error: null,
});

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') return { kind: 'global' };
  if (scope.kind === 'global') return { kind: 'global' };
  if (!['project', 'task'].includes(scope.kind) || typeof scope.id !== 'string' || !scope.id.trim()) {
    return { kind: 'global' };
  }
  const normalized = { kind: scope.kind, id: scope.id.trim() };
  if (scope.kind === 'project' && typeof scope.name === 'string' && scope.name.trim()) {
    normalized.name = scope.name.trim();
  }
  if (scope.kind === 'task' && typeof scope.title === 'string' && scope.title.trim()) {
    normalized.title = scope.title.trim();
  }
  return normalized;
}

function scopeKey(scope) {
  return `${scope.kind}\u0000${scope.id ?? ''}`;
}

function queryFilters(scope) {
  return {
    cursor: 0,
    limit: ACTIVITY_DEFAULT_LIMIT,
    order: 'desc',
    project_id: scope.kind === 'project' ? scope.id : null,
    run_id: null,
    target_kind: scope.kind === 'task' ? 'task' : null,
    target_id: scope.kind === 'task' ? scope.id : null,
  };
}

function uniqueContractItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : '';
    if (!eventId || eventId.length > 200 || seen.has(eventId)) continue;
    if (!Number.isSafeInteger(item.seq) || item.seq < 1) continue;
    seen.add(eventId);
    unique.push(item);
  }
  return unique;
}

function presentationalTarget(target) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.kind !== 'string' || !target.kind.trim()) return null;
  if (typeof target.id !== 'string' || !target.id.trim()) return null;
  return { kind: target.kind, id: target.id };
}

function presentationalActor(actor) {
  if (!actor || typeof actor !== 'object' || typeof actor.kind !== 'string') return null;
  return {
    kind: actor.kind,
    id: typeof actor.id === 'string' ? actor.id : null,
  };
}

function presentationalClient(provenance) {
  if (!provenance || typeof provenance !== 'object') return null;
  const channel = typeof provenance.channel === 'string' ? provenance.channel : null;
  const clientId = typeof provenance.client_id === 'string' ? provenance.client_id : null;
  return channel || clientId ? { channel, clientId } : null;
}

function toTimelineItem(item) {
  const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : '';
  const messageKey = typeof item.message_key === 'string' ? item.message_key.trim() : '';
  const fallback = item.fallback === true;
  // Un fallback del Core solo se traduce como `activity.unknown` y con args válidos; cualquier otra clave marcada
  // fallback, o args fuera del contrato, deja al timeline en su texto genérico «Evento desconocido».
  const known = MESSAGE_KEYS.has(messageKey)
    && (!fallback || (messageKey === UNKNOWN_EVENT_KEY && translateActivityMessage(messageKey, item.args) !== null));
  const project = typeof item.project_id === 'string' && item.project_id.trim()
    ? { id: item.project_id }
    : null;
  return {
    eventId,
    seq: item.seq,
    timestamp: item.ts,
    class: item.class,
    kind: typeof item.kind === 'string' ? item.kind : undefined,
    target: presentationalTarget(item.target),
    project,
    actor: presentationalActor(item.actor),
    client: presentationalClient(item.provenance),
    message: known ? { key: messageKey, params: item.args } : null,
    known,
    severity: VISUAL_TO_SEVERITY[item.visual] ?? null,
    correlationId: typeof item.correlation_id === 'string' ? item.correlation_id : null,
  };
}

function errorText(error, reason) {
  const raw = typeof error === 'string'
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : '';
  if (reason === 'disconnected') {
    return `Core está desconectado${raw ? `: ${raw}` : '.'}`;
  }
  if (reason === 'degraded') {
    return `Core está degradado${raw ? `: ${raw}` : '.'}`;
  }
  return raw || 'El Core no devolvió actividad.';
}

function errorCode(message, reason) {
  if (reason) return reason;
  const prefix = typeof message === 'string' ? message.match(/^[a-z][a-z0-9_]+/i)?.[0] : null;
  return prefix ?? '';
}

function coreStatus(status, hasData, pageError) {
  if (pageError || status === 'stale' || status === 'error' || status === 'disconnected') return 'error';
  if (status === 'degraded') return hasData ? 'error' : 'degraded';
  if ((status === 'loading' || status === 'idle') && !hasData) return 'loading';
  return 'ready';
}

/** Read-only Activity projection over the Core's descending, numeric-sequence cursor. */
export function ActivityPanel({
  scope: inputScope = { kind: 'global' },
  active = true,
  pollMs,
  onOpenTarget,
  className = '',
}) {
  const scope = useMemo(() => normalizeScope(inputScope), [inputScope]);
  const filterKey = scopeKey(scope);
  const filters = queryFilters(scope);
  const list = useCoreQuery('activity_list', filters, { enabled: active, pollMs });
  const [pages, setPages] = useState(() => emptyPages(filterKey));
  const pageGeneration = useRef(0);
  const loadingMore = useRef(null);
  const pageContext = useRef({ key: filterKey, headData: null, readEpoch: 0 });

  // A successful base read always begins a new cursor traversal, including an identical poll.
  useLayoutEffect(() => {
    if (pageContext.current.key === filterKey
      && pageContext.current.headData === list.data
      && pageContext.current.readEpoch === list.readEpoch) return;
    pageContext.current = { key: filterKey, headData: list.data, readEpoch: list.readEpoch };
    pageGeneration.current += 1;
    loadingMore.current = null;
    setPages(emptyPages(filterKey, list.data, list.readEpoch));
  }, [filterKey, list.data, list.readEpoch]);

  // A failed head read invalidates pages from the previous connection. The retained head stays visible.
  const headFailure = HEAD_FAILURES.has(list.status);
  useLayoutEffect(() => {
    if (!headFailure) return;
    pageGeneration.current += 1;
    loadingMore.current = null;
    setPages(emptyPages(filterKey, list.data, list.readEpoch));
  }, [headFailure, filterKey, list.data, list.readEpoch]);

  const pageState = pages.key === filterKey
    && pages.headData === list.data
    && pages.readEpoch === list.readEpoch
    ? pages
    : emptyPages(filterKey, list.data, list.readEpoch);
  const baseItems = Array.isArray(list.data?.items) ? list.data.items : [];
  const contractItems = useMemo(
    () => uniqueContractItems([...baseItems, ...pageState.items]),
    [baseItems, pageState.items],
  );
  const items = useMemo(() => contractItems.map(toTimelineItem), [contractItems]);

  const pageCursor = pageState.hasLoadedPage ? pageState.nextCursor : list.data?.next_cursor;
  const hasMore = pageState.hasLoadedPage ? pageState.hasMore : list.data?.has_more === true;
  const usableCursor = Number.isSafeInteger(pageCursor) && pageCursor > 0 ? pageCursor : null;
  const canLoadMore = usableCursor !== null
    && hasMore
    && !headFailure
    && list.status !== 'refreshing'
    && !pageState.error;
  const cursor = list.data
    ? { next: usableCursor ?? pageCursor ?? null, hasMore: hasMore === true }
    : null;

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !canLoadMore || usableCursor === null) return;
    const token = {};
    loadingMore.current = token;
    const requestedKey = filterKey;
    const requestedHead = list.data;
    const requestedEpoch = list.readEpoch;
    const requestedGeneration = pageGeneration.current;
    setPages((current) => (current.key !== requestedKey
      || current.headData !== requestedHead
      || current.readEpoch !== requestedEpoch
      ? current
      : { ...current, loading: true, error: null }));
    try {
      const page = await listAdeActivity({
        cursor: usableCursor,
        limit: ACTIVITY_DEFAULT_LIMIT,
        order: 'desc',
        projectId: scope.kind === 'project' ? scope.id : null,
        runId: null,
        targetKind: scope.kind === 'task' ? 'task' : null,
        targetId: scope.kind === 'task' ? scope.id : null,
      });
      if (pageGeneration.current !== requestedGeneration) return;
      setPages((current) => (current.key !== requestedKey
        || current.headData !== requestedHead
        || current.readEpoch !== requestedEpoch
        || pageGeneration.current !== requestedGeneration
        ? current
        : {
          ...current,
          items: [...current.items, ...(Array.isArray(page?.items) ? page.items : [])],
          nextCursor: page?.next_cursor ?? null,
          hasMore: page?.has_more === true,
          hasLoadedPage: true,
          loading: false,
          error: null,
        }));
    } catch (error) {
      if (pageGeneration.current !== requestedGeneration) return;
      const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
      setPages((current) => (current.key !== requestedKey
        || current.headData !== requestedHead
        || current.readEpoch !== requestedEpoch
        || pageGeneration.current !== requestedGeneration
        ? current
        : { ...current, loading: false, error: message }));
    } finally {
      if (loadingMore.current === token) loadingMore.current = null;
    }
  }, [canLoadMore, usableCursor, filterKey, list.data, list.readEpoch, scope]);

  const retry = useCallback(() => {
    setPages((current) => ({ ...current, error: null, loading: false }));
    list.retry();
  }, [list.retry]);

  const failure = Boolean(pageState.error) || headFailure;
  const hasData = Boolean(list.data);
  const timelineStatus = coreStatus(list.status, hasData, pageState.error);
  const stale = Boolean(pageState.error) || (headFailure && hasData);
  const message = pageState.error || errorText(list.error, list.reason
    ?? (list.status === 'disconnected' ? 'disconnected' : list.status === 'degraded' ? 'degraded' : null));
  const code = pageState.error
    ? errorCode(pageState.error)
    : errorCode(list.error, list.reason);

  return (
    <ActivityTimeline
      items={items}
      scope={scope}
      status={timelineStatus}
      stale={stale}
      error={failure ? { message, code } : null}
      cursor={cursor}
      loadingMore={pageState.loading}
      onLoadMore={loadMore}
      onRefresh={retry}
      onRetry={retry}
      onOpenTarget={onOpenTarget}
      translateMessage={translateActivityMessage}
      className={className}
    />
  );
}
