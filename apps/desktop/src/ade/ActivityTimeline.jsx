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
// @property {string|number} seq events.seq: i64 decimal canónico (o entero JS seguro en fixtures).
//                               Se muestra sin convertir a Number; la vista NO reordena por él.
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
//                               Pares planos EXPLÍCITAMENTE seguros (máx. 8). La etiqueta debe
//                               pertenecer a una allowlist de familias técnicas y el valor debe ser
//                               primitivo y no parecer una credencial; claves desconocidas, anidadas
//                               o sensibles se descartan. No es el payload crudo del evento.
// @property {string} [correlationId]  Une hechos (p. ej. decisión y efecto); se muestra, no se fusiona.
//
// Navegación: `onOpenTarget({kind, id, projectId})` recibe el target durable exacto y el Project
// durable del hecho (para `project`, es el mismo ID del target). Sin callback, o con otro kind / id
// mal formado, el destino se pinta como texto informativo. La vista solo avisa al host; no navega ni escribe.
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
const ACTIVITY_I64_MAX = 9_223_372_036_854_775_807n;

function canonicalActivityI64(value, positive = false) {
  let parsed;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && value.length <= 19 && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    return null;
  }
  if (parsed < (positive ? 1n : 0n) || parsed > ACTIVITY_I64_MAX) return null;
  return parsed.toString();
}

// Allowlist de palabras que pueden componer una etiqueta de metadata. Una etiqueta solo
// se acepta si TODAS sus palabras normalizadas están aquí: una clave desconocida
// (`custom`, `html`, `body`), anidada (`auth.session.secret`, `context.access_key`) o de
// una familia sensible (`access_key`, `secretkey`, `jwttoken`, `passwordhash`, `sinleer`)
// se descarta sin depender de coincidencias exactas o de fragmentos frágiles.
const SAFE_METADATA_WORDS = new Set([
  // Procedencia y clasificación
  'actor', 'agent', 'agente', 'person', 'persona', 'system', 'sistema',
  'model', 'modelo', 'provider', 'proveedor', 'client', 'cliente', 'core',
  'channel', 'canal', 'transport', 'transporte',
  'event', 'evento', 'kind', 'tipo', 'type', 'class', 'clase',
  'status', 'estado', 'state', 'severity', 'severidad', 'level',
  'source', 'origen', 'origin', 'schema', 'esquema', 'contract', 'contrato', 'version',
  // Referencias durables
  'target', 'destino', 'destination', 'entity', 'entidad', 'correlation',
  'project', 'proyecto', 'task', 'tarea', 'run', 'spawn',
  // Métricas y conteos
  'count', 'cuenta', 'total', 'number', 'numero', 'num',
  'retry', 'retries', 'reintento', 'reintentos',
  'attempt', 'attempts', 'intento', 'intentos',
  'duration', 'duracion', 'latency', 'latencia',
  'ms', 'millisecond', 'milliseconds', 'milisegundo', 'milisegundos',
  'second', 'seconds', 'segundo', 'segundos', 'elapsed',
  'size', 'tamano', 'byte', 'bytes', 'kb', 'mb', 'gb',
  'rows', 'filas', 'items', 'elementos', 'depth', 'profundidad',
  'priority', 'prioridad', 'step', 'paso', 'phase', 'fase',
  'queue', 'cola', 'port', 'puerto', 'method', 'metodo',
  'mode', 'modo', 'result', 'resultado', 'outcome', 'desenlace',
  'code', 'codigo', 'exit', 'salida', 'signal', 'senal',
  'start', 'end', 'started', 'finished', 'line', 'column',
  'sha', 'commit', 'branch', 'tag',
  // Identidad y tiempo
  'id', 'ids', 'name', 'nombre', 'label', 'etiqueta', 'ref', 'referencia',
  'seq', 'sequence', 'secuencia', 'index', 'indice',
  'timestamp', 'ts', 'time', 'hora', 'fecha',
  // Plataforma
  'http', 'https', 'rpc', 'grpc', 'sse', 'api',
  'host', 'hostname', 'node', 'nodo', 'worker', 'thread', 'hilo',
  'readiness', 'ready', 'health', 'salud',
  'protocol', 'protocolo', 'encoding', 'codificacion',
]);

