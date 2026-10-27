// SOLO PARA PRUEBAS. No se importa desde código de producción.
//
// Respuestas de `provider_capabilities` (LXO-135): la fixture canónica del Core tal cual (docs/core/fixtures/api/, con tres
// proveedores falsos: completo, parcial y bloqueado por el entorno) más la capa de la lectura viva (`status`, `refreshing`,
// `checked_at_ms`) y variantes locales sintéticas (`testOnly: true`) para los casos que la canónica no cubre. Los nombres de
// proveedor de las variantes (`claude`, `codex`…) son SOLO datos de prueba: ninguna regla de producción los conoce.
import canonicalSnapshot from '../../../../../docs/core/fixtures/api/provider_capabilities.v1.json';

export const CANONICAL_SNAPSHOT = Object.freeze(canonicalSnapshot);

const clone = (value) => JSON.parse(JSON.stringify(value));

/** La lectura viva: el snapshot más lo que añade el registro del Core. */
export function live(snapshot = CANONICAL_SNAPSHOT, over = {}) {
  return { ...clone(snapshot), status: 'ready', refreshing: false, checked_at_ms: 1792000000000, ...over };
}

const CAPS = ['start', 'events', 'answer', 'interrupt', 'steer', 'resume'];

/** Un proveedor con todas las capabilities `available`, y las que se digan cambiadas. */
export function provider(id, changes = {}, over = {}) {
  const capabilities = Object.fromEntries(CAPS.map((c) => [c, { state: 'available' }]));
  for (const [cap, state] of Object.entries(changes)) capabilities[cap] = typeof state === 'string' ? { state } : state;
  return {
    id, cli_version: '1.0.0', environment: { state: 'ready' }, matrix: { capabilities, version: 1 }, testOnly: true, ...over,
  };
}

/** Un proveedor bloqueado por el entorno: toda la matriz queda `environment_blocked` por el mismo bloqueo. */
export function blocked(id, block = 'cli_missing') {
  const state = { state: 'environment_blocked', block };
  return provider(id, Object.fromEntries(CAPS.map((c) => [c, state])), { cli_version: null, environment: { state: 'blocked', blocks: [block] } });
}

/** Una lectura viva con los proveedores dados. `generation` identifica la foto. */
export function liveWith(providers, over = {}) {
  return { version: 1, generation: 1, providers: providers.map(clone), status: 'ready', refreshing: false, checked_at_ms: 1792000000000, ...over };
}

/** El Core sondeando por primera vez: todavía no hay proveedores ni hora. */
export const PROBING = Object.freeze({ version: 1, generation: 0, providers: [], status: 'probing', refreshing: true, checked_at_ms: null });
