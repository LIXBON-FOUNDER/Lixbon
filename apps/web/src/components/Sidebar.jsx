import { tieneVisuals } from '../lib/planes';
import { useDonaciones } from '../lib/donaciones';
import { useTema } from '../hooks/useTema';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate as useRawNavigate } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { guardarIdioma, otherLocalePath } from '../i18n/paths';
import { useT } from '../i18n/useT';
import { LogoLixbon } from './Logo';
import { useDismiss } from '../hooks/useDismiss';
import { HistorySkeleton } from './Skeleton';
import { Desplegable } from './Desplegable';
import {
  IconPlus, IconSearch, IconPanel, IconChat, IconGrid, IconDots,
  IconChevron, IconGear, IconPencil, IconTrash, IconLogout, IconX, IconSun, IconMoon,
  IconBook, IconBolt, IconGlobe, IconUser, IconLayers, IconCorazon, IconTerminal,
} from './Icons';

const MENU_W = 170; // ancho mínimo de .sb-menu, para no salirse por la derecha

function HistoryItem({ conv, active, onRename, onDelete, onNavigate, base = '/c' }) {
  const t = useT('sidebar');
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

  return (
    <div className={`sb-item ${active ? 'is-active' : ''}`} ref={rootRef}>
      <button
        className="sb-item__title"
        onClick={() => { navigate(`${base}/${conv.id}`); onNavigate?.(); }}
      >
        {conv.title || t('untitled')}
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

export function Sidebar({
  user, conversations, loadingConversations, activeId, collapsed, onToggleCollapse,
  onRename, onDelete, onLogout, compact = false, open = false, onClose,
  hasMoreConversations = false, onLoadMore, onSearch,
  historyBase = '/c', newPath = '/chat', seccion = 'chat',
}) {
  const t = useT('sidebar');
  const tc = useT('common');
  const tn = useT('nav');
  const locale = useLocale();
  const donaciones = useDonaciones();
  const { pathname } = useLocation();
  const [historyOpen, setHistoryOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);
  const { tema, alternar: alternarTema } = useTema();
  const searchRef = useRef(null);
  const profileRef = useRef(null);
  const closeBtnRef = useRef(null);
  const navigate = useNavigate();
  const rawNavigate = useRawNavigate();

  const closeProfile = useCallback(() => setProfileMenu(false), []);
  useDismiss(profileMenu, profileRef, closeProfile);

  // preventScroll: el campo vive en una casilla con overflow oculto que aún se
  // está ensanchando, y el navegador la desplazaría para mostrar el cursor.
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

  const local = query
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(query.toLowerCase()))
    : conversations;
  const visible = query && found?.q === query.trim() ? found.items : local;

  // Al acercarse al final de la lista se pide la página siguiente.
  const moreRef = useRef(null);
  const wantsMore = !query && hasMoreConversations && Boolean(onLoadMore);
  useEffect(() => {
    const el = moreRef.current;
    if (!wantsMore || !el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [wantsMore, onLoadMore, conversations.length]);

  const drawerHidden = compact && !open;
  const nuevoLabel = seccion === 'visuals' ? t('newDesign') : t('newConversation');

  return (
    <aside
      className={`sidebar ${collapsed && !compact ? 'is-collapsed' : ''} ${open ? 'is-open' : ''}`}
      id="sidebar-drawer"
      aria-label={t('conversationsPanel')}
      aria-hidden={drawerHidden || undefined}
      inert={drawerHidden || undefined}
    >
      <div className="sidebar__rail" aria-hidden={!collapsed}>
        <button className="icon-btn" onClick={onToggleCollapse} aria-label={t('openPanel')} tabIndex={collapsed ? 0 : -1}>
          <IconPanel />
        </button>
        <button className="icon-btn" onClick={() => navigate(newPath)} aria-label={t('newConversation')} tabIndex={collapsed ? 0 : -1}>
          <IconPlus />
        </button>
      </div>

      <div className="sidebar__body" aria-hidden={collapsed && !compact}>
        <div className="sidebar__header">
          <Link to="/chat" className="sidebar__logo" onClick={compact ? onClose : undefined}>
            <LogoLixbon />
          </Link>
          <div className="sidebar__header-actions">
            {compact ? (
              <button ref={closeBtnRef} className="icon-btn" onClick={onClose} aria-label={t('closePanel')}>
                <IconX />
              </button>
            ) : (
              <button className="icon-btn" onClick={onToggleCollapse} aria-label={t('collapsePanel')}>
                <IconPanel />
              </button>
            )}
          </div>
        </div>

        {/* Buscar y crear comparten la bandeja: la casilla ancha es la acción
            en curso; tocar la estrecha intercambia los papeles. */}
        <div className="sb-bandeja">
          <div className={`sb-bandeja__casilla sb-bandeja__casilla--nuevo ${searchOpen ? 'is-estrecha' : ''}`}>
            <button
              className="sb-bandeja__btn"
              onClick={() => (searchOpen ? cerrarBusqueda() : go(newPath))}
              aria-label={nuevoLabel}
            >
              <IconPlus size={16} />
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
              <IconSearch size={16} />
            </button>
            <input
              ref={searchRef}
              type="search"
              className="sb-bandeja__campo"
              placeholder={t('searchHistory')}
              aria-label={t('searchHistory')}
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
          <span className="sidebar__label">{t('spaces')}</span>
          <button className={`sb-nav ${seccion === 'chat' ? 'is-active' : ''}`} onClick={() => (seccion === 'chat' ? setHistoryOpen(true) : go('/chat'))}>
            <IconChat /> <span>{t('conversations')}</span>
            {seccion === 'chat' && conversations.length > 0 && <span className="sb-nav__num">{conversations.length}{hasMoreConversations ? '+' : ''}</span>}
          </button>
          <button className={`sb-nav ${seccion === 'visuals' ? 'is-active' : ''}`} onClick={() => (seccion === 'visuals' ? setHistoryOpen(true) : go('/visuals'))}>
            <IconLayers /> <span>{t('visuals')}</span>
            {seccion === 'visuals' && conversations.length > 0 && <span className="sb-nav__num">{conversations.length}{hasMoreConversations ? '+' : ''}</span>}
            {!tieneVisuals(user) && <span className="sb-menu__tag">Pro</span>}
          </button>
          <button className="sb-nav" onClick={() => go('/apps')}>
            <IconGrid /> <span>{t('apps')}</span>
          </button>
          {/* Las sesiones del CLI y del IDE que el usuario abre en remoto. */}
          <button className="sb-nav" onClick={() => go('/remote')}>
            <IconTerminal /> <span>{t('remote')}</span>
          </button>
        </nav>

        <div className="sidebar__history">
          <button className="sidebar__history-head" onClick={() => setHistoryOpen((v) => !v)}>
            <span>{t('history')}</span>
            <IconChevron size={14} open={historyOpen} />
          </button>
          <div className={`reveal ${historyOpen ? 'is-open' : ''}`}>
            <div className="reveal__inner">
              <div className="sidebar__history-list">
                {user && loadingConversations ? (
                  <HistorySkeleton />
                ) : (
                  <>
                    {visible.map((c) => (
                      <HistoryItem
                        key={c.id}
                        conv={c}
                        active={c.id === activeId}
                        onRename={onRename}
                        onDelete={onDelete}
                        onNavigate={compact ? onClose : undefined}
                        base={historyBase}
                      />
                    ))}
                    {wantsMore && <div ref={moreRef} className="sidebar__more" aria-hidden="true" />}
                    {visible.length === 0 && (
                      <p className="sidebar__empty">
                        {user ? t('noConversations') : t('logInToSaveHistory')}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Con las donaciones activas, «Donar» lo ve todo el mundo; si no, solo
            la cuenta gratuita ve el atajo a los planes. */}
        {donaciones?.enabled ? (
          <button className="sidebar__upgrade sidebar__upgrade--donar" onClick={() => go('/plans')}>
            <IconCorazon size={16} /> <span>{t('donate')}</span>
          </button>
        ) : user && (!user.plan_id || user.plan_id === 'free') && (
          <button className="sidebar__upgrade" onClick={() => go('/plans')}>
            <IconBolt size={16} /> <span>{tc('upgrade')}</span>
          </button>
        )}

        <div className="sidebar__foot">
        <div className="sidebar__profile" ref={profileRef}>
          {user ? (
            <>
              {user.avatar_url ? (
                <img className="sidebar__avatar sidebar__avatar--img" src={user.avatar_url} alt="" />
              ) : (
                <span className="sidebar__avatar">
                  {(user.first_name || user.username || '?')[0].toUpperCase()}
                </span>
              )}
              <div className="sidebar__profile-info">
                <span className="sidebar__profile-name">
                  {[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username}
                </span>
                <Link
                  to="/plans"
                  className="sidebar__plan"
                  onClick={compact ? onClose : undefined}
                >
                  {user.plan_name || t('freePlan')}
                </Link>
              </div>
              <button
                className="icon-btn"
                onClick={() => setProfileMenu((v) => !v)}
                aria-label={tc('settings')}
                aria-expanded={profileMenu}
              >
                <IconGear />
              </button>
                <Desplegable abierto={profileMenu} className="sb-menu sb-menu--profile" role="menu">
                  <button onClick={() => { setProfileMenu(false); go('/plans'); }}>
                    <IconBolt size={14} /> {tn('plans')}
                  </button>
                  <button onClick={alternarTema}>
                    {tema === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />} {tema === 'dark' ? t('lightTheme') : t('darkTheme')}
                  </button>
                  <div className="sb-menu__lang">
                    <span className="sb-menu__lang-label"><IconGlobe size={14} /> {tn('language')}</span>
                    <span className="sb-menu__lang-opts" role="listbox" aria-label={tn('language')}>
                      {[{ code: 'es', label: 'ES' }, { code: 'en', label: 'EN' }].map((o) => (
                        <button
                          key={o.code}
                          type="button"
                          role="option"
                          aria-selected={locale === o.code}
                          className={locale === o.code ? 'is-active' : ''}
                          onClick={() => {
                            setProfileMenu(false);
                            if (locale === o.code) return;
                            guardarIdioma(o.code);
                            rawNavigate(otherLocalePath(pathname));
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  <button onClick={() => { setProfileMenu(false); go('/account'); }}>
                    <IconGear size={14} /> {tc('settings')}
                  </button>
                  <button onClick={() => { setProfileMenu(false); go('/docs'); }}>
                    <IconBook size={14} /> {t('docs')}
                  </button>
                  {user.role === 'admin' && (
                    <button onClick={() => { setProfileMenu(false); go('/admin'); }}>
                      <IconGrid size={14} /> {t('adminPanel')}
                    </button>
                  )}
                  <button onClick={() => { setProfileMenu(false); onLogout(); }}>
                    <IconLogout size={14} /> {tc('logOut')}
                  </button>
                </Desplegable>
            </>
          ) : (
            <>
              <span className="sidebar__avatar sidebar__avatar--guest">
                <IconUser size={17} />
              </span>
              <div className="sidebar__profile-info">
                <Link to="/auth" className="sidebar__profile-name" onClick={compact ? onClose : undefined}>
                  {tc('logIn')}
                </Link>
                <Link to="/plans" className="sidebar__plan-link" onClick={compact ? onClose : undefined}>
                  {donaciones?.enabled ? t('donate') : t('seePlans')}
                </Link>
              </div>
            </>
          )}
        </div>
        </div>
      </div>
    </aside>
  );
}
