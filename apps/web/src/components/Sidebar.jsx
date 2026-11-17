import { tieneVisuals } from '../lib/planes';
import { useDonaciones } from '../lib/donaciones';
import { useTema } from '../hooks/useTema';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate as useRawNavigate } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { guardarIdioma, otherLocalePath, withLocale } from '../i18n/paths';
import { useT } from '../i18n/useT';
import { ShimmerText } from './ShimmerText';
import { useTrabajando } from '../lib/trabajando';
import { LogoLixbon, LogoMark } from './Logo';
import { useDismiss } from '../hooks/useDismiss';
import { useConfirmar } from '../hooks/useConfirmar';
import { HistorySkeleton } from './Skeleton';
import { Recorte } from './Pulido';
import { Desplegable } from './Desplegable';
import {
  IconChevron, IconDots, IconX, IconUser,
  NavNuevo, NavBuscar, NavPanel, NavChat, NavVisuals, NavEspacios, NavSkills, NavApps, NavRemoto, NavDocs,
  NavAjustes, NavUso, NavPlanes, NavIdioma, NavSalir, NavAdmin, NavDonar, TemaClaro, TemaOscuro, TemaSistema,
  Icono,
} from './Icons';

const MENU_W = 220; // ancho mínimo de .sb-menu, para no salirse por la derecha

// «Recientes» se puede plegar; se recuerda entre visitas.
const RECIENTES_KEY = 'lixbon.sidebar.recientes';
const leerRecientes = () => { try { return localStorage.getItem(RECIENTES_KEY) !== '0'; } catch { return true; } };

// «Archivadas» empieza plegado: las sesiones guardadas no estorban.
const ARCHIVADAS_KEY = 'lixbon.sidebar.archivadas';
const leerArchivadas = () => { try { return localStorage.getItem(ARCHIVADAS_KEY) === '1'; } catch { return false; } };

// Orden y filtro de las sesiones (Coding).
const ORDEN_KEY = 'lixbon.sidebar.sesiones';
const leerOrden = () => {
  try { return { orden: 'actividad', origen: 'todas', ...JSON.parse(localStorage.getItem(ORDEN_KEY) || '{}') }; } catch { return { orden: 'actividad', origen: 'todas' }; }
};

// Una sesión de la nube sigue viva mientras su entorno esté encendido.
const enMarcha = (r) => (r.source === 'cloud'
  ? ['preparando', 'activa'].includes(r.sandbox?.estado) && r.status !== 'ended'
  : r.status === 'online');

const ICONO_ORIGEN = { cloud: 'remoto', cli: 'cli', ide: 'ide' };

const iniciales = (user) => {
  const n = [user.first_name, user.last_name].filter(Boolean);
  if (n.length) return n.map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (user.username || '?')[0].toUpperCase();
};

// El menú es `position: fixed` porque la lista hace scroll y lo recortaba. Se
// mide justo antes de pintar para que no salte.
function useMenuFijo(abierto, btnRef, alto) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!abierto) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
        top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - alto - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [abierto, btnRef, alto]);
  return pos;
}

