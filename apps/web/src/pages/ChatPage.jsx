// ChatPage.jsx — pantalla principal (mockups 2.1 y 2.2).
// Con sesión: chat con streaming SSE, memoria de conversación e historial.
// Sin sesión: se VE la interfaz ("¿Qué investigaremos hoy?"); al enviar → registro.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useIsCompact } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { Logo } from '../components/Logo';
import { Sidebar } from '../components/Sidebar';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { ThreadSkeleton } from '../components/Skeleton';
import { ShareDialog } from '../components/ShareDialog';
import { VerifyBanner } from '../components/VerifyBanner';
import { IconShare, IconArrowDown, IconGlobe, IconMenu } from '../components/Icons';

const CONTEXT_WINDOW = 20; // mensajes previos que se envían como contexto

const AVISO_VACIO = 'El modelo no devolvió respuesta. Suele pasar cuando la conversación ya no cabe '
  + 'en su ventana de contexto: prueba a repetir la pregunta o empieza una conversación nueva.';
const AVISO_CORTADA = 'Respuesta cortada: el modelo alcanzó su límite de tokens.';

// Razonamiento previo de los modelos thinking: plegado, y abierto mientras
// el modelo aún no ha escrito nada para que se vea que está trabajando.
function Razonamiento({ texto, activo }) {
  return (
    <details className="msg-razon" open={activo}>
      <summary className={activo ? 'msg-razon__titulo is-activo' : 'msg-razon__titulo'}>
        {activo ? 'Razonando…' : 'Razonamiento'}
      </summary>
      <div className="msg-razon__texto">{texto}</div>
    </details>
  );
}

