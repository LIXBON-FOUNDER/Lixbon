// ActivityTimeline.jsx — vista Activity de solo lectura (rodaja LXO-99, SOLO fixtures).
//
// PARCIAL: en master no existe la query Activity ni la proyección de LXO-92. Este
// componente no lee el Event Log, no llama al Core y no acepta payloads crudos:
// pinta una lista ya normalizada por la proyección cuando exista. No es la
// aceptación de LXO-99 ni implica que la vista esté conectada.
//
// Frontera provisional de ActivityItem (alineada con docs/core/EVENTOS.md):
//
// @typedef {'state'|'effect'|'decision'|'system'} ActivityClass
// @typedef {'person'|'agent'|'system'} ActivityActorKind
// @typedef {'ui'|'lxo'|'core'} ActivityChannel
// @typedef {'project'|'task'|'run'|'spawn_request'|'attention'|'agent'|'core'} ActivityTargetKind
// @typedef {'info'|'success'|'warning'|'danger'} ActivitySeverity
//
// @typedef {Object} ActivityItem
// @property {string} eventId    events.id (UUID v7): identidad estable. Es la clave de render y lo que
//                               sobrevive a un reemplazo por reconexión; nunca se usa el índice de la lista.
// @property {number} seq        events.seq: orden autoritativo y único cursor. Entero positivo. Se muestra
//                               como procedencia; la vista NO reordena por él.
// @property {number} timestamp  events.ts en ms epoch. Informativo: se muestra, NUNCA ordena.
// @property {ActivityClass} class  Clase del hecho. decision y effect se pintan como filas distintas.
// @property {string} [kind]     kind del evento (1..64). Solo trazabilidad y fallback de desconocidos;
//                               jamás se traduce a una frase humana.
// @property {{kind: ActivityTargetKind, id: string}} target  Referencia durable (id), no ruta ni nombre.
// @property {{id: string, name?: string}|null} [project]     Proyecto del hecho; el id es la identidad.
// @property {{kind: ActivityActorKind, id: string|null}} actor  Quién lo provocó. Un agente lleva su Task.
// @property {{channel: ActivityChannel, clientId: string|null}} [client]  Transporte, no identidad.
// @property {{key: string, text?: string|null, params?: Object}|null} [message]
//                               Texto humano o clave provistos por Core / la proyección. El componente
//                               no deriva texto de `kind` ni resume con IA.
// @property {boolean} [known]   false = la proyección no reconoce el kind; se usa el fallback.
// @property {ActivitySeverity|null} [severity]  Opcional; solo presentación.
// @property {Array<{label: string, value: string|number|boolean}>} [metadata]
//                               Pares planos EXPLÍCITAMENTE seguros (máx. 8). Objetos, arrays y claves
//                               sensibles se descartan; no es el payload crudo del evento.
// @property {string} [correlationId]  Une hechos (p. ej. decisión y efecto); se muestra, no se fusiona.
//
// Prohibido por contrato: `payload` crudo, `summary`/resúmenes de IA, `unread`/Attention y fusionar
// decision/effect en una sola fila. La vista es de solo lectura y no escribe en el Core.

import { useId, useMemo } from 'react';
import './ActivityTimeline.css';

const CLASS_LABELS = {
  state: 'Estado',
  decision: 'Decisión',
  effect: 'Efecto',
  system: 'Sistema',
};

const TARGET_LABELS = {
  project: 'Proyecto',
  task: 'Tarea',
  run: 'Run',
  spawn_request: 'Lanzamiento',
  agent: 'Agente',
  core: 'Core',
  // `attention` se acepta como referencia opaca, pero esta vista no rotula ni expone
  // unread / el estado de Attention: eso pertenece a LXO-100, no a Activity.
};

const ACTOR_LABELS = {
  person: 'Persona',
  agent: 'Agente',
  system: 'Sistema',
};

const CHANNEL_LABELS = {
  ui: 'UI',
  lxo: 'CLI',
  core: 'Core',
};

const SEVERITY_LABELS = {
  info: 'Info',
  success: 'Correcto',
  warning: 'Aviso',
  danger: 'Error',
};

const STATUSES = new Set(['loading', 'ready', 'error', 'degraded']);
const CLASS_KEYS = new Set(Object.keys(CLASS_LABELS));
const SEVERITY_KEYS = new Set(Object.keys(SEVERITY_LABELS));

