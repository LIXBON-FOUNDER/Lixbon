import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ATTENTION_CATEGORIES,
  ATTENTION_LIMIT,
  ATTENTION_SEVERITIES,
  listAdeAttention,
} from './coreQueries';
import { useCoreQuery } from './useCoreQuery';
import './AttentionInbox.css';

const CATEGORY_LABELS = {
  question: 'Pregunta',
  approval: 'Aprobación',
  review_ready: 'Revisión lista',
  conflict: 'Conflicto',
  failed: 'Fallida',
  environment_blocked: 'Entorno bloqueado',
  risk: 'Riesgo',
};

const CATEGORY_HINTS = {
  question: 'Un agente espera una respuesta.',
  approval: 'Algo espera una aprobación humana.',
  review_ready: 'Un resultado está listo para revisar o integrar.',
  conflict: 'Un conflicto impide avanzar.',
  failed: 'Un intento terminó con error.',
  environment_blocked: 'El entorno impide trabajar.',
  risk: 'Una política o heurística avisa de un riesgo.',
};

const SEVERITY_LABELS = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

const TARGET_LABELS = {
  project: 'Project',
  task: 'Task',
  run: 'Run',
  spawn_request: 'Solicitud de lanzamiento',
  attempt: 'Intento',
  thread: 'Hilo',
  worktree: 'Worktree',
  artifact: 'Artefacto',
  review: 'Revisión',
  integration: 'Integración',
  agent: 'Agente',
  decision: 'Decisión',
  policy: 'Política',
};

const EMPTY_PAGES = Object.freeze({ items: [], nextCursor: null, hasMore: false, hasLoadedPage: false, loading: false, error: null });

const emptyPages = (key, headData = null, headReadEpoch = 0) => ({ ...EMPTY_PAGES, key, headData, headReadEpoch, items: [] });

const label = (labels, code) => labels[code] || code;

const toSummary = (item) => ({
  attentionId: item.id,
  kind: item.target_kind,
  id: item.target_id,
  projectId: item.project_id,
  runId: item.run_id,
  category: item.category,
  severity: item.severity,
  occurrence: item.occurrence,
  createdAt: item.created_at,
});

function describeAttentionError(code) {
  if (!code) return 'Core no devolvió detalle.';
  if (/(_unavailable|degraded|almac[eé]n.*no disponible)/i.test(code)) return 'Core no tiene un almacén autoritativo disponible.';
  if (/(_auth_required|authentication|unauthorized|identidad)/i.test(code)) return 'Core no pudo autenticar esta lectura.';
  if (/(_invalid_cursor)/i.test(code)) return 'El cursor de paginación ya no es válido para este Core.';
  if (/(_invalid_request)/i.test(code)) return 'Core rechazó los filtros de esta consulta.';
  if (/(_read_failed|_internal)/i.test(code)) return 'Core no pudo leer la Attention.';
  if (/(disconnected|connection|transport|timeout|ipc.*closed)/i.test(code)) return 'No se pudo completar la conexión con Core.';
  return 'Core devolvió un error al leer la Attention.';
}

function connectionLabel(reason) {
  if (reason === 'disconnected') return 'desconectado';
  if (reason === 'degraded') return 'degradado';
  return 'con error';
}

/**
 * Suma los conteos que publica `projects_overview` (Projects + lo que no tiene Project).
 * No deriva categorías ni severidades: solo agrega números que ya fijó el Core.
 */
export function sumAttentionCounts(overview) {
  const byCategory = Object.fromEntries(ATTENTION_CATEGORIES.map((category) => [category, 0]));
  let total = 0;
  const add = (attention) => {
    if (!attention || !Number.isFinite(attention.total)) return;
    total += attention.total;
    for (const category of ATTENTION_CATEGORIES) {
      const value = attention.by_category?.[category];
      if (Number.isFinite(value)) byCategory[category] += value;
    }
  };
  for (const project of overview?.projects ?? []) add(project.counts?.attention);
  add(overview?.unassigned?.attention);
  return { total, byCategory };
}

