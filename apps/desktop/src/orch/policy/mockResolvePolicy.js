// mockResolvePolicy.js — implementación simulada de `orch_resolve_policy` basada en la
// tabla perfiles→flags. Solo se carga en desarrollo (import.meta.env.DEV) o desde las
// pruebas; el build de producción no la incluye.

import { PROFILES } from './resolvePolicy.js';

/** @typedef {import('./policyTypes').EffectivePolicy} EffectivePolicy */
/** @typedef {import('./policyTypes').ResolvePolicyArgs} ResolvePolicyArgs */

/** Versiones contra las que se verificaron los flags (tabla perfiles→flags, 2026-10-09). */
export const VERIFIED_VERSIONS = { claude: ['2.1.296'], codex: ['0.159.0', '0.162.1'] };

const WORKTREE_WARNING = 'El aislamiento entre tareas lo da el worktree de git, no la CLI; el .git del worktree apunta al repo principal.';
/** Roles válidos del orquestador (roles.rs del host). */
export const KNOWN_ROLES = ['explorador', 'implementador', 'revisor', 'escalado', 'adversario'];
/** Motivo exacto del host (agents.rs, CODEX_NO_LXO). */
export const CODEX_LXO_DONE_REASON = 'Codex en este sandbox no puede conectarse al host local para entregar con lxo done; ver PR de entrega por archivo';
export const LXO_ONLY_WARNING = 'No verificado: que el modo plan respete --allowedTools "Bash(lxo *)" y deje ejecutar lxo.';
export const ALLOWED_TOOLS_WARNING = 'Lista de --allowedTools pendiente de definir por el host';
const CLAUDE_WARNINGS = [
  'Claude no tiene sandbox del sistema operativo: los límites los aplica la propia CLI.',
  'Claude no corta la red.',
];

/** Flags por perfil, tomados solo de la tabla perfiles→flags (sin flags inventados). */
function mockFlags(provider, profile, worktree) {
  if (provider === 'claude') {
    // Explorar y Proponer: mismo argv y orden que el host de DESKTOP (c270625); Bash solo para lxo.
    if (profile === 'explorar' || profile === 'proponer') {
      return ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit', '--allowedTools', 'Bash(lxo *)', '--permission-mode', 'plan'];
    }
    if (profile === 'delegar_con_revision') return ['--permission-mode', 'acceptEdits'];
  }
  if (provider === 'codex') {
    if (profile === 'explorar' || profile === 'proponer') return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    if (profile === 'delegar_con_revision') return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--cd', worktree];
  }
  return null;
}

/**
 * Implementación mock: reproduce la tabla y las reglas del host sin ejecutar nada.
 * `role` vacío o null = consulta de flags (role: null en la respuesta).
 * @param {ResolvePolicyArgs} args
 * @param {{ detectedVersion?: string|null }} [opts] versión simulada de la CLI
 * @returns {Promise<EffectivePolicy>}
 */
export async function mockResolvePolicy(args, opts = {}) {
  const role = args.role ? String(args.role).trim() || null : null;
  const p = { ...(await resolveFlags(args, opts)), role };
  // Igual que evaluate_for del host: rol desconocido bloquea; con rol (tarea hija que
  // entrega con lxo done) Codex queda bloqueado porque su sandbox no llega al host local.
  if (role && !KNOWN_ROLES.includes(role)) return { ...p, status: 'blocked', reason: `Rol desconocido: ${role}` };
  if (role && p.provider === 'codex' && p.status !== 'blocked') return { ...p, status: 'blocked', reason: CODEX_LXO_DONE_REASON };
  return p;
}

async function resolveFlags({ provider, profile, worktree }, opts) {
  const cli_version = opts.detectedVersion === undefined ? VERIFIED_VERSIONS[provider]?.[0] ?? null : opts.detectedVersion;
  const warnings = provider === 'claude' ? [...CLAUDE_WARNINGS, WORKTREE_WARNING] : [WORKTREE_WARNING];
  // La tabla no fija la lista de herramientas de Delegar con revisión en Claude.
  if (provider === 'claude' && profile === 'delegar_con_revision') warnings.push(ALLOWED_TOOLS_WARNING);
  if (provider === 'claude' && (profile === 'explorar' || profile === 'proponer')) warnings.push(LXO_ONLY_WARNING);
  const base = { profile, provider, cli_version, warnings };
  const def = PROFILES.find((p) => p.id === profile);
  if (!def || !def.enabled) {
    return { ...base, argv: [], status: 'blocked', reason: def?.disabledReason || 'Perfil no soportado' };
  }
  const flags = mockFlags(provider, profile, worktree);
  if (!flags) return { ...base, argv: [], status: 'blocked', reason: 'Proveedor no soportado' };
  const argv = [provider, ...flags];
  if (!cli_version) return { ...base, argv, status: 'blocked', reason: `No se detectó la CLI de ${provider}` };
  const verified = VERIFIED_VERSIONS[provider] || [];
  if (!verified.includes(cli_version)) {
    return { ...base, argv, status: 'unverified', reason: `Versión ${cli_version} distinta de las verificadas (${verified.join(', ')})` };
  }
  return { ...base, argv, status: 'ok', reason: null };
}