// Una fila de la barra: el título y, a la derecha, el icono de lo que es
// (nube, CLI, IDE o espacio) que se cambia por «⋯» al pasar el ratón.
function Fila({ titulo, activa, trabajando, apagada, deshabilitada, onOpen, icono, iconoTitulo, marca, opciones, editable, onRename, etiquetaMenu }) {
  const t = useT('sidebar');
  const tc = useT('common');
  const [menu, setMenu] = useState(false);
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState('');
  const raiz = useRef(null);
  const btn = useRef(null);
  const cerrar = useCallback(() => setMenu(false), []);
  useDismiss(menu, raiz, cerrar);
  const pos = useMenuFijo(menu, btn, 48 + opciones.length * 38);

  const confirmar = () => {
    setEditando(false);
    const nuevo = borrador.trim();
    if (nuevo && nuevo !== titulo) onRename(nuevo);
  };

  if (editando) {
    return (
      <div className="sb-fila sb-fila--editando">
        <input className="sb-item__edit" value={borrador} autoFocus aria-label={t('conversationOptions')}
          onChange={(e) => setBorrador(e.target.value)} onBlur={confirmar}
          onKeyDown={(e) => { if (e.key === 'Enter') confirmar(); if (e.key === 'Escape') setEditando(false); }} />
      </div>
    );
  }

  const items = editable
    ? [{ id: 'rename', icono: 'editar', label: tc('rename'), onClick: () => { setBorrador(titulo); setEditando(true); } }, ...opciones]
    : opciones;
  return (
    <div className={`sb-fila ${activa ? 'is-active' : ''} ${menu ? 'is-menu' : ''} ${apagada ? 'is-apagada' : ''}`} ref={raiz}>
      <button type="button" className="sb-fila__abrir" onClick={onOpen} disabled={deshabilitada} aria-current={activa ? 'page' : undefined}
        aria-label={iconoTitulo ? `${titulo} · ${iconoTitulo}` : titulo}>
        {/* Sin «…»: si no cabe, el final se funde y el nombre completo sale
            en un globo a su lado. */}
        {trabajando ? <ShimmerText text={titulo} className="sb-fila__t" /> : <Recorte texto={titulo} className="sb-fila__t" />}
      </button>
      <button type="button" ref={btn} className="sb-fila__slot" onClick={() => setMenu((v) => !v)}
        aria-label={etiquetaMenu} aria-haspopup="menu" aria-expanded={menu}>
        {icono && (
          <span className="sb-fila__origen" aria-hidden="true">
            <Icono nombre={icono} size={16} />
            {marca && <span className={`sb-fila__marca sb-fila__marca--${marca}`} />}
          </span>
        )}
        <span className="sb-fila__puntos" aria-hidden="true"><IconDots size={16} /></span>
      </button>
      {pos && (
        <Desplegable abierto={menu} className="sb-menu" style={{ left: pos.left, top: pos.top }} role="menu">
          {items.map((o) => (o.sep ? <div key={o.id} className="sb-menu__sep" /> : (
            <button key={o.id} role="menuitem" className={o.peligro ? 'sb-menu__danger' : ''} title={o.hint}
              onClick={() => { setMenu(false); o.onClick(); }}>
              <Icono nombre={o.icono} size={16} /> <span>{o.label}</span>
            </button>
          )))}
        </Desplegable>
      )}
    </div>
  );
}

function HistoryItem({ conv, active, onRename, onDelete, onPin, onArchive, onMove, onShare, onNavigate, base = '/c' }) {
  const t = useT('sidebar');
  const tc = useT('common');
  const estaTrabajando = useTrabajando();
  const navigate = useNavigate();
  const titulo = conv.title || t('untitled');
  const opciones = [
    { id: 'pin', icono: 'fijar', label: conv.pinned ? t('unpinChat') : t('pinChat'), onClick: () => onPin?.(conv.id, !conv.pinned) },
    { id: 'move', icono: 'carpeta', label: t('moveToSpace'), onClick: () => onMove?.(conv) },
    { id: 'share', icono: 'compartir', label: t('shareChat'), onClick: () => onShare?.(conv.id) },
    { id: 's1', sep: true },
    { id: 'archive', icono: 'archivar', label: t('archiveChat'), onClick: () => onArchive?.(conv.id) },
    { id: 'delete', icono: 'borrar', label: tc('delete'), peligro: true, onClick: () => onDelete(conv.id) },
  ];
  return (
    <Fila titulo={titulo} activa={active} trabajando={estaTrabajando(conv.id)}
      onOpen={() => { navigate(`${base}/${conv.id}`); onNavigate?.(); }}
      icono={conv.espacio_id ? 'carpeta' : null} iconoTitulo={conv.espacio_id ? t('spaces') : null}
      opciones={opciones} editable onRename={(nuevo) => onRename(conv.id, nuevo)} etiquetaMenu={t('conversationOptions')} />
  );
}

