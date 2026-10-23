// observe/bootstrap.js — arranque observacional de Mobile desde la snapshot compacta del Core (LXO-107).
//
// Flujo: caché local (si hay, se pinta como desactualizada) → `core_snapshot` (punto coherente con su
// cursor) → `core_events` desde ese cursor mientras la app está delante. Cuando llegan eventos nuevos se
// pide otra snapshot: la snapshot pinta, el Event Log dice cuándo ha cambiado algo. Nada de esto es
// autoridad en el móvil ni escribe en el Core.
//
// Estados (`status`):
//   connecting        sin datos todavía, pidiendo la primera snapshot
//   online            sincronizado hace menos de STALE_MS
//   stale             hay datos, pero vienen de la caché o de una sincronización vieja
//   offline           sin conexión con el gateway o con el IDE; se reintenta con backoff acotado
//   unauthorized      el gateway o el Core rechazan la identidad: no se reintenta solo
//   version_mismatch  el IDE, el gateway o la snapshot son de otra versión: no se reintenta solo
// Offline no es un fallo: los datos que hubiera se conservan, marcados como desactualizados.
//
// Sin dependencias de React Native: el reloj, el almacenamiento y el transporte se inyectan.

export const SUPPORTED_SNAPSHOT_VERSION = 1;
export const CORE_SNAPSHOT_CAPABILITY = 'core_snapshot';
export const STATUS = Object.freeze({
  CONNECTING: 'connecting',
  ONLINE: 'online',
  STALE: 'stale',
  OFFLINE: 'offline',
  UNAUTHORIZED: 'unauthorized',
  VERSION_MISMATCH: 'version_mismatch',
});
/** Una sincronización más vieja que esto se marca como desactualizada. */
export const STALE_MS = 60_000;
/** Cada cuánto se sigue el Event Log con la app delante y en línea. */
export const POLL_MS = 5_000;
/** Backoff de reintentos y tope de intentos seguidos: después se espera a volver, reconectar o `retry()`. */
export const BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
export const MAX_ATTEMPTS = BACKOFF_MS.length;
export const EVENTS_PAGE = 200;
/** Páginas de eventos por vuelta: un hueco enorme se resuelve con otra snapshot, no leyendo sin fin. */
const MAX_EVENT_PAGES = 5;
/** Eventos recientes que se conservan para las vistas (deduplicados por `seq`). */
export const RECENT_EVENTS = 200;

const UNAUTHORIZED = /(^unauthorized$|_auth_required$|^forbidden$)/;
const VERSION = /^(unsupported_action|protocol_mismatch|snapshot_version_unsupported)$/;
const CURSOR = /^(invalid_cursor|cursor_ahead)$/;

/** Clasifica un resultado fallido de `request`. */
export function classify(result) {
  if (result?.transport) return 'offline';
  const code = String(result?.code || '');
  if (UNAUTHORIZED.test(code)) return 'unauthorized';
  if (VERSION.test(code)) return 'version';
  if (CURSOR.test(code)) return 'cursor';
  return 'offline'; // Core no disponible, error interno…: el IDE está, el dato no; se reintenta
}

function validSnapshot(s) {
  return (
    s &&
    typeof s === 'object' &&
    Number.isSafeInteger(s.cursor?.events) &&
    s.projects && Array.isArray(s.projects.items) &&
    s.active_tasks && Array.isArray(s.active_tasks.items) &&
    s.attention && Array.isArray(s.attention.items)
  );
}

/**
 * - `hostKey`: identifica al IDE (máquina) para la caché.
 * - `request(action, args)`: resuelve `{ ok: true, data }` o `{ ok: false, code? , transport? }`.
 * - `cache`: `{ load, save, clear }` (ver cache.js) o `null`.
 * - `clock`: `{ now, setTimeout, clearTimeout }`.
 * - `log(code, fields)`: solo códigos y contadores, nunca contenido.
 * - `onChange(state)`.
 */