function Sources({ sources, queries }) {
  return (
    <div className="msg-sources">
      <span className="msg-sources__title"><IconGlobe size={13} /> Fuentes</span>
      {queries?.length > 0 && (
        <p className="msg-sources__queries">
          Buscó: {queries.map((q, i) => <span key={i} className="msg-sources__query">{q}</span>)}
        </p>
      )}
      {sources.length === 0 && <p className="msg-sources__queries">Sin resultados.</p>}
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
  const confirmar = useConfirmar();
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
  const abortRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  // En compacto el panel es un cajón sobre el chat, no una columna.
  const compact = useIsCompact();
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Al pasar a escritorio el cajón deja de tener sentido (el panel es fijo).
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

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

    // Privacidad: con el historial desactivado la conversación vive solo en
    // memoria (el backend tampoco la persiste) — sin URL /c/:id ni sidebar.
    const saveHistory = user?.settings?.save_history !== false;
    const convId = routeConvId || crypto.randomUUID();
    const isFirstExchange = messages.length === 0;
    const history = [...messages.slice(-CONTEXT_WINDOW), { role: 'user', content: text }];

    if (!routeConvId && saveHistory) {
      loadedConvRef.current = convId; // evita el refetch al cambiar la URL
      navigate(`/c/${convId}`, { replace: true });
    }

    stickToBottomRef.current = true;
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    if (webSearch) setSearching(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const patchLast = (fn) => setMessages((prev) => {
      const next = prev.slice();
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });

    try {
      await streamChatCompletion({
        model: chosenModel,
        messages: history,
        conversationId: convId,
        webSearch,
        signal: abort.signal,
        onSources: (sources, queries) => {
          setSearching(false);
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, sources, queries };
            return next;
          });
        },
        onDelta: (delta) => {
          setSearching(false);
          patchLast((last) => ({ ...last, content: last.content + delta }));
        },
        onReasoning: (delta) => {
          setSearching(false);
          patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta }));
        },
        onFinish: (reason, event) => {
          if (event?.type === 'empty') {
            patchLast((last) => ({ ...last, content: `⚠️ ${AVISO_VACIO}`, error: true }));
          } else if (reason === 'length') {
            patchLast((last) => ({ ...last, aviso: AVISO_CORTADA }));
          }
        },
      });
      // Stream cerrado sin contenido ni aviso (p. ej. el gateway se reinició a
      // mitad): que no quede "Pensando…" con el botón de enviar activo.
      patchLast((last) => (last.content ? last : { ...last, content: `⚠️ ${AVISO_VACIO}`, error: true }));

      if (isFirstExchange && saveHistory) {
        try {
          const res = await api.post(`/api/conversations/${convId}/generate-title`);
          setTitle(res.data.title);
        } catch { /* el título puede quedar vacío */ }
      }
      if (saveHistory) loadConversations();
    } catch (err) {
      // Detenido por el usuario: lo generado hasta ahí se queda tal cual
      // (el gateway también lo persiste al cortarse el stream).
      if (err.name === 'AbortError') {
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (!last.content) next.pop();
          return next;
        });
        return;
      }
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
      abortRef.current = null;
      setSearching(false);
      setBusy(false);
    }
  };

  const stop = () => abortRef.current?.abort();

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
    const ok = await confirmar({
      titulo: '¿Eliminar esta conversación?',
      texto: 'Se borrarán todos sus mensajes. Esta acción no se puede deshacer.',
      etiqueta: 'Eliminar',
    });
    if (!ok) return;
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
    const ok = await confirmar({
      titulo: '¿Cerrar sesión?',
      texto: 'Tendrás que volver a iniciar sesión para ver tu historial.',
      etiqueta: 'Cerrar sesión',
      peligro: false,
    });
    if (!ok) return;
    await logout();
    setConversations([]);
    navigate('/');
  };

  if (loading) {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
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
        compact={compact}
        open={compact && drawerOpen}
        onClose={closeDrawer}
      />

      {compact && drawerOpen && (
        <div className="sidebar-scrim" onClick={closeDrawer} aria-hidden="true" />
      )}

      <main className="chat-main">
        <header className="chat-header">
          <button
            className="icon-btn chat-header__menu"
            onClick={() => setDrawerOpen(true)}
            aria-label="Abrir panel de conversaciones"
            aria-controls="sidebar-drawer"
            aria-expanded={drawerOpen}
          >
            <IconMenu />
          </button>
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
            <Link to="/auth" className="pill-btn pill-btn--primary chat-header__share">
              Iniciar sesión
            </Link>
          )}
        </header>

        <VerifyBanner />

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
            {/* Sin sesión el encabezado explica el límite en vez de invitar a
                escribir: es lo primero que hay que saber antes de empezar. */}
            <h2 className={`chat-hero__title ${user ? '' : 'chat-hero__title--invitado'}`}>
              {user
                ? '¿Qué investigaremos hoy?'
                : 'Solo tienes un chat disponible para usar. Inicia sesión para tener más chats y funciones'}
            </h2>
            <div className="chat-hero__input">
              <ChatInput onSend={send} onStop={stop} busy={busy} models={models} model={model} onModelChange={setModel}
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
                      {(m.sources?.length > 0 || m.queries?.length > 0) && (
                        <Sources sources={m.sources || []} queries={m.queries} />
                      )}
                      {searching && i === messages.length - 1 && !m.content && (
                        <span className="msg__searching">
                          <IconGlobe size={14} /> Buscando en internet…
                        </span>
                      )}
                      {m.reasoning && (
                        <Razonamiento texto={m.reasoning} activo={busy && i === messages.length - 1 && !m.content} />
                      )}
                      {m.content
                        ? <Markdown>{m.content}</Markdown>
                        : (!searching && !m.reasoning && <span className="msg__thinking">Pensando…</span>)}
                      {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                    </div>
                  )
                ))}
              </div>
            </div>
            <div className="chat-composer">
              {/* Dentro del compositor: se apoya en su borde superior y lo sigue
                  cuando la caja crece o el teclado móvil la empuja. */}
              {showJump && (
                <button className="chat-jump" onClick={jumpToBottom}>
                  más <IconArrowDown size={14} />
                </button>
              )}
              <ChatInput onSend={send} onStop={stop} busy={busy} models={models} model={model} onModelChange={setModel}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} />
              <p className="chat-disclaimer">
                lixbon puede equivocarse. Verifica la informacion antes de usarla.
              </p>
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
