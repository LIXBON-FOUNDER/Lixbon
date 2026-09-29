// github.js — pull requests a través de la CLI oficial `gh`, que ya trae la
// sesión del usuario (`gh auth login`): así el IDE no guarda ningún token de
// GitHub. Solo se le pasan números y nombres de campo, nunca texto del
// usuario, porque la línea pasa por la shell.
import { runCommand } from './tauri';

const PR_LIST_FIELDS = 'number,title,author,headRefName,baseRefName,state,isDraft,reviewDecision,updatedAt,url';
const PR_VIEW_FIELDS = [
  'number', 'title', 'body', 'author', 'headRefName', 'baseRefName', 'state', 'isDraft', 'mergeable',
  'reviewDecision', 'reviews', 'reviewRequests', 'labels', 'statusCheckRollup', 'commits', 'files', 'url',
  'closingIssuesReferences', 'additions', 'deletions', 'mergedAt',
].join(',');

async function gh(args, timeout = 30000) {
  const res = await runCommand(`gh ${args}`, timeout);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'gh falló').trim().split('\n').slice(-2).join(' '));
  return res.stdout;
}

const json = async (args) => JSON.parse(await gh(args));

/** 'ok' | 'missing' (sin gh) | 'unauth' (gh sin sesión). */
export async function ghStatus() {
  const v = await runCommand('gh --version', 8000).catch(() => null);
  if (!v || v.code !== 0) return 'missing';
  const auth = await runCommand('gh auth status', 10000).catch(() => null);
  return auth && auth.code === 0 ? 'ok' : 'unauth';
}

/** Usuario con el que `gh` tiene sesión, o '' si no se sabe. */
export async function ghUser() {
  try { return (await gh('api user --jq .login', 10000)).trim(); } catch { return ''; }
}

export const listPrs = (state = 'open') => json(`pr list --state ${state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open'} --limit 40 --json ${PR_LIST_FIELDS}`);

export const viewPr = (number) => json(`pr view ${Number(number)} --json ${PR_VIEW_FIELDS}`);

/** Comentarios de revisión anclados a líneas. `slug` = owner/repo. */
export async function reviewComments(slug, number) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return [];
  const list = await json(`api repos/${slug}/pulls/${Number(number)}/comments --paginate`);
  return list.map((c) => ({
    id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body, author: c.user?.login,
    hunk: c.diff_hunk, url: c.html_url, replyTo: c.in_reply_to_id || null, createdAt: c.created_at,
  }));
}

export const mergePr = (number, method) => gh(`pr merge ${Number(number)} --${['squash', 'merge', 'rebase'].includes(method) ? method : 'squash'}`, 60000);

export const prDiff = (number) => gh(`pr diff ${Number(number)}`, 30000);

export function checkState(c) {
  if (c.__typename === 'StatusContext') {
    return { name: c.context, state: c.state === 'SUCCESS' ? 'ok' : c.state === 'PENDING' ? 'running' : 'fail' };
  }
  const running = c.status && c.status !== 'COMPLETED';
  const ok = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion);
  const secs = c.startedAt && c.completedAt ? Math.round((new Date(c.completedAt) - new Date(c.startedAt)) / 1000) : null;
  return { name: c.name || c.workflowName, state: running ? 'running' : ok ? 'ok' : 'fail', secs, url: c.detailsUrl };
}
