// github.js — pull requests y GitHub Actions a través de la CLI oficial `gh`,
// que ya trae la sesión del usuario (`gh auth login`): así el IDE no guarda
// ningún token de GitHub. Todo pasa por `gh_exec`: argumentos sueltos, sin
// shell, y la salida entera (un JSON recortado por el principio no se parsea).
import { runCommand, ghExec } from './tauri';

const PR_LIST_FIELDS = 'number,title,author,headRefName,baseRefName,state,isDraft,reviewDecision,updatedAt,url';
const PR_VIEW_FIELDS = [
  'number', 'title', 'body', 'author', 'headRefName', 'baseRefName', 'state', 'isDraft', 'mergeable',
  'reviewDecision', 'reviews', 'reviewRequests', 'labels', 'statusCheckRollup', 'commits', 'files', 'url',
  'closingIssuesReferences', 'additions', 'deletions', 'mergedAt', 'createdAt',
].join(',');
const RUN_FIELDS = 'databaseId,number,attempt,displayTitle,name,workflowName,workflowDatabaseId,status,conclusion,event,headBranch,headSha,createdAt,startedAt,updatedAt,url';

async function gh(args, timeout = 30000) {
  const res = await ghExec(args, timeout);
  if (res.timed_out) throw new Error('GitHub tardó demasiado en responder. Prueba de nuevo.');
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'gh falló').trim().split('\n').slice(-2).join(' '));
  return res.stdout;
}

async function json(args, timeout) {
  const out = (await gh(args, timeout)).trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('GitHub devolvió una respuesta que no se pudo leer. Pulsa Actualizar para reintentar.');
  }
}

const num = (n) => String(Math.trunc(Number(n)));
const okSlug = (slug) => /^[\w.-]+\/[\w.-]+$/.test(slug || '');

/** 'ok' | 'missing' (sin gh) | 'unauth' (gh sin sesión). */
export async function ghStatus() {
  const v = await runCommand('gh --version', 8000).catch(() => null);
  if (!v || v.code !== 0) return 'missing';
  const auth = await runCommand('gh auth status', 10000).catch(() => null);
  return auth && auth.code === 0 ? 'ok' : 'unauth';
}

/** Usuario con el que `gh` tiene sesión, o '' si no se sabe. */
export async function ghUser() {
  try { return (await gh(['api', 'user', '--jq', '.login'], 10000)).trim(); } catch { return ''; }
}

// ── Pull requests ───────────────────────────────────────────────────────

export const listPrs = (state = 'open') => json(['pr', 'list', '--state', ['open', 'closed', 'all'].includes(state) ? state : 'open', '--limit', '40', '--json', PR_LIST_FIELDS]).then((l) => l || []);

export const viewPr = (number) => json(['pr', 'view', num(number), '--json', PR_VIEW_FIELDS]);

/** Comentarios de revisión anclados a líneas. `slug` = owner/repo. */
export async function reviewComments(slug, number) {
  if (!okSlug(slug)) return [];
  // --slurp junta las páginas en un solo array (sin él salen `[...][...]`).
  const pages = await json(['api', `repos/${slug}/pulls/${num(number)}/comments`, '--paginate', '--slurp']);
  return (pages || []).flat().map((c) => ({
    id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body, author: c.user?.login,
    hunk: c.diff_hunk, url: c.html_url, replyTo: c.in_reply_to_id || null, createdAt: c.created_at,
  }));
}

export const mergePr = (number, method) => gh(['pr', 'merge', num(number), `--${['squash', 'merge', 'rebase'].includes(method) ? method : 'squash'}`], 60000);

export const prDiff = (number) => gh(['pr', 'diff', num(number)], 30000);

/** Id de la ejecución de Actions a partir del enlace de un check, si lo es. */
export function runIdFromUrl(url) {
  const m = /\/actions\/runs\/(\d+)/.exec(url || '');
  return m ? Number(m[1]) : null;
}

export function checkState(c) {
  if (c.__typename === 'StatusContext') {
    return { name: c.context, state: c.state === 'SUCCESS' ? 'ok' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'running' : 'fail', url: c.targetUrl, detail: c.description };
  }
  const running = c.status && c.status !== 'COMPLETED';
  const skipped = c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL';
  const ok = c.conclusion === 'SUCCESS';
  const secs = c.startedAt && c.completedAt ? Math.round((new Date(c.completedAt) - new Date(c.startedAt)) / 1000) : null;
  return {
    name: c.name || c.workflowName,
    workflow: c.workflowName && c.workflowName !== c.name ? c.workflowName : '',
    state: running ? 'running' : ok ? 'ok' : skipped ? 'skip' : c.conclusion === 'CANCELLED' ? 'cancel' : 'fail',
    secs,
    url: c.detailsUrl,
    runId: runIdFromUrl(c.detailsUrl),
  };
}

// ── GitHub Actions ──────────────────────────────────────────────────────

export const listWorkflows = () => json(['workflow', 'list', '--all', '--limit', '100', '--json', 'id,name,path,state']).then((l) => l || []);

