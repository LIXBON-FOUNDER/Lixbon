import { validateLink, relativeFile } from '../ade/f6Contract.js';

const ids = ['task_id', 'attempt_id', 'attention_id', 'project_id'];
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(v);
const allowed = new Set(['rid', ...ids, 'view', 'file', 'line', 'revision', 'open_desktop']);

export function desktopLinkRequest(raw) {
  if (Object.keys(raw).some((k) => !allowed.has(k)) || ids.filter((k) => raw[k] != null).length !== 1
    || ids.some((k) => raw[k] != null && !validId(raw[k]))
    || (raw.open_desktop !== undefined && typeof raw.open_desktop !== 'boolean')
    || (raw.view !== undefined && !['overview', 'activity', 'diff', 'review', 'artifact'].includes(raw.view))
    || (raw.file !== undefined && !relativeFile(raw.file))
    || (raw.line !== undefined && (!raw.file || !Number.isSafeInteger(raw.line) || raw.line < 1 || raw.line > 10000000))
    || (raw.revision !== undefined && !/^[a-f0-9]{7,64}$/i.test(raw.revision))) return null;
  const { rid, ...input } = raw;
  return input;
}

/** Generates with Core; this relay never assembles a lixbon URL or accepts a client's URL. */
export async function desktopLink(input, call, openDesktop) {
  let taskId = input.task_id;
  let attemptId = input.attempt_id;
  let projectId = input.project_id;
  let attention;
  if (input.attention_id) {
    attention = await call('attention_detail', { attention_id: input.attention_id });
    if (attention?.id !== input.attention_id || attention.status !== 'active') throw new Error('link_stale: la Attention ya no está activa');
    if (attention.target_kind === 'task') taskId = attention.target_id;
    else if (attention.target_kind === 'attempt') attemptId = attention.target_id;
    else if (attention.target_kind === 'project') projectId = attention.target_id;
    else throw new Error('link_not_found: el destino de Attention no admite apertura en Desktop');
  }
  if (attemptId) {
    const detail = await call('attempt_detail_v2', { attempt_id: attemptId });
    if (detail?.attempt?.id !== attemptId || !validId(detail.attempt.task_id)) throw new Error('link_target_mismatch: Attempt inválido');
    taskId = detail.attempt.task_id;
  }
  if (taskId) {
    const detail = await call('task_detail_v2', { task_id: taskId });
    if (detail?.task?.id !== taskId || !validId(detail.task.project_id)) throw new Error('link_target_mismatch: Task inválida');
    projectId = detail.task.project_id;
    if (attention?.project_id && attention.project_id !== projectId) throw new Error('link_target_mismatch: Attention de otro proyecto');
  }
  if (!validId(projectId)) throw new Error('link_not_found: Project no disponible');
  const args = { project_id: projectId, ...(taskId && { task_id: taskId }), ...(attemptId && { attempt_id: attemptId }) };
  for (const k of ['view', 'file', 'line', 'revision']) if (input[k] !== undefined) args[k] = input[k];
  const link = validateLink(await call('deep_link_generate', args));
  if (link.target.project_id !== projectId || (taskId && link.target.task_id !== taskId) || (attemptId && link.target.attempt_id !== attemptId)) throw new Error('link_target_mismatch: enlace de otro destino');
  let open_status = link.status === 'stale' ? 'stale' : 'not_requested';
  if (input.open_desktop && link.status === 'ready') {
    try {
      if (typeof openDesktop !== 'function') throw new Error('host unavailable');
      await openDesktop(link.canonical);
      open_status = 'opened';
    } catch { open_status = 'unavailable'; }
  }
  return { link, open_status };
}
