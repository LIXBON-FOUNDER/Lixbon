// F6 read contracts. Core remains the authority for identities, ownership and local locations.
const fail = (name, detail) => { throw new Error(`ade_query_invalid_response: ${name}: ${detail}`); };
const text = (v) => typeof v === 'string' && v.length > 0;
const id = (v) => text(v) && /^[A-Za-z0-9._-]{1,200}$/.test(v);
export const relativeFile = (v) => text(v) && v.length <= 1024 && !/[\\:%\u0000-\u001f\u007f]/.test(v)
  && v.split('/').every((p) => p && p !== '.' && p !== '..');
const fields = (input, keys) => Object.fromEntries(keys.filter((k) => input[k] !== undefined && input[k] !== null).map((k) => [k, input[k]]));
const targetKeys = ['project_id', 'task_id', 'attempt_id', 'view', 'file', 'line', 'revision'];

export function validateLink(r) {
  const t = r?.target;
  if (r?.v !== 1 || !['ready', 'stale'].includes(r.status) || !text(r.canonical) || !r.canonical.startsWith('lixbon://project/')
    || r.canonical.length > 2048 || !id(t?.project_id) || (t.task_id != null && !id(t.task_id))
    || (t.attempt_id != null && (!id(t.attempt_id) || !t.task_id))
    || (t.view != null && !['overview', 'activity', 'diff', 'review', 'artifact'].includes(t.view))
    || (['diff', 'review', 'artifact'].includes(t.view) && !t.attempt_id)
    || (t.file != null && !relativeFile(t.file))
    || (t.line != null && (!t.file || !Number.isSafeInteger(t.line) || t.line < 1 || t.line > 10000000))
    || (t.revision != null && !/^[a-fA-F0-9]{7,64}$/.test(t.revision))
    || !['not_requested', 'current', 'stale', 'unknown'].includes(r.revision?.state)
    || ((r.status === 'ready') !== ['not_requested', 'current'].includes(r.revision?.state))) fail('deep_link', 'destino o revisión inválidos');
  try {
    const u = new URL(r.canonical);
    const path = `/${t.project_id}${t.task_id ? `/task/${t.task_id}` : ''}${t.attempt_id ? `/attempt/${t.attempt_id}` : ''}`;
    const keys = [...u.searchParams.keys()];
    if (u.protocol !== 'lixbon:' || u.hostname !== 'project' || u.username || u.password || u.port || u.hash || u.pathname !== path
      || new Set(keys).size !== keys.length || keys.some((k) => !['view', 'file', 'line', 'revision', 'v'].includes(k))
      || (u.searchParams.has('v') && u.searchParams.get('v') !== '1')) fail('deep_link', 'URL canónica inválida');
    for (const k of ['view', 'file', 'line', 'revision']) if (u.searchParams.get(k) !== (t[k] == null ? null : String(t[k]))) fail('deep_link', 'URL y destino diferentes');
  } catch { fail('deep_link', 'URL canónica inválida'); }
  return r;
}

export function validateWorkspace(r, args) {
  if (r?.v !== 1 || r.attempt_id !== args.attempt_id || !id(r.project_id) || !id(r.task_id) || !id(r.worktree_id)
    || !text(r.root) || (args.file && !text(r.file))) fail('attempt_workspace', 'ubicación o identidad inválida');
  return r;
}

export function validateOwnership(r, args) {
  const o = r?.owner;
  const validAttempt = (a) => id(a?.id) && id(a?.task_id) && text(a?.status) && text(a?.provider) && ['human', 'agent'].includes(a?.held_by);
  if (r?.v !== 1 || r.project_id !== args.project_id || r.path !== args.path
    || !['owned', 'none', 'ambiguous'].includes(o?.state) || !Array.isArray(o.candidates)
    || (o.state === 'owned' && !validAttempt(o.attempt)) || (o.state !== 'owned' && o.attempt != null)
    || !o.candidates.every(validAttempt) || !Array.isArray(r.touched_by)
    || !r.touched_by.every((a) => id(a.attempt_id) && id(a.task_id))
    || (r.revision != null && !['current', 'stale', 'unknown'].includes(r.revision?.state))) fail('work_at', 'propiedad inválida');
  return r;
}

export function validateReturn(r, args) {
  if (r?.v !== 1 || r.attempt_id !== args.attempt_id || !['human', 'agent'].includes(r.owner)
    || typeof r.can_return !== 'boolean' || (r.can_return && r.owner !== 'human')
    || (r.human_changes != null && (r.human_changes.provenance !== 'verified'
      || !Array.isArray(r.human_changes.gaps)))) fail('attempt_return_preview', 'devolución inválida');
  return r;
}

export const F6_QUERY_SPECS = {
  deep_link_resolve: { request: (i) => ({ url: i.url }), validate: validateLink },
  deep_link_generate: { request: (i) => fields(i, targetKeys), validate: validateLink },
  project_workspace: { request: (i) => fields(i, ['project_id', 'file']), validate: (r, a) => {
    if (r?.v !== 1 || r.project_id !== a.project_id || !text(r.root) || (a.file && !text(r.file))) fail('project_workspace', 'ubicación inválida');
    return r;
  } },
  attempt_workspace: { request: (i) => fields(i, ['attempt_id', 'file']), validate: validateWorkspace },
  work_at: { request: (i) => fields(i, ['project_id', 'path', 'worktree_id', 'revision']), validate: validateOwnership },
  attempt_return_preview: { request: (i) => ({ attempt_id: i.attempt_id }), validate: validateReturn },
};