const MAX_METADATA = 8;
const MAX_METADATA_LABEL = 40;
const MAX_METADATA_VALUE = 120;

// Filtra familias de campos que pueden contener credenciales, payload crudo o estado de Attention.
// Se conserva una política por familias (en vez de una allowlist) para no ocultar metadatos inocuos.
const BLOCKED_METADATA_WORDS = new Set([
  'unread',
  'attention',
  'atencion',
  'read',
  'seen',
  'payload',
  'raw',
  'argv',
  'env',
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'auth',
  'authentication',
  'cookie',
  'credential',
  'credentials',
  'bearer',
  'jwt',
  'session',
  'proto',
  'prototype',
  'constructor',
]);

const BLOCKED_METADATA_KEY_PREFIXES = new Set([
  'api',
  'private',
  'client',
  'session',
  'signing',
  'encryption',
  'ssh',
]);

const BLOCKED_METADATA_COMPACT_PATTERNS = [
  /^(?:(?:access|refresh|id|auth|api|client|session|private|signing|encryption|ssh)?(?:token|secret|password|passwd|passphrase|credential|authorization|cookie|bearer|jwt))$/,
  /^(?:api|private|client|session|signing|encryption|ssh)key$/,
  /^(?:(?:is|has|was|last|mark|marked)?read(?:at|by|count|status|time|timestamp)?)$/,
  /unread|attention|atencion/,
];

const TIME_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const TIME_TITLE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'long',
  timeStyle: 'medium',
});

function scopeTitle(scope) {
  if (scope.kind === 'project') return `Proyecto · ${scope.name || scope.id}`;
  if (scope.kind === 'task') return `Tarea · ${scope.title || scope.id}`;
  return 'Actividad global';
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || !['global', 'project', 'task'].includes(scope.kind)) {
    return { kind: 'global' };
  }
  if (scope.kind === 'global') return { kind: 'global' };
  if (typeof scope.id !== 'string' || !scope.id.trim()) return { kind: 'global' };
  if (scope.kind === 'project' && typeof scope.name === 'string' && scope.name.trim()) {
    return { kind: 'project', id: scope.id.trim(), name: scope.name.trim() };
  }
  if (scope.kind === 'task' && typeof scope.title === 'string' && scope.title.trim()) {
    return { kind: 'task', id: scope.id.trim(), title: scope.title.trim() };
  }
  return { kind: scope.kind, id: scope.id.trim() };
}

function eventIdOf(item) {
  return typeof item?.eventId === 'string' ? item.eventId.trim() : '';
}

function blockedMetadataKey(label) {
  const normalized = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = words.join('');

  if (words.some((word) => BLOCKED_METADATA_WORDS.has(word))) return true;
  if (words.includes('sin') && words.includes('leer')) return true;
  if (
    words.includes('key') &&
    words.some((word) => BLOCKED_METADATA_KEY_PREFIXES.has(word))
  ) {
    return true;
  }
  return BLOCKED_METADATA_COMPACT_PATTERNS.some((pattern) => pattern.test(compact));
}

// Conserva el orden que entrega Core. Solo valida procedencia y elimina repeticiones por eventId:
// una reconexión puede reenviar la misma página y React debe reutilizar la fila, no duplicarla.
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const eventId = eventIdOf(item);
    if (!eventId || eventId.length > 200 || seen.has(eventId)) continue;
    if (!Number.isSafeInteger(item.seq) || item.seq < 1) continue;
    seen.add(eventId);
    out.push(item);
  }
  return out;
}

function sanitizeMetadata(metadata) {
  if (!Array.isArray(metadata)) return [];
  const out = [];
  for (const entry of metadata) {
    if (out.length >= MAX_METADATA) break;
    if (!entry || typeof entry !== 'object') continue;
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label || label.length > MAX_METADATA_LABEL || blockedMetadataKey(label)) continue;
    const raw = entry.value;
    const type = typeof raw;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    if (type === 'number' && !Number.isFinite(raw)) continue;
    let value = type === 'string' ? raw.trim() : raw;
    if (type === 'string' && !value) continue;
    if (type === 'string' && value.length > MAX_METADATA_VALUE) {
      value = `${value.slice(0, MAX_METADATA_VALUE - 1)}…`;
    }
    out.push({ label, value });
  }
  return out;
}

