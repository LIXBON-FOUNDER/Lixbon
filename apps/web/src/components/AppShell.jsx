// Marco de la app: la barra lateral se monta una sola vez y Chat, Visuals y
// Remoto se pintan dentro, cada uno en su ruta. Cambiar de sección ya no es
// cambiar de página: el historial, el colapso y el cajón se conservan.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { useNavigate } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useIsCompact } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { Sidebar } from './Sidebar';
import { Logo } from './Logo';

const CONV_PAGE = 10; // conversaciones por página: las 10 recientes y otras 10 con «Cargar más»
const REMOTAS_CADA = 10000; // las sesiones remotas se refrescan cada 10 s

const ShellContext = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export const useShell = () => useContext(ShellContext);

function seccionDe(pathname) {
  const partes = pathname.split('/').filter(Boolean);
  if (partes[0] === 'es') partes.shift();
  if (partes[0] === 'visuals') return 'visuals';
  if (partes[0] === 'remote') return 'remote';
  if (partes[0] === 'integraciones') return 'integraciones';
  if (partes[0] === 'espacios' || partes[0] === 'agentes') return 'espacios';
  return 'chat';
}

function convDe(pathname) {
  const m = pathname.match(/\/c\/([^/?#]+)/);
  return m ? m[1] : null;
}

function visualDe(pathname) {
  const m = pathname.match(/\/visuals\/([^/?#]+)/);
  return m ? m[1] : null;
}

export default function AppShell() {
  const t = useT('chat');
  const tc = useT('common');
  const { user, loading, logout } = useAuth();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const seccion = seccionDe(pathname);
  const activeId = convDe(pathname);
  const visualId = visualDe(pathname);

  // «Chat» y «Visuals» vuelven a donde estabas: la última conversación o el
  // último visual abierto (o el lienzo vacío si lo último fue uno nuevo).
  // «Nuevo chat» es lo único que empieza de cero.
  const [ultimas, setUltimas] = useState({ chat: '/chat', visuals: '/visuals' });
  useEffect(() => {
    if (seccion === 'chat') {
      const ruta = activeId ? `/c/${activeId}` : '/chat';
      setUltimas((u) => (u.chat === ruta ? u : { ...u, chat: ruta }));
    } else if (seccion === 'visuals') {
      const ruta = visualId ? `/visuals/${visualId}` : '/visuals';
      setUltimas((u) => (u.visuals === ruta ? u : { ...u, visuals: ruta }));
    }
  }, [seccion, activeId, visualId]);

  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsMore, setConvsMore] = useState(false);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const moreRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const compact = useIsCompact();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [remotas, setRemotas] = useState([]);
  // Avisos que lanza el marco (renombrar o borrar desde la barra) y que pinta
  // la página de dentro con su propio toast.
  const [aviso, setAviso] = useState(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  useEffect(() => { if (!compact) setDrawerOpen(false); }, [compact]);
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // El historial llega por páginas: la primera al entrar y las siguientes
  // cuando la lista se acerca al final.
  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get(`/api/conversations?limit=${CONV_PAGE}`);
      const page = res.data.conversations;
      // Refrescar solo renueva la primera página: lo que ya trajo «Cargar
      // más» se conserva, para que la lista no se encoja tras cada mensaje.
      const extra = conversationsRef.current.length > CONV_PAGE;
      setConversations((prev) => {
        if (prev.length <= CONV_PAGE) return page;
        const seen = new Set(page.map((c) => c.id));
        return [...page, ...prev.filter((c) => !seen.has(c.id))];
      });
      if (!extra) setConvsMore(page.length === CONV_PAGE);
    } catch { /* sin sesión o error transitorio */ } finally {
      setConvsLoading(false);
    }
  }, []);

  const loadMoreConversations = useCallback(async () => {
    if (moreRef.current) return;
    moreRef.current = true;
    try {
      const res = await api.get(`/api/conversations?limit=${CONV_PAGE}&offset=${conversationsRef.current.length}`);
      const page = res.data.conversations;
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.filter((c) => !seen.has(c.id))];
      });
      setConvsMore(page.length === CONV_PAGE);
    } catch { /* se reintenta al volver a bajar */ } finally {
      moreRef.current = false;
    }
  }, []);

  // La búsqueda va al servidor: con el historial por páginas, filtrar lo
  // cargado dejaría fuera las conversaciones antiguas.
  const searchConversations = useCallback(async (q) => {
    const res = await api.get(`/api/conversations?limit=50&q=${encodeURIComponent(q)}`);
    return res.data.conversations;
  }, []);

  useEffect(() => {
    if (!user) { setConversations([]); setConvsLoading(false); return; }
    setConvsLoading(true);
    loadConversations();
  }, [user, loadConversations]);

  // Sesiones remotas activas, para listarlas bajo «Remoto» en la barra.
  const loadRemotas = useCallback(() => {
    if (!user) { setRemotas([]); return; }
    api.get('/api/remote/sessions')
      .then((res) => setRemotas(res.data.sessions || []))
      .catch(() => {});
  }, [user]);
  useEffect(() => {
    loadRemotas();
    if (!user) return undefined;
    const timer = setInterval(loadRemotas, REMOTAS_CADA);
    return () => clearInterval(timer);
  }, [user, loadRemotas]);

  const renameConversation = useCallback(async (id, newTitle) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    try {
      await api.patch(`/api/conversations/${id}`, { title: newTitle });
      return true;
    } catch {
      setAviso({ texto: t('renameFailed'), n: Date.now() });
      loadConversations();
      return false;
    }
  }, [loadConversations, t]);

  const deleteConversation = useCallback(async (id) => {
    const ok = await confirmar({
      titulo: t('deleteConvTitle'),
      texto: t('deleteConvText'),
      etiqueta: tc('delete'),
    });
    if (!ok) return false;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setUltimas((u) => (u.chat === `/c/${id}` ? { ...u, chat: '/chat' } : u));
    if (id === activeId) navigate('/chat');
    try {
      await api.delete(`/api/conversations/${id}`);
    } catch {
      setAviso({ texto: t('deleteFailed'), n: Date.now() });
      loadConversations();
    }
    return true;
  }, [activeId, confirmar, loadConversations, navigate, t, tc]);

  const handleLogout = useCallback(async () => {
    const ok = await confirmar({
      titulo: t('logoutTitle'),
      texto: t('logoutText'),
      etiqueta: tc('logOut'),
      peligro: false,
    });
    if (!ok) return;
    await logout();
    setConversations([]);
    setConvsMore(false);
    setRemotas([]);
    setUltimas({ chat: '/chat', visuals: '/visuals' });
    navigate('/chat');
  }, [confirmar, logout, navigate, t, tc]);

  const valor = useMemo(() => ({
    conversations, setConversations, loadConversations, renameConversation, deleteConversation,
    remotas, loadRemotas, openDrawer, drawerOpen, compact, aviso,
  }), [conversations, loadConversations, renameConversation, deleteConversation, remotas, loadRemotas, openDrawer, drawerOpen, compact, aviso]);

  if (loading) {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  return (
    <ShellContext.Provider value={valor}>
      <div className={`chat-shell chat-shell--${seccion}`}>
        <Sidebar
          user={user}
          conversations={conversations}
          loadingConversations={convsLoading}
          hasMoreConversations={convsMore}
          onLoadMore={loadMoreConversations}
          onSearch={searchConversations}
          activeId={activeId}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          onRename={renameConversation}
          onDelete={deleteConversation}
          onLogout={handleLogout}
          compact={compact}
          open={compact && drawerOpen}
          onClose={closeDrawer}
          seccion={seccion}
          remotas={remotas}
          ultimas={ultimas}
          remotaActiva={seccion === 'remote' ? params.get('s') : null}
        />
        {compact && drawerOpen && (
          <div className="sidebar-scrim" onClick={closeDrawer} aria-hidden="true" />
        )}
        <Outlet />
      </div>
    </ShellContext.Provider>
  );
}
