// providersContract.js — contrato del comando Tauri `orch_list_providers` (host c72ff47,
// src-tauri/src/orch/providers.rs). Todos los nombres viven aquí.
// El mock de ./mockListProviders.js solo se carga si import.meta.env.DEV y VITE_ORCH_MOCK === '1'.
//
// Forma (snake_case, tal cual la serializa el host):
//   { id: 'claude'|'codex', version: string|null, available: bool, disabled_reason: string|null,
//     models: [{ id, label, verified }], efforts: string[],
//     models_source: 'initialize'|'help'|'debug_models'|'config'|'none' }
// El host no manda etiqueta del proveedor: la pone la UI (PROVIDER_LABELS).
import { invoke } from '@tauri-apps/api/core';

export const PROVIDERS_COMMAND = 'orch_list_providers';
export const PROVIDER_IDS = Object.freeze(['claude', 'codex']);
export const DEFAULT_PROVIDER = 'claude';
export const PROVIDER_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'lixbon-cli': 'Lixbon CLI' });
export const EFFORT_LABELS = Object.freeze({ low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo', ultra: 'Ultra' });
export const UNVERIFIED_LABEL = 'sin verificar';

export const providerLabel = (id) => PROVIDER_LABELS[id] || id;

/** Normaliza lo que llegue del host: campos ausentes → valores vacíos, nunca se lanza. */
/** Motivo de bloqueo de un perfil en este proveedor (blocked_profiles), o null. */
export const blockedProfileReason = (p, profile) => p?.blocked_profiles?.find((b) => b.profile === profile)?.reason ?? null;

export function normalizeProvider(p) {
  const models = Array.isArray(p?.models) ? p.models.filter((m) => m && typeof m.id === 'string') : [];
  return {
    id: String(p?.id || ''),
    version: p?.version ?? null,
    available: p?.available === true,
    disabled_reason: p?.disabled_reason ?? null,
    models: models.map((m) => ({ id: m.id, label: m.label || m.id, verified: m.verified === true })),
    efforts: Array.isArray(p?.efforts) ? p.efforts.filter((e) => typeof e === 'string') : [],
    models_source: p?.models_source ?? 'none',
    // 300abea: Codex con [windows] sandbox = "elevated" (solo se lee config.toml).
    sandbox_elevated: p?.sandbox_elevated === true,
    warnings: Array.isArray(p?.warnings) ? p.warnings.filter((w) => typeof w === 'string') : [],
    blocked_profiles: Array.isArray(p?.blocked_profiles)
      ? p.blocked_profiles.filter((b) => b && typeof b.profile === 'string').map((b) => ({ profile: b.profile, reason: String(b.reason || '') }))
      : [],
  };
}

/** Comando real. `refresh` vuelve a consultar las CLI (el host cachea 15 min). */
export async function invokeListProviders({ refresh = false } = {}) {
  const list = await invoke(PROVIDERS_COMMAND, { refresh });
  return (Array.isArray(list) ? list : []).map(normalizeProvider);
}

export async function listProviders(opts) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    // Rama eliminada en el build de producción (DEV es la constante false).
    const { mockListProviders } = await import('./mockListProviders.js');
    return (await mockListProviders(opts)).map(normalizeProvider);
  }
  return invokeListProviders(opts);
}