function timeInfo(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return { iso: undefined, label: '—', title: 'Hora no disponible' };
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return { iso: undefined, label: '—', title: 'Hora no disponible' };
  }
  return {
    iso: date.toISOString(),
    label: TIME_FORMAT.format(date),
    title: `${TIME_TITLE_FORMAT.format(date)} · hora del Core (no ordena)`,
  };
}

function resolveMessage(item, translateMessage) {
  if (item.known === false) return null;
  const message = item.message && typeof item.message === 'object' ? item.message : null;
  if (!message) return null;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text) return text;
  const key = typeof message.key === 'string' ? message.key.trim() : '';
  if (!key || typeof translateMessage !== 'function') return null;
  try {
    const params = message.params && typeof message.params === 'object' ? message.params : undefined;
    const translated = translateMessage(key, params);
    return typeof translated === 'string' && translated.trim() ? translated.trim() : null;
  } catch {
    // Un catálogo roto no puede romper la vista ni inventar texto.
    return null;
  }
}

function messageKeyOf(item) {
  if (item.known === false) return null;
  const message = item.message && typeof item.message === 'object' ? item.message : null;
  return message && typeof message.key === 'string' && message.key.trim() ? message.key.trim() : null;
}

function targetOf(item) {
  const target = item.target;
  if (!target || typeof target !== 'object') return null;
  if (typeof target.id !== 'string' || !target.id.trim()) return null;
  return {
    kind: typeof target.kind === 'string' ? target.kind.trim() : '',
    id: target.id.trim(),
  };
}

function projectOf(item) {
  const project = item.project;
  if (!project || typeof project !== 'object') return null;
  if (typeof project.id !== 'string' || !project.id.trim()) return null;
  return {
    id: project.id.trim(),
    name: typeof project.name === 'string' ? project.name.trim() : '',
  };
}

function actorOf(item) {
  if (!item.actor || typeof item.actor !== 'object') return null;
  const kind = ACTOR_LABELS[item.actor.kind] ? item.actor.kind : '';
  const id = typeof item.actor.id === 'string' ? item.actor.id.trim() : '';
  return kind || id ? { kind, id } : null;
}

function clientOf(item) {
  if (!item.client || typeof item.client !== 'object') return null;
  const channel = typeof item.client.channel === 'string' ? item.client.channel.trim() : '';
  const clientId = typeof item.client.clientId === 'string' ? item.client.clientId.trim() : '';
  return channel || clientId ? { channel, clientId } : null;
}

function correlationOf(item) {
  return typeof item.correlationId === 'string' && item.correlationId.trim()
    ? item.correlationId.trim().slice(0, 128)
    : '';
}

function errorOf(error) {
  if (typeof error === 'string') return { message: error.trim(), code: '' };
  if (!error || typeof error !== 'object') return { message: '', code: '' };
  return {
    message: typeof error.message === 'string' ? error.message.trim() : '',
    code: typeof error.code === 'string' ? error.code.trim() : '',
  };
}

