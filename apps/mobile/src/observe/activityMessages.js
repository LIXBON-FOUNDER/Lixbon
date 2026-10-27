// observe/activityMessages.js — COPIA de apps/desktop/src/ade/activityMessages.js (LXO-92/99) para Mobile.
// El Core devuelve claves de Activity y cada cliente las traduce; la app móvil no puede importar de Desktop,
// así que se copia tal cual (como los tokens de diseño). activityMessages.test.js falla si las claves de las
// dos copias dejan de coincidir: al cambiar una, cambiar la otra en el mismo PR.

const MAX_ARGUMENT_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 480;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export const ACTIVITY_V1_MESSAGE_KEYS = Object.freeze([
  'activity.run.created',
  'activity.run.closed',
  'activity.run.removed',
  'activity.task.created',
  'activity.task.starting',
  'activity.task.running',
  'activity.task.waiting',
  'activity.task.awaiting_terminal_approval',
  'activity.task.done',
  'activity.task.failed',
  'activity.task.stopped',
  'activity.task.exited',
  'activity.task.phase_done',
  'activity.task.phase_started',
  'activity.task.question',
  'activity.task.reply',
  'activity.task.removed',
  'activity.task.review_requested',
  'activity.decision.review.accepted',
  'activity.decision.review.rejected',
  'activity.decision.merge.merged',
  'activity.decision.merge.conflict',
  'activity.decision.merge.error',
  'activity.decision.merge.target_moved',
  'activity.decision.pr.created',
  'activity.decision.pr.already_exists',
  'activity.decision.pr.error',
  'activity.effect.git_merge.merged',
  'activity.effect.git_merge.conflict',
  'activity.effect.git_merge.error',
  'activity.effect.git_push_pr.created',
  'activity.effect.git_push_pr.already_exists',
  'activity.effect.git_push_pr.error',
  'activity.effect.git_worktree.created',
  'activity.effect.git_worktree.removed',
  'activity.effect.process.launched',
  'activity.effect.process.not_launched',
  'activity.project.registered',
  'activity.project.location_added',
  'activity.project.archived',
  'activity.project.restored',
  'activity.project.relocated',
  'activity.spawn.requested',
  'activity.spawn.approved',
  'activity.spawn.rejected',
  'activity.spawn.launch_failed',
  'activity.spawn.timeout',
  'activity.spawn.coordinator_closed',
  'activity.spawn.cancelled_run_removed',
  'activity.environment.blocked',
  'activity.environment.cleared',
  'activity.attention.risk_acted',
  'activity.attention.created',
  'activity.attention.resolved',
  // Modelo Task/Attempt (LXO-233): intención de la Task, ejecución del Attempt y sus entidades.
  'activity.task.intent_created',
  'activity.task.updated',
  'activity.task.discarded',
  'activity.task.restored',
  'activity.attempt.requested',
  'activity.attempt.continued',
  'activity.attempt.approved',
  'activity.attempt.rejected',
  'activity.attempt.started',
  'activity.attempt.completed',
  'activity.attempt.failed',
  'activity.attempt.stopped',
  'activity.attempt.waiting',
  'activity.attempt.awaiting_terminal_approval',
  'activity.attempt.resumed',
  'activity.attempt.exited',
  'activity.attempt.integrated',
  'activity.provider_session.opened',
  'activity.provider_session.bound',
  'activity.provider_session.resumed',
  'activity.provider_session.detached',
  'activity.provider_session.closed',
  'activity.thread.created',
  'activity.thread.summarized',
  'activity.worktree.created',
  'activity.worktree.adopted',
  'activity.worktree.attached',
  'activity.worktree.missing',
  'activity.worktree.found',
  'activity.worktree.removed',
  'activity.artifact.created',
  'activity.review.accepted',
  'activity.review.rejected',
  'activity.review.invalidated',
  'activity.core.agentic_cut',
  'activity.unknown',
]);

