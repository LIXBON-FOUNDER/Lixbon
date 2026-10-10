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
export function normalizeSaveWarnings(input) {
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
