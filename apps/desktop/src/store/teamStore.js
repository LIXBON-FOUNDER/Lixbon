// teamStore.js — Lixbon Team: presencia en vivo, proyectos, directos (DMs) y
// mensajería sobre el hub real (core/gateway/routers/team.py). Un solo store
// porque comparte la conexión WS con la presencia: separar el chat de
// directos en otro store solo duplicaría el socket.
import { create } from 'zustand';
import { useAppStore } from './appStore';
import { api } from '../lib/api';

let ws = null;
let reconnectTimer = null;
let pingTimer = null;

function wsUrl(serverUrl, apiKey) {
  return `${serverUrl.replace(/^http/i, 'ws')}/ws/team?token=${encodeURIComponent(apiKey)}`;
}

function clientId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const useTeamStore = create((set, get) => ({
  bootstrapped: false,
  connected: false,
  me: null,
  presencia: 'desconectado', // el estado REAL propio
  proyectos: [],
  directos: [],   // canales tipo "directo" ya abiertos (DMs)
  amigos: [],
  solicitudes: [],
  mensajesPorCanal: {}, // canal_id -> mensajes ordenados por seq
  cargandoMensajes: {}, // canal_id -> bool
  error: '',
  inviting: false,

  bootstrap: async () => {
    const { apiKey } = useAppStore.getState();
    if (!apiKey || get().bootstrapped) return;
    try {
      const data = await api.get('/api/team/bootstrap');
      set({
        bootstrapped: true,
        me: data.yo,
        presencia: data.presencia,
        proyectos: data.proyectos || [],
        directos: data.directos || [],
        amigos: data.amigos || [],
        solicitudes: data.solicitudes || [],
        error: '',
      });
      get().connect();
    } catch (e) {
      set({ error: String(e.message || e) });
    }
  },

  connect: () => {
    const { serverUrl, apiKey } = useAppStore.getState();
    if (!serverUrl || !apiKey || ws) return;
    try {
      ws = new WebSocket(wsUrl(serverUrl, apiKey));
    } catch {
      return;
    }
    ws.onopen = () => {
      set({ connected: true });
      ws.send(JSON.stringify({ tipo: 'hola', cursores: {} }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'ping' }));
      }, 30000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      get()._onEvent(msg);
    };
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      clearInterval(pingTimer);
      // Reintenta: una red inestable no debe dejar la presencia congelada.
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => get().connect(), 4000);
    };
    ws.onerror = () => { try { ws?.close(); } catch { /* ya cerrado */ } };
  },

  disconnect: () => {
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    set({ connected: false });
  },

  _onEvent: (msg) => {
    switch (msg.tipo) {
      case 'presencia': {
        const { usuario_id, estado } = msg;
        set({
          proyectos: get().proyectos.map((p) => ({
            ...p,
            miembros: (p.miembros || []).map((m) =>
              m.usuario?.id === usuario_id ? { ...m, estado } : m),
          })),
          directos: get().directos.map((d) =>
            d.con?.id === usuario_id ? { ...d, estado } : d),
          amigos: get().amigos.map((a) =>
            a.usuario?.id === usuario_id ? { ...a, estado } : a),
        });
        return;
      }
      case 'proyecto_actualizado': {
        if (!msg.proyecto) return;
        const existe = get().proyectos.some((p) => p.id === msg.proyecto.id);
        set({
          proyectos: existe
            ? get().proyectos.map((p) => (p.id === msg.proyecto.id ? msg.proyecto : p))
            : [...get().proyectos, msg.proyecto],
        });
        return;
      }
      case 'canal_creado': {
        if (!msg.canal || msg.canal.tipo !== 'directo') return;
        if (get().directos.some((d) => d.id === msg.canal.id)) return;
        set({ directos: [...get().directos, msg.canal] });
        return;
      }
      case 'mensaje':
      case 'mensaje_ack':
        if (msg.canal_id && msg.mensaje) get()._upsertMensaje(msg.canal_id, msg.mensaje);
        return;
      case 'mensaje_editado':
        if (msg.canal_id && msg.mensaje) get()._upsertMensaje(msg.canal_id, msg.mensaje);
        return;
      case 'mensaje_borrado': {
        if (!msg.canal_id) return;
        const actuales = get().mensajesPorCanal[msg.canal_id] || [];
        // Con lápida (tiene respuestas) el servidor manda el mensaje editado a "borrado";
        // sin ella, desaparece del todo.
        const siguiente = msg.mensaje
          ? actuales.map((m) => (m.id === msg.mensaje_id ? msg.mensaje : m))
          : actuales.filter((m) => m.id !== msg.mensaje_id);
        set({ mensajesPorCanal: { ...get().mensajesPorCanal, [msg.canal_id]: siguiente } });
        return;
      }
      default:
    }
  },

  /** Inserta o reemplaza un mensaje por id, y también por client_id — así el eco
      real (HTTP o `mensaje_ack` por WS, lo que llegue primero) sustituye al
      optimista sin duplicarlo cuando llega el segundo. */
  _upsertMensaje: (canalId, mensaje) => {
    const actuales = get().mensajesPorCanal[canalId] || [];
    const sinDuplicado = actuales.filter((m) => m.id !== mensaje.id && (
      !mensaje.client_id || m.client_id !== mensaje.client_id
    ));
    const siguiente = [...sinDuplicado, mensaje].sort((a, b) => a.seq - b.seq);
    set({ mensajesPorCanal: { ...get().mensajesPorCanal, [canalId]: siguiente } });
  },

  cargarMensajes: async (canalId) => {
    if (get().cargandoMensajes[canalId]) return;
    set({ cargandoMensajes: { ...get().cargandoMensajes, [canalId]: true } });
    try {
      const lista = await api.get(`/api/team/channels/${canalId}/messages?antes_de=0&limite=200`);
      const ordenados = [...(lista || [])].sort((a, b) => a.seq - b.seq);
      set({ mensajesPorCanal: { ...get().mensajesPorCanal, [canalId]: ordenados } });
    } catch (e) {
      set({ error: String(e.message || e) });
    } finally {
      set({ cargandoMensajes: { ...get().cargandoMensajes, [canalId]: false } });
    }
  },

  /** Manda el mensaje ya (optimista) y lo reconcilia cuando llegue la
      confirmación real (HTTP 201 y/o el `mensaje_ack` por WS). */
  enviarMensaje: async (canalId, texto) => {
    const texto2 = texto.trim();
    if (!texto2) return { ok: false, error: 'El mensaje está vacío.' };
    const cid = clientId();
    get()._upsertMensaje(canalId, {
      id: `tmp-${cid}`, canal_id: canalId, seq: Number.MAX_SAFE_INTEGER,
      autor_id: get().me?.id, texto: texto2, client_id: cid,
      creado_en: new Date().toISOString(), editado_en: null, borrado_en: null,
      responde_a: null, adjuntos: [], respuestas: 0,
    });
    try {
      const salida = await api.post(`/api/team/channels/${canalId}/messages`, {
        client_id: cid, texto: texto2, adjuntos: [], responde_a: null,
      });
      if (salida) get()._upsertMensaje(canalId, salida);
      return { ok: true };
    } catch (e) {
      const actuales = get().mensajesPorCanal[canalId] || [];
      set({
        mensajesPorCanal: {
          ...get().mensajesPorCanal,
          [canalId]: actuales.filter((m) => m.client_id !== cid),
        },
      });
      return { ok: false, error: String(e.message || e) };
    }
  },

  /** Abre (o reutiliza) el directo con `usuarioId`. 403 si no comparten
      proyecto ni son amigos — el server manda, no se adivina aquí. */
  abrirDirecto: async (usuarioId) => {
    const existente = get().directos.find((d) => d.con?.id === usuarioId);
    if (existente) return { ok: true, canal: existente };
    try {
      const canal = await api.post('/api/team/dms', { usuario_id: usuarioId });
      set({ directos: [...get().directos.filter((d) => d.id !== canal.id), canal] });
      return { ok: true, canal };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },

  /** Invita por correo o usuario a un proyecto (el primero de la lista si no se indica). */
  invite: async (identificador, proyectoId) => {
    const pid = proyectoId || get().proyectos[0]?.id;
    if (!pid || !identificador.trim()) return { ok: false, error: 'Falta el proyecto o el correo.' };
    set({ inviting: true });
    try {
      await api.post(`/api/team/projects/${pid}/members`, { identificador: identificador.trim() });
      set({ inviting: false });
      return { ok: true };
    } catch (e) {
      set({ inviting: false });
      return { ok: false, error: String(e.message || e) };
    }
  },
}));
