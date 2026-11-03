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
import { HistorySkeleton } from './Skeleton';
import { Desplegable } from './Desplegable';
import {
  IconChevron, IconDots, IconPencil, IconTrash, IconX, IconUser, IconUpDown, IconCli, IconIde,
  NavNuevo, NavBuscar, NavPanel, NavChat, NavVisuals, NavEspacios, NavSkills, NavApps, NavRemoto, NavDocs,
  NavAjustes, NavUso, NavPlanes, NavIdioma, NavSalir, NavAdmin, NavDonar, TemaClaro, TemaOscuro, TemaSistema,
} from './Icons';

const MENU_W = 170; // ancho mínimo de .sb-menu, para no salirse por la derecha

// «Recientes» se puede plegar; se recuerda entre visitas.
const RECIENTES_KEY = 'lixbon.sidebar.recientes';
const leerRecientes = () => { try { return localStorage.getItem(RECIENTES_KEY) !== '0'; } catch { return true; } };

const iniciales = (user) => {
  const n = [user.first_name, user.last_name].filter(Boolean);
  if (n.length) return n.map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (user.username || '?')[0].toUpperCase();
};

function HistoryItem({ conv, active, onRename, onDelete, onNavigate, base = '/c' }) {
  const t = useT('sidebar');
  const estaTrabajando = useTrabajando();
  const tc = useT('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const navigate = useNavigate();
  const rootRef = useRef(null);
  const btnRef = useRef(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, rootRef, closeMenu);

  // El menú es `position: fixed` porque el historial hace scroll y lo recortaba.
  // Se mide justo antes de pintar para que no salte.
  useLayoutEffect(() => {
    if (!menuOpen) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setMenuPos({
        left: Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8),
        top: Math.min(r.bottom + 4, window.innerHeight - 110),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menuOpen]);

  const startEdit = () => {
    setDraft(conv.title || '');
    setEditing(true);
    setMenuOpen(false);
  };

  const commitEdit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== conv.title) onRename(conv.id, title);
  };

  if (editing) {
    return (
      <div className="sb-item sb-item--editing">
        <input
          className="sb-item__edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          autoFocus
        />
      </div>
    );
  }

  const titulo = conv.title || t('untitled');
  // Con una respuesta en curso, el título lleva el brillo de «Pensando».
  const trabajando = estaTrabajando(conv.id);
  return (
    <div className={`sb-item ${active ? 'is-active' : ''}`} ref={rootRef}>
      <button
        className="sb-item__title"
        onClick={() => { navigate(`${base}/${conv.id}`); onNavigate?.(); }}
      >
        {trabajando
          ? <ShimmerText text={titulo} className="sb-item__texto" />
          : <span className="sb-item__texto">{titulo}</span>}
      </button>
      <button
        ref={btnRef}
        className="icon-btn sb-item__menu-btn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label={t('conversationOptions')}
        aria-expanded={menuOpen}
      >
        <IconDots size={14} />
      </button>
      {menuPos && (
        <Desplegable abierto={menuOpen} className="sb-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
          <button onClick={startEdit}><IconPencil size={14} /> {tc('rename')}</button>
          <button className="sb-menu__danger" onClick={() => { setMenuOpen(false); onDelete(conv.id); }}>
            <IconTrash size={14} /> {tc('delete')}
          </button>
        </Desplegable>
      )}
    </div>
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
  user, conversations, loadingConversations, activeId, collapsed, onToggleCollapse,
  onRename, onDelete, onLogout, compact = false, open = false, onClose,
  hasMoreConversations = false, onLoadMore, onSearch,
  historyBase = '/c', newPath = '/chat', seccion = 'chat', remotas = [], remotaActiva = null,
  ultimas = { chat: '/chat', visuals: '/visuals' },
}) {
  const t = useT('sidebar');
  const tc = useT('common');
  const tn = useT('nav');
  const donaciones = useDonaciones();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);
  const { preferencia: temaPref, fijar: fijarTema } = useTema();
  const searchRef = useRef(null);
  const profileRef = useRef(null);
  const closeBtnRef = useRef(null);
  const navigate = useNavigate();

  const closeProfile = useCallback(() => setProfileMenu(false), []);
  useDismiss(profileMenu, profileRef, closeProfile);

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
  const abrirAjustes = (seccion = '') => {
    rawNav(withLocale(`/account${seccion ? `/${seccion}` : ''}`, localeSb), { state: { fondo: locationActual } });
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
  const local = q
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q.toLowerCase()))
    : conversations;
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

  const drawerHidden = compact && !open;
  const railVisible = collapsed && !compact;
  // «Nuevo chat» en todas las secciones: la barra es la misma en Chat, Visuals y Remoto.
  const nuevoLabel = seccion === 'remote' ? t('connectSession') : t('newConversation');
  const esGratis = user && (!user.plan_id || user.plan_id === 'free');

  // Dos modos, como Chat y Code: la barra entera cambia. En Remoto la lista
  // es la de sesiones (activas arriba y las inactivas para verlas luego).
  const modo = seccion === 'remote' ? 'remote' : 'chat';
  const activo = modo === 'remote' ? null : seccion;
  const NAV = modo === 'remote' ? [
    { id: 'apps', to: '/apps', Icon: NavApps, label: t('apps') },
    { id: 'docs', to: '/docs/remote', Icon: NavDocs, label: t('docs') },
  ] : [
    { id: 'chat', to: ultimas.chat, Icon: NavChat, label: t('conversations') },
    { id: 'visuals', to: ultimas.visuals, Icon: NavVisuals, label: t('visuals'), pro: !tieneVisuals(user) },
    { id: 'espacios', to: '/espacios', Icon: NavEspacios, label: t('spaces') },
    { id: 'integraciones', to: '/integraciones', Icon: NavSkills, label: t('integrations') },
    { id: 'apps', to: '/apps', Icon: NavApps, label: t('apps') },
    { id: 'docs', to: '/docs', Icon: NavDocs, label: t('docs') },
  ];
  const qr = query.trim().toLowerCase();
  const remotasVisibles = qr ? remotas.filter((r) => `${r.title || ''} ${r.machine || ''}`.toLowerCase().includes(qr)) : remotas;
  const gruposRemotos = [
    { clave: 'activeSessions', items: remotasVisibles.filter((r) => r.status === 'online') },
    { clave: 'recentSessions', items: remotasVisibles.filter((r) => r.status !== 'online') },
  ].filter((g) => g.items.length);

  return (
    <aside
      className={`sidebar ${railVisible ? 'is-collapsed' : ''} ${open ? 'is-open' : ''}`}
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
        <button className="sb-rail__btn sb-rail__btn--nuevo" onClick={() => navigate(newPath)} data-tip={nuevoLabel} aria-label={nuevoLabel}>
          <NavNuevo />
        </button>
        <button className="sb-rail__btn" onClick={abrirBusqueda} data-tip={t('searchConversations')} aria-label={t('searchConversations')}>
          <NavBuscar />
        </button>
        <button className="sb-rail__btn" onClick={() => navigate(modo === 'remote' ? ultimas.chat : '/remote')}
          data-tip={modo === 'remote' ? t('chatMode') : t('remoteMode')} aria-label={modo === 'remote' ? t('chatMode') : t('remoteMode')}>
          {modo === 'remote' ? <NavChat /> : <NavRemoto />}
        </button>
        <span className="sb-rail__hueco" />
        {NAV.map(({ id, to, Icon, label }) => (
          <button key={id} className={`sb-rail__btn ${activo === id ? 'is-active' : ''}`} onClick={() => navigate(to)} data-tip={label} aria-label={label}>
            <Icon relleno={activo === id} />
          </button>
        ))}
        {user && (
          <button className="sb-rail__btn sb-rail__avatar" onClick={() => { onToggleCollapse?.(); setProfileMenu(true); }} data-tip={tc('settings')} aria-label={tc('settings')}>
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
              onClick={() => modo !== 'remote' && go('/remote')} title={t('remoteMode')} aria-label={t('remoteMode')}>
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

        {/* Buscar y crear comparten la bandeja: la casilla ancha es la acción
            en curso; tocar la estrecha intercambia los papeles. */}
        <div className="sb-bandeja">
          <div className={`sb-bandeja__casilla sb-bandeja__casilla--nuevo ${searchOpen ? 'is-estrecha' : ''}`}>
            <button
              className="sb-bandeja__btn"
              onClick={() => (searchOpen ? cerrarBusqueda() : go(modo === 'remote' ? '/remote' : newPath))}
              aria-label={nuevoLabel}
            >
              <NavNuevo />
              <span className="sb-bandeja__txt" aria-hidden="true">{nuevoLabel}</span>
            </button>
          </div>
          <div className={`sb-bandeja__casilla ${searchOpen ? '' : 'is-estrecha'}`}>
            <button
              className="sb-bandeja__btn"
              onClick={() => (searchOpen ? searchRef.current?.focus() : setSearchOpen(true))}
              aria-label={t('searchConversations')}
              aria-expanded={searchOpen}
            >
              <NavBuscar />
            </button>
            <input
              ref={searchRef}
              type="search"
              className="sb-bandeja__campo"
              placeholder={seccion === 'remote' ? t('searchSessions') : t('searchHistory')}
              aria-label={seccion === 'remote' ? t('searchSessions') : t('searchHistory')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation(); // en móvil, Escape también cerraría el cajón
                cerrarBusqueda();
              }}
              tabIndex={searchOpen ? 0 : -1}
            />
          </div>
        </div>

        <nav className="sidebar__nav" aria-label={t('spaces')}>
          {NAV.map(({ id, to, Icon, label, pro }) => (
            <button key={id} className={`sb-nav ${activo === id ? 'is-active' : ''}`} onClick={() => go(to)} aria-current={activo === id ? 'page' : undefined}>
              <Icon relleno={activo === id} /> <span>{label}</span>
              {pro && <span className="sb-nav__pro">Pro</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar__history" role="region" aria-label={t('history')}>
          {modo === 'remote' ? (
            <>
              {gruposRemotos.map((g) => (
                <div key={g.clave} className="sidebar__grupo">
                  <span className="sidebar__label">{t(g.clave)}</span>
                  {g.items.map((r) => {
                    const sinNada = r.status === 'ended' && !(r.transcript_events > 0);
                    const estado = r.status === 'online' ? 'online' : r.status === 'ended' ? 'ended' : 'offline';
                    return (
                      <button key={r.id} type="button" disabled={sinNada}
                        className={`sb-item sb-sesion ${r.id === remotaActiva ? 'is-active' : ''}`}
                        onClick={() => go(`/remote?s=${r.id}`)} aria-current={r.id === remotaActiva ? 'page' : undefined}
                        title={`${r.machine || ''}${r.machine ? ' · ' : ''}${t(`remote_${estado}`)}`}>
                        <span className={`sb-sesion__titulo is-${estado}`}>
                          {estado === 'online' ? <ShimmerText text={r.title || t('remoteSession')} /> : (r.title || t('remoteSession'))}
                        </span>
                        {r.source === 'ide' || r.source === 'cli' ? (
                          <span className="sb-sesion__origen" title={r.source.toUpperCase()} aria-label={r.source.toUpperCase()}>
                            {r.source === 'ide' ? <IconIde size={16} /> : <IconCli size={16} />}
                          </span>
                        ) : <span className="sb-sesion__origen sb-sesion__origen--texto">{r.source}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {gruposRemotos.length === 0 && (
                <p className="sidebar__empty">{qr ? t('noResults') : user ? t('noRemoteSessions') : t('logInToSaveHistory')}</p>
              )}
            </>
          ) : user && loadingConversations ? (
            <HistorySkeleton />
          ) : (
            <>
              {q ? (
                <div className="sidebar__grupo sidebar__grupo--busqueda">
                  {visible.map((c) => (
                    <HistoryItem key={c.id} conv={c} active={c.id === activeId} onRename={onRename} onDelete={onDelete}
                      onNavigate={compact ? onClose : undefined} base={historyBase} />
                  ))}
                  {visible.length === 0 && <p className="sidebar__empty">{t('noResults')}</p>}
                </div>
              ) : visible.length > 0 && (
                <div className="sidebar__grupo">
                  <button type="button" className="sidebar__label sidebar__label--plegable" onClick={alternarRecientes}
                    aria-expanded={recientesAbierto} aria-controls="sb-recientes">
                    <span>{t('recentChats')}</span>
                    <IconChevron size={14} open={recientesAbierto} />
                  </button>
                  {recientesAbierto && (
                    <div id="sb-recientes" className="sidebar__grupo">
                      {visible.map((c) => (
                        <HistoryItem key={c.id} conv={c} active={c.id === activeId} onRename={onRename} onDelete={onDelete}
                          onNavigate={compact ? onClose : undefined} base={historyBase} />
                      ))}
                      {wantsMore && (
                        <button type="button" className="sidebar__more" onClick={cargarMas} disabled={cargandoMas}>
                          {cargandoMas ? t('loadingMore') : t('loadMore')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {visible.length === 0 && !q && (
                <p className="sidebar__empty">
                  {user ? t('noConversations') : t('logInToSaveHistory')}
                </p>
              )}
            </>
          )}
        </div>

        <div className="sidebar__foot">
          {/* Con las donaciones activas, «Donar» lo ve todo el mundo. */}
          {donaciones?.enabled && (
            <button className="sidebar__upgrade sidebar__upgrade--donar" onClick={() => go('/plans')}>
              <NavDonar /> <span>{t('donate')}</span>
            </button>
          )}

          <div className="sidebar__profile" ref={profileRef}>
            {user ? (
              <>
                <button
                  type="button"
                  className={`sidebar__profile-btn ${profileMenu ? 'is-open' : ''}`}
                  onClick={() => setProfileMenu((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={profileMenu}
                >
                  {user.avatar_url
                    ? <img className="sidebar__avatar sidebar__avatar--img" src={user.avatar_url} alt="" />
                    : <span className="sidebar__avatar">{iniciales(user)}</span>}
                  <span className="sidebar__profile-info">
                    <span className="sidebar__profile-name">
                      {[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username}
                    </span>
                    <span className="sidebar__plan">{user.plan_name || t('freePlan')}</span>
                  </span>
                  <IconUpDown size={14} />
                </button>
                <Desplegable abierto={profileMenu} className="sb-cuenta" role="menu">
                  <div className="sb-cuenta__quien">
                    <span className="sb-cuenta__nombre">{[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username}</span>
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
                  <div className="sb-cuenta__fila">
                    <span>{t('theme')}</span>
                    <span className="sb-seg" role="group" aria-label={t('theme')}>
                      {[['light', TemaClaro, t('lightTheme')], ['dark', TemaOscuro, t('darkTheme')], ['system', TemaSistema, t('systemTheme')]].map(([valor, Icono, nombre]) => (
                        <button key={valor} type="button" className={temaPref === valor ? 'is-on' : ''} aria-pressed={temaPref === valor} aria-label={nombre} title={nombre} onClick={() => fijarTema(valor)}>
                          <Icono size={16} relleno={temaPref === valor} />
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