export function ActivityTimeline({
  items = [],
  scope = { kind: 'global' },
  status = 'ready',
  stale = false,
  error = null,
  cursor = null,
  loadingMore = false,
  onLoadMore,
  onRefresh,
  onRetry,
  translateMessage,
  className = '',
}) {
  const headingId = useId();
  const safeScope = normalizeScope(scope);
  const safeItems = useMemo(() => normalizeItems(items), [items]);
  const viewStatus = STATUSES.has(status) ? status : 'error';
  const busy = viewStatus === 'loading' || (viewStatus === 'ready' && loadingMore === true);
  const showCachedRows =
    viewStatus === 'ready' || (viewStatus === 'loading' && stale === true);
  const showStale = (viewStatus === 'ready' || viewStatus === 'loading') && stale === true;
  const nextCursor =
    cursor && typeof cursor === 'object' && Number.isSafeInteger(cursor.next) && cursor.next >= 0
      ? cursor.next
      : null;
  const hasMore = Boolean(cursor && typeof cursor === 'object' && cursor.hasMore === true);
  const canLoadMore =
    viewStatus === 'ready' &&
    nextCursor !== null &&
    hasMore &&
    typeof onLoadMore === 'function';
  const showEnd = Boolean(
    viewStatus === 'ready' && cursor && typeof cursor === 'object' && cursor.hasMore === false,
  );
  const showFooter = viewStatus === 'ready' && safeItems.length > 0 && (canLoadMore || showEnd);
  const displayCount = showCachedRows ? safeItems.length : 0;
  const scopeName = scopeTitle(safeScope);
  const normalizedError = errorOf(error);
  const emptyHint =
    safeScope.kind === 'project'
      ? 'No hay hechos registrados para este proyecto.'
      : safeScope.kind === 'task'
        ? 'No hay hechos registrados para esta tarea.'
        : 'No hay hechos registrados todavía.';

  return (
    <section
      className={['activity', className].filter(Boolean).join(' ')}
      data-testid="activity-timeline"
      data-scope-kind={safeScope.kind}
      data-status={viewStatus}
      aria-labelledby={headingId}
      aria-busy={busy ? 'true' : 'false'}
    >
      <header className="activity__head">
        <div className="activity__heading">
          <h2 className="activity__title" id={headingId}>
            {scopeName}
          </h2>
          {safeScope.kind !== 'global' ? (
            <span className="activity__scope-id mono" data-testid="activity-scope-id">
              {safeScope.id}
            </span>
          ) : null}
        </div>
        <div className="activity__head-meta">
          <span
            className="activity__count mono"
            data-testid="activity-count"
            aria-label={`${displayCount} eventos cargados`}
          >
            {displayCount}
          </span>
          <span className="activity__readonly" title="La vista no escribe en el Core">
            Solo lectura
          </span>
        </div>
      </header>

      {showStale ? (
        <div className="activity__notice" role="status" data-testid="activity-stale">
          <span>Vista desactualizada. Puede faltar actividad reciente.</span>
          {typeof onRefresh === 'function' ? (
            <button
              type="button"
              className="activity__action"
              data-testid="activity-refresh"
              onClick={() => onRefresh({ scope: safeScope })}
            >
              Actualizar
            </button>
          ) : null}
        </div>
      ) : null}

      {viewStatus === 'loading' ? (
        <div className="activity__state" role="status" data-testid="activity-loading">
          <span>Cargando actividad…</span>
          <div className="activity__skeletons" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className="activity__skeleton skeleton" />
            ))}
          </div>
        </div>
      ) : null}

      {viewStatus === 'error' ? (
        <div className="activity__state activity__state--error" role="alert" data-testid="activity-error">
          <strong>No se pudo cargar la actividad.</strong>
          <p>{normalizedError.message || 'El Core no devolvió actividad.'}</p>
          {normalizedError.code ? <code className="activity__code">{normalizedError.code}</code> : null}
          {typeof onRetry === 'function' ? (
            <button
              type="button"
              className="activity__action"
              data-testid="activity-retry"
              onClick={() => onRetry({ scope: safeScope })}
            >
              Reintentar
            </button>
          ) : null}
        </div>
      ) : null}

      {viewStatus === 'degraded' ? (
        <div className="activity__state" role="status" data-testid="activity-degraded">
          <strong>El registro de actividad no está disponible.</strong>
          <p>Este Core funciona en modo degradado (sin Event Log), así que no hay hechos que mostrar.</p>
          {typeof onRefresh === 'function' ? (
            <button
              type="button"
              className="activity__action"
              data-testid="activity-refresh"
              onClick={() => onRefresh({ scope: safeScope })}
            >
              Actualizar
            </button>
          ) : null}
        </div>
      ) : null}

      {viewStatus === 'ready' && safeItems.length === 0 ? (
        <div className="activity__state" role="status" data-testid="activity-empty">
          <strong>Sin actividad todavía.</strong>
          <p>{emptyHint}</p>
        </div>
      ) : null}

      {showCachedRows && safeItems.length > 0 ? (
        <ol className="activity__list" data-testid="activity-list">
          {safeItems.map((item) => {
            const eventId = eventIdOf(item);
            const unknown = item.known === false;
            const text = resolveMessage(item, translateMessage);
            const messageKey = messageKeyOf(item);
            const kind = typeof item.kind === 'string' ? item.kind.trim().slice(0, 64) : '';
            const classKey = CLASS_KEYS.has(item.class) ? item.class : 'unknown';
            const severity = SEVERITY_KEYS.has(item.severity) ? item.severity : null;
            const target = targetOf(item);
            const project = projectOf(item);
            const actor = actorOf(item);
            const client = clientOf(item);
            const correlationId = correlationOf(item);
            const meta = sanitizeMetadata(item.metadata);
            const time = timeInfo(item.timestamp);
            const showProject =
              project && !(target && target.kind === 'project' && target.id === project.id);

            return (
              <li
                key={eventId}
                className={[
                  'activity__item',
                  `activity__item--class-${classKey}`,
                  severity ? `activity__item--severity-${severity}` : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={`activity-${eventId}`}
                data-event-id={eventId}
                data-seq={item.seq}
                data-kind={kind || undefined}
                data-class={classKey}
                data-severity={severity || undefined}
                title={`evento ${eventId} · seq ${item.seq}`}
              >
                <span className="activity__spine" aria-hidden="true" />
                <div className="activity__body">
                  <div className="activity__top">
                    <span className={`activity__class activity__class--${classKey}`}>
                      {CLASS_LABELS[classKey] || 'Sin clase'}
                    </span>
                    {severity ? (
                      <span className={`activity__severity activity__severity--${severity}`}>
                        {SEVERITY_LABELS[severity]}
                      </span>
                    ) : null}
                    <p
                      className={[
                        'activity__message',
                        text ? '' : 'activity__message--fallback',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-testid={`activity-message-${eventId}`}
                      data-message-key={messageKey || undefined}
                    >
                      {text || (unknown ? 'Evento desconocido' : 'Actividad sin descripción')}
                    </p>
                  </div>

                  <div className="activity__meta">
                    <span
                      className="activity__seq mono"
                      title={`evento ${eventId} · seq ${item.seq}`}
                    >
                      #{item.seq}
                    </span>
                    <time className="activity__time mono" dateTime={time.iso} title={time.title}>
                      {time.label}
                    </time>
                    {target ? (
                      <span className="activity__target" data-testid={`activity-target-${eventId}`}>
                        {TARGET_LABELS[target.kind] || 'Destino'}{' '}
                        <span className="mono" title={target.id}>
                          {target.id}
                        </span>
                      </span>
                    ) : (
                      <span className="activity__target activity__target--missing">Sin destino</span>
                    )}
                    {showProject ? (
                      <span className="activity__project" data-testid={`activity-project-${eventId}`}>
                        Proyecto <span className="mono">{project.id}</span>
                        {project.name ? (
                          <span className="activity__project-name"> · {project.name}</span>
                        ) : null}
                      </span>
                    ) : null}
                    {actor ? (
                      <span className="activity__actor" data-testid={`activity-actor-${eventId}`}>
                        {actor.kind ? ACTOR_LABELS[actor.kind] : 'Actor'}
                        {actor.id ? (
                          <>
                            {' · '}
                            <span className="mono">{actor.id}</span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                    {client ? (
                      <span className="activity__client" data-testid={`activity-client-${eventId}`}>
                        {CHANNEL_LABELS[client.channel] || client.channel}
                        {client.clientId ? (
                          <>
                            {' · '}
                            <span className="mono">{client.clientId}</span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                    {correlationId ? (
                      <span className="activity__corr" data-testid={`activity-correlation-${eventId}`}>
                        correlación <span className="mono">{correlationId}</span>
                      </span>
                    ) : null}
                    {unknown ? (
                      <span className="activity__kind" data-testid={`activity-kind-${eventId}`}>
                        tipo <span className="mono">{kind || 'desconocido'}</span>
                      </span>
                    ) : null}
                  </div>

                  {meta.length > 0 ? (
                    <dl className="activity__metadata">
                      {meta.map((entry, index) => (
                        <div
                          className="activity__meta-pair"
                          key={`${entry.label}-${index}`}
                          data-testid={`activity-meta-${index}`}
                        >
                          <dt className="activity__meta-label">{entry.label}</dt>
                          <dd className="activity__meta-value mono">{String(entry.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {showFooter ? (
        <footer className="activity__footer">
          {canLoadMore ? (
            <button
              type="button"
              className="activity__more"
              data-testid="activity-load-more"
              disabled={loadingMore === true}
              onClick={() => onLoadMore({ cursor: nextCursor, scope: safeScope })}
            >
              {loadingMore === true ? 'Cargando…' : 'Cargar más actividad'}
            </button>
          ) : null}
          {showEnd ? <span className="activity__end">No hay más actividad.</span> : null}
        </footer>
      ) : null}
    </section>
  );
}