export function listRuns({ workflow, branch, status, limit = 40 } = {}) {
  const args = ['run', 'list', '--limit', String(limit), '--json', RUN_FIELDS];
  if (workflow) args.push('--workflow', num(workflow));
  if (branch) args.push('--branch', branch);
  if (status) args.push('--status', status);
  return json(args).then((l) => l || []);
}

export const viewRun = (id) => json(['run', 'view', num(id), '--json', `${RUN_FIELDS},jobs`]);

export const rerunRun = (id, onlyFailed) => gh(['run', 'rerun', num(id), ...(onlyFailed ? ['--failed'] : [])], 60000);
export const rerunJob = (jobId) => gh(['run', 'rerun', '--job', num(jobId)], 60000);
export const cancelRun = (id) => gh(['run', 'cancel', num(id)], 60000);
export const setWorkflowEnabled = (id, on) => gh(['workflow', on ? 'enable' : 'disable', num(id)], 30000);

/** Lanza un workflow con `workflow_dispatch`. `inputs` = { nombre: valor }. */
export function dispatchWorkflow(id, ref, inputs = {}) {
  const args = ['workflow', 'run', num(id)];
  if (ref) args.push('--ref', ref);
  for (const [k, v] of Object.entries(inputs)) {
    if (v !== '' && v != null) args.push('-f', `${k}=${v}`);
  }
  return gh(args, 60000);
}

/** Log de un job, en grupos por paso: [{ step, lines: [{ time, text }] }]. */
export async function jobLog(jobId) {
  const raw = await gh(['run', 'view', '--job', num(jobId), '--log'], 120000);
  return parseLog(raw);
}

export function parseLog(raw) {
  const groups = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    // `gh` escribe «job<TAB>paso<TAB>2026-…Z texto».
    const parts = line.split('\t');
    const step = parts.length >= 3 ? parts[1] : '';
    const rest = parts.length >= 3 ? parts.slice(2).join('\t') : line;
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/.exec(rest);
    const text = (m ? m[2] : rest).replace(/^﻿/, '');
    if (!cur || cur.step !== step) { cur = { step, lines: [] }; groups.push(cur); }
    cur.lines.push({ time: m ? m[1] : '', text });
  }
  return groups;
}

/** Entradas de `workflow_dispatch` del YAML del workflow, o null si no se
    puede lanzar a mano. Lee el archivo de GitHub en ese ref. */
export async function workflowDispatch(slug, path, ref) {
  if (!okSlug(slug) || !/^[\w./-]+$/.test(path || '')) return null;
  const args = ['api', `repos/${slug}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, '--jq', '.content'];
  const b64 = (await gh(args, 20000)).replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return parseDispatch(new TextDecoder().decode(bytes));
}

/** Lector mínimo del bloque `on.workflow_dispatch.inputs` (por sangría). */
export function parseDispatch(yaml) {
  const lines = yaml.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim());
  const indent = (l) => l.length - l.trimStart().length;
  const i = lines.findIndex((l) => /^\s*workflow_dispatch\s*:/.test(l) || /^\s*on\s*:.*\bworkflow_dispatch\b/.test(l) || /^\s*-\s*workflow_dispatch\s*$/.test(l));
  if (i < 0) return null;
  const inputs = [];
  const base = indent(lines[i]);
  let j = i + 1;
  while (j < lines.length && indent(lines[j]) > base && !/^\s*inputs\s*:/.test(lines[j])) j++;
  if (j >= lines.length || indent(lines[j]) <= base) return { inputs };
  const inBase = indent(lines[j]);
  let cur = null;
  let keyIndent = null;
  for (let k = j + 1; k < lines.length && indent(lines[k]) > inBase; k++) {
    const l = lines[k];
    const d = indent(l);
    const m = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(l);
    if (keyIndent == null) keyIndent = d;
    if (d === keyIndent && m) {
      cur = { name: m[1], description: '', type: 'string', default: '', required: false, options: [] };
      inputs.push(cur);
    } else if (cur && m) {
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'description') cur.description = v;
      else if (m[1] === 'type') cur.type = v;
      else if (m[1] === 'default') cur.default = v;
      else if (m[1] === 'required') cur.required = v === 'true';
      else if (m[1] === 'options' && v.startsWith('[')) cur.options = v.slice(1, -1).split(',').map((o) => o.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (cur && /^\s*-\s*/.test(l)) {
      cur.options.push(l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { inputs };
}

/** Estado de una ejecución o job de Actions reducido a uno de la interfaz. */
export function runState(r) {
  if (!r) return 'idle';
  if (r.status && r.status !== 'completed') return r.status === 'queued' || r.status === 'waiting' || r.status === 'pending' || r.status === 'requested' ? 'queued' : 'running';
  switch (r.conclusion) {
    case 'success': return 'ok';
    case 'failure': case 'timed_out': case 'startup_failure': return 'fail';
    case 'cancelled': return 'cancel';
    case 'skipped': case 'neutral': return 'skip';
    case 'action_required': return 'queued';
    default: return 'fail';
  }
}