// Una etiqueta con separadores estructurales representa una ruta anidada, no un par plano.
const NESTED_METADATA_LABEL = /[./\\:\[\]{}?#&=]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Defensa en profundidad: aunque una etiqueta sea inocua, un valor con forma de
// credencial o de estado de lectura no se publica.
const SECRET_VALUE_SUBSTRINGS =
  /(?:token|secret|secreto|password|passwd|pwd|passphrase|contrasena|credencial|credenciales|autorizacion|sesion|clave|bearer|jwt|cookie|credential|authorization|unread|attention|atencion|sin[ _-]?leer|access[ _-]?key|api[ _-]?key|private[ _-]?key|client[ _-]?secret)/i;

// `read`/`seen` como palabra completa, no como fragmento: `readiness` o `thread` siguen siendo seguros.
const READ_STATE_VALUE =
  /(?:^|[^a-z0-9])(?:read|seen|visto|vista|vistos|vistas|leido|leida|leidos|leidas)(?:$|[^a-z0-9])/i;

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:sk|rk)[-_](?:live|test)[-_][A-Za-z0-9_-]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
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

function metadataWords(label) {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSafeMetadataLabel(label) {
  if (typeof label !== 'string') return false;
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > MAX_METADATA_LABEL) return false;
  if (CONTROL_CHARS.test(trimmed) || NESTED_METADATA_LABEL.test(trimmed)) return false;
  const words = metadataWords(trimmed);
  if (words.length === 0) return false;
  if (!words.some((word) => SAFE_METADATA_WORDS.has(word))) return false;
  return words.every(
    (word) => SAFE_METADATA_WORDS.has(word) || /^[0-9]+$/.test(word),
  );
}

function isSafeMetadataValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const probe = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
  if (SECRET_VALUE_SUBSTRINGS.test(probe) || READ_STATE_VALUE.test(probe)) return false;
  return !SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(probe));
}

function activityCountLabel(count) {
  return count === 1 ? '1 evento cargado' : `${count} eventos cargados`;
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
    const seq = canonicalActivityI64(item.seq, true);
    if (seq === null) continue;
    seen.add(eventId);
    out.push(item.seq === seq ? item : { ...item, seq });
  }
  return out;
}

