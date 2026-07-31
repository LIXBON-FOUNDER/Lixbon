// Sidebar.jsx — panel izquierdo del chat (mockup 2.1): logo + buscar + colapsar,
// navegación, Historial colapsable y footer de perfil con plan.
// El colapso anima el ancho: el contenido completo vive en __body y el modo
// colapsado en __rail; ambos se funden con opacidad durante la transición.
// En compacto (≤860px) el panel deja de ser columna y se comporta como cajón:
// `compact` llega desde ChatPage y cambia el colapsar por un cerrar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Logo } from './Logo';
import { planColor } from '../lib/planColors';
import { useTheme } from '../lib/theme';
import { useDismiss } from '../hooks/useDismiss';
import { HistorySkeleton } from './Skeleton';
import {
  IconPlus, IconSearch, IconPanel, IconChat, IconGrid, IconDots,
  IconChevron, IconGear, IconPencil, IconTrash, IconLogout, IconX,
  IconBook, IconBolt, IconGlobe, IconSun, IconMoon,
} from './Icons';

const MENU_W = 170; // ancho mínimo de .sb-menu, para no salirse por la derecha

function HistoryItem({ conv, active, onRename, onDelete, onNavigate }) {
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
        onClick={() => { navigate(`/c/${conv.id}`); onNavigate?.(); }}
      >
        {conv.title || 'Sin título'}
      </button>
      <button
        ref={btnRef}
        className="icon-btn sb-item__menu-btn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Opciones de la conversación"
        aria-expanded={menuOpen}
      >
        <IconDots size={14} />
      </button>
      {menuOpen && menuPos && (
        <div className="sb-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
          <button onClick={startEdit}><IconPencil size={14} /> Renombrar</button>
          <button className="sb-menu__danger" onClick={() => { setMenuOpen(false); onDelete(conv.id); }}>
            <IconTrash size={14} /> Eliminar
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  user, conversations, loadingConversations, activeId, collapsed, onToggleCollapse,
  onRename, onDelete, onLogout, compact = false, open = false, onClose,
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const searchRef = useRef(null);
  const profileRef = useRef(null);
  const closeBtnRef = useRef(null);
  const navigate = useNavigate();

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
      aria-label="Panel de conversaciones"
      aria-hidden={drawerHidden || undefined}
      inert={drawerHidden || undefined}
    >
      {/* Modo colapsado: columna de iconos */}
      <div className="sidebar__rail" aria-hidden={!collapsed}>
        <button className="icon-btn" onClick={onToggleCollapse} aria-label="Abrir panel" tabIndex={collapsed ? 0 : -1}>
          <IconPanel />
        </button>
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="Nueva conversación" tabIndex={collapsed ? 0 : -1}>
          <IconPlus />
        </button>
      </div>

      {/* Contenido completo */}
      <div className="sidebar__body" aria-hidden={collapsed && !compact}>
        <div className="sidebar__header">
          <Link to="/" className="sidebar__logo" onClick={compact ? onClose : undefined}>
            <Logo size={30} />
          </Link>
          <div className="sidebar__header-actions">
            <button
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            >
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <button className="icon-btn" onClick={() => setSearchOpen((v) => !v)} aria-label="Buscar conversaciones">
              {searchOpen ? <IconX /> : <IconSearch />}
            </button>
            {compact ? (
              <button ref={closeBtnRef} className="icon-btn" onClick={onClose} aria-label="Cerrar panel">
                <IconX />
              </button>
            ) : (
              <button className="icon-btn" onClick={onToggleCollapse} aria-label="Colapsar panel">
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
              placeholder="Buscar…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              tabIndex={searchOpen ? 0 : -1}
            />
          </div>
        </div>

        <nav className="sidebar__nav">
          <button className="sb-nav" onClick={() => go('/')}>
            <IconPlus /> <span>Nueva conversación</span>
          </button>
          <button className="sb-nav" onClick={() => setHistoryOpen(true)}>
            <IconChat /> <span>Conversaciones</span>
          </button>
          <button className="sb-nav" onClick={() => go('/aplicaciones')}>
            <IconGrid /> <span>Aplicaciones</span>
          </button>
          <button className="sb-nav sb-nav--soon" title="Próximamente">
            <IconDots /> <span>Más</span>
          </button>
        </nav>

        <div className="sidebar__history">
          <button className="sidebar__history-head" onClick={() => setHistoryOpen((v) => !v)}>
            <span>Historial</span>
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
                      />
                    ))}
                    {visible.length === 0 && (
                      <p className="sidebar__empty">
                        {user ? 'Aún no hay conversaciones' : 'Inicia sesión para guardar tu historial'}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {user && user.plan_id !== 'advance' && (
          <button className="sidebar__upgrade" onClick={() => go('/planes')}>
            <IconBolt size={16} /> <span>Mejorar plan</span>
          </button>
        )}

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
                  to="/planes"
                  className="sidebar__plan"
                  onClick={compact ? onClose : undefined}
                  style={{ background: planColor(user.plan_id), color: '#fff' }}
                >
                  Plan {user.plan_name || 'Gratuito'}
                </Link>
              </div>
              <button
                className="icon-btn"
                onClick={() => setProfileMenu((v) => !v)}
                aria-label="Ajustes"
                aria-expanded={profileMenu}
              >
                <IconGear />
              </button>
              {profileMenu && (
                <div className="sb-menu sb-menu--profile" role="menu">
                  <button onClick={() => { setProfileMenu(false); go('/planes'); }}>
                    <IconBolt size={14} /> Planes
                  </button>
                  <button className="sb-menu__soon" disabled title="Próximamente">
                    <IconGlobe size={14} /> Lenguaje <span className="sb-menu__tag">Pronto</span>
                  </button>
                  <button onClick={() => { setProfileMenu(false); go('/account'); }}>
                    <IconGear size={14} /> Ajustes
                  </button>
                  <button onClick={() => { setProfileMenu(false); go('/docs'); }}>
                    <IconBook size={14} /> Documentación
                  </button>
                  {user.role === 'admin' && (
                    <button onClick={() => { setProfileMenu(false); go('/admin'); }}>
                      <IconGrid size={14} /> Panel admin
                    </button>
                  )}
                  <button onClick={onLogout}><IconLogout size={14} /> Cerrar sesión</button>
                </div>
              )}
            </>
          ) : (
            <>
              <span className="sidebar__avatar">?</span>
              <div className="sidebar__profile-info">
                <Link to="/auth" className="sidebar__profile-name" onClick={compact ? onClose : undefined}>
                  Iniciar sesion
                </Link>
                <Link to="/planes" className="sidebar__plan" onClick={compact ? onClose : undefined}>
                  Ver planes
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
