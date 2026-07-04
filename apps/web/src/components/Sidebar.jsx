// Sidebar.jsx — panel izquierdo del chat (mockup 2.1): logo + buscar + colapsar,
// navegación, Historial colapsable y footer de perfil con plan.
// El colapso anima el ancho: el contenido completo vive en __body y el modo
// colapsado en __rail; ambos se funden con opacidad durante la transición.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Logo } from './Logo';
import {
  IconPlus, IconSearch, IconPanel, IconChat, IconGrid, IconDots,
  IconChevron, IconGear, IconPencil, IconTrash, IconLogout, IconX,
} from './Icons';

function HistoryItem({ conv, active, onRename, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const navigate = useNavigate();

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
    <div className={`sb-item ${active ? 'is-active' : ''}`}>
      <button className="sb-item__title" onClick={() => navigate(`/c/${conv.id}`)}>
        {conv.title || 'Sin título'}
      </button>
      <button
        className="icon-btn sb-item__menu-btn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Opciones de la conversación"
      >
        <IconDots size={14} />
      </button>
      {menuOpen && (
        <div className="sb-menu" onMouseLeave={() => setMenuOpen(false)}>
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
  user, conversations, activeId, collapsed, onToggleCollapse,
  onRename, onDelete, onLogout,
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);
  const searchRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const visible = query
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(query.toLowerCase()))
    : conversations;

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
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
      <div className="sidebar__body" aria-hidden={collapsed}>
        <div className="sidebar__header">
          <Link to="/" className="sidebar__logo"><Logo size={30} /></Link>
          <div className="sidebar__header-actions">
            <button className="icon-btn" onClick={() => setSearchOpen((v) => !v)} aria-label="Buscar conversaciones">
              {searchOpen ? <IconX /> : <IconSearch />}
            </button>
            <button className="icon-btn" onClick={onToggleCollapse} aria-label="Colapsar panel">
              <IconPanel />
            </button>
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
          <button className="sb-nav" onClick={() => navigate('/')}>
            <IconPlus /> <span>Nueva conversación</span>
          </button>
          <button className="sb-nav" onClick={() => setHistoryOpen(true)}>
            <IconChat /> <span>Conversaciones</span>
          </button>
          <button className="sb-nav sb-nav--soon" title="Próximamente">
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
                {visible.map((c) => (
                  <HistoryItem
                    key={c.id}
                    conv={c}
                    active={c.id === activeId}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                ))}
                {visible.length === 0 && (
                  <p className="sidebar__empty">
                    {user ? 'Aún no hay conversaciones' : 'Inicia sesión para guardar tu historial'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="sidebar__profile">
          {user ? (
            <>
              <span className="sidebar__avatar">
                {(user.first_name || user.username || '?')[0].toUpperCase()}
              </span>
              <div className="sidebar__profile-info">
                <span className="sidebar__profile-name">
                  {[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username}
                </span>
                <Link to="/planes" className="sidebar__plan">Plan {user.plan_name || 'Gratuito'}</Link>
              </div>
              <button className="icon-btn" onClick={() => setProfileMenu((v) => !v)} aria-label="Ajustes">
                <IconGear />
              </button>
              {profileMenu && (
                <div className="sb-menu sb-menu--profile" onMouseLeave={() => setProfileMenu(false)}>
                  <button onClick={() => { setProfileMenu(false); navigate('/account'); }}>
                    <IconGear size={14} /> Mi cuenta
                  </button>
                  {user.role === 'admin' && (
                    <button onClick={() => { setProfileMenu(false); navigate('/admin'); }}>
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
                <Link to="/auth" className="sidebar__profile-name">Iniciar sesion</Link>
                <Link to="/planes" className="sidebar__plan">Ver planes</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