// Sesión de la nube, el CLI o el IDE: abrir, renombrar, fijar, archivar y lo propio de cada una.
function RemoteItem({ r, active, onOpen, acciones }) {
  const t = useT('sidebar');
  const tc = useT('common');
  const confirmar = useConfirmar();
  const nube = r.source === 'cloud';
  const activa = enMarcha(r);
  const titulo = r.title || t('remoteSession');
  const marca = r.needs_you ? 'warn' : (nube && r.sandbox?.estado === 'error') ? 'danger' : null;
  const origen = { cloud: t('cloudSession'), cli: 'CLI', ide: 'IDE' }[r.source] || r.source;
  const estadoTxt = marca === 'warn' ? t('needsYou') : marca === 'danger' ? t('failed') : t(`remote_${activa ? 'online' : r.status === 'ended' ? 'ended' : 'offline'}`);

  const pausable = nube && ['preparando', 'activa'].includes(r.sandbox?.estado);
  const reanudable = nube && ['pausada', 'error'].includes(r.sandbox?.estado);
  const rama = r.sandbox?.branch;
  const prN = r.sandbox?.pr_url ? Number(r.sandbox.pr_url.split('/').pop()) : null;
  const opciones = [
    { id: 'pin', icono: 'fijar', label: r.pinned ? t('unpinSession') : t('pinSession'), onClick: () => acciones.pin(r.id, !r.pinned) },
    ...(pausable ? [{ id: 'pause', icono: 'pausa', label: t('pauseEnv'), onClick: () => acciones.pausar(r.id) }] : []),
    ...(reanudable ? [{ id: 'resume', icono: 'reproducir', label: t('resumeEnv'), onClick: () => acciones.reanudar(r.id) }] : []),
    ...(nube && rama ? [{ id: 'branch', icono: 'externo', label: t('viewBranch'), onClick: () => window.open(`https://github.com/${r.sandbox.repo}/tree/${rama}`, '_blank', 'noopener') }] : []),
    ...(nube && prN ? [{ id: 'pr', icono: 'pull-request', label: t('viewPr', { n: prN }), onClick: () => window.open(r.sandbox.pr_url, '_blank', 'noopener') }] : []),
    ...(!nube && r.status !== 'ended' ? [{
      id: 'end', icono: 'detener', label: t('endSession'), hint: t('endSessionHint'),
      onClick: async () => { if (await confirmar({ titulo: t('endTitle'), texto: t('endText'), etiqueta: t('endSession') })) acciones.terminar(r.id); },
    }] : []),
    { id: 's1', sep: true },
    { id: 'archive', icono: r.archived ? 'bandeja' : 'archivar', label: r.archived ? t('unarchiveSession') : t('archiveSession'), onClick: () => acciones.archivar(r.id, !r.archived) },
    nube ? {
      id: 'delete', icono: 'borrar', label: tc('delete'), peligro: true,
      onClick: async () => { if (await confirmar({ titulo: t('deleteSessionTitle'), texto: t('deleteSessionText'), etiqueta: tc('delete') })) acciones.borrar(r); },
    } : {
      id: 'forget', icono: 'borrar', label: t('forgetSession'), peligro: true,
      onClick: async () => { if (await confirmar({ titulo: t('forgetTitle'), texto: t('forgetText'), etiqueta: t('forgetSession') })) acciones.borrar(r); },
    },
  ];
  return (
    <Fila titulo={titulo} activa={active} trabajando={activa && !marca} apagada={r.status === 'ended' && !nube}
      deshabilitada={r.status === 'ended' && !(r.transcript_events > 0)} onOpen={onOpen}
      icono={ICONO_ORIGEN[r.source] || 'remoto'} iconoTitulo={`${origen} · ${estadoTxt}`} marca={marca}
      opciones={opciones} editable onRename={(nuevo) => acciones.renombrar(r.id, nuevo)} etiquetaMenu={t('sessionOptions')} />
  );
}

// Cabecera de grupo: plegable si se quiere y, al pasar, su acción (ordenar).
function Cabecera({ texto, n, abierta, onToggle, accion }) {
  const contenido = (
    <>
      <span>{texto}</span>
      {n != null && <span className="sb-cab__n">{n}</span>}
      {onToggle && <IconChevron size={14} open={abierta} />}
    </>
  );
  return (
    <div className="sb-cab">
      {onToggle ? (
        <button type="button" className="sb-cab__btn" onClick={onToggle} aria-expanded={abierta}>{contenido}</button>
      ) : <span className="sb-cab__btn">{contenido}</span>}
      {accion}
    </div>
  );
}

