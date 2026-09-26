import { create } from 'zustand';
import {
  loadToken, saveToken, deleteToken, getViewer, getWorkspace, listIssues,
  getIssue, addComment, createIssue, setIssueState,
} from '../lib/linear';

const vacio = () => ({ issues: [], cargando: false, error: '', cargado: false });

export const useIssuesStore = create((set, get) => ({
  token: null,
  viewer: null,
  estado: 'mirando',
  error: '',

  equipos: [],
  equiposCargados: false,
  cargandoEquipos: false,

  porProyecto: {},

  abierta: null,
  cargandoAbierta: false,

  del: (proyectoId) => get().porProyecto[proyectoId] || vacio(),

  _actualizar(proyectoId, cambios) {
    set((s) => {
      const actual = s.porProyecto[proyectoId] || vacio();
      return {
        porProyecto: {
          ...s.porProyecto,
          [proyectoId]: typeof cambios === 'function' ? cambios(actual) : { ...actual, ...cambios },
        },
      };
    });
  },

  mirarClave: async () => {
    if (get().estado !== 'mirando') return;
    const token = await loadToken();
    if (!token) { set({ token: '', estado: 'sin-clave' }); return; }
    set({ token, estado: 'comprobando' });
    try {
      const viewer = await getViewer(token);
      set({ viewer, estado: 'lista', error: '' });
    } catch (e) {
      set({ estado: 'error', error: e.message });
    }
  },

  conectar: async (clave) => {
    const limpia = clave.trim();
    if (!limpia) return;
    set({ estado: 'comprobando', error: '' });
    try {
      const viewer = await getViewer(limpia);
      await saveToken(limpia);
      set({ token: limpia, viewer, estado: 'lista', error: '' });
    } catch (e) {
      set({ estado: 'sin-clave', error: e.message });
    }
  },

  desconectar: async () => {
    await deleteToken();
    set({
      token: '', viewer: null, estado: 'sin-clave', error: '',
      equipos: [], equiposCargados: false, porProyecto: {}, abierta: null,
    });
  },

  cargarEquipos: async () => {
    const { token, equiposCargados, cargandoEquipos } = get();
    if (!token || equiposCargados || cargandoEquipos) return;
    set({ cargandoEquipos: true });
    try {
      const equipos = await getWorkspace(token);
      set({ equipos, equiposCargados: true, cargandoEquipos: false });
    } catch (e) {
      set({ error: e.message, cargandoEquipos: false });
    }
  },

  estadosDe: (teamId) => {
    const equipo = get().equipos.find((e) => e.id === teamId);
    const nodos = equipo?.states?.nodes || [];
    return [...nodos].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  },

  cargar: async (proyecto, { forzar = false } = {}) => {
    const { token } = get();
    if (!token || !proyecto?.linear_team_id) return;
    const actual = get().del(proyecto.id);
    if (actual.cargando || (actual.cargado && !forzar)) return;
    get()._actualizar(proyecto.id, { cargando: true, error: '' });
    get().cargarEquipos();
    try {
      const issues = await listIssues(token, {
        teamId: proyecto.linear_team_id,
        projectId: proyecto.linear_project_id || '',
      });
      get()._actualizar(proyecto.id, { issues, cargando: false, cargado: true });
    } catch (e) {
      get()._actualizar(proyecto.id, { cargando: false, cargado: true, error: e.message });
    }
  },

  abrir: async (issueId) => {
    const { token } = get();
    if (!token) return;
    set({ cargandoAbierta: true, abierta: null });
    try {
      const issue = await getIssue(token, issueId);
      set({ abierta: issue, cargandoAbierta: false });
    } catch (e) {
      set({ cargandoAbierta: false, error: e.message });
    }
  },

  cerrar: () => set({ abierta: null }),

  comentar: async (issueId, texto) => {
    const { token } = get();
    if (!token || !texto.trim()) return '';
    try {
      const comentario = await addComment(token, issueId, texto.trim());
      set((s) => {
        if (s.abierta?.id !== issueId) return {};
        const nodes = [...(s.abierta.comments?.nodes || []), comentario];
        return { abierta: { ...s.abierta, comments: { ...s.abierta.comments, nodes } } };
      });
      return '';
    } catch (e) {
      return e.message;
    }
  },

  crear: async (proyecto, titulo) => {
    const { token } = get();
    if (!token || !proyecto?.linear_team_id) return 'Este proyecto no está vinculado a Linear.';
    try {
      await createIssue(token, {
        teamId: proyecto.linear_team_id,
        projectId: proyecto.linear_project_id || '',
        title: titulo.trim(),
      });
      await get().cargar(proyecto, { forzar: true });
      return '';
    } catch (e) {
      return e.message;
    }
  },

  mover: async (proyectoId, issueId, stateId) => {
    const { token } = get();
    if (!token) return;
    const antes = get().del(proyectoId).issues;
    const destino = antes.find((i) => i.id === issueId)?.state;
    get()._actualizar(proyectoId, (a) => ({
      ...a,
      issues: a.issues.map((i) => (i.id === issueId ? { ...i, _moviendo: true } : i)),
    }));
    try {
      const issue = await setIssueState(token, issueId, stateId);
      get()._actualizar(proyectoId, (a) => ({
        ...a,
        issues: a.issues.map((i) => (i.id === issueId ? { ...i, state: issue.state, _moviendo: false } : i)),
      }));
      set((s) => (s.abierta?.id === issueId ? { abierta: { ...s.abierta, state: issue.state } } : {}));
    } catch (e) {
      get()._actualizar(proyectoId, (a) => ({
        ...a,
        issues: a.issues.map((i) => (i.id === issueId ? { ...i, state: destino, _moviendo: false } : i)),
        error: e.message,
      }));
    }
  },

  limpiar: () => set({ porProyecto: {}, abierta: null }),
}));