function AttentionItem({ item, interactive, tabIndex, itemRef, onFocus, onKeyDown, onOpenTarget }) {
  const metaId = useId();
  const summary = toSummary(item);
  const category = label(CATEGORY_LABELS, item.category);
  const severity = label(SEVERITY_LABELS, item.severity);
  const target = `${label(TARGET_LABELS, item.target_kind)} ${item.target_id}`;
  const content = (
    <>
      <span className={`attention-inbox__sev attention-inbox__sev--${item.severity}`} aria-hidden="true" />
      <span className="attention-inbox__body">
        <span className="attention-inbox__category" title={CATEGORY_HINTS[item.category]}>{category}</span>
        <span className="attention-inbox__meta" id={metaId}>
          <span>{severity}</span>
          <span aria-hidden="true">·</span>
          <span className="attention-inbox__target">{target}</span>
          <span aria-hidden="true">·</span>
          <span className="mono attention-inbox__id">{item.id}</span>
        </span>
        <span className="attention-inbox__context">
          <span>Project {item.project_id || 'sin Project'}</span>
          {item.run_id && <span>Run {item.run_id}</span>}
          <span>Ocurrencia {item.occurrence}</span>
        </span>
      </span>
    </>
  );
  const shared = {
    className: 'attention-inbox__item',
    'data-attention-id': item.id,
    'data-target-kind': item.target_kind,
    'data-target-id': item.target_id,
    'data-category': item.category,
    'data-severity': item.severity,
  };
  const accessibleName = `${severity}: ${category}. ${target}`;
  if (!interactive) {
    return (
      <li className="attention-inbox__row">
        <div {...shared} role="group" aria-label={accessibleName} aria-describedby={metaId}>
          {content}
        </div>
      </li>
    );
  }
  return (
    <li className="attention-inbox__row">
      <button
        {...shared}
        ref={itemRef}
        type="button"
        tabIndex={tabIndex}
        aria-label={accessibleName}
        aria-describedby={metaId}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={() => onOpenTarget(summary)}
      >
        {content}
      </button>
    </li>
  );
}

function QueryFailure({ status, error, retry }) {
  const title = status === 'disconnected' ? 'Core desconectado' : status === 'degraded' ? 'Core degradado' : 'Error de Core';
  return (
    <div className="attention-inbox__state attention-inbox__state--error" role="alert" data-testid="attention-error">
      <strong>{title}</strong>
      <span>{describeAttentionError(error)}</span>
      <code>{error || 'sin detalle'}</code>
      <button type="button" className="lk" onClick={retry}>Reintentar</button>
    </div>
  );
}

/**
 * Superficie F2 de Attention: lista global activa, solo lectura, servida por el Core (LXO-89).
 * No decide qué es Attention ni sus códigos: traduce los del contrato, conserva su orden y
 * agrega los contadores que publica projects_overview. No resuelve, no pospone y no marca leído.
 */