function MenuOrden({ orden, setOrden }) {
  const t = useT('sidebar');
  const [abierto, setAbierto] = useState(false);
  const raiz = useRef(null);
  const btn = useRef(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useDismiss(abierto, raiz, cerrar);
  const pos = useMenuFijo(abierto, btn, 330);
  const opt = (clave, valor, label, icono) => (
    <button key={`${clave}-${valor}`} role="menuitemradio" aria-checked={orden[clave] === valor}
      onClick={() => setOrden({ ...orden, [clave]: valor })}>
      {icono ? <Icono nombre={icono} size={16} /> : <span className="sb-menu__hueco" />}
      <span>{label}</span>
      {orden[clave] === valor && <Icono nombre="hecho" size={16} className="sb-menu__check" />}
    </button>
  );
  return (
    <span ref={raiz}>
      <button type="button" ref={btn} className={`sb-cab__accion ${abierto ? 'is-on' : ''}`} onClick={() => setAbierto((v) => !v)}
        aria-label={t('sortFilter')} title={t('sortFilter')} aria-haspopup="menu" aria-expanded={abierto}>
        <Icono nombre="selector" size={14} />
      </button>
      {pos && (
        <Desplegable abierto={abierto} className="sb-menu" style={{ left: pos.left, top: pos.top }} role="menu">
          <small className="sb-menu__tit">{t('sortBy')}</small>
          {opt('orden', 'actividad', t('sortActivity'))}
          {opt('orden', 'creacion', t('sortCreated'))}
          <div className="sb-menu__sep" />
          <small className="sb-menu__tit">{t('show')}</small>
          {opt('origen', 'todas', t('showAll'))}
          {opt('origen', 'cloud', t('showCloud'), 'remoto')}
          {opt('origen', 'cli', t('showCli'), 'cli')}
          {opt('origen', 'ide', t('showIde'), 'ide')}
        </Desplegable>
      )}
    </span>
  );
}

// ES / EN: cambia la ruta al otro idioma y lo recuerda.
function SelectorIdioma() {
  const tn = useT('nav');
  const locale = useLocale();
  const { pathname } = useLocation();
  const rawNavigate = useRawNavigate();
  return (
    <span className="sb-seg sb-seg--texto" role="group" aria-label={tn('language')}>
      {[{ code: 'es', label: 'ES' }, { code: 'en', label: 'EN' }].map((o) => (
        <button
          key={o.code}
          type="button"
          className={locale === o.code ? 'is-on' : ''}
          aria-pressed={locale === o.code}
          onClick={() => {
            if (locale === o.code) return;
            guardarIdioma(o.code);
            rawNavigate(otherLocalePath(pathname));
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function Sidebar({
  user, conversations, fijados = [], loadingConversations, activeId, collapsed, onToggleCollapse,
  onRename, onDelete, onPin, onArchive, onMove, onShare, onLogout, compact = false, open = false, onClose,
  hasMoreConversations = false, onLoadMore, onSearch,
  historyBase = '/c', newPath = '/chat', seccion = 'chat', remotas = [], remotaActiva = null,
  accionesRemota = {}, onNuevaSesion,
  ultimas = { chat: '/chat', visuals: '/visuals' },
}) {
  const t = useT('sidebar');
  const tc = useT('common');
  const tn = useT('nav');
  const donaciones = useDonaciones();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);
  const [masMenu, setMasMenu] = useState(false);
  const { preferencia: temaPref, fijar: fijarTema } = useTema();
  const searchRef = useRef(null);
  const profileRef = useRef(null);
  const masRef = useRef(null);
  const closeBtnRef = useRef(null);
  const navigate = useNavigate();

  const closeProfile = useCallback(() => setProfileMenu(false), []);
  useDismiss(profileMenu, profileRef, closeProfile);
  const closeMas = useCallback(() => setMasMenu(false), []);
  useDismiss(masMenu, masRef, closeMas);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const cerrarBusqueda = () => {
    setSearchOpen(false);
    setQuery('');
  };

  // El foco entra en el cajón al abrirlo. Depende solo de `open` a propósito:
  // con `onClose` en las dependencias, cada re-render del chat durante el
  // streaming robaría el foco al campo de búsqueda.
  useEffect(() => {
    if (compact && open) closeBtnRef.current?.focus();
  }, [compact, open]);

  useEffect(() => {
    if (!compact || !open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [compact, open, onClose]);

  const go = (path) => {
    navigate(path);
    if (compact) onClose?.();
  };
  // Ajustes se abre encima de lo que hay: sin transición de página y
  // recordando el fondo para volver a él al cerrar.
  const rawNav = useRawNavigate();
  const locationActual = useLocation();
  const localeSb = useLocale();
  const abrirAjustes = (sec = '') => {
    rawNav(withLocale(`/account${sec ? `/${sec}` : ''}`, localeSb), { state: { fondo: locationActual } });
    if (compact) onClose?.();
  };

  const abrirBusqueda = () => {
    if (collapsed && !compact) onToggleCollapse?.();
    setSearchOpen(true);
  };

  // Con onSearch la búsqueda la resuelve el servidor (el historial llega por
  // páginas); mientras responde, se filtra lo que ya está cargado.
  const [found, setFound] = useState(null);
  useEffect(() => {
    const q = query.trim();
    setFound(null);
    if (!q || !onSearch) return undefined;
    let vigente = true;
    const timer = setTimeout(() => {
      onSearch(q).then((items) => { if (vigente) setFound({ q, items }); }).catch(() => {});
    }, 250);
    return () => { vigente = false; clearTimeout(timer); };
  }, [query, onSearch]);

  const q = query.trim();
  const fijadosIds = new Set(fijados.map((c) => c.id));
  const local = q
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q.toLowerCase()))
    : conversations.filter((c) => !fijadosIds.has(c.id));
  const visible = q && found?.q === q ? found.items : local;

  // Solo llegan las 10 más recientes; las siguientes se piden a mano con
  // «Cargar más» al final de la lista, nunca solas al hacer scroll.
  const wantsMore = !q && hasMoreConversations && Boolean(onLoadMore);
  const [cargandoMas, setCargandoMas] = useState(false);
  const cargarMas = async () => {
    if (cargandoMas) return;
    setCargandoMas(true);
    try { await onLoadMore(); } finally { setCargandoMas(false); }
  };

  const [recientesAbierto, setRecientesAbierto] = useState(leerRecientes);
  const alternarRecientes = () => setRecientesAbierto((v) => {
    try { localStorage.setItem(RECIENTES_KEY, v ? '0' : '1'); } catch { /* sin almacenamiento */ }
    return !v;
  });

  const [archivadasAbierto, setArchivadasAbierto] = useState(leerArchivadas);
  const alternarArchivadas = () => setArchivadasAbierto((v) => {
    try { localStorage.setItem(ARCHIVADAS_KEY, v ? '0' : '1'); } catch { /* sin almacenamiento */ }
    return !v;
  });

  const [orden, setOrdenEstado] = useState(leerOrden);
  const setOrden = (o) => {
    setOrdenEstado(o);
    try { localStorage.setItem(ORDEN_KEY, JSON.stringify(o)); } catch { /* sin almacenamiento */ }
  };

  const drawerHidden = compact && !open;
  const railVisible = collapsed && !compact;
  const esGratis = user && (!user.plan_id || user.plan_id === 'free');

  // Dos modos, como Chat y Code: la barra entera cambia. En Coding la lista
  // es la de sesiones (fijadas, activas, recientes y archivadas).
  const modo = seccion === 'remote' ? 'remote' : 'chat';
  const activo = modo === 'remote' ? null : seccion;
  const nuevoLabel = modo === 'remote' ? t('connectSession') : t('newConversation');
  const nuevo = () => (modo === 'remote' ? (onNuevaSesion ? onNuevaSesion() : go('/coding')) : go(newPath));
  const NAV = modo === 'remote' ? [
    { id: 'apps', to: '/apps', Icon: NavApps, label: t('apps') },
    { id: 'docs', to: '/docs/remote', Icon: NavDocs, label: t('docs') },
  ] : [
    { id: 'visuals', to: ultimas.visuals, Icon: NavVisuals, label: t('visuals'), pro: !tieneVisuals(user) },
    { id: 'espacios', to: '/espacios', Icon: NavEspacios, label: t('spaces') },
    { id: 'integraciones', to: '/integraciones', Icon: NavSkills, label: t('integrations') },
  ];
  const MAS = [
    { id: 'apps', to: '/apps', icono: 'apps', label: t('apps') },
    { id: 'docs', to: '/docs', icono: 'docs', label: t('docs') },
    ...(donaciones?.enabled ? [{ id: 'donar', to: '/plans', icono: 'donar', label: t('donate') }] : []),
  ];

  // Sesiones: buscar, filtrar por origen y ordenar; luego fijadas, activas,
  // recientes y, aparte y plegadas, las archivadas.
  const qr = q.toLowerCase();
  let sesiones = qr ? remotas.filter((r) => `${r.title || ''} ${r.machine || ''}`.toLowerCase().includes(qr)) : remotas;
  if (orden.origen !== 'todas') sesiones = sesiones.filter((r) => r.source === orden.origen);
  const clave = (r) => (orden.orden === 'creacion' ? r.created_at : r.last_seen_at) || '';
  sesiones = [...sesiones].sort((a, b) => clave(b).localeCompare(clave(a)));
  const archivadas = sesiones.filter((r) => r.archived);
  const vivas = sesiones.filter((r) => !r.archived);
  const gruposRemotos = [
    { clave: 'pinnedSessions', items: vivas.filter((r) => r.pinned) },
    { clave: 'activeSessions', items: vivas.filter((r) => !r.pinned && enMarcha(r)) },
    { clave: 'recentSessions', items: vivas.filter((r) => !r.pinned && !enMarcha(r)), orden: true },
  ].filter((g) => g.items.length || g.orden);
  const verArchivadas = archivadas.length > 0 && (archivadasAbierto || Boolean(qr));
  const archivarRemota = (id, archived) => {
    if (archived) setArchivadasAbierto(true);
    accionesRemota.archivar?.(id, archived);
  };
  const acciones = { ...accionesRemota, archivar: archivarRemota };
  const pintarRemota = (r) => (
    <RemoteItem key={r.id} r={r} active={r.id === remotaActiva} acciones={acciones}
      onOpen={() => go(`${r.source === 'cloud' ? '/coding' : '/remote'}?s=${r.id}`)} />
  );
  const pintarChat = (c) => (
    <HistoryItem key={c.id} conv={c} active={c.id === activeId} onRename={onRename} onDelete={onDelete}
      onPin={onPin} onArchive={onArchive} onMove={onMove} onShare={onShare}
      onNavigate={compact ? onClose : undefined} base={historyBase} />
  );
  const haySesiones = gruposRemotos.some((g) => g.items.length) || archivadas.length > 0;
  const nombreUsuario = user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.username) : '';

  return (
    <aside
      className={`sidebar sidebar--v2 ${railVisible ? 'is-collapsed' : ''} ${open ? 'is-open' : ''}`}
      id="sidebar-drawer"
      aria-label={t('conversationsPanel')}
      aria-hidden={drawerHidden || undefined}
      inert={drawerHidden || undefined}
    >
      {/* Colapsada: solo iconos, con su nombre en un globo al pasar el cursor. */}
      <nav className="sidebar__rail" aria-label={t('spaces')} aria-hidden={!railVisible} inert={!railVisible || undefined}>
        <button className="sb-rail__btn sb-rail__logo" onClick={onToggleCollapse} data-tip={t('openPanel')} aria-label={t('openPanel')}>
          <LogoMark size={20} />
          <NavPanel />
        </button>
        <button className="sb-rail__btn sb-rail__btn--nuevo" onClick={nuevo} data-tip={nuevoLabel} aria-label={nuevoLabel}>
          <NavNuevo />
        </button>
        <button className="sb-rail__btn" onClick={abrirBusqueda} data-tip={t('search')} aria-label={t('search')}>
          <NavBuscar />
        </button>
        <button className="sb-rail__btn" onClick={() => navigate(modo === 'remote' ? ultimas.chat : '/coding')}
          data-tip={modo === 'remote' ? t('chatMode') : t('remoteMode')} aria-label={modo === 'remote' ? t('chatMode') : t('remoteMode')}>
          {modo === 'remote' ? <NavChat /> : <NavRemoto />}
        </button>
        <span className="sb-rail__hueco" />
        {[...NAV, ...(modo === 'chat' ? MAS.filter((m) => m.id !== 'donar').map((m) => ({ ...m, Icon: m.id === 'apps' ? NavApps : NavDocs })) : [])].map(({ id, to, Icon, label }) => (
          <button key={id} className={`sb-rail__btn ${activo === id ? 'is-active' : ''}`} onClick={() => navigate(to)} data-tip={label} aria-label={label}>
            <Icon relleno={activo === id} />
          </button>
        ))}
        {user && (
          <button className="sb-rail__btn sb-rail__avatar" onClick={() => { onToggleCollapse?.(); setProfileMenu(true); }} data-tip={t('account')} aria-label={t('account')}>
            {user.avatar_url
              ? <img className="sidebar__avatar sidebar__avatar--img" src={user.avatar_url} alt="" />
              : <span className="sidebar__avatar">{iniciales(user)}</span>}
          </button>
        )}
      </nav>

      <div className="sidebar__body" aria-hidden={railVisible} inert={railVisible || undefined}>
        <div className="sidebar__header">
          <Link to="/chat" className="sidebar__logo" onClick={compact ? onClose : undefined}>
            <LogoLixbon />
          </Link>
          <span className="sb-modo" role="group" aria-label={t('mode')}>
            <button type="button" className={modo === 'chat' ? 'is-on' : ''} aria-pressed={modo === 'chat'}
              onClick={() => modo !== 'chat' && go(ultimas.chat)} title={t('chatMode')} aria-label={t('chatMode')}>
              <NavChat size={16} relleno={modo === 'chat'} />
            </button>
            <button type="button" className={modo === 'remote' ? 'is-on' : ''} aria-pressed={modo === 'remote'}
              onClick={() => modo !== 'remote' && go('/coding')} title={t('remoteMode')} aria-label={t('remoteMode')}>
              <NavRemoto size={16} relleno={modo === 'remote'} />
            </button>
          </span>
          {compact ? (
            <button ref={closeBtnRef} className="icon-btn" onClick={onClose} aria-label={t('closePanel')}>
              <IconX />
            </button>
          ) : (
            <button className="icon-btn" onClick={onToggleCollapse} aria-label={t('collapsePanel')} title={t('collapsePanel')}>
              <NavPanel />
            </button>
          )}
        </div>

        <nav className="sb-nav2" aria-label={t('spaces')}>
          <button type="button" className="sb-nav2__fila" onClick={nuevo}>
            <NavNuevo /> <span>{nuevoLabel}</span> <kbd>Ctrl K</kbd>
          </button>
          {searchOpen ? (
            <div className="sb-nav2__fila sb-nav2__busca">
              <NavBuscar />
              <input
                ref={searchRef}
                type="search"
                placeholder={modo === 'remote' ? t('searchSessions') : t('searchHistory')}
                aria-label={modo === 'remote' ? t('searchSessions') : t('searchHistory')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  e.stopPropagation(); // en móvil, Escape también cerraría el cajón
                  cerrarBusqueda();
                }}
              />
              <button type="button" className="sb-nav2__cerrar" onClick={cerrarBusqueda} aria-label={tc('close')}><IconX size={14} /></button>
            </div>
          ) : (
            <button type="button" className="sb-nav2__fila" onClick={() => setSearchOpen(true)}>
              <NavBuscar /> <span>{t('search')}</span>
            </button>
          )}
          {NAV.map(({ id, to, Icon, label, pro }) => (
            <button key={id} type="button" className={`sb-nav2__fila ${activo === id ? 'is-active' : ''}`} onClick={() => go(to)}
              aria-current={activo === id ? 'page' : undefined}>
              <Icon relleno={activo === id} /> <span>{label}</span>
              {pro && <span className="sb-nav__pro">Pro</span>}
            </button>
          ))}
          {modo === 'chat' && (
            <div className="sb-nav2__mas" ref={masRef}>
              <button type="button" className={`sb-nav2__fila ${masMenu ? 'is-on' : ''}`} onClick={() => setMasMenu((v) => !v)}
                aria-haspopup="menu" aria-expanded={masMenu}>
                <Icono nombre="opciones" size={18} /> <span>{t('more')}</span>
              </button>
              <Desplegable abierto={masMenu} className="sb-menu sb-menu--mas" role="menu">
                {MAS.map((m) => (
                  <button key={m.id} role="menuitem" onClick={() => { setMasMenu(false); go(m.to); }}>
                    <Icono nombre={m.icono} size={16} /> <span>{m.label}</span>
                  </button>
                ))}
              </Desplegable>
            </div>
          )}
        </nav>

        <div className="sidebar__history sb-lista" role="region" aria-label={t('history')}>
          {modo === 'remote' ? (
            <>
              {gruposRemotos.map((g) => (
                <div key={g.clave} className="sb-grupo">
                  <Cabecera texto={t(g.clave)} accion={g.orden ? <MenuOrden orden={orden} setOrden={setOrden} /> : null} />
                  {g.items.map(pintarRemota)}
                </div>
              ))}
              {archivadas.length > 0 && (
                <div className="sb-grupo">
                  <Cabecera texto={t('archivedSessions')} n={archivadas.length} abierta={verArchivadas} onToggle={alternarArchivadas} />
                  {verArchivadas && archivadas.map(pintarRemota)}
                </div>
              )}
              {!haySesiones && (
                <p className="sidebar__empty">{qr || orden.origen !== 'todas' ? t('noResults') : user ? t('noRemoteSessions') : t('logInToSaveHistory')}</p>
              )}
            </>
          ) : user && loadingConversations ? (
            <HistorySkeleton />
          ) : (
            <>
              {q ? (
                <div className="sb-grupo">
                  {visible.map(pintarChat)}
                  {visible.length === 0 && <p className="sidebar__empty">{t('noResults')}</p>}
                </div>
              ) : (
                <>
                  {fijados.length > 0 && (
                    <div className="sb-grupo">
                      <Cabecera texto={t('pinnedChats')} />
                      {fijados.map(pintarChat)}
                    </div>
                  )}
                  {visible.length > 0 && (
                    <div className="sb-grupo">
                      <Cabecera texto={t('recentChats')} abierta={recientesAbierto} onToggle={alternarRecientes} />
                      {recientesAbierto && (
                        <>
                          {visible.map(pintarChat)}
                          {wantsMore && (
                            <button type="button" className="sidebar__more" onClick={cargarMas} disabled={cargandoMas}>
                              {cargandoMas ? t('loadingMore') : t('loadMore')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
              {visible.length === 0 && fijados.length === 0 && !q && (
                <p className="sidebar__empty">
                  {user ? t('noConversations') : t('logInToSaveHistory')}
                </p>
              )}
            </>
          )}
        </div>

        <div className="sidebar__foot sb-pie">
          <div className="sidebar__profile" ref={profileRef}>
            {user ? (
              <>
                <div className="sb-pie__fila">
                  <button
                    type="button"
                    className={`sb-pie__yo ${profileMenu ? 'is-open' : ''}`}
                    onClick={() => setProfileMenu((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={profileMenu}
                  >
                    {user.avatar_url
                      ? <img className="sidebar__avatar sidebar__avatar--img" src={user.avatar_url} alt="" />
                      : <span className="sidebar__avatar">{iniciales(user)}</span>}
                    <span className="sb-pie__nombre">{nombreUsuario}</span>
                    <span className="sb-pie__plan">· {user.plan_name || t('freePlan')}</span>
                    <IconChevron size={14} open={profileMenu} />
                  </button>
                  <button type="button" className="icon-btn sb-pie__ajustes" onClick={() => abrirAjustes()} aria-label={t('settings')} title={t('settings')}>
                    <NavAjustes />
                  </button>
                </div>
                <Desplegable abierto={profileMenu} className="sb-cuenta" role="menu">
                  <div className="sb-cuenta__quien">
                    <span className="sb-cuenta__nombre">{nombreUsuario}</span>
                    {user.email && <span className="sb-cuenta__correo">{user.email}</span>}
                  </div>
                  <button role="menuitem" onClick={() => { setProfileMenu(false); abrirAjustes(); }}>
                    <NavAjustes /> {tc('settings')}
                  </button>
                  <button role="menuitem" onClick={() => { setProfileMenu(false); abrirAjustes('usage'); }}>
                    <NavUso /> {t('usage')}
                  </button>
                  <button role="menuitem" className={esGratis ? 'sb-cuenta__mejorar' : ''} onClick={() => { setProfileMenu(false); go('/plans'); }}>
                    <NavPlanes /> {esGratis ? t('upgradePro') : tn('plans')}
                  </button>
                  {donaciones?.enabled && modo === 'remote' && (
                    <button role="menuitem" onClick={() => { setProfileMenu(false); go('/plans'); }}>
                      <NavDonar /> {t('donate')}
                    </button>
                  )}
                  <div className="sb-cuenta__fila">
                    <span>{t('theme')}</span>
                    <span className="sb-seg" role="group" aria-label={t('theme')}>
                      {[['light', TemaClaro, t('lightTheme')], ['dark', TemaOscuro, t('darkTheme')], ['system', TemaSistema, t('systemTheme')]].map(([valor, IconoTema, nombre]) => (
                        <button key={valor} type="button" className={temaPref === valor ? 'is-on' : ''} aria-pressed={temaPref === valor} aria-label={nombre} title={nombre} onClick={() => fijarTema(valor)}>
                          <IconoTema size={16} relleno={temaPref === valor} />
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="sb-cuenta__fila">
                    <span className="sb-cuenta__etiqueta"><NavIdioma /> {tn('language')}</span>
                    <SelectorIdioma />
                  </div>
                  {user.role === 'admin' && (
                    <button role="menuitem" onClick={() => { setProfileMenu(false); go('/admin'); }}>
                      <NavAdmin /> {t('adminPanel')}
                    </button>
                  )}
                  <button role="menuitem" onClick={() => { setProfileMenu(false); onLogout(); }}>
                    <NavSalir /> {tc('logOut')}
                  </button>
                </Desplegable>
              </>
            ) : (
              <div className="sidebar__invitado">
                <Link to="/auth" className="sidebar__profile-btn" onClick={compact ? onClose : undefined}>
                  <span className="sidebar__avatar sidebar__avatar--guest"><IconUser size={15} /></span>
                  <span className="sidebar__profile-info">
                    <span className="sidebar__profile-name">{tc('logIn')}</span>
                    <span className="sidebar__plan">{t('logInToSaveHistory')}</span>
                  </span>
                </Link>
                <SelectorIdioma />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
