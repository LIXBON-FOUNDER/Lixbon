import { create } from 'zustand';
import * as api from '../lib/api';

const PAGINA = 50;

const vacio = () => ({ lista: [], hayMas: false, cargando: false, cargado: false, cursor: 0 });
const vacioHilo = (canalId) => ({ canalId, lista: [], hayMas: false, cargando: false, cargado: false });

function ordenar(lista) {
  const confirmados = lista.filter((m) => !m.pendiente).sort((a, b) => a.seq - b.seq);
  const pendientes = lista.filter((m) => m.pendiente);
  return [...confirmados, ...pendientes];
}

function conCambio(lista, mensajeId, cambio) {
  let tocado = false;
  const nueva = lista.map((m) => {
    if (m.id !== mensajeId) return m;
    tocado = true;
    return typeof cambio === 'function' ? cambio(m) : { ...m, ...cambio };
  });
  return tocado ? nueva : lista;
}

const topeSeq = (mensajes) =>
  mensajes.reduce((max, m) => (m.seq > max ? m.seq : max), 0);

export const useMensajesStore = create((set, get) => ({
  porCanal: {},
  hilos: {},

  _actualizar(canalId, cambios) {
    set((s) => {
      const actual = s.porCanal[canalId] || vacio();
      const nuevo = typeof cambios === 'function' ? cambios(actual) : { ...actual, ...cambios };
      return { porCanal: { ...s.porCanal, [canalId]: nuevo } };
    });
  },

  _actualizarHilo(raizId, canalId, cambios) {
    set((s) => {
      const actual = s.hilos[raizId] || vacioHilo(canalId);
      const nuevo = typeof cambios === 'function' ? cambios(actual) : { ...actual, ...cambios };
      return { hilos: { ...s.hilos, [raizId]: { ...nuevo, canalId: canalId || actual.canalId } } };
    });
  },

  del: (canalId) => get().porCanal[canalId] || vacio(),
  delHilo: (raizId) => get().hilos[raizId] || vacioHilo(null),

  _verSeq: (canalId, seq) => {
    if (!seq) return;
    get()._actualizar(canalId, (actual) =>
      seq > actual.cursor ? { ...actual, cursor: seq } : actual);
  },

  cursores: () => {
    const fuera = {};
    for (const [canalId, estado] of Object.entries(get().porCanal)) {
      if (estado.cursor) fuera[canalId] = estado.cursor;
    }
    return fuera;
  },

  cargar: async (canalId, { forzar = false } = {}) => {
    const estado = get().del(canalId);
    if (estado.cargando || (estado.cargado && !forzar)) return;
    get()._actualizar(canalId, { cargando: true });
    try {
      const { mensajes, hay_mas } = await api.listarMensajes(canalId, { limite: PAGINA });
      get()._actualizar(canalId, (actual) => ({
        ...actual,
        lista: ordenar([...mensajes, ...actual.lista.filter((m) => m.pendiente)]),
        hayMas: hay_mas,
        cargando: false,
        cargado: true,
        cursor: Math.max(actual.cursor, topeSeq(mensajes)),
      }));
    } catch (e) {
      get()._actualizar(canalId, { cargando: false, error: e.message });
    }
  },

  cargarMas: async (canalId) => {
    const estado = get().del(canalId);
    if (estado.cargando || !estado.hayMas) return;
    const primero = estado.lista.find((m) => !m.pendiente);
    if (!primero) return;
    get()._actualizar(canalId, { cargando: true });
    try {
      const { mensajes, hay_mas } = await api.listarMensajes(canalId, {
        antesDe: primero.seq,
        limite: PAGINA,
      });
      get()._actualizar(canalId, (actual) => ({
        ...actual,
        lista: ordenar([...mensajes, ...actual.lista]),
        hayMas: hay_mas,
        cargando: false,
      }));
    } catch (e) {
      get()._actualizar(canalId, { cargando: false, error: e.message });
    }
  },

  cargarHilo: async (canalId, raizId, { forzar = false } = {}) => {
    const estado = get().delHilo(raizId);
    if (estado.cargando || (estado.cargado && !forzar)) return;
    get()._actualizarHilo(raizId, canalId, { cargando: true });
    try {
      const { mensajes, hay_mas } = await api.listarMensajes(canalId, {
        hiloDe: raizId,
        limite: PAGINA,
      });
      get()._actualizarHilo(raizId, canalId, (actual) => ({
        ...actual,
        lista: ordenar([...mensajes, ...actual.lista.filter((m) => m.pendiente)]),
        hayMas: hay_mas,
        cargando: false,
        cargado: true,
      }));
      get()._verSeq(canalId, topeSeq(mensajes));
    } catch (e) {
      get()._actualizarHilo(raizId, canalId, { cargando: false, error: e.message });
    }
  },

  cargarMasHilo: async (canalId, raizId) => {
    const estado = get().delHilo(raizId);
    if (estado.cargando || !estado.hayMas) return;
    const primero = estado.lista.find((m) => !m.pendiente);
    if (!primero) return;
    get()._actualizarHilo(raizId, canalId, { cargando: true });
    try {
      const { mensajes, hay_mas } = await api.listarMensajes(canalId, {
        hiloDe: raizId,
        antesDe: primero.seq,
        limite: PAGINA,
      });
      get()._actualizarHilo(raizId, canalId, (actual) => ({
        ...actual,
        lista: ordenar([...mensajes, ...actual.lista]),
        hayMas: hay_mas,
        cargando: false,
      }));
    } catch (e) {
      get()._actualizarHilo(raizId, canalId, { cargando: false, error: e.message });
    }
  },

  enviar: async (canalId, texto, autorId, adjuntos = [], respondeA = null) => {
    const limpio = texto.trim();
    if (!limpio && !adjuntos.length) return;
    const clientId = crypto.randomUUID();
    const provisional = {
      id: `tmp:${clientId}`,
      canal_id: canalId,
      client_id: clientId,
      autor_id: autorId,
      texto: limpio,
      creado_en: new Date().toISOString(),
      editado_en: null,
      borrado_en: null,
      responde_a: respondeA,
      adjuntos,
      pendiente: true,
      fallido: false,
    };
    get()._meter(canalId, provisional);
    await get()._empujar(canalId, provisional);
  },

  _meter(canalId, mensaje) {
    if (mensaje.responde_a) {
      get()._actualizarHilo(mensaje.responde_a, canalId, (actual) => ({
        ...actual,
        lista: ordenar([...actual.lista, mensaje]),
      }));
      return;
    }
    get()._actualizar(canalId, (actual) => ({ ...actual, lista: [...actual.lista, mensaje] }));
  },

  reintentar: async (canalId, clientId) => {
    const enCanal = get().del(canalId).lista.find((m) => m.client_id === clientId);
    const enHilo = enCanal
      ? null
      : Object.values(get().hilos)
        .flatMap((h) => h.lista)
        .find((m) => m.client_id === clientId);
    const pendiente = enCanal || enHilo;
    if (!pendiente) return;
    get()._parche(canalId, pendiente, { fallido: false });
    await get()._empujar(canalId, pendiente);
  },

  _parche(canalId, mensaje, cambios) {
    const arreglar = (actual) => ({
      ...actual,
      lista: actual.lista.map((m) =>
        m.client_id === mensaje.client_id ? { ...m, ...cambios } : m),
    });
    if (mensaje.responde_a) get()._actualizarHilo(mensaje.responde_a, canalId, arreglar);
    else get()._actualizar(canalId, arreglar);
  },

  async _empujar(canalId, provisional) {
    try {
      const mensaje = await api.enviarMensaje(
        canalId,
        provisional.client_id,
        provisional.texto,
        (provisional.adjuntos || []).map((a) => a.id),
        provisional.responde_a || null,
      );
      get().confirmar(canalId, provisional.client_id, mensaje);
    } catch {
      get()._parche(canalId, provisional, { fallido: true });
    }
  },

  confirmar: (canalId, clientId, mensaje, resumen = null) => {
    const arreglar = (actual) => {
      const sinProvisional = actual.lista.filter((m) => m.client_id !== clientId);
      if (sinProvisional.some((m) => m.id === mensaje.id)) {
        return { ...actual, lista: ordenar(sinProvisional) };
      }
      return { ...actual, lista: ordenar([...sinProvisional, mensaje]) };
    };
    if (mensaje.responde_a) get()._actualizarHilo(mensaje.responde_a, canalId, arreglar);
    else get()._actualizar(canalId, arreglar);
    get()._verSeq(canalId, mensaje.seq);
    if (resumen) get()._resumen(canalId, resumen);
  },

  recibir: (canalId, mensaje, resumen = null) => {
    get()._verSeq(canalId, mensaje.seq);
    if (resumen) get()._resumen(canalId, resumen);

    if (mensaje.responde_a) {
      if (!get().hilos[mensaje.responde_a]?.cargado) return;
      get()._actualizarHilo(mensaje.responde_a, canalId, (actual) => mezclar(actual, mensaje));
      return;
    }
    get()._actualizar(canalId, (actual) => mezclar(actual, mensaje));
  },

  editar: async (canalId, mensajeId, texto) => {
    const limpio = texto.trim();
    const antes = get()._buscar(canalId, mensajeId);
    if (!antes || antes.texto === limpio) return;
    get()._enSitio(canalId, mensajeId, { texto: limpio, editado_en: new Date().toISOString() });
    try {
      const mensaje = await api.editarMensaje(mensajeId, limpio);
      get()._enSitio(canalId, mensajeId, mensaje);
    } catch (e) {
      get()._enSitio(canalId, mensajeId, { texto: antes.texto, editado_en: antes.editado_en });
      throw e;
    }
  },

  borrar: async (canalId, mensajeId) => {
    get()._enSitio(canalId, mensajeId, { borrandose: true });
    try {
      const lapida = await api.borrarMensaje(mensajeId);
      get()._quitar(canalId, mensajeId, lapida);
    } catch (e) {
      get()._enSitio(canalId, mensajeId, { borrandose: false });
      throw e;
    }
  },

  _buscar: (canalId, mensajeId) => {
    const enCanal = get().del(canalId).lista.find((m) => m.id === mensajeId);
    if (enCanal) return enCanal;
    for (const hilo of Object.values(get().hilos)) {
      const m = hilo.lista.find((x) => x.id === mensajeId);
      if (m) return m;
    }
    return null;
  },

  _enSitio(canalId, mensajeId, cambio) {
    set((s) => {
      const porCanal = { ...s.porCanal };
      const hilos = { ...s.hilos };
      let tocado = false;

      const actual = porCanal[canalId];
      if (actual) {
        const lista = conCambio(actual.lista, mensajeId, cambio);
        if (lista !== actual.lista) { porCanal[canalId] = { ...actual, lista }; tocado = true; }
      }
      for (const [raizId, hilo] of Object.entries(hilos)) {
        const lista = conCambio(hilo.lista, mensajeId, cambio);
        if (lista !== hilo.lista) { hilos[raizId] = { ...hilo, lista }; tocado = true; }
      }
      return tocado ? { porCanal, hilos } : {};
    });
  },

  _quitar(canalId, mensajeId, lapida = null) {
    if (lapida) { get()._enSitio(canalId, mensajeId, lapida); return; }
    set((s) => {
      const porCanal = { ...s.porCanal };
      const hilos = { ...s.hilos };
      const actual = porCanal[canalId];
      if (actual) {
        porCanal[canalId] = { ...actual, lista: actual.lista.filter((m) => m.id !== mensajeId) };
      }
      for (const [raizId, hilo] of Object.entries(hilos)) {
        if (raizId === mensajeId) { delete hilos[raizId]; continue; }
        hilos[raizId] = { ...hilo, lista: hilo.lista.filter((m) => m.id !== mensajeId) };
      }
      return { porCanal, hilos };
    });
  },

  _resumen(canalId, resumen) {
    if (!resumen?.mensaje_id) return;
    get()._enSitio(canalId, resumen.mensaje_id, {
      respuestas: resumen.respuestas,
      ultima_respuesta_en: resumen.ultima_respuesta_en,
      respondientes: resumen.respondientes,
    });
  },

  _editado: (canalId, mensaje) => get()._enSitio(canalId, mensaje.id, mensaje),

  _borrado: (canalId, ev) => {
    get()._quitar(canalId, ev.mensaje_id, ev.mensaje || null);
    if (ev.resumen_hilo) get()._resumen(canalId, ev.resumen_hilo);
  },

  olvidar: (canalId) => {
    set((s) => {
      const { [canalId]: _fuera, ...resto } = s.porCanal;
      const hilos = Object.fromEntries(
        Object.entries(s.hilos).filter(([, h]) => h.canalId !== canalId),
      );
      return { porCanal: resto, hilos };
    });
  },

  limpiar: () => set({ porCanal: {}, hilos: {} }),
}));

function mezclar(actual, mensaje) {
  const repetido = actual.lista.some(
    (m) => m.id === mensaje.id || (mensaje.client_id && m.client_id === mensaje.client_id),
  );
  if (!repetido) return { ...actual, lista: ordenar([...actual.lista, mensaje]) };
  return {
    ...actual,
    lista: ordenar(
      actual.lista.map((m) =>
        m.id === mensaje.id || (mensaje.client_id && m.client_id === mensaje.client_id)
          ? mensaje
          : m),
    ),
  };
}
