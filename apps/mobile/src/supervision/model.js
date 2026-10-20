// supervision/model.js — reglas del prototipo de supervisión (Sprint D): qué
// pide atención, cuándo los datos están al día, desactualizados o sin
// conexión, y qué se puede decidir desde el teléfono. Sin React ni red para
// poder probarlo con `node --test`.

export const STALE_AFTER_MS = 60 * 1000;

// Una revisión deja de caber en el teléfono por tamaño o por tocar zonas
// delicadas: entonces se escala a Desktop.
export const REVIEW_LIMITS = { files: 12, lines: 400 };
const SENSITIVE_PATHS = /(^|\/)(migrations?|auth|infra|\.github|secrets?)(\/|$)|\.env/i;

// Orden de la bandeja de atención: lo que bloquea al agente va primero.
const ATTENTION_RANK = { approval: 0, question: 1, failed: 2, review: 3 };

/// Conexión del teléfono con el gateway: sin red es «sin conexión»; con red
/// pero sin sincronizar hace rato, «desactualizado». Ninguno es un fallo.
export function connectionState({ deviceOnline, syncedAt }, now) {
  if (!deviceOnline) return 'offline';
  if (now - syncedAt > STALE_AFTER_MS) return 'stale';
  return 'online';
}

/// Estado de un host (Desktop o CLI) según su último latido.
export function hostState(host, now) {
  if (!host || !host.connected) return 'offline';
  if (now - host.lastSeenAt > STALE_AFTER_MS) return 'stale';
  return 'online';
}

/// Lo que piden las tareas, derivado SOLO de su estado: leer un aviso no la
/// vacía, y un aviso sin leer de algo resuelto no la llena (atención ≠ no leído).
export function attention(tasks) {
  const items = [];
  for (const task of tasks) {
    if (task.pending) {
      items.push({ taskId: task.id, kind: task.pending.kind, title: task.pending.title, since: task.pending.at });
    } else if (task.status === 'failed') {
      const last = task.attempts[task.attempts.length - 1];
      items.push({ taskId: task.id, kind: 'failed', title: `Falló el intento ${last ? last.n : ''}`.trim(), since: last ? last.endedAt : 0 });
    }
  }
  return items.sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || a.since - b.since);
}

export const unreadCount = (notifications) => notifications.filter((n) => !n.read).length;

export function reviewComplexity(review) {
  const lines = review.additions + review.deletions;
  if (review.files.length > REVIEW_LIMITS.files || lines > REVIEW_LIMITS.lines) return 'high';
  if (review.files.some((f) => SENSITIVE_PATHS.test(f.path))) return 'high';
  return 'normal';
}

/// La revisión se generó sobre un commit que ya no es la punta de la rama.
export const isReviewStale = (review, task) => review.baseSha !== task.headSha;

const hasContext = (task) => !!(task && task.hostId && task.target && task.target.branch && task.policy && task.policy.level);

/// Qué hace la acción principal de una decisión:
///   send      se manda ahora
///   queue     queda en cola y se manda al reconectar (se muestra como pendiente)
///   refresh   hay que actualizar antes de decidir (datos o revisión viejos)
///   desktop   no se decide desde el teléfono
///   blocked   no se puede (falta contexto o no hay conexión)
export function decide(kind, { task, host, connection, now }) {
  if (!hasContext(task)) return { mode: 'blocked', reason: 'Falta el destino, el host o la política de esta tarea.' };
  if (kind === 'approval' && task.policy.level === 'elevated') {
    return { mode: 'desktop', reason: 'La política elevada solo se aprueba en Desktop.' };
  }
  if (kind === 'review') {
    const review = task.pending && task.pending.review;
    if (!review) return { mode: 'blocked', reason: 'No hay revisión.' };
    if (reviewComplexity(review) === 'high') return { mode: 'desktop', reason: 'Revisión grande o en zonas delicadas: se revisa en Desktop.' };
    if (isReviewStale(review, task)) return { mode: 'refresh', reason: 'La rama cambió desde que se generó la revisión.' };
  }
  const queueable = kind === 'question';
  if (connection === 'offline') {
    return queueable
      ? { mode: 'queue', reason: 'Sin conexión: la respuesta queda en cola hasta reconectar.' }
      : { mode: 'blocked', reason: 'Sin conexión: esto no se decide con datos guardados.' };
  }
  if (connection === 'stale') return { mode: 'refresh', reason: 'Los datos están desactualizados: actualiza antes de decidir.' };
  const hs = hostState(host, now);
  if (hs === 'offline') {
    return queueable
      ? { mode: 'queue', reason: `${host ? host.name : 'El host'} no está conectado: la respuesta le llega al volver.` }
      : { mode: 'blocked', reason: `${host ? host.name : 'El host'} no está conectado.` };
  }
  if (hs === 'stale') return { mode: 'refresh', reason: `${host.name} no responde desde hace rato: actualiza antes de decidir.` };
  return { mode: 'send', reason: '' };
}

/// Host donde se abriría la tarea en Desktop: el suyo si está conectado, si no
/// otro Desktop conectado; null si no hay ninguno (no se finge el traspaso).
export function desktopHandoff(task, hosts, now) {
  const own = hosts.find((h) => h.id === task.hostId);
  if (own && own.kind === 'desktop' && hostState(own, now) !== 'offline') return own;
  return hosts.find((h) => h.kind === 'desktop' && hostState(h, now) === 'online') || null;
}

// ── Avisos push: sin secretos ni diffs ──────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(password|passwd|secret|token)\s*[:=]\s*\S+/i,
];
const DIFF_PATTERN = /^(diff --git|@@ |\+\+\+ |--- )/m;

export const containsSecret = (text) => SECRET_PATTERNS.some((rx) => rx.test(String(text)));
export const containsDiff = (text) => DIFF_PATTERN.test(String(text));

const PUSH_TITLE = {
  question: 'Un agente te pregunta algo',
  approval: 'Un agente pide aprobación',
  review: 'Revisión lista',
  failed: 'Un intento falló',
  done: 'Tarea terminada',
};

/// Lo que viaja en el push: el tipo, el proyecto y el título de la tarea. El
/// comando, la pregunta y el diff se ven al abrir la app, nunca en el aviso.
export function pushPayload(notification, task, project) {
  const body = [project && project.name, task && task.title].filter(Boolean).join(' · ');
  const safe = containsSecret(body) || containsDiff(body) ? 'Abre Lixbon para verlo' : body;
  return { title: PUSH_TITLE[notification.kind] || 'Lixbon', body: safe, data: { taskId: notification.taskId } };
}

// ── Formato ─────────────────────────────────────────────────────────────────

export function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function duration(from, to) {
  const m = Math.max(0, Math.round((to - from) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
