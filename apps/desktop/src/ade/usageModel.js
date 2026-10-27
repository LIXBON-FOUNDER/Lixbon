/**
 * Modelo de la vista de Usage (LXO-206): del informe del Core a lo que la interfaz muestra. Puro y sin dependencias de React ni de Tauri.
 *
 * REGLAS (las invariantes de la issue, comprobadas en `usageModel.test.js` y `UsageView.test.jsx`):
 * 1. DESCONOCIDO NUNCA SE PINTA COMO 0. Un porcentaje, un token o un coste que el proveedor no dio se dice «sin dato»; no hay barra
 *    llena ni vacía para él. Un `0` solo se muestra si el Core lo envió.
 * 2. La frescura es visible siempre: cuándo se observó y de dónde (una consulta al proveedor o lo último visto en una ejecución).
 * 3. Los proveedores no se suman ni se comparan: no hay ningún total en este módulo.
 * 4. Un fallo de uso es del USO, no del proveedor ni de ningún Attempt: ningún estado de uso usa el tono de peligro.
 * 5. Nada que parezca una credencial: la cuenta es una huella de 8 hex y no hay función que construya otra cosa.
 */

export const STATUS_INFO = Object.freeze({
  fresh: { label: 'Al día', tone: 'good', glyph: '●', help: 'El dato se observó hace poco.' },
  stale: { label: 'Dato antiguo', tone: 'warn', glyph: '◐', help: 'Es el último dato conocido: pasó su plazo o no se pudo actualizar.' },
  unknown: { label: 'Sin datos', tone: 'unknown', glyph: '?', help: 'Todavía no se sabe: no es cero.' },
  unsupported: { label: 'No informa de su uso', tone: 'muted', glyph: '–', help: 'El proveedor no ofrece su uso por diseño. No es un fallo.' },
  environment_blocked: { label: 'Entorno bloqueado', tone: 'info', glyph: '⊘', help: 'El entorno impide consultarlo. No es un fallo del proveedor.' },
});

export const ERROR_COPY = Object.freeze({
  auth_required: 'El proveedor pide iniciar sesión.',
  rate_limited: 'El proveedor limita las consultas de uso: se reintentará más tarde.',
  provider_unavailable: 'El proveedor no contestó a tiempo o todavía no tiene datos.',
  unsupported: 'El proveedor no informa de su uso.',
  environment_blocked: 'El entorno impide consultar el uso.',
  internal: 'Falló la consulta de uso dentro de Lixbon.',
});

export const PROVENANCE_COPY = Object.freeze({
  provider_query: 'consulta al proveedor',
  run_observation: 'lo último que dijo durante una ejecución',
});

export const FIELD_LABELS = Object.freeze({ windows: 'Cuota por ventana', tokens: 'Tokens', credits: 'Créditos', plan: 'Plan', cost: 'Coste' });
export const FIELD_STATE_WORDS = Object.freeze({ available: 'se informa', unsupported: 'no se informa', unavailable: 'no disponible ahora', environment_blocked: 'bloqueado por el entorno' });

/** Etiquetas de las ventanas que el Core normaliza; un id que no se conoce se muestra tal cual (es texto del proveedor). */
const WINDOW_LABELS = Object.freeze({ five_hour: 'Ventana de 5 horas', seven_day: 'Semana', primary: 'Ventana principal', secondary: 'Ventana secundaria' });

