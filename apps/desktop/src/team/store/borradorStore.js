import { create } from 'zustand';
import * as adj from '../lib/adjuntos';
import { useTeamStore } from './teamStore';

const vacio = () => ({ texto: '', adjuntos: [] });

const enVuelo = new Map();

export const useBorradorStore = create((set, get) => ({
  porCanal: {},

  del: (canalId) => get().porCanal[canalId] || vacio(),

  _actualizar(canalId, cambios) {
    set((s) => {
      const actual = s.porCanal[canalId] || vacio();
      const nuevo = typeof cambios === 'function' ? cambios(actual) : { ...actual, ...cambios };
      return { porCanal: { ...s.porCanal, [canalId]: nuevo } };
    });
  },

  _parche(canalId, localId, cambios) {
    get()._actualizar(canalId, (actual) => ({
      ...actual,
      adjuntos: actual.adjuntos.map((p) => (p.localId === localId ? { ...p, ...cambios } : p)),
    }));
  },

  escribir: (canalId, texto) => get()._actualizar(canalId, { texto }),

  añadir: async (clave, archivos, canalId = clave) => {
    const lista = Array.from(archivos || []);
    if (!lista.length) return [];

    const quejas = [];
    const sitio = adj.MAX_POR_MENSAJE - get().del(clave).adjuntos.length;
    if (lista.length > sitio) {
      quejas.push(`Solo caben ${adj.MAX_POR_MENSAJE} adjuntos por mensaje.`);
    }

    for (const file of lista.slice(0, Math.max(0, sitio))) {
      const motivo = adj.revisar(file);
      if (motivo) { quejas.push(motivo); continue; }
      get()._subir(clave, file, null, false, canalId);
    }
    return quejas;
  },

  añadirVoz: (clave, file, duracionMs, canalId = clave) =>
    get()._subir(clave, file, { duracion_ms: duracionMs }, true, canalId),

  async _subir(clave, file, medidasFijas = null, esVoz = false, canalId = clave) {
    const localId = crypto.randomUUID();
    const tipo = esVoz ? 'audio' : adj.tipoProbable(file);
    const vista = tipo === 'imagen' || tipo === 'video' ? URL.createObjectURL(file) : '';

    get()._actualizar(clave, (actual) => ({
      ...actual,
      adjuntos: [...actual.adjuntos, {
        localId,
        nombre: file.name,
        bytes: file.size,
        tipo,
        vista,
        esVoz,
        duracionLocal: medidasFijas?.duracion_ms ?? null,
        progreso: 0,
        subiendo: true,
        error: '',
        adjunto: null,
      }],
    }));

    try {
      const medidas = medidasFijas || (await adj.medir(file));
      const llave = useTeamStore.getState().llave;
      const { promesa, cancelar } = adj.subir({
        canalId,
        file,
        llave,
        medidas,
        onProgreso: (p) => get()._parche(clave, localId, { progreso: p }),
      });
      enVuelo.set(localId, cancelar);
      const adjunto = await promesa;
      enVuelo.delete(localId);
      get()._parche(clave, localId, {
        subiendo: false, progreso: 1, adjunto, tipo: adjunto.tipo,
      });
    } catch (e) {
      enVuelo.delete(localId);
      if (!get().del(clave).adjuntos.some((p) => p.localId === localId)) return;
      get()._parche(clave, localId, { subiendo: false, error: e.message });
    }
  },

  quitar: (canalId, localId) => {
    enVuelo.get(localId)?.();
    enVuelo.delete(localId);
    const pieza = get().del(canalId).adjuntos.find((p) => p.localId === localId);
    if (pieza?.vista) URL.revokeObjectURL(pieza.vista);
    get()._actualizar(canalId, (actual) => ({
      ...actual,
      adjuntos: actual.adjuntos.filter((p) => p.localId !== localId),
    }));
  },

  listoParaEnviar: (canalId) => {
    const b = get().del(canalId);
    if (b.adjuntos.some((p) => p.subiendo)) return false;
    return Boolean(b.texto.trim()) || b.adjuntos.some((p) => p.adjunto);
  },

  ids: (canalId) =>
    get().del(canalId).adjuntos.filter((p) => p.adjunto).map((p) => p.adjunto.id),

  vaciar: (canalId) => {
    const b = get().del(canalId);
    for (const p of b.adjuntos) {
      if (p.adjunto && p.vista) URL.revokeObjectURL(p.vista);
    }
    get()._actualizar(canalId, {
      texto: '',
      adjuntos: b.adjuntos.filter((p) => !p.adjunto),
    });
  },

  olvidar: (canalId) => {
    for (const p of get().del(canalId).adjuntos) {
      enVuelo.get(p.localId)?.();
      enVuelo.delete(p.localId);
      if (p.vista) URL.revokeObjectURL(p.vista);
    }
    set((s) => {
      const { [canalId]: _fuera, ...resto } = s.porCanal;
      return { porCanal: resto };
    });
  },

  limpiar: () => {
    for (const cancelar of enVuelo.values()) cancelar();
    enVuelo.clear();
    for (const b of Object.values(get().porCanal)) {
      for (const p of b.adjuntos) if (p.vista) URL.revokeObjectURL(p.vista);
    }
    set({ porCanal: {} });
  },
}));
