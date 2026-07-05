// ChatPage.jsx — pantalla principal (mockups 2.1 y 2.2).
// Con sesión: chat con streaming SSE, memoria de conversación e historial.
// Sin sesión: se VE la interfaz ("¿Qué investigaremos hoy?"); al enviar → registro.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { Sidebar } from '../components/Sidebar';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { ThreadSkeleton } from '../components/Skeleton';
import { ShareDialog } from '../components/ShareDialog';
import { IconShare, IconArrowDown, IconGlobe } from '../components/Icons';

const CONTEXT_WINDOW = 20; // mensajes previos que se envían como contexto

function Sources({ sources }) {
  return (
    <div className="msg-sources">
      <span className="msg-sources__title"><IconGlobe size={13} /> Fuentes</span>
      <ol className="msg-sources__list">
        {sources.map((s, i) => (
          <li key={i}>
            <a href={s.url} target="_blank" rel="noreferrer" title={s.snippet}>{s.title || s.url}</a>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function ChatPage() {
  const { user, loading, logout } = useAuth();
  const { id: routeConvId } = useParams();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [title, setTitle] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [toast, setToast] = useState(null); // { text, leaving }
  const [showJump, setShowJump] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [searching, setSearching] = useState(false);

  const scrollRef = useRef(null);
  const loadedConvRef = useRef(null); // conversación ya cargada (evita refetch tras navigate)
  const stickToBottomRef = useRef(true);
  const toastTimers = useRef([]);

  const showToast = (text) => {
    toastTimers.current.forEach(clearTimeout);
    setToast({ text, leaving: false });
    toastTimers.current = [
      setTimeout(() => setToast((t) => (t ? { ...t, leaving: true } : t)), 2400),
      setTimeout(() => setToast(null), 2800),
    ];
  };

  // ── Datos iniciales (usuario con sesión) ─────────────────────────────
  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get('/api/conversations');
      setConversations(res.data.conversations);
    } catch { /* sin sesión o error transitorio */ } finally {
      setConvsLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    const res = await api.get('/v1/models');
    const ids = res.data.data
      .map((m) => m.id)
      .filter((id) => !String(id).startsWith('error:'));
    setModels(ids);
    setModel((current) => current || ids[0] || '');
    return ids;
  }, []);

  useEffect(() => {
    if (!user) { setConvsLoading(false); return; }
    setConvsLoading(true);
    loadConversations();
    loadModels().catch(() => setModels([]));
  }, [user, loadConversations, loadModels]);

  // ── Cargar/limpiar conversación según la ruta ────────────────────────
  useEffect(() => {
    if (!routeConvId) {
      loadedConvRef.current = null;
      setMessages([]);
      setTitle(null);
      return;
    }
    if (!user || loadedConvRef.current === routeConvId) return;
    loadedConvRef.current = routeConvId;
    setMsgsLoading(true);
    api.get(`/api/conversations/${routeConvId}/messages`)
      .then((res) => {
        setMessages(res.data.messages.map((m) => ({ role: m.role, content: m.content })));
        setTitle(res.data.conversation?.title || null);
      })
      .catch(() => navigate('/', { replace: true }))
      .finally(() => setMsgsLoading(false));
  }, [routeConvId, user, navigate]);

  // ── Scroll: auto-follow durante el stream + botón "más ↓" ───────────
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight > el.clientHeight);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // ── Enviar mensaje ───────────────────────────────────────────────────
  const send = async (text) => {
    if (!user) {
      navigate('/auth?mode=register');
      return;
    }
    // Si el usuario escribe antes de que /v1/models responda, se resuelve aquí
    // para no perder su mensaje.
    let chosenModel = model;
    if (!chosenModel) {
      try {
        chosenModel = (await loadModels())[0] || '';
      } catch { /* cae al toast de abajo */ }
      if (!chosenModel) {
        showToast('No hay modelos disponibles ahora mismo');
        return;
      }
    }

    const convId = routeConvId || crypto.randomUUID();
    const isFirstExchange = messages.length === 0;
    const history = [...messages.slice(-CONTEXT_WINDOW), { role: 'user', content: text }];

    if (!routeConvId) {
      loadedConvRef.current = convId; // evita el refetch al cambiar la URL
      navigate(`/c/${convId}`, { replace: true });
    }

    stickToBottomRef.current = true;
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    if (webSearch) setSearching(true);

    try {
      await streamChatCompletion({
        model: chosenModel,
        messages: history,
        conversationId: convId,
        webSearch,
        onSources: (sources) => {
          setSearching(false);
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, sources };
            return next;
          });
        },
        onDelta: (delta) => {
          setSearching(false);
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        },
      });

      if (isFirstExchange) {
        try {
          const res = await api.post(`/api/conversations/${convId}/generate-title`);
          setTitle(res.data.title);
        } catch { /* el título puede quedar vacío */ }
      }
      loadConversations();
    } catch (err) {
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = {
          ...last,
          content: last.content || `⚠️ ${err.message}`,
          error: !last.content,
        };
        return next;
      });
    } finally {
      setSearching(false);
      setBusy(false);
    }
  };

  // ── Acciones del historial ───────────────────────────────────────────
  const renameConversation = async (id, newTitle) => {
    // Optimista: la UI cambia ya; si el backend falla se recarga la verdad.
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    if (id === routeConvId) setTitle(newTitle);
    try {
      await api.patch(`/api/conversations/${id}`, { title: newTitle });
    } catch {
      showToast('No se pudo renombrar');
      loadConversations();
    }
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('¿Eliminar esta conversación?')) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === routeConvId) navigate('/');
    try {
      await api.delete(`/api/conversations/${id}`);
    } catch {
      showToast('No se pudo eliminar');
      loadConversations();
    }
  };

  const handleLogout = async () => {
    await logout();
    setConversations([]);
    navigate('/');
  };

  if (loading) {
    return (
      <div className="app-loading">
        <span className="brand app-loading__logo">FOLAX</span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  const empty = messages.length === 0;

  return (
    <div className="chat-shell">
      <Sidebar
        user={user}
        conversations={conversations}
        loadingConversations={convsLoading}
        activeId={routeConvId}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onRename={renameConversation}
        onDelete={deleteConversation}
        onLogout={handleLogout}
      />

      <main className="chat-main">
        <header className="chat-header">
          <h1 className="chat-header__title">{title || (empty ? '' : 'Sin título')}</h1>
          {user ? (
            !empty && routeConvId && (
              <button
                className="pill-btn pill-btn--primary chat-header__share"
                onClick={() => setShareOpen(true)}
              >
                <IconShare size={15} /> Compartir
              </button>
            )
          ) : (
            <div className="chat-header__auth">
              <Link to="/auth" className="pill-btn pill-btn--outline">Inicia Sesion</Link>
              <Link to="/auth?mode=register" className="pill-btn pill-btn--primary">Registrate</Link>
            </div>
          )}
        </header>

        {msgsLoading && empty ? (
          <>
            <div className="chat-scroll">
              <ThreadSkeleton />
            </div>
            <div className="chat-composer">
              <ChatInput onSend={send} busy models={models} model={model} onModelChange={setModel} />
            </div>
          </>
        ) : empty ? (
          <div className="chat-hero">
            <h2 className="chat-hero__title">¿Qué investigaremos hoy?</h2>
            <div className="chat-hero__input">
              <ChatInput onSend={send} busy={busy} models={models} model={model} onModelChange={setModel}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} />
            </div>
          </div>
        ) : (
          <>
            <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
              <div className="chat-thread">
                {messages.map((m, i) => (
                  m.role === 'user' ? (
                    <div key={i} className="msg msg--user">{m.content}</div>
                  ) : (
                    <div key={i} className={`msg msg--assistant ${m.error ? 'msg--error' : ''}`}>
                      {m.sources?.length > 0 && <Sources sources={m.sources} />}
                      {searching && i === messages.length - 1 && !m.content && (
                        <span className="msg__searching">
                          <IconGlobe size={14} /> Buscando en internet…
                        </span>
                      )}
                      {m.content
                        ? <Markdown>{m.content}</Markdown>
                        : (!searching && <span className="msg__thinking">Pensando…</span>)}
                    </div>
                  )
                ))}
              </div>
            </div>
            {showJump && (
              <button className="chat-jump" onClick={jumpToBottom}>
                más <IconArrowDown size={14} />
              </button>
            )}
            <div className="chat-composer">
              <ChatInput onSend={send} busy={busy} models={models} model={model} onModelChange={setModel}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} />
            </div>
          </>
        )}

        {toast && (
          <div className={`chat-toast ${toast.leaving ? 'is-leaving' : ''}`}>{toast.text}</div>
        )}
      </main>

      {shareOpen && routeConvId && (
        <ShareDialog conversationId={routeConvId} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}
