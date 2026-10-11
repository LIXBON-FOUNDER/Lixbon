// terminalApprovalContract.js — contrato con el host para la espera de aprobación en la
// terminal del agente y los motivos de fallo por tiempo. Nombres confirmados por el equipo;
// el host (bb0b013) todavía no los emite.
// Todos los nombres viven aquí: si el host los cambia, se renombran solo en este archivo.

export const TERMINAL_APPROVAL = Object.freeze({
  /** Valor de `status` de la tarea/intento mientras la CLI espera aprobación en su terminal. */
  status: 'awaiting_terminal_approval',
  /** Campo opcional: límite de la espera, ms desde epoch (se acepta también ISO). */
  deadlineField: 'approval_deadline',
  /** Campo con el motivo del fallo y su valor cuando venció la espera. */
  failureField: 'failure_reason',
  timeoutReason: 'terminal_approval_timeout',
});

/** Valores de `failure_reason` que la UI sabe explicar. */
export const FAILURE_REASONS = Object.freeze({
  terminalApprovalTimeout: TERMINAL_APPROVAL.timeoutReason,
  agentIdleTimeout: 'agent_idle_timeout',
});

export const TERMINAL_APPROVAL_TEXT = Object.freeze({
  waiting: 'Esperando aprobación en la terminal',
  hint: 'Ve a la terminal del agente para aprobar o rechazar.',
  timeout: 'Nadie aprobó en la terminal a tiempo',
});

export const FAILURE_REASON_TEXT = Object.freeze({
  [FAILURE_REASONS.terminalApprovalTimeout]: TERMINAL_APPROVAL_TEXT.timeout,
  [FAILURE_REASONS.agentIdleTimeout]: 'El agente no escribió nada durante demasiado tiempo',
});

const T = TERMINAL_APPROVAL;
export const isAwaitingTerminalApproval = (task) => task?.status === T.status;
export const isTerminalApprovalTimeout = (task) => task?.status === 'failed' && task?.[T.failureField] === T.timeoutReason;
/** Texto del motivo de fallo conocido de una tarea fallida; null si no hay o no se conoce. */
export const failureReasonText = (task) => (task?.status === 'failed' ? FAILURE_REASON_TEXT[task?.[T.failureField]] ?? null : null);
export const approvalDeadline = (task) => task?.[T.deadlineField];

/** Igual que toMs/countdown de PendingSpawns (aprobacion-de-lanzamientos-completa), que no está en esta rama. */
export function toMs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return NaN;
}

export function countdown(deadline, now) {
  const ms = toMs(deadline) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'vencido';
  const s = Math.floor(ms / 1000);
  return `vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
