// Contrato del comando Tauri `orch_resolve_policy` (lo implementa el host Rust;
// todavía no existe). La UI solo consume esta forma.

/** Ids que usa el host (agents.rs); las etiquetas legibles solo viven en la UI. */
export type PolicyProvider = 'claude' | 'codex';
export type PolicyProfile = 'explorar' | 'proponer' | 'delegar_con_revision' | 'autonomia_amplia';
export type PolicyStatus = 'ok' | 'blocked' | 'unverified';

export interface ResolvePolicyArgs {
  provider: PolicyProvider;
  profile: PolicyProfile;
  /** Rol de la tarea (explorador, implementador, revisor, escalado, adversario).
      null o vacío = solo consulta de flags (al host se envía ''). Rol desconocido = blocked. */
  role: string | null;
  worktree: string;
  /** Modelo pedido (alias o id). Hoy solo lo usa el mock para la advertencia del modo plan. */
  model?: string | null;
}

export interface EffectivePolicy {
  profile: PolicyProfile;
  /** Rol con el que se resolvió; null si fue una consulta sin rol. */
  role: string | null;
  provider: PolicyProvider;
  /** argv exacto con el que se lanzaría la CLI. */
  argv: string[];
  /** Versión detectada con `--version`; null si no se pudo leer. */
  cli_version: string | null;
  warnings: string[];
  status: PolicyStatus;
  /** Motivo del estado (obligatorio cuando es blocked o unverified). */
  reason: string | null;
}

export type PolicyResolver = (args: ResolvePolicyArgs) => Promise<EffectivePolicy>;

/** Lo que entrega la vista al lanzar; nombres compatibles con spawn del host. */
export interface PolicyLaunch extends EffectivePolicy {
  /** true solo si status es 'unverified' y se marcó la confirmación. */
  ack_unverified: boolean;
}