const KEY_SET = new Set(ACTIVITY_V1_MESSAGE_KEYS);
const TASK_STATUSES = new Set([
  'starting',
  'running',
  'waiting',
  'awaiting_terminal_approval',
  'done',
  'failed',
  'stopped',
  'exited',
]);
const UNKNOWN_EVENT_REASONS = new Set(['unknown_kind', 'unsupported_version', 'invalid_payload']);
const PROJECT_ORIGINS = {
  manual: 'registro manual',
  auto: 'registro automático',
  backfill: 'carga histórica',
  import: 'importación',
};
const ENVIRONMENT_CODES = {
  cli_missing: 'falta la CLI',
  cli_flags_unsupported: 'la CLI no admite estas opciones',
  windows_sandbox_elevated: 'el entorno de Windows requiere elevación',
  windows_sandbox_setup: 'el sandbox de Windows no está listo o está en uso',
};
const ATTENTION_CATEGORIES = {
  question: 'pregunta',
  approval: 'aprobación',
  review_ready: 'revisión lista',
  conflict: 'conflicto',
  failed: 'fallo',
  environment_blocked: 'entorno bloqueado',
  risk: 'riesgo',
};
const ATTENTION_SEVERITIES = {
  critical: 'crítica',
  high: 'alta',
  medium: 'media',
  low: 'baja',
};
const RESOLUTIONS = {
  acted: 'se tomó una acción',
  condition_cleared: 'la condición dejó de ocurrir',
  superseded: 'fue reemplazada por otra incidencia',
};
const INTENT_FIELDS = { title: 'el título', spec: 'el encargo' };
const STOP_CAUSES = new Set(['cancelled', 'run_closed']);
const ACTIVE_FROM = new Set(['starting', 'running', 'waiting', 'awaiting_terminal_approval']);
const ATTEMPT_FAILURES = {
  launch_failed: 'no llegó a arrancar',
  terminal_approval_timeout: 'nadie aprobó en la terminal a tiempo',
  agent_idle_timeout: 'el agente dejó de dar señales',
  agent_reported: 'el agente informó el fallo',
};
const SESSION_BINDINGS = { stream_json: 'por stream-json', session_id: 'por su id de sesión' };
const CONTINUITY_REASONS = {
  requested: 'pedido',
  provider_changed: 'cambió el proveedor',
  resume_unsupported: 'el proveedor no puede reanudar',
  session_unavailable: 'no había una sesión que reanudar',
  session_expired: 'la sesión caducó',
};
const SESSION_CLOSED_FROM = new Set(['open', 'idle']);
const WORKTREE_REMOVAL = { integrated: 'integrado', discarded: 'descartado', gone: 'ya no existía' };
const ARTIFACT_KINDS = {
  report: 'un informe',
  pull_request: 'un pull request',
  last_message: 'su último mensaje',
  commit: 'un commit',
  file: 'un archivo',
};

function safeText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > MAX_ARGUMENT_LENGTH
    ? `${normalized.slice(0, MAX_ARGUMENT_LENGTH - 1)}…`
    : normalized;
}

function requiredText(args, key) {
  return safeText(args[key]);
}

function optionalText(args, key) {
  if (args[key] === undefined || args[key] === null) return null;
  return safeText(args[key]);
}

