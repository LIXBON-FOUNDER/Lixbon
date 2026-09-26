import { invoke } from '@tauri-apps/api/core';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { load } from '@tauri-apps/plugin-store';

const SECRET = 'linear.token';
const STORE_KEY = 'linearToken';
const API = 'https://api.linear.app/graphql';

export const KEY_URL = 'https://linear.app/settings/account/security';

let storePromise = null;
function getStore() {
  if (!storePromise) storePromise = load('lixbon.settings.json', { autoSave: true });
  return storePromise;
}

export async function loadToken() {
  try {
    const value = await invoke('secret_get', { name: SECRET });
    if (value) return value;
  } catch { /* sin almacén del sistema: se cae al JSON */ }
  try {
    return (await (await getStore()).get(STORE_KEY)) || '';
  } catch {
    return '';
  }
}

export async function saveToken(token) {
  try {
    await invoke('secret_set', { name: SECRET, value: token });
    return;
  } catch { /* sin almacén cifrado: mejor el JSON que perder la sesión */ }
  await (await getStore()).set(STORE_KEY, token);
}

export async function deleteToken() {
  try { await invoke('secret_delete', { name: SECRET }); } catch { /* no existía */ }
  try { await (await getStore()).delete(STORE_KEY); } catch { /* no existía */ }
}

async function gql(token, query, variables = {}) {
  let res;
  try {
    res = await nativeFetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query, variables }),
      connectTimeout: 15000,
    });
  } catch (e) {
    throw new Error('No se pudo contactar con Linear: ' + (e?.message || e));
  }

  if (res.status === 401 || res.status === 400) {
    throw new Error('La API key no es válida o fue revocada.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `Linear respondió ${res.status}.`);
  if (body?.errors?.length) throw new Error(body.errors[0].message || 'Linear rechazó la consulta.');
  return body?.data;
}

export async function getViewer(token) {
  const data = await gql(token, `{ viewer { id name email avatarUrl } }`);
  return data.viewer;
}

export async function getWorkspace(token) {
  const data = await gql(
    token,
    `{
      teams(first: 50) {
        nodes {
          id key name
          projects(first: 50) { nodes { id name state } }
          states(first: 30) { nodes { id name type color position } }
        }
      }
    }`,
  );
  return data.teams.nodes;
}

export async function listIssues(token, { teamId, projectId = '', first = 40 }) {
  const filter = projectId
    ? `{ team: { id: { eq: $teamId } }, project: { id: { eq: $projectId } } }`
    : `{ team: { id: { eq: $teamId } } }`;
  const data = await gql(
    token,
    `query Issues($teamId: ID!${projectId ? ', $projectId: ID!' : ''}, $first: Int!) {
      issues(
        first: $first
        filter: ${filter}
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title url priority updatedAt
          state { id name type color }
          assignee { id name avatarUrl }
          project { id name }
        }
      }
    }`,
    projectId ? { teamId, projectId, first } : { teamId, first },
  );
  return data.issues.nodes;
}

export async function getIssue(token, id) {
  const data = await gql(
    token,
    `query Issue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority estimate dueDate
        createdAt updatedAt
        state { id name type color }
        assignee { id name displayName avatarUrl }
        creator { id name displayName avatarUrl }
        project { id name }
        parent { id identifier title }
        labels(first: 20) { nodes { id name color } }
        children(first: 20) {
          nodes { id identifier title state { name type color } }
        }
        comments(first: 50) {
          nodes {
            id body createdAt
            user { id name displayName avatarUrl }
          }
        }
      }
    }`,
    { id },
  );
  return data.issue;
}

export async function getIssueActivity(token, id) {
  const data = await gql(
    token,
    `query Historial($id: String!) {
      issue(id: $id) {
        history(first: 50) {
          nodes {
            id createdAt
            actor { id name displayName }
            fromState { name } toState { name }
            fromPriority toPriority
            fromAssignee { name displayName } toAssignee { name displayName }
            fromTitle toTitle
            fromEstimate toEstimate
          }
        }
      }
    }`,
    { id },
  );
  return data.issue?.history?.nodes || [];
}

export async function addComment(token, issueId, body) {
  const data = await gql(
    token,
    `mutation Comentar($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id body createdAt user { id name displayName avatarUrl } }
      }
    }`,
    { input: { issueId, body } },
  );
  if (!data.commentCreate?.success) throw new Error('Linear no pudo publicar el comentario.');
  return data.commentCreate.comment;
}

export async function createIssue(token, { teamId, projectId = '', title, description = '' }) {
  const data = await gql(
    token,
    `mutation Crear($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url state { id name type color } }
      }
    }`,
    { input: { teamId, title, description, ...(projectId ? { projectId } : {}) } },
  );
  if (!data.issueCreate?.success) throw new Error('Linear no pudo crear la issue.');
  return data.issueCreate.issue;
}

export async function setIssueState(token, issueId, stateId) {
  const data = await gql(
    token,
    `mutation Mover($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id state { id name type color } }
      }
    }`,
    { id: issueId, stateId },
  );
  if (!data.issueUpdate?.success) throw new Error('Linear no pudo cambiar el estado.');
  return data.issueUpdate.issue;
}

export const PRIORITIES = ['—', 'Urgente', 'Alta', 'Media', 'Baja'];

export function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d} d`;
  return `hace ${Math.round(d / 30)} meses`;
}

export function fecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}
