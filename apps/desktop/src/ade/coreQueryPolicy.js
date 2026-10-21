/**
 * Política de espera del cliente ADE (LXO-101).
 *
 * EL PLAZO DEL CLIENTE ES UN UMBRAL VISUAL, NO UN LÍMITE DEL ESCANEO.
 *
 * Por qué: el Core escanea `resource_inventory` en secuencia y sin paginación, y acota CADA
 * consulta de git a 15 s (docs/core/RESOURCES.md). Un inventario legítimo puede tardar bastante
 * más que cualquier umbral del cliente, y `fs::metadata` no tiene tope global. El plazo de este
 * módulo dice cuándo el cliente DEJA DE ESPERAR; no dice cuánto dura el escaneo ni lo acota.
 *
 * Qué garantiza:
 *  · La petición NO se abandona al pasar el umbral: si el Core contesta más tarde, esa
 *    respuesta se aplica (recuperación). Abandonarla era lo que abría escaneos solapados: el
 *    siguiente poll, un reintento o un cambio de argumentosaban una segunda petición al Core
 *    mientras la primera seguía viva.
 *  · Hay un registro de peticiones outstanding: como mucho UNA por clave de petición y, para
 *    `resource_inventory`, UNA en todo el cliente (cada una es un escaneo del Core).
 *  · Si no hay hueco, la lectura NO se lanza: se aplaza hasta que se libere otro.
 *  · Un plazo agotado NO es evidencia de desconexión: se clasifica aparte ('timeout') y el
 *    estado que se muestra es stale/degraded/error según la evidencia que haya, nunca
 *    «desconectado» por un plazo.
 *
 * Sin dependencias de React ni de Tauri: el hook es un adaptador fino sobre este módulo.
 */

/** Plazo genérico de espera de una query del Core. */
export const QUERY_TIMEOUT_MS = 10_000;

/**
 * `resource_inventory` tiene umbral propio: el Core acota cada consulta de git a 15 s y escanea
 * los repos uno a uno, así que una respuesta legítima puede pasar del plazo genérico. Son 30 s
 * (dos veces el tope por consulta del Core) y NO son una promesa de que el escaneo completo quepa
 * en ellos: el escaneo puede seguir vivo en el Core mucho después.
 */
export const RESOURCE_INVENTORY_TIMEOUT_MS = 30_000;

/** Plazo de espera (umbral visual) por query. */
const QUERY_TIMEOUT_MS_BY_QUERY = { resource_inventory: RESOURCE_INVENTORY_TIMEOUT_MS };

export function timeoutFor(query) {
  return QUERY_TIMEOUT_MS_BY_QUERY[query] ?? QUERY_TIMEOUT_MS;
}

/**
 * Límite de peticiones outstanding (simultáneas) por query del Core.
 *
 * `resource_inventory` es 1: cada petición es un escaneo secuencial del disco y del git del
 * Core, y dos a la vez serían dos escaneos solapados sobre los mismos repositorios. Las demás
 * queries son lecturas baratas y admiten más de una a la vez.
 */
const OUTSTANDING_LIMIT_BY_QUERY = { resource_inventory: 1 };
const DEFAULT_OUTSTANDING_LIMIT = 4;

export function outstandingLimit(query) {
  return OUTSTANDING_LIMIT_BY_QUERY[query] ?? DEFAULT_OUTSTANDING_LIMIT;
}

/**
 * Clasificación del fallo según la EVIDENCIA que aporta el mensaje:
 *
 *  · `degraded`: el Core dice que no tiene almacén autoritativo o que responde degradado.
 *  · `disconnected`: hay evidencia de transporte roto (IPC cerrado, conexión rechazada, fetch
 *    fallido). Solo con esa evidencia se declara una desconexión.
 *  · `timeout`: se agotó un plazo. NO es una desconexión: el Core puede estar escaneando.
 *  · `error`: cualquier otra cosa.
 */
export function classifyCoreError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
  if (/_unavailable|degraded|almac[eé]n.*no disponible/i.test(message)) return 'degraded';
  if (/disconnected|connection refused|failed to fetch|ipc.*closed|closed.*ipc|transport.*closed/i.test(message)) return 'disconnected';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  return 'error';
}

/**
 * Estado que se muestra cuando una lectura falla, según la evidencia:
 * con foto previa se conserva la última foto (`stale`); sin ella, `disconnected` o `degraded`
 * solo si el Core lo dice, y `error` en cualquier otro caso (un plazo agotado, por ejemplo).
 */
export function statusForFailure(reason, hasData) {
  if (hasData) return 'stale';
  if (reason === 'disconnected' || reason === 'degraded') return reason;
  return 'error';
}

/** Peticiones vivas: `requestKey` -> entrada. */
const entries = new Map();
/** Peticiones vivas por query: `query` -> número de entradas. */
const counts = new Map();
/** Avisados cuando se libera un hueco (para lanzar lo que estaba aplazado). */
const slotListeners = new Set();

export function outstandingCount(query) {
  return counts.get(query) ?? 0;
}

/**
 * Devuelve la petición viva de `requestKey`, o la lanza si hay hueco.
 *
 * `null` significa «no hay hueco»: hay otra lectura del Core en marcha y el llamador NO debe
 * preguntar al Core (eso sería un escaneo solapado). Debe esperar a que se libere uno.
 *
 * La entrada lleva `deadline` (el umbral visual de ESA petición, contado desde que se lanzó):
 * quien se enganche después lo hereda, porque el plazo es de la petición y no de quien espera.
 */