export function AttentionInbox({ active = true, pollMs, onOpenTarget, target = null, onClearTarget }) {
  const titleId = useId();
  const projectFilterId = useId();
  const categoryFilterId = useId();
  const severityFilterId = useId();
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  // El target (kind + id durable) lo filtra el Core; `seq` identifica cada apertura explícita, de modo que
  // un stale/reconnect conserva target y filtros y una apertura nueva parte sin filtros heredados.
  const targetKind = target?.kind || '';
  const targetId = target?.id || '';
  const targetKey = target ? `${target.seq ?? ''}\u0000${targetKind}\u0000${targetId}` : '';
  const [seenTargetKey, setSeenTargetKey] = useState(targetKey);
  if (seenTargetKey !== targetKey) {
    setSeenTargetKey(targetKey);
    if (targetKey) {
      setProjectId('');
      setCategory('');
      setSeverity('');
    }
  }
  const filterKey = `${projectId}\u0000${category}\u0000${severity}\u0000${targetKind}\u0000${targetId}`;
  const [pages, setPages] = useState(() => emptyPages(filterKey));
  const [recoveryNotice, setRecoveryNotice] = useState(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const itemRefs = useRef([]);
  const loadingMore = useRef(null);
  const pageGeneration = useRef(0);
  const pageContext = useRef({ key: filterKey, headData: null, readEpoch: 0 });

  const filters = useMemo(() => ({
    project_id: projectId || null,
    target_kind: targetKind || null,
    target_id: targetId || null,
    category: category || null,
    severity: severity || null,
    limit: ATTENTION_LIMIT,
  }), [projectId, targetKind, targetId, category, severity]);

  const list = useCoreQuery('attention_list', filters, { enabled: active, pollMs });
  const overview = useCoreQuery('projects_overview', { archived: 'include' }, { enabled: active, pollMs });

  // El sondeo predeterminado de 15 s actualiza solo la cabecera. Cada lectura correcta inicia una
  // navegación keyset nueva, aunque la cabecera sea idéntica (misma data/updatedAt): una página posterior
  // pudo cambiar sin alterar la cabecera, así que sus filas anexadas y su total ya no son exactos.
  // Core no ofrece una instantánea compartida entre páginas ni un change feed.
  useLayoutEffect(() => {
    if (pageContext.current.key === filterKey && pageContext.current.headData === list.data
      && pageContext.current.readEpoch === list.readEpoch) return;
    pageContext.current = { key: filterKey, headData: list.data, readEpoch: list.readEpoch };
    pageGeneration.current += 1;
    loadingMore.current = null;
    setPages(emptyPages(filterKey, list.data, list.readEpoch));
    setFocusIndex(0);
  }, [filterKey, list.data, list.readEpoch]);

  // Si el Core deja de responder, los cursores del proceso anterior dejan de ser válidos. Al volver,
  // se reinicia desde la primera página (contrato LXO-89) en vez de mezclar páginas de dos sesiones.
  // La cabecera retenida se conserva como contexto de esa primera página mientras dura el fallo; la
  // primera lectura correcta posterior avanza `readEpoch` y vuelve a reiniciar `pages` con la cabecera nueva.
  const headFailure = ['stale', 'disconnected', 'degraded', 'error'].includes(list.status);
  useLayoutEffect(() => {
    if (!headFailure) return;
    pageGeneration.current += 1;
    loadingMore.current = null;
    setPages((current) => emptyPages(current.key, list.data, list.readEpoch));
  }, [headFailure, list.data, list.readEpoch]);

  // Un aviso de cursor caducado pertenece a la consulta anterior: no se arrastra a otro filtro ni target.
  useLayoutEffect(() => {
    setRecoveryNotice(null);
  }, [filterKey]);

  // A head response is visible immediately; never render pages whose cursor came from an older head.
  const pageState = pages.key === filterKey && pages.headData === list.data && pages.headReadEpoch === list.readEpoch
    ? pages
    : EMPTY_PAGES;
  const items = useMemo(() => {
    const seen = new Map();
    for (const item of [...(list.data?.items ?? []), ...pageState.items]) {
      if (!seen.has(item.id)) seen.set(item.id, item);
    }
    return [...seen.values()].sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [list.data, pageState.items]);

  // Los contadores de projects_overview no están acotados a un target: con target activo no se muestran.
  const summed = useMemo(() => {
    if (!overview.data || targetKey) return null;
    if (!projectId) return sumAttentionCounts(overview.data);
    // Con un Project seleccionado se usan SUS contadores del Core, no una suma de la lista visible.
    const attention = overview.data.projects?.find((candidate) => candidate.id === projectId)?.counts?.attention;
    if (!attention) return null;
    return {
      total: Number.isFinite(attention.total) ? attention.total : 0,
      byCategory: Object.fromEntries(ATTENTION_CATEGORIES.map((categoryCode) => [
        categoryCode,
        Number.isFinite(attention.by_category?.[categoryCode]) ? attention.by_category[categoryCode] : 0,
      ])),
    };
  }, [overview.data, projectId, targetKey]);
  const projectOptions = overview.data?.projects ?? [];
  const hasFilters = Boolean(projectId || category || severity);
  const hasNarrowingFilters = Boolean(category || severity);
  const hasData = Boolean(list.data);

  const headCursor = list.data?.has_more ? list.data.next_cursor : null;
  const moreCursor = headFailure ? null : pageState.hasLoadedPage ? pageState.nextCursor : headCursor;
  const canLoadMore = !headFailure && (pageState.hasLoadedPage ? pageState.hasMore : Boolean(headCursor));

  // `projects_overview` no publica recuentos por severidad. Con ese filtro (o con un target), la cifra
  // sale de las filas que ya devolvió el Core: exacta si no quedan páginas ni la respuesta es stale,
  // «N+» en caso contrario (las páginas anexadas se descartan al refrescar o al perder la conexión).
  const pageTotal = hasData ? `${items.length}${canLoadMore || headFailure ? '+' : ''}` : '—';
  const usesPageTotal = Boolean(target) || Boolean(severity);
  const displayedTotal = summed ? (category ? summed.byCategory[category] : summed.total) : null;
  const totalValue = usesPageTotal ? pageTotal : summed ? displayedTotal : '—';
  const totalLabel = target
    ? (hasNarrowingFilters ? 'activas en este target con estos filtros' : 'activas en este target')
    : severity
      ? (category
        ? (projectId ? 'activas con estos filtros' : 'activas en esta categoría y severidad')
        : (projectId ? 'activas con esta severidad en el Project' : 'activas con esta severidad'))
      : category
        ? (projectId ? 'activas en esta categoría del Project' : 'activas en esta categoría')
        : (projectId ? 'activas en el Project' : 'activas en el overview');

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !moreCursor) return;
    const requestToken = {};
    loadingMore.current = requestToken;
    const requestedKey = filterKey;
    const requestedHead = list.data;
    const requestedHeadReadEpoch = list.readEpoch;
    const requestedGeneration = pageGeneration.current;
    setPages((current) => (current.key !== requestedKey || current.headData !== requestedHead
      || current.headReadEpoch !== requestedHeadReadEpoch ? current : {
        ...current,
        loading: true,
        error: null,
      }));
    try {
      const page = await listAdeAttention({
        projectId: projectId || null,
        targetKind: targetKind || null,
        targetId: targetId || null,
        category: category || null,
        severity: severity || null,
        cursor: moreCursor,
      });
      if (pageGeneration.current !== requestedGeneration) return;
      setPages((current) => (current.key !== requestedKey || current.headData !== requestedHead
        || current.headReadEpoch !== requestedHeadReadEpoch
        || pageGeneration.current !== requestedGeneration ? current : {
          ...current,
          items: [...current.items, ...page.items],
          nextCursor: page.next_cursor,
          hasMore: page.has_more,
          hasLoadedPage: true,
          loading: false,
          error: null,
        }));
    } catch (error) {
      if (pageGeneration.current !== requestedGeneration) return;
      const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
      if (/attention_invalid_cursor/.test(message)) {
        // El Core rotó su clave (reinicio): se vuelve a la primera página, sin duplicar.
        setRecoveryNotice('El Core se reinició y el cursor caducó: se volvió a la primera página.');
        setPages((current) => (current.key !== requestedKey || current.headData !== requestedHead
          || current.headReadEpoch !== requestedHeadReadEpoch
          || pageGeneration.current !== requestedGeneration ? current : {
            ...emptyPages(requestedKey, requestedHead, requestedHeadReadEpoch),
          }));
        list.retry();
      } else {
        setPages((current) => (current.key !== requestedKey || current.headData !== requestedHead
          || current.headReadEpoch !== requestedHeadReadEpoch
          || pageGeneration.current !== requestedGeneration ? current : { ...current, loading: false, error: message }));
      }
    } finally {
      if (loadingMore.current === requestToken) loadingMore.current = null;
    }
  }, [moreCursor, projectId, targetKind, targetId, category, severity, filterKey, list.data, list.readEpoch, list.retry]);

  const onItemKeyDown = useCallback((event, index) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    setFocusIndex(next);
    itemRefs.current[next]?.focus();
  }, [items.length]);

  const clearFilters = () => {
    setProjectId('');
    setCategory('');
    setSeverity('');
  };

  const showInitialLoading = list.status === 'loading' && !hasData;
  const showFailure = !hasData && ['disconnected', 'degraded', 'error'].includes(list.status);
  const showEmpty = hasData && items.length === 0 && !showInitialLoading && !showFailure;
  const targetName = target ? `${label(TARGET_LABELS, target.kind)} ${target.id}` : '';
  const interactive = typeof onOpenTarget === 'function';
  const activeIndex = Math.min(focusIndex, Math.max(items.length - 1, 0));

  return (
    <section
      className={`attention-inbox${active ? '' : ' is-hidden'}`}
      aria-labelledby={titleId}
      aria-hidden={!active}
      aria-busy={showInitialLoading || pageState.loading ? 'true' : 'false'}
      inert={!active}
      data-testid="attention-inbox"
    >
      <header className="attention-inbox__head">
        <div className="attention-inbox__heading">
          <h2 id={titleId} className="attention-inbox__title">Attention</h2>
          <p className="attention-inbox__subtitle">Lo que necesita de ti ahora, según el Core. Solo lectura.</p>
        </div>
        <div
          className="attention-inbox__total"
          title={target
            ? (hasNarrowingFilters
              ? 'Attention activa de este target con los filtros aplicados, según la página que devolvió el Core; «+» indica que hay más'
              : 'Attention activa de este target, según la página que devolvió el Core; «+» indica que hay más')
            : severity
              ? 'La página que devolvió el Core; «+» indica que hay más. El overview no cuenta por severidad'
              : projectId
                ? 'counts.attention del Project seleccionado (projects_overview)'
                : 'Suma de counts.attention de projects_overview (Projects y sin Project)'}
        >
          <span className="attention-inbox__total-value" data-testid="attention-total">
            {totalValue}
          </span>
          <span className="attention-inbox__total-label">{totalLabel}</span>
        </div>
      </header>

      <div className="attention-inbox__filters" role="group" aria-label="Filtros de Attention">
        <label className="attention-inbox__filter" htmlFor={projectFilterId}>
          <span>Project</span>
          <select
            id={projectFilterId}
            className="attention-inbox__select"
            value={projectId}
            disabled={projectOptions.length === 0}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Todos</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {Number.isFinite(project.counts?.attention?.total) ? ` · ${project.counts.attention.total}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="attention-inbox__filter" htmlFor={categoryFilterId}>
          <span>Categoría</span>
          <select
            id={categoryFilterId}
            className="attention-inbox__select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">Todas</option>
            {ATTENTION_CATEGORIES.map((code) => (
              <option key={code} value={code}>
                {label(CATEGORY_LABELS, code)}
                {summed && !severity ? ` (${summed.byCategory[code]})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="attention-inbox__filter" htmlFor={severityFilterId}>
          <span>Severidad</span>
          <select
            id={severityFilterId}
            className="attention-inbox__select"
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
          >
            <option value="">Todas</option>
            {ATTENTION_SEVERITIES.map((code) => (
              <option key={code} value={code}>{label(SEVERITY_LABELS, code)}</option>
            ))}
          </select>
        </label>

        <button type="button" className="lk attention-inbox__clear" onClick={clearFilters} disabled={!hasFilters}>
          Limpiar filtros
        </button>
      </div>

      {target && (
        <div className="attention-inbox__target-filter" role="group" aria-label="Filtro por target">
          <span>
            Filtrando por <strong>{targetName}</strong>
            {target.projectId && <> · Project <span className="mono">{target.projectId}</span></>}
          </span>
          {typeof onClearTarget === 'function' && (
            <button type="button" className="lk" onClick={onClearTarget} aria-label={`Quitar el filtro por ${targetName}`}>
              Quitar filtro
            </button>
          )}
        </div>
      )}

      {!target && overview.status === 'stale' && (
        <div className="attention-inbox__state attention-inbox__state--stale" role="status">
          Los conteos del Core están desactualizados ({connectionLabel(overview.reason)}). Se conserva la última respuesta.
        </div>
      )}
      {!target && !overview.data && ['disconnected', 'degraded', 'error'].includes(overview.status) && (
        <div className="attention-inbox__state attention-inbox__state--muted" role="status" data-testid="attention-counts-unavailable">
          Los conteos y el filtro por Project no están disponibles: {describeAttentionError(overview.error)}
        </div>
      )}

      {showInitialLoading && (
        <div className="attention-inbox__state" role="status" data-testid="attention-loading">Cargando Attention activa desde el Core…</div>
      )}

      {showFailure && <QueryFailure status={list.status} error={list.error} retry={list.retry} />}

      {list.status === 'stale' && (
        <div className="attention-inbox__state attention-inbox__state--stale" role="status" data-testid="attention-stale">
          <span>
            Attention desactualizada: Core {connectionLabel(list.reason)}. Se conserva la última respuesta.
            {' '}{describeAttentionError(list.error)}
          </span>
          <code>{list.error}</code>
          <button type="button" className="lk" onClick={list.retry}>Reintentar</button>
        </div>
      )}

      {recoveryNotice && (
        <div className="attention-inbox__state attention-inbox__state--muted" role="status">
          <span>{recoveryNotice}</span>
          <button type="button" className="lk" onClick={() => setRecoveryNotice(null)}>Cerrar aviso</button>
        </div>
      )}

      {showEmpty && (
        <div className="attention-inbox__empty" role="status" data-testid="attention-empty">
          {hasFilters || target
            ? 'No hay Attention activa con estos filtros. Ajusta o limpia los filtros.'
            : 'El Core no tiene Attention activa: no hay pendientes que requieran tu intervención.'}
        </div>
      )}

      {items.length > 0 && (
        <ul
          className="attention-inbox__list"
          aria-label="Attention activa"
          aria-busy={pageState.loading || list.status === 'refreshing'}
        >
          {items.map((item, index) => (
            <AttentionItem
              key={item.id}
              item={item}
              interactive={interactive}
              tabIndex={index === activeIndex ? 0 : -1}
              itemRef={(node) => { itemRefs.current[index] = node; }}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => onItemKeyDown(event, index)}
              onOpenTarget={onOpenTarget}
            />
          ))}
        </ul>
      )}

      {canLoadMore && (
        <button
          type="button"
          className="lk attention-inbox__more"
          onClick={loadMore}
          disabled={pageState.loading}
          aria-busy={pageState.loading}
        >
          {pageState.loading ? 'Cargando…' : 'Cargar más'}
        </button>
      )}

      {pageState.error && (
        <div className="attention-inbox__state attention-inbox__state--error" role="alert">
          <span>No se pudo cargar la siguiente página de Attention. {describeAttentionError(pageState.error)}</span>
          <code>{pageState.error}</code>
          <button type="button" className="lk" onClick={loadMore}>Reintentar</button>
        </div>
      )}

      <p className="attention-inbox__note">
        Solo lectura: las filas se resuelven con el Command de su dominio (responder, aprobar, revisar…).
        Esta vista no resuelve, no pospone y no marca como leído.
      </p>
      <span className="attention-inbox__sr" role="status" aria-live="polite">
        {target
          ? (hasData && totalValue !== '—'
            ? `${totalValue} Attention activas en ${targetName}${hasNarrowingFilters ? ' con los filtros aplicados' : ''}.`
            : '')
          : hasData && totalValue !== '—' ? `${totalValue} Attention ${totalLabel}.` : ''}
      </span>
    </section>
  );
}