export function formatDuration(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** El nombre de una ventana: el normalizado del Core con su duración cuando se sabe. */
export function windowLabel(w) {
  const duration = formatDuration(w.minutes);
  // Algunos proveedores prefijan el id con su espacio de nombres (`codex.primary`): se mira el último tramo.
  const key = typeof w.id === 'string' && w.id.includes('.') ? w.id.slice(w.id.lastIndexOf('.') + 1) : w.id;
  const slug = /^seven_day_(.+)$/.exec(key);
  const known = slug || WINDOW_LABELS[key] !== undefined;
  const base = slug ? `Semana · ${slug[1]}` : (WINDOW_LABELS[key] ?? w.id);
  return duration && known && !['five_hour', 'seven_day'].includes(key) && !slug ? `${base} (${duration})` : base;
}

/** El porcentaje de una ventana. `known: false` = el proveedor no lo dio: sin barra, sin cero. */
export function percentOf(w) {
  if (typeof w.used_percent !== 'number') return { known: false, value: null, high: false, label: 'sin dato' };
  const v = Math.round(w.used_percent * 10) / 10;
  // «Casi agotada» se dice con TEXTO (el color solo acompaña) a partir del 90 %.
  return { known: true, value: w.used_percent, high: w.used_percent >= 90, label: `${Number.isInteger(v) ? v : v.toFixed(1)} % usado` };
}

/** Cuándo se reinicia una ventana (`resets_at` en segundos Unix). Sin hora, se dice; nunca se inventa. */
export function resetText(w, nowMs) {
  if (!Number.isSafeInteger(w.resets_at)) return { known: false, text: 'hora de reinicio desconocida', iso: null };
  const diff = w.resets_at * 1000 - nowMs;
  const iso = new Date(w.resets_at * 1000).toISOString();
  if (diff <= 0) return { known: true, text: 'ya debería haberse reiniciado', iso };
  const min = Math.round(diff / 60_000);
  const h = Math.floor(min / 60);
  const rest = min % 60;
  const when = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h > 0 ? `${h} h ${rest} min` : `${Math.max(1, rest)} min`;
  return { known: true, text: `se reinicia en ${when}`, iso };
}

/** «hace 2 min». Siempre sobre el momento en que se OBSERVÓ el dato, no sobre cuándo se pintó. */
export function ageText(observedAtMs, nowMs) {
  const diff = Math.max(0, nowMs - observedAtMs);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'hace unos segundos';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export const formatTokens = (n) => (Number.isSafeInteger(n) ? n.toLocaleString('es', { useGrouping: 'always' }) : 'sin dato');
export const formatCost = (c) => (typeof c === 'number' ? `${c.toFixed(c < 1 ? 3 : 2)} USD` : 'sin dato');

/** Estado de un proveedor con su explicación, su frescura y, si falló la última consulta, el motivo. */
export function describeProvider(p, nowMs) {
  const info = STATUS_INFO[p.status];
  const snap = p.snapshot ?? null;
  const error = p.error ? { kind: p.error.kind, text: ERROR_COPY[p.error.kind] } : null;
  const freshness = snap
    ? { observedAtMs: snap.observed_at_ms, age: ageText(snap.observed_at_ms, nowMs), source: PROVENANCE_COPY[snap.provenance], provenance: snap.provenance, iso: new Date(snap.observed_at_ms).toISOString() }
    : null;
  let headline;
  if (p.status === 'unknown') headline = error ? `Sin datos de uso: ${error.text}` : 'Sin datos de uso todavía.';
  else if (p.status === 'unsupported') headline = `${p.provider} no informa de su uso. No es un fallo: el proveedor no lo ofrece.`;
  else if (p.status === 'environment_blocked') headline = `El entorno de ${p.provider} está bloqueado, así que no se consulta su uso. No es un fallo del proveedor.`;
  else if (p.status === 'stale') headline = error ? `No se pudo actualizar: ${error.text} Se muestra el último dato.` : 'El dato es más viejo de lo normal.';
  else headline = null;
  return { ...info, id: p.provider, status: p.status, headline, error, freshness, throttled: p.throttled === true };
}

/** Lo que el proveedor puede informar, campo por campo (para que se vea qué falta por diseño y qué por un fallo). */
export const supportList = (p) => ['windows', 'tokens', 'credits', 'plan', 'cost'].map((f) => ({
  field: f, label: FIELD_LABELS[f], state: p.support.fields[f].state, word: FIELD_STATE_WORDS[p.support.fields[f].state],
}));

/** Opciones de filtro sacadas del propio informe: ningún proveedor, cuenta ni modelo conocido de antemano. */
export function filterOptions(report) {
  const providers = report.providers.map((p) => p.provider);
  const accounts = [...new Set(report.providers.map((p) => p.snapshot?.account).filter(Boolean))].sort();
  const models = [...new Set(report.providers.flatMap((p) => (p.snapshot?.models ?? []).map((m) => m.model)))].sort();
  return { providers, accounts, models };
}

/**
 * El informe filtrado por proveedor, cuenta y/o modelo (`''` = todos). Es una vista: nada se suma ni se transforma. Un filtro de
 * cuenta o de modelo oculta a los proveedores sin dato de esa cuenta o ese modelo, y deja solo las filas de modelo que coinciden.
 */
export function filterReport(report, { provider = '', account = '', model = '' } = {}) {
  const keep = [];
  for (const p of report.providers) {
    if (provider && p.provider !== provider) continue;
    if (account && p.snapshot?.account !== account) continue;
    if (model) {
      const rows = (p.snapshot?.models ?? []).filter((m) => m.model === model);
      if (rows.length === 0) continue;
      keep.push({ ...p, snapshot: { ...p.snapshot, models: rows } });
      continue;
    }
    keep.push(p);
  }
  return { ...report, providers: keep };
}