export function ensureRequest(query, requestKey, launch) {
  const existing = entries.get(requestKey);
  if (existing) return existing;
  if (outstandingCount(query) >= outstandingLimit(query)) return null;
  const startedAt = Date.now();
  const entry = { query, requestKey, startedAt, deadline: startedAt + timeoutFor(query) };
  // `settled` nunca rechaza: el error viaja como resultado, para que el enganche siempre pueda
  // distinguir «respondió» de «falló».
  entry.settled = new Promise((resolve) => {
    let launched;
    try {
      launched = launch();
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    Promise.resolve(launched).then(
      (data) => resolve({ ok: true, data }),
      (error) => resolve({ ok: false, error }),
    );
  });
  entries.set(requestKey, entry);
  counts.set(query, outstandingCount(query) + 1);
  const release = () => {
    // Solo la petición registrada libera su hueco: una entrada que ya se liberó (o un registro
    // reiniciado por una prueba) no puede decrementar el hueco de otra.
    if (entries.get(requestKey) !== entry) return;
    entries.delete(requestKey);
    counts.set(query, Math.max(0, outstandingCount(query) - 1));
    for (const listener of [...slotListeners]) {
      try {
        listener(query);
      } catch {
        // Un oyente que falla no puede dejar el hueco ocupado para los demás.
      }
    }
  };
  entry.settled.then(release, release);
  return entry;
}

/** Se avisa cuando se libera un hueco: lo que estaba aplazado puede salir ya. */
export function subscribeFreeSlots(listener) {
  slotListeners.add(listener);
  return () => slotListeners.delete(listener);
}

/**
 * Reloj por defecto: el del entorno. `globalThis` no trae `now()` (eso es `Date.now`), así que el
 * reloj por defecto lo aporta; y las primitivas se buscan en el MOMENTO de usarlas para que un
 * reloj de pruebas (fake timers) siga mandando sobre el umbral visual.
 */
const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
  now: () => Date.now(),
};

/**
 * Lector de una query del Core con UMBRAL VISUAL de espera (LXO-101).
 *
 * Es la parte con reloj de la lectura; el hook de React es un adaptador fino sobre este lector.
 * Las primitivas de tiempo se inyectan (`timers`) para que la política se pueda comprobar sin
 * navegador.
 *
 *  · `launch` se llama UNA vez por lectura viva: si la misma clave ya tiene una petición en
 *    marcha, se engancha a ella (no hay una segunda llamada al Core).
 *  · Si no hay hueco (otro escaneo del Core en marcha), la lectura se APLAZA: no se lanza.
 *  · Al vencer el umbral de la petición, `onThreshold` avisa; la petición sigue viva.
 *  · Cuando la petición se resuelve, `onOutcome` recibe `{ok: true, data}` o `{ok: false, error}`.
 *
 * @param {object} options
 * @param {string} options.query    Nombre de la query del Core.
 * @param {string} options.requestKey Clave de la petición (query + argumentos).
 * @param {() => Promise<unknown>} options.launch La llamada al Core.
 * @param {number} [options.pollMs] Periodo de sondeo.
 * @param {() => boolean} [options.isHidden] Si la ventana está oculta: no se pregunta al Core.
 * @param {object} [options.timers] `{setTimeout, clearTimeout, setInterval, clearInterval, now}`.
 * @param {(entry: object) => void} [options.onStart] La lectura sale (o se engancha).
 * @param {(entry: object) => void} [options.onThreshold] El umbral venció: la foto se conserva.
 * @param {(outcome: object) => void} [options.onOutcome] La petición se resolvió (o falló).
 */
export function createQueryReader({
  query,
  requestKey,
  launch,
  pollMs = 15_000,
  isHidden = () => false,
  timers = DEFAULT_TIMERS,
  onStart = () => {},
  onThreshold = () => {},
  onOutcome = () => {},
}) {
  let alive = true;
  let active = false; // hay una espera viva sobre la petición en curso
  let pending = false; // lectura aplazada: no había hueco para preguntar al Core
  let thresholdTimer = null;
  let interval = null;

  const unsubscribe = subscribeFreeSlots((freedQuery) => {
    if (!alive || freedQuery !== query || !pending) return;
    refresh();
  });

  async function refresh() {
    if (!alive || active || isHidden()) return;
    // Una petición viva para esta clave se reutiliza; si no hay hueco, la lectura se APLAZA:
    // preguntar al Core con otro escaneo en marcha sería un escaneo solapado.
    const entry = ensureRequest(query, requestKey, launch);
    if (!entry) {
      pending = true;
      return;
    }
    pending = false;
    active = true;
    onStart(entry);
    // El umbral es de la petición, no de quien espera: el que se enganche después hereda el plazo.
    thresholdTimer = timers.setTimeout(
      () => { if (alive) onThreshold(entry); },
      Math.max(0, entry.deadline - timers.now()),
    );
    const outcome = await entry.settled;
    timers.clearTimeout(thresholdTimer);
    thresholdTimer = null;
    active = false;
    if (!alive) return;
    onOutcome(outcome);
  }

  return {
    refresh,
    start() {
      refresh();
      interval = timers.setInterval(() => { if (!isHidden()) refresh(); }, pollMs);
    },
    stop() {
      alive = false;
      if (interval !== null) timers.clearInterval(interval);
      if (thresholdTimer !== null) timers.clearTimeout(thresholdTimer);
      unsubscribe();
    },
  };
}

/**
 * Vacía el registro de peticiones outstanding. Solo para pruebas: entre casos de prueba el
 * registro es de módulo y una petición a medio camino envenenaría el caso siguiente.
 */
export function resetOutstandingQueries() {
  entries.clear();
  counts.clear();
}
