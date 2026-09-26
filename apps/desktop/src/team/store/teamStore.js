import { create } from 'zustand';
import * as api from '../lib/api';
import { leerSesion, revalidar, fijarServidor } from '../lib/sesion';
import { abrirSocket } from '../lib/socket';
import { useMensajesStore } from './mensajesStore';
import { useBorradorStore } from './borradorStore';

const ESCRIBIENDO_MS = 4000;

const AVISO_CADA_MS = 2500;

let socket = null;
let ultimoAviso = 0;

export const llaveDe = (pieza) => `${pieza.tipo}:${pieza.id}`;

function recordarAbiertos(abiertos) {
  try {
    localStorage.setItem('lixbon-team-abiertos', JSON.stringify(abiertos));
  } catch { /* da igual: se pierde el orden, no el trabajo */ }
}

export const useTeamStore = create((set, get) => ({
  hidratado: false,
  llave: '',
  usuario: null,
  sesion: 'cargando',
  errorSesion: '',

  cargando: false,
  error: '',
  proyectos: [],
  directos: [],
  amigos: [],
  solicitudes: [],
  presencia: 'desconectado',

  vista: 'chat',
  proyectoId: null,
  canalId: null,
  conexion: 'conectando',
  escribiendo: {},
  noLeidos: {},
  hiloId: null,
  hilosNuevos: {},

  abiertos: (() => {
    try {
      const guardado = JSON.parse(localStorage.getItem('lixbon-team-abiertos') || '[]');
      if (!Array.isArray(guardado)) return [];
      return guardado.filter((p) => p && typeof p.tipo === 'string' && p.id);
    } catch {
      return [];
    }
  })(),

  anchos: (() => {
    const fabrica = { lista: 256, arbol: 260, detalle: 420, hilo: 384, info: 320 };
    try {
      return { ...fabrica, ...JSON.parse(localStorage.getItem('lixbon-team-anchos-v2') || '{}') };
    } catch {
      return fabrica;
    }
  })(),

  zoom: (() => {
    const n = Number(localStorage.getItem('lixbon-team-zoom'));
    return Number.isFinite(n) && n >= 0.85 && n <= 1.4 ? n : 1;
  })(),

  foco: 'chat',
  enfocar: (foco) => { if (get().foco !== foco) set({ foco }); },
  infoAbierta: true,
  alternarInfo: () => set({ infoAbierta: !get().infoAbierta }),

  setZoom: (valor) => {
    const zoom = Math.min(1.4, Math.max(0.85, Math.round(valor * 100) / 100));
    try { localStorage.setItem('lixbon-team-zoom', String(zoom)); } catch { /* da igual */ }
    set({ zoom });
  },

  setAncho: (cual, px) => {
    const anchos = { ...get().anchos, [cual]: Math.round(px) };
    try { localStorage.setItem('lixbon-team-anchos-v2', JSON.stringify(anchos)); } catch { /* da igual */ }
    set({ anchos });
  },

  proyectoActivo: () => get().proyectos.find((p) => p.id === get().proyectoId) || null,

  canalActivo: () => {
    const { canalId, proyectos, directos } = get();
    if (!canalId) return null;
    for (const p of proyectos) {
      const c = p.canales.find((x) => x.id === canalId);
      if (c) return { ...c, proyecto: p };
    }
    return directos.find((d) => d.id === canalId) || null;
  },

  piezaActiva: () => {
    const { vista, canalId, proyectoId } = get();
    if (vista === 'chat') return canalId ? { tipo: 'canal', id: canalId } : null;
    return proyectoId ? { tipo: vista, id: proyectoId } : null;
  },

  abiertosVisibles: () => {
    const { abiertos, proyectos, directos, proyectoId } = get();
    return abiertos.filter((pieza) => {
      if (pieza.tipo !== 'canal') return pieza.id === proyectoId;
      if (directos.some((d) => d.id === pieza.id)) return true;
      const dueno = proyectos.find((p) => p.canales.some((c) => c.id === pieza.id));
      return Boolean(dueno) && dueno.id === proyectoId;
    });
  },

  soyLider: () => get().proyectoActivo()?.rol === 'lider',

  quien: (usuarioId) => {
    const { usuario, proyectos, directos, amigos } = get();
    if (usuario && usuario.id === usuarioId) return usuario;
    for (const p of proyectos) {
      const m = p.miembros.find((x) => x.usuario.id === usuarioId);
      if (m) return m.usuario;
    }
    for (const d of directos) if (d.con?.id === usuarioId) return d.con;
    for (const a of amigos) if (a.usuario?.id === usuarioId) return a.usuario;
    return null;
  },

  escribiendoEn: (canalId) => {
    const ahora = Date.now();
    const mio = get().usuario?.id;
    return Object.entries(get().escribiendo)
      .filter(([clave, hasta]) => hasta > ahora && clave.startsWith(`${canalId}:`))
      .map(([clave]) => Number(clave.split(':')[1]))
      .filter((uid) => uid !== mio);
  },

  hidratar: async (desdeIde = null) => {
    if (get().hidratado) return;
    set({ hidratado: true });

    let llave = desdeIde?.llave;
    let usuario = desdeIde?.usuario || null;
    if (desdeIde) fijarServidor(desdeIde.servidor);
    else ({ llave, usuario } = await leerSesion());
    if (!llave) {
      set({ sesion: 'sin-sesion' });
      return;
    }
    api.usarLlave(llave);
    set({ llave, usuario });

    try {
      if (!desdeIde) set({ usuario: await revalidar(llave) });
      set({ sesion: 'ok' });
      await get().cargar();
      get().conectar();
    } catch (e) {
      set({ sesion: 'error', errorSesion: e.message });
    }
  },

  reintentar: async () => {
    set({ hidratado: false, sesion: 'cargando', errorSesion: '' });
    await get().hidratar();
  },

  salir: () => {
    get().desconectar();
    api.usarLlave('');
    useMensajesStore.getState().limpiar();
    useBorradorStore.getState().limpiar();
    set({
      hidratado: false, llave: '', usuario: null, sesion: 'sin-sesion', errorSesion: '',
      proyectos: [], directos: [], amigos: [], solicitudes: [],
      proyectoId: null, canalId: null, hiloId: null, hilosNuevos: {}, noLeidos: {}, escribiendo: {},
    });
  },

  cargar: async () => {
    set({ cargando: true, error: '' });
    try {
      const datos = await api.bootstrap();
      set({
        cargando: false,
        usuario: datos.yo || get().usuario,
        presencia: datos.presencia || 'desconectado',
        proyectos: datos.proyectos || [],
        directos: datos.directos || [],
        amigos: datos.amigos || [],
        solicitudes: datos.solicitudes || [],
      });
      if (datos.presencia) get()._presencia(datos.yo?.id ?? get().usuario?.id, datos.presencia);
      get()._podarAbiertos();
      get()._elegirAlgoQueMirar();
    } catch (e) {
      set({ cargando: false, error: e.message });
    }
  },

  _elegirAlgoQueMirar: () => {
    const { proyectos, proyectoId, canalId, directos, abiertos } = get();
    const sigueValiendo =
      canalId &&
      (proyectos.some((p) => p.canales.some((c) => c.id === canalId)) ||
        directos.some((d) => d.id === canalId));
    if (sigueValiendo) {
      const dueno = proyectos.find((p) => p.canales.some((c) => c.id === canalId));
      if (dueno && dueno.id !== proyectoId) set({ proyectoId: dueno.id });
      return;
    }

    const ultima = abiertos[abiertos.length - 1];
    if (ultima) {
      if (ultima.tipo === 'canal') { get().abrirCanal(ultima.id); return; }
      const suyo = proyectos.find((p) => p.id === ultima.id);
      if (suyo) { set({ proyectoId: suyo.id, vista: ultima.tipo }); return; }
    }

    const primero = proyectos[0];
    if (primero?.canales?.length) {
      set({ proyectoId: primero.id, vista: 'chat' });
      get().abrirCanal(primero.canales[0].id);
    } else {
      set({ proyectoId: primero?.id || null, canalId: null, vista: 'chat' });
    }
  },

  _anotar: (pieza) => {
    const { abiertos } = get();
    const llave = llaveDe(pieza);
    if (abiertos.some((p) => llaveDe(p) === llave)) return;
    const siguiente = [...abiertos, { tipo: pieza.tipo, id: pieza.id }];
    recordarAbiertos(siguiente);
    set({ abiertos: siguiente });
  },

  _podarAbiertos: () => {
    const { abiertos, proyectos, directos } = get();
    const vivos = abiertos.filter((pieza) => {
      if (pieza.tipo === 'canal') {
        return (
          proyectos.some((p) => p.canales.some((c) => c.id === pieza.id)) ||
          directos.some((d) => d.id === pieza.id)
        );
      }
      return proyectos.some((p) => p.id === pieza.id);
    });
    if (vivos.length === abiertos.length) return;
    recordarAbiertos(vivos);
    set({ abiertos: vivos });
  },

  irAProyecto: (proyectoId) => {
    const proyecto = get().proyectos.find((p) => p.id === proyectoId);
    if (!proyecto) return;
    set({ proyectoId });
    const suya = get().abiertosVisibles()[0];
    if (suya) { get().abrir(suya); return; }
    const primero = proyecto.canales[0];
    if (primero) { get().abrirCanal(primero.id); return; }
    set({ vista: 'chat', canalId: null, hiloId: null });
  },

  volverAlChat: () => {
    const { canalId, proyectoActivo } = get();
    if (canalId) { set({ vista: 'chat' }); return; }
    const primero = proyectoActivo()?.canales?.[0];
    if (primero) get().abrirCanal(primero.id);
    else set({ vista: 'chat' });
  },

  irA: (vista) => {
    const { proyectoId } = get();
    set({ vista });
    if (vista !== 'chat' && proyectoId) get()._anotar({ tipo: vista, id: proyectoId });
  },

  abrir: (pieza) => {
    if (pieza.tipo === 'canal') { get().abrirCanal(pieza.id); return; }
    get().irA(pieza.tipo);
  },

  cerrar: (pieza) => {
    const llave = llaveDe(pieza);
    const { abiertos } = get();
    if (!abiertos.some((p) => llaveDe(p) === llave)) return;

    const activa = get().piezaActiva();
    const visibles = get().abiertosVisibles();
    const donde = visibles.findIndex((p) => llaveDe(p) === llave);

    const resto = abiertos.filter((p) => llaveDe(p) !== llave);
    recordarAbiertos(resto);
    set({ abiertos: resto });

    if (!activa || llaveDe(activa) !== llave) return;

    const quedan = visibles.filter((p) => llaveDe(p) !== llave);
    const vecina = quedan[Math.min(donde, quedan.length - 1)];
    if (vecina) { get().abrir(vecina); return; }
    set({ vista: 'chat', canalId: null, hiloId: null });
  },

  abrirCanal: (canalId) => {
    set((s) => {
      const { [canalId]: _leido, ...resto } = s.noLeidos;
      return { canalId, hiloId: null, vista: 'chat', noLeidos: resto };
    });
    const dueno = get().proyectos.find((p) => p.canales.some((c) => c.id === canalId));
    if (dueno && dueno.id !== get().proyectoId) set({ proyectoId: dueno.id });
    get()._anotar({ tipo: 'canal', id: canalId });
    useMensajesStore.getState().cargar(canalId);
  },

  abrirHilo: (raizId) => {
    const canalId = get().canalId;
    if (!canalId) return;
    set((s) => {
      const { [raizId]: _visto, ...resto } = s.hilosNuevos;
      return { hiloId: raizId, hilosNuevos: resto };
    });
    useMensajesStore.getState().cargarHilo(canalId, raizId);
  },

  cerrarHilo: () => set({ hiloId: null }),

  abrirDirecto: async (usuarioId) => {
    try {
      const canal = await api.abrirDirecto(usuarioId);
      set((s) => ({
        directos: s.directos.some((d) => d.id === canal.id) ? s.directos : [...s.directos, canal],
      }));
      get().abrirCanal(canal.id);
    } catch (e) {
      set({ error: e.message });
    }
  },

  crearProyecto: async (nombre) => {
    try {
      const proyecto = await api.crearProyecto(nombre);
      set((s) => ({ proyectos: [...s.proyectos, proyecto] }));
      get().irAProyecto(proyecto.id);
      return '';
    } catch (e) {
      return e.message;
    }
  },

  editarProyecto: async (id, cambios) => {
    try {
      const proyecto = await api.editarProyecto(id, cambios);
      set((s) => ({ proyectos: s.proyectos.map((p) => (p.id === id ? proyecto : p)) }));
      return '';
    } catch (e) {
      return e.message;
    }
  },

  invitar: async (proyectoId, identificador) => {
    try {
      await api.invitarMiembro(proyectoId, identificador);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  quitarMiembro: async (proyectoId, usuarioId) => {
    try {
      await api.quitarMiembro(proyectoId, usuarioId);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  crearCanal: async (proyectoId, datos) => {
    try {
      const canal = await api.crearCanal(proyectoId, datos);
      set((s) => ({
        proyectos: s.proyectos.map((p) =>
          p.id === proyectoId ? { ...p, canales: [...p.canales, canal] } : p,
        ),
      }));
      get().abrirCanal(canal.id);
      return '';
    } catch (e) {
      return e.message;
    }
  },

  borrarCanal: async (canalId) => {
    try {
      await api.borrarCanal(canalId);
      get()._quitarCanal(canalId);
      return '';
    } catch (e) {
      return e.message;
    }
  },

  sumarACanal: async (canalId, usuarioId) => {
    try {
      await api.sumarACanal(canalId, usuarioId);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  sacarDeCanal: async (canalId, usuarioId) => {
    try {
      await api.sacarDeCanal(canalId, usuarioId);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  pedirAmistad: async (identificador) => {
    try {
      await api.pedirAmistad(identificador);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  aceptarAmistad: async (usuarioId) => {
    try {
      await api.aceptarAmistad(usuarioId);
      await get().cargar();
      return '';
    } catch (e) {
      return e.message;
    }
  },

  cambiarPresencia: async (estado) => {
    const antes = get().presencia;
    const yo = get().usuario?.id;
    get()._presencia(yo, estado);
    if (socket?.enviar({ tipo: 'presencia', estado })) return;
    try {
      await api.ponerPresencia(estado);
    } catch {
      get()._presencia(yo, antes);
    }
  },

  avisarEscribiendo: (canalId) => {
    const ahora = Date.now();
    if (ahora - ultimoAviso < AVISO_CADA_MS) return;
    ultimoAviso = ahora;
    socket?.enviar({ tipo: 'escribiendo', canal_id: canalId });
  },

  _quitarCanal: (canalId) => {
    useMensajesStore.getState().olvidar(canalId);
    useBorradorStore.getState().olvidar(canalId);
    set((s) => ({
      proyectos: s.proyectos.map((p) => ({
        ...p,
        canales: p.canales.filter((c) => c.id !== canalId),
      })),
      directos: s.directos.filter((d) => d.id !== canalId),
      canalId: s.canalId === canalId ? null : s.canalId,
      hiloId: s.canalId === canalId ? null : s.hiloId,
    }));
    get()._podarAbiertos();
    if (!get().canalId) get()._elegirAlgoQueMirar();
  },

  conectar: () => {
    if (socket || !get().llave) return;
    socket = abrirSocket({
      llave: get().llave,
      cursores: () => useMensajesStore.getState().cursores(),
      alEstado: (conexion) => set({ conexion }),
      alEvento: (evento) => get()._evento(evento),
    });
  },

  desconectar: () => {
    socket?.cerrar();
    socket = null;
    set({ conexion: 'sin-conexion' });
  },

  _evento: (ev) => {
    const mensajes = useMensajesStore.getState();

    switch (ev.tipo) {
      case 'listo':
        if (get().presencia === 'desconectado') {
          get()._presencia(get().usuario?.id, 'en_linea');
        }
        break;

      case 'mensaje': {
        mensajes.recibir(ev.canal_id, ev.mensaje, ev.resumen_hilo);
        const propio = ev.mensaje.autor_id === get().usuario?.id;
        if (propio) break;
        if (ev.mensaje.responde_a) {
          const raiz = ev.mensaje.responde_a;
          if (raiz !== get().hiloId) {
            set((s) => ({
              hilosNuevos: { ...s.hilosNuevos, [raiz]: (s.hilosNuevos[raiz] || 0) + 1 },
            }));
          }
          break;
        }
        if (ev.canal_id !== get().canalId) {
          set((s) => ({
            noLeidos: { ...s.noLeidos, [ev.canal_id]: (s.noLeidos[ev.canal_id] || 0) + 1 },
          }));
        }
        break;
      }

      case 'mensaje_ack':
        mensajes.confirmar(ev.canal_id, ev.client_id, ev.mensaje, ev.resumen_hilo);
        break;

      case 'mensaje_editado':
        mensajes._editado(ev.canal_id, ev.mensaje);
        break;

      case 'mensaje_borrado':
        mensajes._borrado(ev.canal_id, ev);
        if (!ev.mensaje && ev.mensaje_id === get().hiloId) set({ hiloId: null });
        break;

      case 'escribiendo':
        set((s) => {
          const ahora = Date.now();
          const vivas = Object.fromEntries(
            Object.entries(s.escribiendo).filter(([, hasta]) => hasta > ahora),
          );
          vivas[`${ev.canal_id}:${ev.usuario_id}`] = ahora + ESCRIBIENDO_MS;
          return { escribiendo: vivas };
        });
        break;

      case 'presencia':
        get()._presencia(ev.usuario_id, ev.estado);
        break;

      case 'canal_creado':
        get()._ponerCanal(ev.canal);
        break;

      case 'canal_borrado':
        get()._quitarCanal(ev.canal_id);
        break;

      case 'proyecto_actualizado':
        set((s) => ({
          proyectos: s.proyectos.map((p) => (p.id === ev.proyecto.id ? ev.proyecto : p)),
        }));
        break;

      case 'miembro_entra':
      case 'miembro_sale':
      case 'amistad':
        get().cargar();
        break;

      default:
        break;
    }
  },

  _presencia: (usuarioId, estado) => {
    const soyYo = usuarioId === get().usuario?.id;
    set((s) => ({
      ...(soyYo ? { presencia: estado } : {}),
      proyectos: s.proyectos.map((p) => ({
        ...p,
        miembros: p.miembros.map((m) =>
          m.usuario.id === usuarioId ? { ...m, estado } : m,
        ),
      })),
      directos: s.directos.map((d) => (d.con?.id === usuarioId ? { ...d, estado } : d)),
      amigos: s.amigos.map((a) => (a.usuario?.id === usuarioId ? { ...a, estado } : a)),
    }));
  },

  _ponerCanal: (canal) => {
    if (canal.tipo === 'directo') {
      set((s) => ({
        directos: s.directos.some((d) => d.id === canal.id)
          ? s.directos.map((d) => (d.id === canal.id ? canal : d))
          : [...s.directos, canal],
      }));
      return;
    }
    set((s) => ({
      proyectos: s.proyectos.map((p) => {
        if (p.id !== canal.proyecto_id) return p;
        const canales = p.canales.some((c) => c.id === canal.id)
          ? p.canales.map((c) => (c.id === canal.id ? canal : c))
          : [...p.canales, canal];
        return { ...p, canales };
      }),
    }));
  },
}));
