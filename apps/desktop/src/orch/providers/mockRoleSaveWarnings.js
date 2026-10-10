// mockRoleSaveWarnings.js — SOLO desarrollo (DEV && VITE_ORCH_MOCK==='1') y pruebas.
// Imita las notas de roles::validate_with (660a0be): modelo o esfuerzo que la lista del
// proveedor no trae (o trae sin verificar) quedan como aviso. Forma confirmada: { ok, warnings: { <rol>: [..] } }.
import { MOCK_CLAUDE, MOCK_CODEX } from './mockListProviders';

const LIST = { claude: MOCK_CLAUDE, codex: MOCK_CODEX };

export function mockRoleSaveWarnings(settings, labels = {}) {
  const out = {};
  for (const [id, cfg] of Object.entries(settings?.roles || {})) {
    const p = LIST[cfg?.provider || 'claude'];
    if (!p) continue;
    const label = labels[id] || id;
    const notes = [];
    if (cfg.model && !p.models.some((m) => m.id === cfg.model && m.verified)) notes.push(`${label}: modelo ${cfg.model} no verificado en ${p.id} (quedará unverified)`);
    if (cfg.effort && !p.efforts.includes(cfg.effort)) notes.push(`${label}: esfuerzo ${cfg.effort} no verificado en ${p.id} (quedará unverified)`);
    if (notes.length) out[id] = notes;
  }
  return { ok: true, warnings: out };
}
