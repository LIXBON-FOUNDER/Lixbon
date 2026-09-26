// githubApi.js — lectura del repositorio del proyecto por la API REST de
// GitHub. El token sale primero de la CLI `gh` (la misma sesión que usa el
// IDE); si no hay, del que el usuario pegue, guardado cifrado.
import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { runCommand } from '../../lib/tauri';

const SECRET = 'github.token';
const STORE_KEY = 'githubToken';
const API = 'https://api.github.com';

export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Lixbon%20Team';
export const MAX_ARCHIVO = 400 * 1024;

let storePromise = null;
const getStore = () => (storePromise ||= load('lixbon.settings.json', { autoSave: true }));

async function tokenDeGh() {
  try {
    const res = await runCommand('gh auth token', 8000);
    const token = res.code === 0 ? res.stdout.trim() : '';
    return /^[\w-]{20,}$/.test(token) ? token : '';
  } catch {
    return '';
  }
}

export async function loadToken() {
  try {
    const value = await invoke('secret_get', { name: SECRET });
    if (value) return value;
  } catch { /* sin almacén del sistema */ }
  try {
    const plain = await (await getStore()).get(STORE_KEY);
    if (plain) return plain;
  } catch { /* sin almacén */ }
  return tokenDeGh();
}

export async function saveToken(token) {
  try {
    await invoke('secret_set', { name: SECRET, value: token });
    return;
  } catch { /* sin almacén cifrado: se cae al JSON */ }
  await (await getStore()).set(STORE_KEY, token);
}

export async function deleteToken() {
  try { await invoke('secret_delete', { name: SECRET }); } catch { /* no existía */ }
  try { await (await getStore()).delete(STORE_KEY); } catch { /* no existía */ }
}

async function api(token, path) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    const err = new Error('No se pudo contactar con GitHub.');
    err.status = 0;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub respondió ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const getUser = (token) => api(token, '/user');
export const getRepo = (token, fullName) => api(token, `/repos/${fullName}`);
const listBranches = (token, fullName) => api(token, `/repos/${fullName}/branches?per_page=100`);

export function normalizeRepo(valor) {
  const crudo = String(valor || '').trim();
  if (!crudo) return '';
  const simple = crudo.replace(/^\/+|\/+$/g, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(simple)) return simple.replace(/\.git$/i, '');
  const m = crudo.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

export async function getTree(token, fullName, ref) {
  const data = await api(token, `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  return {
    entradas: (data?.tree || []).filter((n) => n.type === 'blob' || n.type === 'tree'),
    truncado: Boolean(data?.truncated),
  };
}

export async function getFileContent(token, fullName, path, ref) {
  const data = await api(
    token,
    `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ ref })}`,
  );
  const bytes = data?.size ?? 0;
  const url = data?.html_url || '';
  if (bytes > MAX_ARCHIVO || data?.encoding !== 'base64' || typeof data?.content !== 'string') {
    return { texto: '', binario: true, bytes, url };
  }
  try {
    // atob devuelve bytes: hay que decodificarlos como UTF-8 o se rompen los acentos.
    const bruto = Uint8Array.from(atob(data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    if (bruto.subarray(0, 8000).includes(0)) return { texto: '', binario: true, bytes, url };
    return { texto: new TextDecoder('utf-8').decode(bruto), binario: false, bytes, url };
  } catch {
    return { texto: '', binario: true, bytes, url };
  }
}

export function listCommits(token, fullName, { sha = '', path = '', perPage = 30 } = {}) {
  const q = new URLSearchParams({ per_page: String(perPage) });
  if (sha) q.set('sha', sha);
  if (path) q.set('path', path);
  return api(token, `/repos/${fullName}/commits?${q}`);
}

// La API de ramas no trae la fecha del último commit; se completa solo para
// las más recientes para no gastar el límite de peticiones por hora.
export async function branchesWithDates(token, fullName, { cuantas = 12 } = {}) {
  const ramas = (await listBranches(token, fullName)) || [];
  const detalladas = await Promise.all(ramas.slice(0, cuantas).map(async (r) => {
    try {
      const c = await api(token, `/repos/${fullName}/commits/${r.commit.sha}`);
      return {
        ...r,
        ultimo: {
          mensaje: (c?.commit?.message || '').split('\n')[0],
          fecha: c?.commit?.author?.date || '',
          autor: c?.author?.login || c?.commit?.author?.name || '',
          avatar: c?.author?.avatar_url || '',
        },
      };
    } catch {
      return r;
    }
  }));
  return [...detalladas, ...ramas.slice(cuantas)];
}
