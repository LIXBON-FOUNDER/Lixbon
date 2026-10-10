// roleSaveContract.js — respuesta de orch_settings_set con los avisos de validate().
// Host c969d21 (roles::save_response): `{ ok: true, warnings: { <rol>: string[] }, snapshot }`,
// por rol, cada lista con la forma de las warnings de orch_resolve_policy, y solo aparecen
// los roles con avisos. Se acepta también una lista plana (respaldo) y la respuesta vieja
// (el snapshot a secas).
// Este es el único sitio que conoce la forma; el resto usa estas funciones.

export const SAVE_WARNINGS_FIELD = 'warnings';

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : []);

/**
 * Acepta la respuesta de guardado (o directamente su `warnings`) y devuelve
 * `{ flat: string[], byRole: { [rol]: string[] } }`. Ausente o con otra forma → vacío.
 */
export function normalizeSaveWarnings(input, providers = null) {
  const out = normalizeSaveWarningsRaw(input);
  return providers ? { ...out, providers } : out;
}

function normalizeSaveWarningsRaw(input) {
  const w = input && typeof input === 'object' && !Array.isArray(input) && SAVE_WARNINGS_FIELD in input ? input[SAVE_WARNINGS_FIELD] : input;
  if (Array.isArray(w)) return { flat: strings(w), byRole: {} };
  if (w && typeof w === 'object') {
    const byRole = {};
    for (const [role, list] of Object.entries(w)) {
      const s = strings(list);
      if (s.length) byRole[role] = s;
    }
    return { flat: [], byRole };
  }
  return { flat: [], byRole: {} };
}

export const EMPTY_SAVE_WARNINGS = Object.freeze({ flat: [], byRole: {} });

/** ¿La respuesta es el snapshot completo (host anterior)? La nueva es { ok, warnings }. */
export const isSnapshotResponse = (res) => Boolean(res && typeof res === 'object' && !Array.isArray(res) && 'settings' in res);

/** Snapshot de la respuesta de guardado: `snapshot` si viene, la respuesta vieja si era el
    snapshot, o null (entonces hay que pedir orch_snapshot). */
export function snapshotFromSaveResponse(res) {
  if (res && typeof res === 'object' && res.snapshot && typeof res.snapshot === 'object') return res.snapshot;
  return isSnapshotResponse(res) ? res : null;
}

/** Avisos que solo tienen sentido con Claude (agents.rs, WARN_PLAN_SONNET). */
export const CLAUDE_ONLY_WARNINGS = Object.freeze(['en modo plan, Claude responde con Sonnet aunque pidas otro modelo']);

/** Quita los avisos exclusivos de Claude cuando el proveedor no es Claude. */
export const dropClaudeOnly = (warnings, provider) => (provider === 'claude' ? warnings : warnings.filter((w) => !CLAUDE_ONLY_WARNINGS.includes(w)));

/** { <rol>: proveedor } de la configuración que se mandó a guardar (los avisos se calcularon con ella). */
export function providersOfSettings(settings) {
  return Object.fromEntries(Object.entries(settings?.roles || {}).map(([id, c]) => [id, (c && typeof c.provider === 'string' && c.provider) || 'claude']));
}

/**
 * Avisos de guardado de un rol, SIEMPRE por la clave del host (nunca por posición). Si se
 * calcularon con otro proveedor que el que muestra la fila, están obsoletos y no se enseñan.
 */
export function warningsForRole(sw, roleId, providerId) {
  const list = sw?.byRole?.[roleId] || [];
  const computedFor = sw?.providers?.[roleId];
  if (computedFor && computedFor !== providerId) return [];
  return dropClaudeOnly(list, providerId);
}
