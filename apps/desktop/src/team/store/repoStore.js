import { create } from 'zustand';
import {
  loadToken, saveToken, deleteToken, getUser, getRepo, getTree, getFileContent,
  branchesWithDates, listCommits, normalizeRepo,
} from '../lib/githubApi';

const MAX_ARCHIVOS = 30;

export const useRepoStore = create((set, get) => ({
  token: null,
  usuario: null,
  estado: 'mirando',
  error: '',

  porRepo: {},
  arboles: {},
  commits: {},
  archivos: {},
  _recientes: [],

  rama: {},
  ruta: {},
  pestana: {},
  abiertas: {},

  mirarToken: async () => {
    if (get().estado !== 'mirando') return;
    const token = await loadToken();
    if (!token) { set({ token: '', estado: 'sin-token' }); return; }
    set({ token, estado: 'comprobando' });
    try {
      const usuario = await getUser(token);
      set({ usuario, estado: 'listo', error: '' });
    } catch (e) {
      set({ estado: 'error', error: e.message });
    }
  },

  conectar: async (valor) => {
    const limpio = valor.trim();
    if (!limpio) return;
    set({ estado: 'comprobando', error: '' });
    try {
      const usuario = await getUser(limpio);
      await saveToken(limpio);
      set({ token: limpio, usuario, estado: 'listo', error: '' });
    } catch (e) {
      set({ estado: 'sin-token', error: e.message });
    }
  },

  desconectar: async () => {
    await deleteToken();
    set({
      token: '', usuario: null, estado: 'sin-token', error: '',
      porRepo: {}, arboles: {}, archivos: {}, commits: {}, _recientes: [],
    });
  },

  verPestana: (repo, cual) => {
    set((s) => ({ pestana: { ...s.pestana, [repo]: cual } }));
    if (cual === 'commits') get().cargarCommits(repo, get().rama[normalizeRepo(repo)] || '');
  },

  cargarRepo: async (crudo, { forzar = false } = {}) => {
    const repo = normalizeRepo(crudo);
    const { token } = get();
    if (!token) return;
    if (!repo) {
      set((s) => ({
        porRepo: { ...s.porRepo, [crudo]: { cargando: false, error: malNombre(crudo) } },
      }));
      return;
    }
    const actual = get().porRepo[repo];
    if (actual?.cargando || (actual?.ramas && !forzar)) return;
    set((s) => ({ porRepo: { ...s.porRepo, [repo]: { ...actual, cargando: true, error: '' } } }));
    try {
      const [datos, ramas] = await Promise.all([
        getRepo(token, repo),
        branchesWithDates(token, repo),
      ]);
      const porDefecto = datos?.default_branch || ramas?.[0]?.name || '';
      set((s) => ({
        porRepo: {
          ...s.porRepo,
          [repo]: { datos, ramas: ramas || [], porDefecto, cargando: false, error: '' },
        },
        rama: { ...s.rama, [repo]: s.rama[repo] || porDefecto },
      }));
      const rama = get().rama[repo] || porDefecto;
      if (rama) {
        get().cargarArbol(repo, rama);
        get().cargarCommits(repo, rama);
      }
    } catch (e) {
      set((s) => ({
        porRepo: { ...s.porRepo, [repo]: { ...actual, cargando: false, error: mensaje(e, repo) } },
      }));
    }
  },

  cargarArbol: async (repo, rama, { forzar = false } = {}) => {
    const { token } = get();
    if (!token || !repo || !rama) return;
    const clave = `${repo}@${rama}`;
    const actual = get().arboles[clave];
    if (actual?.cargando || (actual?.entradas && !forzar)) return;
    set((s) => ({ arboles: { ...s.arboles, [clave]: { ...actual, cargando: true, error: '' } } }));
    try {
      const { entradas, truncado } = await getTree(token, repo, rama);
      set((s) => ({
        arboles: { ...s.arboles, [clave]: { entradas, truncado, cargando: false, error: '' } },
      }));
    } catch (e) {
      set((s) => ({
        arboles: { ...s.arboles, [clave]: { cargando: false, error: mensaje(e, repo) } },
      }));
    }
  },

  cargarCommits: async (repo, rama, { forzar = false } = {}) => {
    const { token } = get();
    if (!token || !repo || !rama) return;
    const clave = `${repo}@${rama}`;
    const actual = get().commits[clave];
    if (actual?.cargando || (actual?.lista && !forzar)) return;
    set((s) => ({ commits: { ...s.commits, [clave]: { ...actual, cargando: true, error: '' } } }));
    try {
      const lista = await listCommits(token, repo, { sha: rama, perPage: 30 });
      set((s) => ({ commits: { ...s.commits, [clave]: { lista, cargando: false, error: '' } } }));
    } catch (e) {
      set((s) => ({
        commits: { ...s.commits, [clave]: { cargando: false, error: mensaje(e, repo) } },
      }));
    }
  },

  elegirRama: (repo, rama) => {
    set((s) => ({
      rama: { ...s.rama, [repo]: rama },
      ruta: { ...s.ruta, [repo]: '' },
      pestana: { ...s.pestana, [repo]: 'archivos' },
    }));
    get().cargarArbol(repo, rama);
    get().cargarCommits(repo, rama);
  },

  plegar: (repo, rama, carpeta) => {
    const clave = `${repo}@${rama}`;
    set((s) => {
      const puestas = new Set(s.abiertas[clave] || []);
      if (puestas.has(carpeta)) puestas.delete(carpeta);
      else puestas.add(carpeta);
      return { abiertas: { ...s.abiertas, [clave]: [...puestas] } };
    });
  },

  abrirArchivo: async (repo, rama, ruta) => {
    const { token } = get();
    if (!token) return;
    set((s) => ({
      ruta: { ...s.ruta, [repo]: ruta },
      pestana: { ...s.pestana, [repo]: 'archivos' },
    }));
    const clave = `${repo}@${rama}:${ruta}`;
    if (get().archivos[clave]) return;
    set((s) => ({ archivos: { ...s.archivos, [clave]: { cargando: true } } }));
    try {
      const [datos, historia] = await Promise.all([
        getFileContent(token, repo, ruta, rama),
        listCommits(token, repo, { sha: rama, path: ruta, perPage: 3 }).catch(() => []),
      ]);
      set((s) => {
        const recientes = [...s._recientes.filter((k) => k !== clave), clave];
        const sobran = recientes.slice(0, Math.max(0, recientes.length - MAX_ARCHIVOS));
        const archivos = { ...s.archivos, [clave]: { ...datos, historia, cargando: false } };
        for (const viejo of sobran) delete archivos[viejo];
        return { archivos, _recientes: recientes.slice(-MAX_ARCHIVOS) };
      });
    } catch (e) {
      set((s) => ({
        archivos: { ...s.archivos, [clave]: { cargando: false, error: mensaje(e, repo) } },
      }));
    }
  },

  cerrarArchivo: (repo) => set((s) => ({ ruta: { ...s.ruta, [repo]: '' } })),

  limpiar: () => set({ porRepo: {}, arboles: {}, archivos: {}, commits: {}, _recientes: [], ruta: {} }),
}));

function malNombre(crudo) {
  return `«${crudo}» no parece un repositorio de GitHub. Se espera «owner/repo» —por ejemplo «vercel/next.js»— o la dirección completa del repositorio.`;
}

function mensaje(e, repo) {
  if (e?.status === 404) {
    return `No se encuentra «${repo}». O el nombre no es ese, o tu token no tiene permiso para verlo (los privados necesitan el permiso repo).`;
  }
  if (e?.status === 403) {
    return 'GitHub rechazó la petición: puede ser el límite de peticiones por hora o un permiso que le falta al token.';
  }
  if (e?.status === 401) {
    return 'El token no vale o fue revocado. Conecta otro.';
  }
  return e?.message || 'GitHub no respondió.';
}
