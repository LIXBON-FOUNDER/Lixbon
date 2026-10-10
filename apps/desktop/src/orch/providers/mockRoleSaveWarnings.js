// mockRoleSaveWarnings.js — SOLO desarrollo (DEV && VITE_ORCH_MOCK==='1') y pruebas.
// Imita las notas de roles::validate_with (660a0be): modelo o esfuerzo que la lista del
// proveedor no trae (o trae sin verificar) quedan como aviso. Forma: { ok, warnings: { <rol>: [..] }, snapshot }.
import { MOCK_CLAUDE, MOCK_CODEX } from './mockListProviders';

const LIST = { claude: MOCK_CLAUDE, codex: MOCK_CODEX };

/** Textos de agents.rs (WARN_MODEL_UNVERIFIED, WARN_EFFORT_UNVERIFIED). */
export const MOCK_WARN_MODEL_UNVERIFIED = 'modelo no verificado: la CLI no lo lista entre sus modelos';
export const MOCK_WARN_EFFORT_UNVERIFIED = 'esfuerzo no verificado: la CLI no lo lista entre sus niveles';

/** Forma de roles::save_response: { ok: true, warnings, snapshot }. */
export function mockRoleSaveWarnings(settings, snapshot = null) {
  const out = {};
  for (const [id, cfg] of Object.entries(settings?.roles || {})) {
    const p = LIST[cfg?.provider || 'claude'];
    if (!p) continue;
    const notes = [];
    if (cfg.model && !p.models.some((m) => m.id === cfg.model && m.verified)) notes.push(`${MOCK_WARN_MODEL_UNVERIFIED} (${cfg.model})`);
    if (cfg.effort && !p.efforts.includes(cfg.effort)) notes.push(`${MOCK_WARN_EFFORT_UNVERIFIED} (${cfg.effort})`);
    if (notes.length) out[id] = notes;
  }
  return { ok: true, warnings: out, snapshot };
}
