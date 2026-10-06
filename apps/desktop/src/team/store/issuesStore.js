// issuesStore.js — las issues de cada equipo, contra el gateway de Lixbon.
// Los cambios se pintan al momento (optimista) y el evento del socket trae la
// versión buena; si el servidor dice que no, se vuelve a lo que había.
import { create } from 'zustand';
import * as api from '../lib/api';

const vacio = () => ({ issues: [], cargando: false, cargado: false, error: '' });
// Mismo objeto siempre para un equipo sin cargar: los selectores no deben
// devolver algo nuevo en cada lectura.
const VACIO = Object.freeze(vacio());

export const useIssuesStore = create((set, get) => ({
  porProyecto: {},
  abierta: null,          // detalle de la issue abierta (con comentarios, actividad…)
  abiertaId: null,
  cargandoAbierta: false,
  errorAbierta: '',
  creando: null,          // { proyectoId, estadoId?, padreId? } cuando el formulario está abierto

  del: (proyectoId) => get().porProyecto[proyectoId] || VACIO,

  _poner(proyectoId, cambios) {
    set((s) => {
      const actual = s.porProyecto[proyectoId] || vacio();
      const nuevo = typeof cambios === 'function' ? cambios(actual) : { ...actual, ...cambios };
      return { porProyecto: { ...s.porProyecto, [proyectoId]: nuevo } };
    });
  },

  _guardarIssue(issue) {
    get()._poner(issue.proyecto_id, (a) => {
      const hay = a.issues.some((i) => i.id === issue.id);
      return { ...a, issues: hay ? a.issues.map((i) => (i.id === issue.id ? issue : i)) : [...a.issues, issue] };
    });
    const { abierta } = get();
    if (abierta?.id === issue.id) set({ abierta: { ...abierta, ...issue } });
    if (abierta && issue.padre_id === abierta.id) {
      const lista = abierta.subtareas_lista || [];
      const hay = lista.some((x) => x.id === issue.id);
      set({ abierta: { ...get().abierta, subtareas_lista: hay ? lista.map((x) => (x.id === issue.id ? issue : x)) : [...lista, issue] } });
    }
  },

  cargar: async (proyectoId, { forzar = false } = {}) => {
    const actual = get().del(proyectoId);
    if (!proyectoId || actual.cargando || (actual.cargado && !forzar)) return;
    get()._poner(proyectoId, { cargando: true, error: '' });
    try {
      const issues = await api.listarIssues(proyectoId);
      get()._poner(proyectoId, { issues, cargando: false, cargado: true });
    } catch (e) {
      get()._poner(proyectoId, { cargando: false, error: e.message });
    }
  },

  abrirCreacion: (datos) => set({ creando: datos }),
  cerrarCreacion: () => set({ creando: null }),

  crear: async (proyectoId, datos) => {
    try {
      const issue = await api.crearIssue(proyectoId, datos);
      get()._guardarIssue(issue);
      return { issue };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** Cambia una issue ya: la tarjeta se mueve antes de que conteste el servidor. */
  editar: async (issueId, cambios) => {
    const buscar = () => {
      for (const [pid, datos] of Object.entries(get().porProyecto)) {
        const i = datos.issues.find((x) => x.id === issueId);
        if (i) return { pid, i };
      }
      return null;
    };
    const antes = buscar();
    if (antes) get()._guardarIssue({ ...antes.i, ...cambios });
    try {
      const issue = await api.editarIssue(issueId, cambios);
      get()._guardarIssue(issue);
      return '';
    } catch (e) {
      if (antes) get()._guardarIssue(antes.i);
      return e.message;
    }
  },

  borrar: async (issueId) => {
    try {
      await api.borrarIssue(issueId);
      get()._quitar(issueId);
      return '';
    } catch (e) {
      return e.message;
    }
  },

  _quitar(issueId) {
    set((s) => ({
      porProyecto: Object.fromEntries(Object.entries(s.porProyecto).map(([pid, d]) => [
        pid, { ...d, issues: d.issues.filter((i) => i.id !== issueId) },
      ])),
      ...(s.abiertaId === issueId ? { abierta: null, abiertaId: null } : {}),
    }));
  },

  /** Abre el detalle desde cualquier sección: lleva a Issues y, si la issue es
   *  de otro equipo, cambia a ese equipo. */
  abrir: async (issueId) => {
    set({ abiertaId: issueId, cargandoAbierta: true, errorAbierta: '', abierta: get().abierta?.id === issueId ? get().abierta : null });
    const { useTeamStore } = await import('./teamStore');
    if (useTeamStore.getState().vista !== 'issues') useTeamStore.getState().irA('issues');
    try {
      const abierta = await api.verIssue(issueId);
      const team = useTeamStore.getState();
      if (abierta.proyecto_id !== team.proyectoId) useTeamStore.setState({ proyectoId: abierta.proyecto_id });
      if (get().abiertaId === issueId) set({ abierta, cargandoAbierta: false });
    } catch (e) {
      if (get().abiertaId === issueId) set({ cargandoAbierta: false, errorAbierta: e.message });
    }
  },

  cerrar: () => set({ abierta: null, abiertaId: null, errorAbierta: '' }),

  comentar: async (issueId, texto) => {
    try {
      const c = await api.comentarIssue(issueId, texto);
      get()._comentario({ accion: 'creado', issue_id: issueId, comentario: c });
      return '';
    } catch (e) {
      return e.message;
    }
  },

  borrarComentario: async (comentarioId) => {
    try {
      await api.borrarComentario(comentarioId);
      const a = get().abierta;
      if (a) get()._comentario({ accion: 'borrado', issue_id: a.id, comentario_id: comentarioId });
      return '';
    } catch (e) {
      return e.message;
    }
  },

  _comentario(ev) {
    const a = get().abierta;
    if (!a || a.id !== ev.issue_id) return;
    const lista = a.comentarios_lista || [];
    if (ev.accion === 'creado') {
      if (lista.some((c) => c.id === ev.comentario.id)) return;
      set({ abierta: { ...a, comentarios_lista: [...lista, ev.comentario] } });
    } else {
      set({ abierta: { ...a, comentarios_lista: lista.filter((c) => c.id !== ev.comentario_id) } });
    }
  },

  /** Eventos del socket de Team que tocan issues. */
  evento: (ev) => {
    if (ev.tipo === 'issue') {
      if (ev.accion === 'borrada') get()._quitar(ev.issue_id);
      else if (ev.issue) {
        get()._guardarIssue(ev.issue);
        // La actividad del detalle abierto se refresca en segundo plano.
        if (get().abiertaId === ev.issue.id) {
          api.verIssue(ev.issue.id).then((abierta) => {
            if (get().abiertaId === abierta.id) set({ abierta });
          }).catch(() => {});
        }
      }
    }
    if (ev.tipo === 'issue_comentario') get()._comentario(ev);
  },

  limpiar: () => set({ porProyecto: {}, abierta: null, abiertaId: null, creando: null }),
}));
