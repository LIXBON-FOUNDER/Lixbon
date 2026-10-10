// resolvePolicy.js — adaptador de la política efectiva de una tarea del orquestador.
// Por defecto (producción y también `tauri dev`) llama al comando Tauri `orch_resolve_policy`.
// El mock de ./mockResolvePolicy.js solo se carga si se cumplen las dos condiciones:
//   - modo desarrollo (import.meta.env.DEV), y
//   - la variable VITE_ORCH_MOCK vale '1', p. ej. `VITE_ORCH_MOCK=1 npm run dev`
//     (PowerShell: `$env:VITE_ORCH_MOCK='1'; npm run dev`).
// En el build de producción DEV es la constante false y el bloque del mock se elimina.
// Las pruebas pueden inyectar su propio resolver en la vista.
// Tipos: ./policyTypes.d.ts

import { invoke } from '@tauri-apps/api/core';

/** @typedef {import('./policyTypes').EffectivePolicy} EffectivePolicy */
/** @typedef {import('./policyTypes').ResolvePolicyArgs} ResolvePolicyArgs */

export const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

export const DEFERRED_REASON = 'Aplazada a petición del cliente';

/** Perfiles de EQUIPO.md §31. bypassPermissions / danger-full-access no son perfil y no se ofrecen. */
export const PROFILES = [
  { id: 'explorar', label: 'Explorar', enabled: true },
  { id: 'proponer', label: 'Proponer', enabled: true },
  { id: 'delegar_con_revision', label: 'Delegar con revisión', enabled: true },
  { id: 'autonomia_amplia', label: 'Autonomía amplia', enabled: false, disabledReason: DEFERRED_REASON },
];

/** Comando real del host. @param {ResolvePolicyArgs} args @returns {Promise<EffectivePolicy>} */
export function invokeResolvePolicy({ provider, profile, role, worktree, model }) {
  // El host recibe role como String: vacío = consulta de flags sin rol. `model` es Option<String>.
  return invoke('orch_resolve_policy', { provider, profile, role: role ?? '', worktree, model: model ?? null });
}

/** Resolver por defecto de la vista. @param {ResolvePolicyArgs} args @returns {Promise<EffectivePolicy>} */
export async function resolvePolicy(args) {
  if (import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1') {
    // Rama eliminada en el build de producción (DEV es la constante false).
    const { mockResolvePolicy } = await import('./mockResolvePolicy.js');
    return mockResolvePolicy(args);
  }
  return invokeResolvePolicy(args);
}
