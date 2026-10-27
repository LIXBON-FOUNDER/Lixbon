// SOLO PARA PRUEBAS. No se importa desde código de producción.
//
// Respuestas de `usage_report` (LXO-206): el informe canónico del Core (docs/core/fixtures/api/usage_report.v1.json, LXO-205, con cuatro
// proveedores: uno completo y al día, uno con solo ventanas y observado en una ejecución, uno con un error de autenticación y uno que no
// informa de uso) envuelto en la respuesta de la lectura viva, más VARIANTES LOCALES sintéticas (`testOnly: true`) para los estados que
// la canónica no cubre. Los nombres de proveedor son SOLO datos de prueba: ninguna regla de producción los conoce.
import canonicalReport from '../../../../../docs/core/fixtures/api/usage_report.v1.json';

export const CANONICAL_REPORT = Object.freeze(canonicalReport);
/** `generated_at_ms` de la fixture: el «ahora» de las pruebas. */
export const NOW = canonicalReport.generated_at_ms;

const clone = (v) => JSON.parse(JSON.stringify(v));
const ALL = ['windows', 'tokens', 'credits', 'plan', 'cost'];
const support = (state = 'available') => ({ fields: Object.fromEntries(ALL.map((f) => [f, { state }])) });

/** La respuesta de la lectura viva con el informe dado. */
export function live(report = CANONICAL_REPORT, over = {}) {
  return { v: 1, status: 'ready', refreshing: false, report: clone(report), ...over };
}

export const LOADING = Object.freeze({ v: 1, status: 'loading', refreshing: true, report: null });

/** Un informe con los proveedores dados. */
export function report(providers, over = {}) {
  return { version: 1, generated_at_ms: NOW, providers: clone(providers), ...over };
}

export const PROVIDERS = Object.freeze({
  /** Solo la hora de reinicio, sin porcentaje: lo desconocido NO es 0. */
  sinPorcentaje: () => ({
    provider: 'claude', status: 'fresh', support: support('unsupported'), age_ms: 0,
    snapshot: { provider: 'claude', observed_at_ms: NOW, provenance: 'run_observation', windows: [{ id: 'five_hour', resets_at: NOW / 1000 + 5400 }] },
  }),
  /** Casi agotada, con un límite alcanzado. */
  alLimite: () => ({
    provider: 'codex', status: 'fresh', support: support(), age_ms: 1000,
    snapshot: {
      provider: 'codex', observed_at_ms: NOW - 1000, provenance: 'provider_query', account: 'e7cbf1f7', plan: 'plus', limit_reached: true,
      windows: [{ id: 'primary', minutes: 300, used_percent: 96.5, resets_at: NOW / 1000 + 600 }, { id: 'secondary', minutes: 10080, used_percent: 0, resets_at: NOW / 1000 + 86400 * 3 }],
    },
  }),
  /** Dato viejo porque la última actualización falló. */
  antiguoPorFallo: () => ({
    provider: 'codex', status: 'stale', support: support(), age_ms: 3_600_000,
    error: { kind: 'auth_required', message: 'el proveedor pide iniciar sesión' },
    snapshot: { provider: 'codex', observed_at_ms: NOW - 3_600_000, provenance: 'provider_query', account: 'e7cbf1f7', windows: [{ id: 'primary', minutes: 300, used_percent: 40, resets_at: NOW / 1000 + 100 }] },
  }),
  /** Sin dato alguno por un límite de consultas. */
  sinDatos: () => ({ provider: 'otro', status: 'unknown', support: support(), error: { kind: 'rate_limited', message: 'el proveedor limita las consultas de uso: se reintentará más tarde' } }),
  /** Entorno bloqueado: no se consulta, y no es un fallo. */
  bloqueado: () => ({ provider: 'bloqueado', status: 'environment_blocked', support: support() }),
  /** Dos modelos con datos a medias. */
  conModelos: (provider = 'multi', account = 'aaaabbbb') => ({
    provider, status: 'fresh', support: support(), age_ms: 0,
    snapshot: {
      provider, observed_at_ms: NOW, provenance: 'provider_query', account,
      models: [{ model: 'modelo-a', input_tokens: 1200, output_tokens: 300, cost_usd: 0.0123 }, { model: 'modelo-b', input_tokens: 0, output_tokens: 0, cost_usd: 0 }, { model: 'modelo-c' }],
    },
  }),
});
