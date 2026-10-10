// Tipos del comando Tauri `orch_integrate` (no pasa por orch_call ni por el servidor HTTP).
// Siempre resuelve Ok con un `outcome`; solo los errores de uso (llamada desde un agente,
// falta la confirmación, tarea sin rama, tarea raíz, tarea en curso) llegan como promesa
// rechazada con texto.

export interface IntegrateArgs {
  task: string;
  /** Siempre true: lo pone el diálogo solo tras la confirmación explícita de la persona. */
  confirm: boolean;
  squash?: boolean;
  /** found_commit de la respuesta target_moved anterior. Solo se envía si la persona marcó la segunda confirmación. */
  accept_moved_target?: string;
}

interface Base { task: string; decision: string; branch: string }

export interface IntegrateMerged extends Base {
  outcome: 'merged';
  into: string;
  base_commit: string;
  result_commit: string;
  conflicts: null;
  message: string;
  hint: string;
}

/** Conflicto: el host abortó el merge; la rama destino no cambió. */
export interface IntegrateConflict extends Base {
  outcome: 'conflict';
  into: string;
  base_commit: string;
  result_commit: null;
  conflicts: string[];
  message: string;
  hint: string;
}

/** La rama destino se movió fuera de orch_integrate; no se integró nada. */
export interface IntegrateTargetMoved extends Base {
  outcome: 'target_moved';
  into: string;
  expected_commit: string;
  found_commit: string;
  message: string;
}

/** Fallo resuelto (p. ej. cambios sin commit en la rama destino); no se integró nada. */
export interface IntegrateError extends Partial<Base> {
  outcome: 'error';
  message: string;
  [k: string]: unknown;
}

export interface IntegrateAlreadyMerged extends Base {
  outcome: 'already_merged';
}

/** No hay una revisión de diff aceptada para el head actual de la rama; no se integró nada. */
export interface IntegrateReviewRequired extends Partial<Base> {
  outcome: 'review_required';
  message?: string;
  head_commit?: string;
}

export type IntegrateResult =
  | IntegrateMerged | IntegrateConflict | IntegrateTargetMoved | IntegrateError | IntegrateAlreadyMerged
  | IntegrateReviewRequired;

export type IntegrateFn = (args: IntegrateArgs) => Promise<IntegrateResult>;