function requiredNumber(args, key) {
  const value = args[key];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredIdentifier(args, key) {
  const value = args[key];
  if (typeof value === 'string') return safeText(value);
  return requiredNumber(args, key);
}

function optionalNumber(args, key) {
  if (args[key] === undefined || args[key] === null) return null;
  return requiredNumber(args, key);
}

function requiredBoolean(args, key) {
  return typeof args[key] === 'boolean' ? args[key] : null;
}

function requiredCode(args, key, allowed) {
  const value = args[key];
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function requiredArguments(...values) {
  return values.every((value) => value !== null);
}

function optionalDetails(parts) {
  const present = parts.filter(Boolean);
  return present.length ? ` (${present.join('; ')})` : '';
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function formatMerge(key, args) {
  const decision = requiredNumber(args, 'decision_id');
  const branch = requiredText(args, 'branch');
  const squash = requiredBoolean(args, 'squash');
  const conflicts = optionalNumber(args, 'conflict_count');
  if (!requiredArguments(decision, branch, squash) || (args.conflict_count != null && conflicts === null)) return null;
  const subject = `la rama «${branch}» (decisión ${decision})`;
  if (key.endsWith('.merged')) {
    return `Se integró ${subject}${squash ? ' mediante squash' : ''}.`;
  }
  if (key.endsWith('.conflict')) {
    return `Hubo conflictos al integrar ${subject}${conflicts === null ? '' : ` (${plural(conflicts, 'conflicto', 'conflictos')})`}.`;
  }
  if (key.endsWith('.target_moved')) return `No se integró ${subject} porque cambió el destino.`;
  return `Falló la integración de ${subject}.`;
}

function formatPullRequest(key, args, idField, idLabel) {
  const id = requiredIdentifier(args, idField);
  const branch = requiredText(args, 'branch');
  const hasUrl = requiredBoolean(args, 'has_pr_url');
  if (!requiredArguments(id, branch, hasUrl)) return null;
  const suffix = hasUrl ? ' con enlace al pull request' : '';
  if (key.endsWith('.created')) return `Se creó un pull request para «${branch}» (${idLabel} ${id})${suffix}.`;
  if (key.endsWith('.already_exists')) return `Ya existe un pull request para «${branch}» (${idLabel} ${id})${suffix}.`;
  return `No se pudo crear el pull request para «${branch}» (${idLabel} ${id})${suffix}.`;
}

function formatTaskStatus(key, args) {
  const from = requiredCode(args, 'from', TASK_STATUSES);
  const to = requiredCode(args, 'to', TASK_STATUSES);
  const cause = optionalText(args, 'cause');
  if (!requiredArguments(from, to) || (args.cause != null && cause === null)) return null;
  if (to !== key.slice('activity.task.'.length)) return null;
  const messages = {
    'activity.task.starting': 'La tarea está iniciando.',
    'activity.task.running': 'La tarea está en ejecución.',
    'activity.task.waiting': 'La tarea está en espera.',
    'activity.task.awaiting_terminal_approval': 'La tarea espera aprobación para abrir una terminal.',
    'activity.task.done': 'La tarea terminó correctamente.',
    'activity.task.failed': 'La tarea falló.',
    'activity.task.stopped': 'La tarea se detuvo.',
    'activity.task.exited': 'La tarea salió con error.',
  };
  return messages[key] ?? null;
}

/** Las claves de un Attempt nombran siempre su Task y su número: «intento N de la tarea T» (sin artículo). */
function attemptOf(args) {
  const task = requiredText(args, 'task');
  const n = requiredNumber(args, 'n');
  return requiredArguments(task, n) ? `intento ${n} de la tarea ${task}` : null;
}

function formatAttempt(key, args) {
  const attempt = attemptOf(args);
  if (!attempt) return null;
  switch (key) {
    case 'activity.attempt.approved':
      return `Se aprobó el ${attempt}.`;
    case 'activity.attempt.started':
      return `Empezó el ${attempt}.`;
    case 'activity.attempt.integrated':
      return `Se integró el trabajo del ${attempt}.`;
    case 'activity.attempt.rejected': {
      const cause = requiredCode(args, 'cause', STOP_CAUSES);
      return cause ? `Se rechazó el ${attempt}${cause === 'run_closed' ? ' al cerrarse la ejecución' : ''}.` : null;
    }
    case 'activity.attempt.completed': {
      const summary = requiredBoolean(args, 'has_summary');
      return summary === null ? null : `El ${attempt} terminó correctamente${summary ? ' con resumen' : ''}.`;
    }
    case 'activity.attempt.failed': {
      const reason = requiredCode(args, 'reason', new Set(Object.keys(ATTEMPT_FAILURES)));
      const summary = requiredBoolean(args, 'has_summary');
      return requiredArguments(reason, summary) ? `El ${attempt} falló: ${ATTEMPT_FAILURES[reason]}.` : null;
    }
    case 'activity.attempt.stopped': {
      const from = requiredCode(args, 'from', ACTIVE_FROM);
      const cause = requiredCode(args, 'cause', STOP_CAUSES);
      return requiredArguments(from, cause) ? `Se detuvo el ${attempt}${cause === 'run_closed' ? ' al cerrarse la ejecución' : ''}.` : null;
    }
    default: {
      const from = requiredCode(args, 'from', ACTIVE_FROM);
      if (from === null) return null;
      const states = {
        'activity.attempt.waiting': 'espera una respuesta',
        'activity.attempt.awaiting_terminal_approval': 'espera aprobación en la terminal',
        'activity.attempt.resumed': 'siguió en ejecución',
        'activity.attempt.exited': 'salió sin cerrarse',
      };
      return states[key] ? `El ${attempt} ${states[key]}.` : null;
    }
  }
}

function formatReview(key, args) {
  const attempt = attemptOf(args);
  const head = requiredText(args, 'head_commit');
  if (!requiredArguments(attempt, head)) return null;
  if (key === 'activity.review.invalidated') {
    const observed = requiredText(args, 'observed_head');
    return observed ? `La revisión del ${attempt} sobre ${head} dejó de valer: la rama está en ${observed}.` : null;
  }
  const comment = requiredBoolean(args, 'has_comment');
  if (comment === null) return null;
  const verdict = key === 'activity.review.accepted' ? 'aceptó' : 'rechazó';
  return `Se ${verdict} la revisión del ${attempt} sobre ${head}${comment ? ' con comentario' : ''}.`;
}

function formatSpawnResolved(key, args) {
  const hasReason = requiredBoolean(args, 'has_reason');
  const task = optionalText(args, 'task');
  if (!requiredArguments(hasReason) || (args.task != null && task === null)) return null;
  const outcomes = {
    'activity.spawn.approved': 'La solicitud de lanzamiento fue aprobada',
    'activity.spawn.rejected': 'La solicitud de lanzamiento fue rechazada',
    'activity.spawn.launch_failed': 'No se pudo iniciar la tarea solicitada',
    'activity.spawn.timeout': 'La solicitud de lanzamiento venció por tiempo',
    'activity.spawn.coordinator_closed': 'La solicitud terminó al cerrarse el coordinador',
    'activity.spawn.cancelled_run_removed': 'La solicitud se canceló al eliminarse la ejecución',
  };
  const details = [
    task ? `tarea ${task}` : null,
    hasReason ? 'con motivo registrado' : null,
  ];
  return `${outcomes[key]}${optionalDetails(details)}.`;
}

const FORMATTERS = {
  'activity.run.created': (args) => {
    const task = requiredText(args, 'root_task');
    return task ? `Se creó la ejecución para la tarea ${task}.` : null;
  },
  'activity.run.closed': (args) => {
    const forced = requiredBoolean(args, 'forced');
    const stopped = requiredNumber(args, 'stopped_total');
    if (!requiredArguments(forced, stopped)) return null;
    return `La ejecución ${forced ? 'se cerró de forma forzada' : 'se cerró'}; ${plural(stopped, 'tarea detenida', 'tareas detenidas')}.`;
  },
  'activity.run.removed': (args) => {
    const tasks = requiredNumber(args, 'tasks');
    return tasks === null ? null : `Se eliminó la ejecución junto con ${plural(tasks, 'tarea', 'tareas')}.`;
  },
  'activity.task.created': (args) => {
    const title = requiredText(args, 'title');
    const agent = requiredText(args, 'agent');
    const depth = requiredNumber(args, 'depth');
    const external = requiredBoolean(args, 'external');
    const role = optionalText(args, 'role');
    const model = optionalText(args, 'model');
    const parent = optionalText(args, 'parent');
    if (!requiredArguments(title, agent, depth, external)
      || (args.role != null && role === null)
      || (args.model != null && model === null)
      || (args.parent != null && parent === null)) return null;
    return `Se creó la tarea «${title}» para ${agent}${optionalDetails([
      role ? `rol ${role}` : null,
      model ? `modelo ${model}` : null,
      parent ? `depende de ${parent}` : null,
      `profundidad ${depth}`,
      external ? 'externa' : null,
    ])}.`;
  },
  'activity.task.starting': formatTaskStatus,
  'activity.task.running': formatTaskStatus,
  'activity.task.waiting': formatTaskStatus,
  'activity.task.awaiting_terminal_approval': formatTaskStatus,
  'activity.task.done': formatTaskStatus,
  'activity.task.failed': formatTaskStatus,
  'activity.task.stopped': formatTaskStatus,
  'activity.task.exited': formatTaskStatus,
  'activity.task.phase_done': () => 'La tarea terminó una fase.',
  'activity.task.phase_started': () => 'La tarea inició una fase.',
  'activity.task.question': (args) => {
    const message = requiredNumber(args, 'message_id');
    const to = requiredText(args, 'to');
    return requiredArguments(message, to) ? `La tarea envió la pregunta ${message} a ${to}.` : null;
  },
  'activity.task.reply': (args) => {
    const question = requiredNumber(args, 'question_id');
    const message = requiredNumber(args, 'message_id');
    return requiredArguments(question, message)
      ? `La tarea respondió a la pregunta ${question} con el mensaje ${message}.`
      : null;
  },
  'activity.task.removed': (args) => {
    const cause = requiredCode(args, 'cause', new Set(['launch_failed', 'unused']));
    if (!cause) return null;
    return cause === 'unused' ? 'Se eliminó la tarea porque no llegó a usarse.' : 'Se eliminó la tarea porque falló su lanzamiento.';
  },
  'activity.task.intent_created': (args) => {
    const title = requiredText(args, 'title');
    const depth = requiredNumber(args, 'depth');
    const parent = optionalText(args, 'parent');
    if (!requiredArguments(title, depth) || (args.parent != null && parent === null)) return null;
    return `Se creó la tarea «${title}»${optionalDetails([parent ? `depende de ${parent}` : null, `profundidad ${depth}`])}.`;
  },
  'activity.task.updated': (args) => {
    const changed = Array.isArray(args.changed) ? args.changed : null;
    const title = optionalText(args, 'title');
    if (!changed || !changed.length || !changed.every((f) => typeof f === 'string' && INTENT_FIELDS[f])
      || (args.title != null && title === null)) return null;
    const fields = changed.map((f) => INTENT_FIELDS[f]).join(' y ');
    return `Se actualizó ${fields} de la tarea${title ? ` («${title}»)` : ''}.`;
  },
  'activity.task.discarded': () => 'Se descartó la tarea.',
  'activity.task.restored': () => 'Se recuperó la tarea descartada.',
  'activity.attempt.continued': (args) => {
    const attempt = attemptOf(args);
    const fromN = requiredNumber(args, 'from_n');
    const strategy = requiredCode(args, 'strategy', new Set(['native_resume', 'context_package']));
    if (!requiredArguments(attempt, fromN, strategy)) return null;
    if (strategy === 'native_resume') {
      if (requiredCode(args, 'reason', new Set(['preferred'])) === null) return null;
      return `El ${attempt} continúa el intento ${fromN} reanudando la sesión del proveedor.`;
    }
    const reason = requiredCode(args, 'reason', new Set(Object.keys(CONTINUITY_REASONS)));
    return reason ? `El ${attempt} continúa el intento ${fromN} con un paquete de contexto (${CONTINUITY_REASONS[reason]}).` : null;
  },
  'activity.attempt.requested': (args) => {
    const attempt = attemptOf(args);
    const provider = requiredText(args, 'provider');
    const external = requiredBoolean(args, 'external');
    const approval = requiredBoolean(args, 'approval_required');
    const optional = ['model', 'effort', 'role', 'profile'].map((k) => [k, optionalText(args, k)]);
    if (!requiredArguments(attempt, provider, external, approval)
      || optional.some(([k, v]) => args[k] != null && v === null)) return null;
    const [model, effort, role, profile] = optional.map(([, v]) => v);
    return `Se pidió el ${attempt} con ${provider}${optionalDetails([
      role ? `rol ${role}` : null,
      model ? `modelo ${model}` : null,
      effort ? `esfuerzo ${effort}` : null,
      profile ? `perfil ${profile}` : null,
      external ? 'externo' : null,
      approval ? 'pendiente de aprobación' : null,
    ])}.`;
  },
  'activity.attempt.approved': formatAttempt,
  'activity.attempt.rejected': formatAttempt,
  'activity.attempt.started': formatAttempt,
  'activity.attempt.completed': formatAttempt,
  'activity.attempt.failed': formatAttempt,
  'activity.attempt.stopped': formatAttempt,
  'activity.attempt.waiting': formatAttempt,
  'activity.attempt.awaiting_terminal_approval': formatAttempt,
  'activity.attempt.resumed': formatAttempt,
  'activity.attempt.exited': formatAttempt,
  'activity.attempt.integrated': formatAttempt,
  'activity.provider_session.opened': (args) => {
    const attempt = attemptOf(args);
    const provider = requiredText(args, 'provider');
    const resumable = requiredBoolean(args, 'resumable');
    const bound = requiredBoolean(args, 'bound');
    if (!requiredArguments(attempt, provider, resumable, bound)) return null;
    return `Se abrió una sesión de ${provider} en el ${attempt}${optionalDetails([resumable ? 'reanudable' : null, bound ? 'vinculada' : null])}.`;
  },
  'activity.provider_session.bound': (args) => {
    const task = requiredText(args, 'task');
    const binding = requiredCode(args, 'binding', new Set(Object.keys(SESSION_BINDINGS)));
    return requiredArguments(task, binding) ? `La sesión de la tarea ${task} quedó vinculada ${SESSION_BINDINGS[binding]}.` : null;
  },
  'activity.provider_session.resumed': (args) => {
    const task = requiredText(args, 'task');
    const n = requiredNumber(args, 'n');
    return requiredArguments(task, n) ? `Se reanudó la sesión de la tarea ${task} en el intento ${n}.` : null;
  },
  'activity.provider_session.detached': (args) => {
    const task = requiredText(args, 'task');
    return task ? `La sesión de la tarea ${task} quedó en espera.` : null;
  },
  'activity.provider_session.closed': (args) => {
    const task = requiredText(args, 'task');
    const from = requiredCode(args, 'from', SESSION_CLOSED_FROM);
    return requiredArguments(task, from) ? `Se cerró la sesión de la tarea ${task}.` : null;
  },
  'activity.thread.created': (args) => {
    const task = requiredText(args, 'task');
    return task ? `Se abrió la conversación de la tarea ${task}.` : null;
  },
  'activity.thread.summarized': (args) => {
    const task = requiredText(args, 'task');
    const summary = requiredBoolean(args, 'has_summary');
    if (!requiredArguments(task, summary)) return null;
    return summary ? `Se resumió la conversación de la tarea ${task}.` : `Se quitó el resumen de la conversación de la tarea ${task}.`;
  },
  'activity.worktree.created': (args) => {
    const attempt = attemptOf(args);
    const branch = optionalText(args, 'branch');
    if (!attempt || (args.branch != null && typeof args.branch !== 'string')) return null;
    return `Se creó el worktree del ${attempt}${branch ? ` para «${branch}»` : ''}.`;
  },
  'activity.worktree.adopted': (args) => {
    const attempt = attemptOf(args);
    const provenance = requiredCode(args, 'provenance', new Set(['adopted', 'external']));
    const branch = optionalText(args, 'branch');
    if (!requiredArguments(attempt, provenance) || (args.branch != null && typeof args.branch !== 'string')) return null;
    const what = provenance === 'external' ? 'Se registró un worktree externo' : 'Se adoptó un worktree existente';
    return `${what} en el ${attempt}${branch ? ` («${branch}»)` : ''}.`;
  },
  'activity.worktree.attached': (args) => {
    const attempt = attemptOf(args);
    return attempt ? `El ${attempt} reutiliza su worktree.` : null;
  },
  'activity.worktree.missing': (args) => {
    const task = requiredText(args, 'task');
    return task ? `No se encuentra el worktree de la tarea ${task}.` : null;
  },
  'activity.worktree.found': (args) => {
    const task = requiredText(args, 'task');
    return task ? `Se volvió a encontrar el worktree de la tarea ${task}.` : null;
  },
  'activity.worktree.removed': (args) => {
    const task = requiredText(args, 'task');
    const reason = requiredCode(args, 'reason', new Set(Object.keys(WORKTREE_REMOVAL)));
    const kept = requiredBoolean(args, 'branch_kept');
    if (!requiredArguments(task, reason, kept)) return null;
    return `Se quitó el worktree de la tarea ${task} (${WORKTREE_REMOVAL[reason]}${kept ? '; se conserva la rama' : ''}).`;
  },
  'activity.artifact.created': (args) => {
    const attempt = attemptOf(args);
    const kind = requiredCode(args, 'kind', new Set(Object.keys(ARTIFACT_KINDS)));
    const verifiable = requiredBoolean(args, 'verifiable');
    if (!requiredArguments(attempt, kind, verifiable)) return null;
    return `El ${attempt} dejó ${ARTIFACT_KINDS[kind]}${verifiable ? ' verificable' : ''}.`;
  },
  'activity.review.accepted': formatReview,
  'activity.review.rejected': formatReview,
  'activity.review.invalidated': formatReview,
  'activity.core.agentic_cut': (args) => {
    const tasks = requiredNumber(args, 'tasks');
    const attempts = requiredNumber(args, 'attempts');
    return requiredArguments(tasks, attempts)
      ? `Se pasó al modelo de tareas e intentos (${plural(tasks, 'tarea', 'tareas')}, ${plural(attempts, 'intento', 'intentos')}).`
      : null;
  },
  'activity.task.review_requested': (args) => {
    const branch = requiredText(args, 'branch');
    return branch ? `Se solicitó revisar la rama «${branch}».` : null;
  },
  'activity.decision.review.accepted': (args) => {
    const id = requiredNumber(args, 'decision_id');
    const hasComment = requiredBoolean(args, 'has_comment');
    return requiredArguments(id, hasComment)
      ? `La revisión ${id} fue aceptada${hasComment ? ' con comentario' : ' sin comentario'}.`
      : null;
  },
  'activity.decision.review.rejected': (args) => {
    const id = requiredNumber(args, 'decision_id');
    const hasComment = requiredBoolean(args, 'has_comment');
    return requiredArguments(id, hasComment)
      ? `La revisión ${id} fue rechazada${hasComment ? ' con comentario' : ' sin comentario'}.`
      : null;
  },
  'activity.decision.merge.merged': formatMerge,
  'activity.decision.merge.conflict': formatMerge,
  'activity.decision.merge.error': formatMerge,
  'activity.decision.merge.target_moved': formatMerge,
  'activity.decision.pr.created': (args) => formatPullRequest('activity.decision.pr.created', args, 'decision_id', 'decisión'),
  'activity.decision.pr.already_exists': (args) => formatPullRequest('activity.decision.pr.already_exists', args, 'decision_id', 'decisión'),
  'activity.decision.pr.error': (args) => formatPullRequest('activity.decision.pr.error', args, 'decision_id', 'decisión'),
  'activity.effect.git_merge.merged': (args) => {
    const effect = requiredText(args, 'effect_id');
    const branch = requiredText(args, 'branch');
    return requiredArguments(effect, branch) ? `El efecto ${effect} integró la rama «${branch}».` : null;
  },
  'activity.effect.git_merge.conflict': (args) => {
    const effect = requiredText(args, 'effect_id');
    const branch = requiredText(args, 'branch');
    return requiredArguments(effect, branch) ? `El efecto ${effect} encontró conflictos al integrar «${branch}».` : null;
  },
  'activity.effect.git_merge.error': (args) => {
    const effect = requiredText(args, 'effect_id');
    const branch = requiredText(args, 'branch');
    return requiredArguments(effect, branch) ? `Falló la integración de «${branch}» (efecto ${effect}).` : null;
  },
  'activity.effect.git_push_pr.created': (args) => formatPullRequest('activity.effect.git_push_pr.created', args, 'effect_id', 'efecto'),
  'activity.effect.git_push_pr.already_exists': (args) => formatPullRequest('activity.effect.git_push_pr.already_exists', args, 'effect_id', 'efecto'),
  'activity.effect.git_push_pr.error': (args) => formatPullRequest('activity.effect.git_push_pr.error', args, 'effect_id', 'efecto'),
  'activity.effect.git_worktree.created': (args) => {
    const effect = requiredText(args, 'effect_id');
    const branch = requiredText(args, 'branch');
    const base = optionalText(args, 'base');
    if (!requiredArguments(effect, branch) || (args.base != null && typeof args.base !== 'string')) return null;
    return `Se creó un worktree para «${branch}»${base ? ` desde «${base}»` : ''} (efecto ${effect}).`;
  },
  'activity.effect.git_worktree.removed': (args) => {
    const effect = requiredText(args, 'effect_id');
    const worktreeRemoved = requiredBoolean(args, 'worktree_removed');
    const branchDeleted = requiredBoolean(args, 'branch_deleted');
    const branch = optionalText(args, 'branch');
    if (!requiredArguments(effect, worktreeRemoved, branchDeleted) || (args.branch != null && typeof args.branch !== 'string')) return null;
    const details = [
      branch ? `rama «${branch}»` : null,
      branchDeleted ? 'rama eliminada' : null,
    ];
    return `${worktreeRemoved ? 'Se retiró' : 'No se retiró'} el worktree (efecto ${effect})${optionalDetails(details)}.`;
  },
  'activity.effect.process.launched': (args) => {
    const effect = requiredText(args, 'effect_id');
    return effect ? `Se inició un proceso (efecto ${effect}).` : null;
  },
  'activity.effect.process.not_launched': (args) => {
    const effect = requiredText(args, 'effect_id');
    return effect ? `No se inició el proceso (efecto ${effect}).` : null;
  },
  'activity.project.registered': (args) => {
    const name = requiredText(args, 'name');
    const origin = requiredCode(args, 'origin', new Set(Object.keys(PROJECT_ORIGINS)));
    const hasRemote = requiredBoolean(args, 'has_remote');
    return requiredArguments(name, origin, hasRemote)
      ? `Se registró el proyecto «${name}» por ${PROJECT_ORIGINS[origin]}${hasRemote ? ' con remoto' : ' sin remoto'}.`
      : null;
  },
  'activity.project.location_added': (args) => {
    const primary = requiredBoolean(args, 'primary');
    const adopted = requiredBoolean(args, 'fingerprint_adopted');
    return requiredArguments(primary, adopted)
      ? `Se añadió una ubicación al proyecto${primary ? ' como principal' : ''}${adopted ? ' y se adoptó su huella' : ''}.`
      : null;
  },
  'activity.project.archived': () => 'Se archivó el proyecto.',
  'activity.project.restored': () => 'Se restauró el proyecto.',
  'activity.project.relocated': (args) => {
    const adopted = requiredBoolean(args, 'fingerprint_adopted');
    const mismatch = requiredBoolean(args, 'confirmed_mismatch');
    return requiredArguments(adopted, mismatch)
      ? `Se reubicó el proyecto${adopted ? ' y se adoptó la huella' : ''}${mismatch ? '; se confirmó una discrepancia' : ''}.`
      : null;
  },
  'activity.spawn.requested': (args) => {
    const parent = requiredText(args, 'parent_task');
    const title = requiredText(args, 'title');
    const provider = requiredText(args, 'provider');
    const profile = requiredText(args, 'profile');
    const shared = requiredBoolean(args, 'shared');
    const policy = requiredCode(args, 'policy_status', new Set(['ok', 'blocked', 'unverified']));
    const role = optionalText(args, 'role');
    const model = optionalText(args, 'model');
    const effort = optionalText(args, 'effort');
    if (!requiredArguments(parent, title, provider, profile, shared, policy)
      || (args.role != null && role === null)
      || (args.model != null && model === null)
      || (args.effort != null && effort === null)) return null;
    const policyText = { ok: 'permitida', blocked: 'bloqueada', unverified: 'sin verificar' }[policy];
    return `Se solicitó iniciar «${title}» con ${provider} desde la tarea ${parent}${optionalDetails([
      `perfil ${profile}`,
      role ? `rol ${role}` : null,
      model ? `modelo ${model}` : null,
      effort ? `esfuerzo ${effort}` : null,
      shared ? 'compartida' : 'no compartida',
      `política ${policyText}`,
    ])}.`;
  },
  'activity.spawn.approved': formatSpawnResolved,
  'activity.spawn.rejected': formatSpawnResolved,
  'activity.spawn.launch_failed': formatSpawnResolved,
  'activity.spawn.timeout': formatSpawnResolved,
  'activity.spawn.coordinator_closed': formatSpawnResolved,
  'activity.spawn.cancelled_run_removed': formatSpawnResolved,
  'activity.environment.blocked': (args) => {
    const provider = requiredText(args, 'provider');
    const profile = requiredText(args, 'profile');
    const code = requiredCode(args, 'code', new Set(Object.keys(ENVIRONMENT_CODES)));
    return requiredArguments(provider, profile, code)
      ? `El entorno de ${provider} está bloqueado para el perfil ${profile}: ${ENVIRONMENT_CODES[code]}.`
      : null;
  },
  'activity.environment.cleared': (args) => {
    const provider = requiredText(args, 'provider');
    const profile = requiredText(args, 'profile');
    const code = requiredCode(args, 'code', new Set(Object.keys(ENVIRONMENT_CODES)));
    return requiredArguments(provider, profile, code)
      ? `Se despejó el bloqueo del entorno de ${provider} para el perfil ${profile}: ${ENVIRONMENT_CODES[code]}.`
      : null;
  },
  'activity.attention.risk_acted': (args) => {
    const resolution = requiredCode(args, 'resolution', new Set(Object.keys(RESOLUTIONS)));
    return resolution ? `Se registró una acción relacionada con un riesgo: ${RESOLUTIONS[resolution]}.` : null;
  },
  'activity.attention.created': (args) => {
    const category = requiredCode(args, 'category', new Set(Object.keys(ATTENTION_CATEGORIES)));
    const severity = requiredCode(args, 'severity', new Set(Object.keys(ATTENTION_SEVERITIES)));
    const occurrence = requiredNumber(args, 'occurrence');
    const targetKind = requiredText(args, 'target_kind');
    const targetId = requiredText(args, 'target_id');
    return requiredArguments(category, severity, occurrence, targetKind, targetId)
      ? `Se registró una incidencia de ${ATTENTION_CATEGORIES[category]} con severidad ${ATTENTION_SEVERITIES[severity]} para ${targetKind} ${targetId} (ocurrencia ${occurrence}).`
      : null;
  },
  'activity.attention.resolved': (args) => {
    const resolution = requiredCode(args, 'resolution', new Set(Object.keys(RESOLUTIONS)));
    return resolution ? `Se registró la resolución de una incidencia: ${RESOLUTIONS[resolution]}.` : null;
  },
  'activity.unknown': (args) => {
    const reason = requiredCode(args, 'reason', UNKNOWN_EVENT_REASONS);
    const kind = requiredText(args, 'kind');
    const version = requiredNumber(args, 'event_version');
    return requiredArguments(reason, kind, version)
      ? `No se reconoce el evento «${kind}» (versión ${version}, motivo: ${reason}).`
      : null;
  },
};

export function translateActivityMessage(key, args = {}) {
  if (typeof key !== 'string' || !KEY_SET.has(key)) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const formatter = FORMATTERS[key];
  if (typeof formatter !== 'function') return null;
  try {
    const result = formatter.length > 1 ? formatter(key, args) : formatter(args);
    if (typeof result !== 'string') return null;
    const bounded = result.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (!bounded) return null;
    return bounded.length > MAX_MESSAGE_LENGTH
      ? `${bounded.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
      : bounded;
  } catch {
    return null;
  }
}
