// Sidebar.jsx — panel izquierdo del chat (mockup 2.1): logo + buscar + colapsar,
// navegación, Historial colapsable y footer de perfil con plan.
// El colapso anima el ancho: el contenido completo vive en __body y el modo
// colapsado en __rail; ambos se funden con opacidad durante la transición.
// En compacto (≤860px) el panel deja de ser columna y se comporta como cajón:
// `compact` llega desde ChatPage y cambia el colapsar por un cerrar.
import { tieneVisuals } from '../lib/planes';
import { useTema } from '../hooks/useTema';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate as useRawNavigate } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useLocale } from '../i18n/LocaleContext';
import { otherLocalePath } from '../i18n/paths';
import { useT } from '../i18n/useT';
import { Logo } from './Logo';
import { planBadge } from '../lib/planColors';
import { useDismiss } from '../hooks/useDismiss';
import { HistorySkeleton } from './Skeleton';
import { Desplegable } from './Desplegable';
import {
  IconPlus, IconSearch, IconPanel, IconChat, IconGrid, IconDots,
  IconChevron, IconGear, IconPencil, IconTrash, IconLogout, IconX, IconSun, IconMoon,
  IconBook, IconBolt, IconGlobe, IconUser, IconLayers,
} from './Icons';

const MENU_W = 170; // ancho mínimo de .sb-menu, para no salirse por la derecha

function HistoryItem({ conv, active, onRename, onDelete, onNavigate, base = '/c' }) {
  const t = useT('sidebar');
  const tc = useT('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null); // { left, top } en coordenadas de viewport
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
  historyBase = '/c', newPath = '/chat', seccion = 'chat',
}) {
  const t = useT('sidebar');
  const tc = useT('common');
  const tn = useT('nav');
  const locale = useLocale();
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

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // El foco entra en el cajón al abrirlo. Depende solo de `open` a propósito:
  // con `onClose` en las dependencias, cada re-render del chat durante el
  // streaming robaría el foco al campo de búsqueda.
  useEffect(() => {
    if (compact && open) closeBtnRef.current?.focus();
  }, [compact, open]);

  // Escape cierra el cajón.
  useEffect(() => {
    if (!compact || !open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [compact, open, onClose]);

  // Navegar desde el cajón lo cierra: en móvil tapa todo el chat.
  const go = (path) => {
    navigate(path);
    if (compact) onClose?.();
  };

  const visible = query
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(query.toLowerCase()))
    : conversations;

  const drawerHidden = compact && !open;

  return (
    <aside
      className={`sidebar ${collapsed && !compact ? 'is-collapsed' : ''} ${open ? 'is-open' : ''}`}
      id="sidebar-drawer"
      aria-label={t('conversationsPanel')}
      aria-hidden={drawerHidden || undefined}
      inert={drawerHidden || undefined}
    >
      {/* Modo colapsado: columna de iconos */}
      <div className="sidebar__rail" aria-hidden={!collapsed}>
        <button className="icon-btn" onClick={onToggleCollapse} aria-label={t('openPanel')} tabIndex={collapsed ? 0 : -1}>
          <IconPanel />
        </button>
        <button className="icon-btn" onClick={() => navigate(newPath)} aria-label={t('newConversation')} tabIndex={collapsed ? 0 : -1}>
          <IconPlus />
        </button>
      </div>

      {/* Contenido completo */}
      <div className="sidebar__body" aria-hidden={collapsed && !compact}>
        <div className="sidebar__header">
          <Link to="/chat" className="sidebar__logo" onClick={compact ? onClose : undefined}>
            <Logo />
          </Link>
          <div className="sidebar__header-actions">
            <button className="icon-btn" onClick={() => setSearchOpen((v) => !v)} aria-label={t('searchConversations')}>
              {searchOpen ? <IconX /> : <IconSearch />}
            </button>
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

        <div className={`reveal ${searchOpen ? 'is-open' : ''}`}>
          <div className="reveal__inner">
            <input
              ref={searchRef}
              className="sidebar__search"
              placeholder={tc('search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              tabIndex={searchOpen ? 0 : -1}
            />
          </div>
        </div>

        <nav className="sidebar__nav">
          <button className="sb-nav" onClick={() => go(newPath)}>
            <IconPlus /> <span>{seccion === 'visuals' ? t('newDesign') : t('newConversation')}</span>
          </button>
          <button className={`sb-nav ${seccion === 'chat' ? 'is-active' : ''}`} onClick={() => (seccion === 'chat' ? setHistoryOpen(true) : go('/chat'))}>
            <IconChat /> <span>{t('conversations')}</span>
          </button>
          <button className={`sb-nav ${seccion === 'visuals' ? 'is-active' : ''}`} onClick={() => (seccion === 'visuals' ? setHistoryOpen(true) : go('/visuals'))}>
            <IconLayers /> <span>{t('visuals')}</span>
            {!tieneVisuals(user) && <span className="sb-menu__tag">Pro</span>}
          </button>
          <button className="sb-nav" onClick={() => go('/apps')}>
            <IconGrid /> <span>{t('apps')}</span>
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

        {/* Solo la cuenta gratuita ve el atajo; en Pro/Advance se cambia de plan desde Ajustes. */}
        {user && (!user.plan_id || user.plan_id === 'free') && (
          <button className="sidebar__upgrade" onClick={() => go('/plans')}>
            <IconBolt size={16} /> <span>{tc('upgrade')}</span>
          </button>
        )}

        <div className="sidebar__foot">
        {/* La pestaña que asoma sobre la tarjeta: la misma pieza que llevan
            los avisos y los diálogos. */}
        <span className="tab" aria-hidden="true" />
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
                  style={{
                    background: planBadge(user.plan_id).bg,
                    color: planBadge(user.plan_id).ink,
                  }}
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
                  <button onClick={() => { setProfileMenu(false); rawNavigate(otherLocalePath(pathname)); }}>
                    <IconGlobe size={14} /> {tn('language')} <span className="sb-menu__tag">{locale === 'es' ? 'EN' : 'ES'}</span>
                  </button>
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
                  {t('seePlans')}
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