function sanitizeMetadata(metadata) {
  if (!Array.isArray(metadata)) return [];
  const out = [];
  for (const entry of metadata) {
    if (out.length >= MAX_METADATA) break;
    if (!entry || typeof entry !== 'object') continue;
    try {
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      if (!isSafeMetadataLabel(label)) continue;
      const raw = entry.value;
      if (!isSafeMetadataValue(raw)) continue;
      let value = typeof raw === 'string' ? raw.trim() : raw;
      if (typeof value === 'string' && value.length > MAX_METADATA_VALUE) {
        value = `${value.slice(0, MAX_METADATA_VALUE - 1)}…`;
      }
      out.push({ label, value });
    } catch {
      // Un objeto hostil no puede romper la vista ni colarse como metadata.
    }
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

// Solo se navega a entidades que la vista ya conoce como alcance (Project / Task). `run`,
// `spawn_request`, `agent`, `core` y `attention` siguen siendo referencias informativas: abrirlas
// pertenece a otras rodajas (Attempt/F3, Attention) y aquí no se inventa esa navegación.
const NAVIGABLE_TARGET_KINDS = new Set(['project', 'task']);
const MAX_TARGET_ID = 200;

// Devuelve la referencia durable EXACTA (kind + id sin tocar) o null. Un kind o id con espacios
// sobrantes, vacío, con caracteres de control o demasiado largo se considera mal formado: no se
// «arregla» con trim porque el host recibiría un id distinto del que Core emitió.
function navigableTargetOf(item) {
  const target = item.target;
  if (!target || typeof target !== 'object') return null;
  const { kind, id } = target;
  if (typeof kind !== 'string' || !NAVIGABLE_TARGET_KINDS.has(kind)) return null;
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > MAX_TARGET_ID) return null;
  if (CONTROL_CHARS.test(id)) return null;
  return { kind, id };
}

function navigableProjectIdOf(item, target) {
  if (target.kind === 'project') return target.id;
  const id = item.project?.id;
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > MAX_TARGET_ID || CONTROL_CHARS.test(id)) return null;
  return id;
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

// Copy seguro por categoría: el mensaje y el código crudos del Core nunca se renderizan.
const ERROR_COPY = {
  disconnected: 'Core está desconectado.',
  degraded: 'Core está degradado.',
  timeout: 'Core no respondió a tiempo.',
  page: 'No se pudieron cargar más eventos.',
};
const GENERIC_ERROR_COPY = 'El Core no devolvió actividad.';

function errorCopyOf(error) {
  const kind = error && typeof error === 'object' ? error.kind : null;
  return Object.hasOwn(ERROR_COPY, kind) ? ERROR_COPY[kind] : GENERIC_ERROR_COPY;
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
  onOpenTarget,
  translateMessage,
  className = '',
}) {
  const headingId = useId();
  const safeScope = normalizeScope(scope);
  const safeItems = useMemo(() => normalizeItems(items), [items]);
  const viewStatus = STATUSES.has(status) ? status : 'error';
  const busy = viewStatus === 'loading' || (viewStatus === 'ready' && loadingMore === true);
  const staleView = stale === true;
  // Una reconexión (loading) o un fallo de actualización (error) no pueden borrar lo ya
  // cargado si la vista está marcada como stale: las filas, la cuenta y el aviso siguen.
  const showCachedRows =
    viewStatus === 'ready' ||
    (staleView && (viewStatus === 'loading' || viewStatus === 'error'));
  const showStale =
    staleView &&
    (viewStatus === 'ready' || viewStatus === 'loading' || viewStatus === 'error');
  // next_cursor es el seq del último evento devuelto: con has_more=true debe ser un
  // i64 decimal canónico positivo. Los valores inseguros nunca pasan por Number.
  const nextCursor = cursor && typeof cursor === 'object'
    ? canonicalActivityI64(cursor.next, true)
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
  const errorCopy = errorCopyOf(error);
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
            aria-label={activityCountLabel(displayCount)}
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
          <p>{errorCopy}</p>
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
            const openable = typeof onOpenTarget === 'function' ? navigableTargetOf(item) : null;
            const project = projectOf(item);
            const actor = actorOf(item);
            const client = clientOf(item);
            const correlationId = correlationOf(item);
            const meta = sanitizeMetadata(item.metadata);
            const time = timeInfo(item.timestamp);
            const showProject =
              project && !(target && target.kind === 'project' && target.id === project.id);
            const rowLabel = [
              `Evento ${eventId}`,
              `secuencia ${item.seq}`,
              CLASS_LABELS[classKey] || 'Sin clase',
              severity ? SEVERITY_LABELS[severity] : '',
              text || (unknown ? 'Evento desconocido' : 'Actividad sin descripción'),
              target ? `${TARGET_LABELS[target.kind] || 'Destino'} ${target.id}` : 'Sin destino',
            ]
              .filter(Boolean)
              .join('. ');

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
                aria-label={rowLabel}
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
                      data-testid={`activity-seq-${eventId}`}
                      aria-label={`Secuencia ${item.seq}`}
                      title={`evento ${eventId} · seq ${item.seq}`}
                    >
                      #{item.seq}
                    </span>
                    <time className="activity__time mono" dateTime={time.iso} title={time.title}>
                      {time.label}
                    </time>
                    {target && openable ? (
                      <button
                        type="button"
                        className="activity__target activity__target--link"
                        data-testid={`activity-target-${eventId}`}
                        aria-label={`Abrir ${TARGET_LABELS[openable.kind]} ${openable.id}`}
                        onClick={() => onOpenTarget({
                          kind: openable.kind,
                          id: openable.id,
                          projectId: navigableProjectIdOf(item, openable),
                        })}
                      >
                        {TARGET_LABELS[target.kind] || 'Destino'}{' '}
                        <span className="mono" title={target.id}>
                          {target.id}
                        </span>
                      </button>
                    ) : target ? (
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
