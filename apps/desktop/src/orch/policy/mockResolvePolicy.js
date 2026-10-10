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
/** Advertencias exactas del host (agents.rs, 5d4ce56) para Codex sin red local con entrega por archivo. */
export const CODEX_REPORT_MARKERS_WARNING = 'Sin red local: entrega con lxo report (bloque con marcadores en la salida); lxo phase, ask y check no llegan al host.';
export const CODEX_REPORT_FILE_WARNING = 'Sin red local: entrega con lxo report (report.json); lxo phase, ask y check no llegan al host.';
export const CODEX_NO_ASK_WARNING = 'Sin red local, Codex no puede usar lxo ask: no podrá preguntarle a la persona y decidirá solo.';
export const CODEX_COPY_BLOCK_WARNING = 'La entrega en solo lectura depende de que el agente copie el bloque del informe sin cambios; si el hash no coincide, la tarea termina Failed.';
/** Órdenes de Bash permitidas a Claude en todos sus perfiles (agents.rs, LXO_TOOLS; cinco reglas desde que se añadió lxo check). Nunca `Bash(lxo *)`. */
export const LXO_TOOLS = ['Bash(lxo report:*)', 'Bash(lxo guide)', 'Bash(lxo phase:*)', 'Bash(lxo ask:*)', 'Bash(lxo check)'];
/** Herramientas quitadas en los perfiles sin escritura (agents.rs, READ_ONLY_BLOCKED). */
export const READ_ONLY_BLOCKED = ['Edit', 'Write', 'NotebookEdit'];
/** Un solo token `--flag=a,b,c`, como allowed_tools()/disallowed_tools() del host. */
export const ALLOWED_TOOLS_TOKEN = `--allowedTools=${LXO_TOOLS.join(',')}`;
export const DISALLOWED_TOOLS_TOKEN = `--disallowedTools=${READ_ONLY_BLOCKED.join(',')}`;
/** Advertencia exacta del host para Claude + Delegar con revisión (agents.rs). */
/** Advertencia exacta del host para Claude + Delegar con revisión (agents.rs, WARN_DELEGAR). */
export const ALLOWED_TOOLS_WARNING = 'Los comandos de solo lectura y las cinco reglas de lxo corren sin pedir aprobación. Los comandos que modifican algo esperan aprobación en la terminal; si nadie responde a tiempo, la tarea falla.';
/** El host (bb0b013) no tiene esta cadena: texto acordado para el modo plan con un modelo que no es Sonnet. */
/** Codex read-only: límite de tamaño del informe (agents.rs, WARN_CODEX_BIG). */
export const CODEX_LARGE_REPORT_WARNING = 'Codex puede rechazar informes de más de unos 50 KB: mantén el mensaje final por debajo de ese tamaño.';
export const PLAN_MODE_MODEL_WARNING = 'en modo plan, Claude responde con Sonnet aunque pidas otro modelo';
const CLAUDE_WARNINGS = [
  'Claude no tiene sandbox del sistema operativo: los límites los aplica la propia CLI.',
  'Claude no corta la red.',
];

/** Flags por perfil, tomados solo de la tabla perfiles→flags (sin flags inventados). */
function mockFlags(provider, profile, worktree) {
  if (provider === 'claude') {
    // Mismo argv y orden que profile_flags del host (bb0b013): listas en un solo token `=`.
    if (profile === 'explorar' || profile === 'proponer') {
      return ['-p', '--output-format', 'stream-json', '--verbose', DISALLOWED_TOOLS_TOKEN, ALLOWED_TOOLS_TOKEN, '--permission-mode', 'plan'];
    }
    if (profile === 'delegar_con_revision') return [ALLOWED_TOOLS_TOKEN, '--permission-mode', 'acceptEdits'];
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
  // Igual que evaluate_for del host (5d4ce56): rol desconocido bloquea; con rol la tarea
  // hija entrega por archivo/marcadores, así que Codex sin red local queda en su estado
  // con advertencias (ningún perfil del mock da red local a Codex).
  if (role && !KNOWN_ROLES.includes(role)) return { ...p, status: 'blocked', reason: `Rol desconocido: ${role}` };
  if (role && p.provider === 'codex' && p.status !== 'blocked') {
    const readOnly = p.argv.includes('read-only');
    const warnings = [...p.warnings, readOnly ? CODEX_REPORT_MARKERS_WARNING : CODEX_REPORT_FILE_WARNING, CODEX_NO_ASK_WARNING];
    if (readOnly) warnings.push(CODEX_COPY_BLOCK_WARNING);
    return { ...p, warnings };
  }
  return p;
}

async function resolveFlags({ provider, profile, worktree, model }, opts) {
  const cli_version = opts.detectedVersion === undefined ? VERIFIED_VERSIONS[provider]?.[0] ?? null : opts.detectedVersion;
  const warnings = provider === 'claude' ? [...CLAUDE_WARNINGS, WORKTREE_WARNING] : [WORKTREE_WARNING];
  // La tabla no fija la lista de herramientas de Delegar con revisión en Claude.
  if (provider === 'claude' && profile === 'delegar_con_revision') warnings.push(ALLOWED_TOOLS_WARNING);
  const base = { profile, provider, cli_version, warnings };
  const def = PROFILES.find((p) => p.id === profile);
  if (!def || !def.enabled) {
    return { ...base, argv: [], status: 'blocked', reason: def?.disabledReason || 'Perfil no soportado' };
  }
  const flags = mockFlags(provider, profile, worktree);
  if (!flags) return { ...base, argv: [], status: 'blocked', reason: 'Proveedor no soportado' };
  const argv = [provider, ...flags];
  if (provider === 'codex' && argv.includes('read-only')) warnings.push(CODEX_LARGE_REPORT_WARNING);
  if (provider === 'claude' && planModeIgnoresModel(argv, model)) warnings.push(PLAN_MODE_MODEL_WARNING);
  if (!cli_version) return { ...base, argv, status: 'blocked', reason: `No se detectó la CLI de ${provider}` };
  const verified = VERIFIED_VERSIONS[provider] || [];
  if (!verified.includes(cli_version)) {
    return { ...base, argv, status: 'unverified', reason: `Versión ${cli_version} distinta de las verificadas (${verified.join(', ')})` };
  }
  return { ...base, argv, status: 'ok', reason: null };
}


/** Sonnet por alias o id (`sonnet`, `claude-sonnet-4-5`…), como same_model_family del host. */
const isSonnet = (m) => /(^|-)sonnet($|-)/.test(String(m).trim().toLowerCase());

/** Solo el mock decide esto; la UI se limita a pintar `warnings`. */
function planModeIgnoresModel(argv, model) {
  const i = argv.indexOf('--permission-mode');
  return i >= 0 && argv[i + 1] === 'plan' && Boolean(model && String(model).trim()) && !isSonnet(model);
}

/**
 * argv de lanzamiento simulado: el host solo añade detrás modelo, esfuerzo y `--` antes del prompt.
 * @param {{ argv: string[] }} policy
 * @param {{ model?: string|null, effort?: string|null, prompt: string }} extra
 */
export function mockLaunchArgv(policy, { model, effort, prompt }) {
  const out = [...policy.argv];
  if (model) out.push('--model', model);
  if (effort) out.push('--effort', effort);
  out.push('--', prompt);
  return out;
}