export function createCoreBootstrap({ hostKey, request, cache = null, clock = globalThis, now = () => Date.now(), log = () => {}, onChange = () => {} }) {
  let state = {
    status: STATUS.CONNECTING,
    snapshot: null,
    cursor: null,
    syncedAt: null,
    fromCache: false,
    reason: null,
    attempts: 0,
    events: [],
  };
  let link = { transportOpen: false, hostConnected: false, capabilities: null };
  let foreground = true;
  let started = false;
  let stopped = false;
  let inflight = false;
  let timer = null;
  let generation = 0;
  let needsSnapshot = true;
  let terminal = false; // unauthorized / version_mismatch: solo `retry()` lo reanuda

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms) => {
    clear();
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = null;
      sync();
    }, ms);
  };
  const reachable = () => link.transportOpen && link.hostConnected;
  const hasData = () => state.snapshot !== null;
  const fresh = () => state.syncedAt !== null && !state.fromCache && now() - state.syncedAt < STALE_MS;
  /** Estado mientras no hay un error terminal. */
  const settledStatus = () => {
    if (!reachable()) return STATUS.OFFLINE;
    if (!hasData()) return STATUS.CONNECTING;
    return fresh() ? STATUS.ONLINE : STATUS.STALE;
  };

  function versionMismatch(reason) {
    terminal = true;
    clear();
    log('core_bootstrap_version_mismatch', { reason });
    set({ status: STATUS.VERSION_MISMATCH, reason });
  }

  function capabilityMissing() {
    return Array.isArray(link.capabilities) && !link.capabilities.includes(CORE_SNAPSHOT_CAPABILITY);
  }

  function fail(kind, code) {
    if (kind === 'unauthorized') {
      terminal = true;
      clear();
      log('core_bootstrap_unauthorized', { code });
      set({ status: STATUS.UNAUTHORIZED, reason: code || 'unauthorized' });
      return;
    }
    if (kind === 'version') {
      versionMismatch(code);
      return;
    }
    const attempts = state.attempts + 1;
    log('core_bootstrap_retry', { code: code || 'offline', attempts });
    // Offline no borra nada: los datos que hubiera siguen, marcados como no frescos.
    set({ attempts, reason: code || 'offline', status: reachable() && hasData() ? STATUS.STALE : STATUS.OFFLINE });
    if (attempts < MAX_ATTEMPTS) schedule(BACKOFF_MS[attempts - 1]);
    else log('core_bootstrap_backoff_exhausted', { attempts });
  }

  async function fetchSnapshot(gen) {
    const res = await request('core_snapshot', {});
    if (gen !== generation) return false;
    if (!res.ok) {
      fail(classify(res), res.code || res.transport);
      return false;
    }
    const snapshot = res.data?.snapshot;
    if (snapshot?.snapshot_version !== SUPPORTED_SNAPSHOT_VERSION) {
      versionMismatch('snapshot_version_unsupported');
      return false;
    }
    if (!validSnapshot(snapshot)) {
      fail('offline', 'invalid_snapshot');
      return false;
    }
    const at = now();
    const cursor = snapshot.cursor.events;
    needsSnapshot = false;
    // Los eventos anteriores al nuevo cursor ya están reflejados en la snapshot.
    const events = state.events.filter((e) => e.seq <= cursor);
    state = { ...state, snapshot, cursor, syncedAt: at, fromCache: false, reason: null, attempts: 0, events };
    set({ status: settledStatus() });
    log('core_bootstrap_snapshot', {
      projects: snapshot.projects.items.length,
      tasks: snapshot.active_tasks.items.length,
      truncated: !!(snapshot.projects.truncated || snapshot.active_tasks.truncated || snapshot.attention.truncated),
    });
    cache?.save(hostKey, { snapshot, cursor, savedAt: at });
    return true;
  }

  /** Lee el Event Log desde el cursor. Devuelve `true` si llegó algo nuevo. */
  async function followEvents(gen) {
    let cursor = state.cursor;
    const incoming = [];
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const res = await request('core_events', { cursor, limit: EVENTS_PAGE });
      if (gen !== generation) return null;
      if (!res.ok) {
        const kind = classify(res);
        if (kind === 'cursor') {
          // El cursor no es de este Core (base nueva, reinstalación…): la caché no vale; snapshot nueva.
          log('core_bootstrap_cursor_reset', { code: res.code });
          cache?.clear(hostKey);
          needsSnapshot = true;
          set({ cursor: null, events: [], fromCache: true });
          return true;
        }
        fail(kind, res.code || res.transport);
        return null;
      }
      const data = res.data || {};
      for (const e of data.events || []) {
        // Reconectar o repetir una página nunca duplica: solo cuenta lo que supera el cursor.
        if (Number.isSafeInteger(e?.seq) && e.seq > cursor) {
          incoming.push(e);
          cursor = e.seq;
        }
      }
      if (Number.isSafeInteger(data.next_cursor) && data.next_cursor > cursor) cursor = data.next_cursor;
      if (!data.has_more) break;
      if (page === MAX_EVENT_PAGES - 1) needsSnapshot = true;
    }
    const events = [...state.events, ...incoming].slice(-RECENT_EVENTS);
    state = { ...state, cursor, events, syncedAt: now(), reason: null, attempts: 0 };
    set({ status: settledStatus() });
    if (incoming.length) needsSnapshot = true;
    return incoming.length > 0 || needsSnapshot;
  }

  async function sync() {
    if (stopped || terminal || inflight || !started) return;
    clear();
    if (capabilityMissing()) {
      versionMismatch('host_without_core_snapshot');
      return;
    }
    if (!reachable()) {
      set({ status: STATUS.OFFLINE });
      return; // se retoma al volver la conexión (`setLink`)
    }
    if (!foreground) return;
    inflight = true;
    const gen = generation;
    try {
      if (needsSnapshot || state.cursor === null) {
        if (!(await fetchSnapshot(gen))) return;
      } else {
        const changed = await followEvents(gen);
        if (changed === null) return;
        if (changed && needsSnapshot && !(await fetchSnapshot(gen))) return;
      }
      if (gen === generation && foreground) schedule(POLL_MS);
    } finally {
      if (gen === generation) inflight = false;
    }
  }

  return {
    get state() {
      return state;
    },

    async start() {
      if (started || stopped) return;
      started = true;
      const cached = cache ? await cache.load(hostKey) : null;
      if (stopped) return;
      if (cached && state.snapshot === null) {
        // La caché solo pinta: se marca desactualizada y se pide la snapshot real enseguida.
        set({ snapshot: cached.snapshot, cursor: cached.cursor, syncedAt: cached.savedAt, fromCache: true, status: reachable() ? STATUS.STALE : STATUS.OFFLINE });
        log('core_bootstrap_cache', { age_ms: Math.max(0, now() - cached.savedAt) });
      }
      needsSnapshot = true;
      sync();
    },

    /** Estado del transporte: socket con el gateway, IDE conectado y capabilities de su `hello`. */
    setLink(next) {
      const was = reachable();
      link = { ...link, ...next };
      if (!started || stopped) return;
      if (capabilityMissing()) {
        if (state.status !== STATUS.VERSION_MISMATCH) versionMismatch('host_without_core_snapshot');
        return;
      }
      if (!reachable()) {
        clear();
        if (!terminal) set({ status: STATUS.OFFLINE });
        return;
      }
      if (!was && !terminal) {
        // Reconexión: se sigue desde el cursor que había, con el backoff a cero.
        set({ attempts: 0, status: settledStatus() });
        sync();
      }
    },

    setForeground(active) {
      if (foreground === active) return;
      foreground = active;
      if (!started || stopped) return;
      if (!active) {
        clear();
        return;
      }
      if (terminal) return;
      if (!fresh() && hasData()) set({ status: reachable() ? STATUS.STALE : STATUS.OFFLINE });
      set({ attempts: 0 });
      sync();
    },

    /** Reintento manual: también sale de unauthorized / version_mismatch. */
    retry() {
      if (stopped) return;
      terminal = false;
      generation += 1;
      inflight = false;
      set({ attempts: 0, reason: null, status: settledStatus() });
      sync();
    },

    stop() {
      stopped = true;
      generation += 1;
      clear();
    },
  };
}
