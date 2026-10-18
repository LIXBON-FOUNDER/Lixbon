import { useSeo } from '../lib/seo';
import { ShimmerText } from '../components/ShimmerText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useIsCompact } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { Logo } from '../components/Logo';
import { Sidebar } from '../components/Sidebar';
import { ChatInput } from '../components/ChatInput';
import { guardarRazonar, leerRazonar, nivelesDe, thinkDe } from '../lib/razonamiento';
import { Markdown } from '../components/Markdown';
import { ThreadSkeleton } from '../components/Skeleton';
import { ShareDialog } from '../components/ShareDialog';
import { VerifyBanner } from '../components/VerifyBanner';
import { IconShare, IconArrowDown, IconGlobe, IconLayers, IconMenu } from '../components/Icons';
import { MensajeError, Razonamiento } from '../components/Mensajes';
import { MascotaChat } from '../components/Mascota';
import { ChatVisualPanel, VISUAL_CHAT_PROMPT, VisualChip, sinBloquesVisuales } from '../components/ChatVisualPanel';
import { FILE_PROMPT } from '../lib/archivos';
import { tieneVisuals } from '../lib/planes';
import { deleteVisual, getVisual } from '../lib/visualsApi';
import {
  aplicarRespuesta, cargarPaginas, compactarHistorial, contextoArchivos, crearVisual, etiquetaDePedido, guardarRespuesta, pedidoVisual, tieneVisual,
  tituloDe, visualDeConversacion,
} from '../lib/visualStudio';

const SEPARADOR_ADJUNTOS = '\n\n---\n\n';

const CONV_PAGE = 30; // conversaciones por página del historial
const CONTEXT_WINDOW = 20; // mensajes previos que se envían como contexto

// Sin datos de tokens (conversación recién cargada o sin respuesta aún) el
// contexto se estima por caracteres; el gateway manda el uso real al terminar.
const estimarTokens = (msgs) => Math.round(msgs.reduce((n, m) => n + (m.content?.length || 0), 0) / 3.5);


// «Miércoles 15 de octubre · Buenas tardes, Gabriel», como el eyebrow de founder.
function fechaSaludo(t, nombre) {
  const ahora = new Date();
  const hora = ahora.getHours();
  const saludo = t(hora < 12 ? 'greetMorning' : hora < 20 ? 'greetAfternoon' : 'greetNight');
  const fecha = new Intl.DateTimeFormat(t('dateLocale'), { weekday: 'long', day: 'numeric', month: 'long' }).format(ahora);
  return `${fecha} · ${nombre ? `${saludo}, ${nombre}` : saludo}`;
}

// La última palabra del titular va en cursiva oliva, como en founder.
function UltimaEnCursiva({ texto }) {
  const m = texto.match(/^(.*\s)(\S+?)([?!.]*)$/);
  if (!m) return texto;
  return <>{m[1]}<em>{m[2]}</em>{m[3]}</>;
}

function Sources({ sources, queries }) {
  const t = useT('chat');
  return (
    <div className="msg-sources">
      <span className="msg-sources__title"><IconGlobe size={13} /> {t('sourcesTitle')}</span>
      {queries?.length > 0 && (
        <p className="msg-sources__queries">
          {t('searchedLabel')} {queries.map((q, i) => <span key={i} className="msg-sources__query">{q}</span>)}
        </p>
      )}
      {sources.length === 0 && <p className="msg-sources__queries">{t('noResults')}</p>}
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
  const t = useT('chat');
  const tc = useT('common');
  useSeo({ title: t('seoTitle'), path: '/chat', noindex: true });
  const { user, loading, logout } = useAuth();
  const confirmar = useConfirmar();
  const { id: routeConvId } = useParams();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsMore, setConvsMore] = useState(false);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const moreRef = useRef(false);
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [title, setTitle] = useState(null);
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [contextUso, setContextUso] = useState(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const compact = useIsCompact();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [razonar, setRazonar] = useState(leerRazonar);
  const [avisoCuota, setAvisoCuota] = useState(null);
  const [searching, setSearching] = useState(false);
  const [visual, setVisual] = useState(null);
  const [paginasVisual, setPaginasVisual] = useState([]);
  const [panelVisual, setPanelVisual] = useState(false);
  const [errorVisual, setErrorVisual] = useState('');

  const scrollRef = useRef(null);
  const loadedConvRef = useRef(null);
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

  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  // El historial llega por páginas: la primera al entrar y las siguientes
  // cuando la lista se acerca al final. Los mensajes, solo al abrir una.
  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get(`/api/conversations?limit=${CONV_PAGE}`);
      setConversations(res.data.conversations);
      setConvsMore(res.data.conversations.length === CONV_PAGE);
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

  const loadModels = useCallback(async () => {
    const res = await api.get('/v1/models');
    const ids = res.data.data
      .map((m) => m.id)
      .filter((id) => !String(id).startsWith('error:'));
    setModels(ids);
    setModelInfo(Object.fromEntries(res.data.data.map((m) => [m.id, {
      num_ctx: m.num_ctx, context_length: m.context_length, capabilities: m.capabilities || [], name: m.name || m.id,
      reasoning: m.reasoning, real: m.model || m.id,
    }])));
    setModel((current) => current || ids[0] || '');
    return ids;
  }, []);

  useEffect(() => {
    if (!user) { setConvsLoading(false); return; }
    setConvsLoading(true);
    loadConversations();
    loadModels().catch(() => setModels([]));
  }, [user, loadConversations, loadModels]);

  useEffect(() => {
    if (!routeConvId) {
      loadedConvRef.current = null;
      setMessages([]);
      setTitle(null);
      setContextUso(null);
      setVisual(null);
      setPaginasVisual([]);
      setPanelVisual(false);
      setErrorVisual('');
      return;
    }
    if (!user || loadedConvRef.current === routeConvId) return;
    setVisual(null);
    setPaginasVisual([]);
    setPanelVisual(false);
    setErrorVisual('');
    visualDeConversacion(routeConvId).then((v) => { if (v) cargarVisual(v.id); }).catch(() => {});
    loadedConvRef.current = routeConvId;
    setMsgsLoading(true);
    api.get(`/api/conversations/${routeConvId}/messages`)
      .then((res) => {
        const cargados = res.data.messages.map((m) => ({
          role: m.role, content: m.content, prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens,
        }));
        setMessages(cargados);
        setTitle(res.data.conversation?.title || null);
        const ultimo = [...cargados].reverse().find((m) => m.role === 'assistant' && m.prompt_tokens);
        setContextUso(ultimo
          ? { used: ultimo.prompt_tokens + ultimo.completion_tokens, total: null }
          : { used: estimarTokens(cargados), total: null, estimado: true });
      })
      .catch(() => navigate('/', { replace: true }))
      .finally(() => setMsgsLoading(false));
  }, [routeConvId, user, navigate]);

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

  const modelVision = Boolean(modelInfo[model]?.capabilities?.includes('vision'));

  const cargarVisual = async (vid) => {
    const m = await getVisual(vid);
    const paginas = await cargarPaginas(vid, m);
    setVisual({ id: vid, title: m.title, version: m.version, label: m.viewing_label });
    setPaginasVisual(paginas);
    return paginas;
  };

  const guardarVisual = async (respuesta, convId, base, patchLast, pedido) => {
    const r = aplicarRespuesta(base.paginas, respuesta, { estricto: true });
    if (r.fallos.length) patchLast((last) => ({ ...last, aviso: t('visualEditFailed', { names: r.fallos.map((f) => f.name).join(', ') }) }));
    if (!r.cambiadas.length) return;
    try {
      let vid = base.visual?.id;
      let version;
      if (!vid) {
        const vis = await crearVisual({
          kind: 'design', title: tituloDe(r.files, title || t('untitled')),
          meta: { conversation_id: convId, origin: 'chat' },
          files: r.cambiadas.map((f) => ({ path: f.name, role: 'source', text: f.code })),
          label: etiquetaDePedido(pedido),
        });
        vid = vis.id;
        version = vis.version;
      } else {
        version = (await guardarRespuesta(vid, base.visual.version, r.cambiadas,
          (actuales) => aplicarRespuesta(actuales, respuesta, { estricto: true }).cambiadas, etiquetaDePedido(pedido))).version;
      }
      patchLast((last) => ({ ...last, visual: { version, nuevas: r.cambiadas.map((f) => f.name) } }));
      await cargarVisual(vid);
      setErrorVisual('');
    } catch (err) {
      setErrorVisual(err.response?.data?.detail?.message || t('visualSaveError'));
    }
  };

  const descartarVisual = async () => {
    const ok = await confirmar({ titulo: t('discardVisualTitle'), texto: t('discardVisualText'), etiqueta: t('discardVisual') });
    if (!ok) return;
    try { await deleteVisual(visual.id); } catch { /* ya no existe */ }
    setVisual(null);
    setPaginasVisual([]);
    setPanelVisual(false);
  };

  const send = async (entrada, images = []) => {
    if (!user) {
      navigate('/auth?mode=register');
      return;
    }
    // Con adjuntos el texto llega como «contexto --- pregunta»: el comando va en la pregunta.
    const corte = entrada.lastIndexOf(SEPARADOR_ADJUNTOS);
    const cabeza = corte >= 0 ? entrada.slice(0, corte + SEPARADOR_ADJUNTOS.length) : '';
    const pedido = pedidoVisual(entrada.slice(cabeza.length));
    if (pedido.comando && !pedido.texto.trim()) {
      showToast(t('visualCommandEmpty'));
      return;
    }
    const text = cabeza + pedido.texto;
    // Si el usuario escribe antes de que /v1/models responda, se resuelve aquí
    // para no perder su mensaje.
    let chosenModel = model;
    if (!chosenModel) {
      try {
        chosenModel = (await loadModels())[0] || '';
      } catch { /* cae al toast de abajo */ }
      if (!chosenModel) {
        showToast(t('noModelsAvailable'));
        return;
      }
    }

    // Privacidad: con el historial desactivado la conversación vive solo en
    // memoria (el backend tampoco la persiste) — sin URL /c/:id ni sidebar.
    const saveHistory = user?.settings?.save_history !== false;
    const convId = routeConvId || crypto.randomUUID();
    const isFirstExchange = messages.length === 0;
    // Las imágenes viajan con el mensaje (modelo con visión); el historial
    // guardado solo conserva el texto.
    const history = [...messages.slice(-CONTEXT_WINDOW), { role: 'user', content: text, ...(images.length ? { images } : {}) }];
    // Con el diseño abierto, lo que se escriba suele ser un cambio del diseño.
    const conVisuals = tieneVisuals(user) && (pedido.visual || (panelVisual && paginasVisual.length > 0));
    const base = { visual, paginas: paginasVisual };

    if (!routeConvId && saveHistory) {
      loadedConvRef.current = convId;
      navigate(`/c/${convId}`, { replace: true });
    }

    stickToBottomRef.current = true;
    setMessages([...history, { role: 'assistant', content: '' }]);
    setContextUso((prev) => ({ used: Math.max(prev?.used || 0, estimarTokens(history)), total: null, estimado: true }));
    setBusy(true);
    setAvisoCuota(null);
    if (webSearch) setSearching(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const patchLast = (fn) => setMessages((prev) => {
      const next = prev.slice();
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });

    let respuesta = '';
    try {
      await streamChatCompletion({
        model: chosenModel,
        messages: conVisuals ? compactarHistorial(history, { soloPaginas: true }) : history,
        conversationId: convId,
        system: conVisuals ? FILE_PROMPT + VISUAL_CHAT_PROMPT + contextoArchivos(base.paginas, base.visual?.version || 0) : FILE_PROMPT,
        webSearch,
        think: thinkDe(razonar, nivelesDe(modelInfo[chosenModel])),
        onQuota: setAvisoCuota,
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
          respuesta += delta;
          if (conVisuals && tieneVisual(respuesta)) setPanelVisual(true);
          patchLast((last) => ({ ...last, content: last.content + delta }));
        },
        onReasoning: (delta) => {
          setSearching(false);
          patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta }));
        },
        onFinish: (reason, chunk) => {
          const event = chunk?.lixbon_event;
          if (chunk?.usage) {
            setContextUso({
              used: (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0),
              total: chunk.lixbon_context?.num_ctx || null,
            });
          }
          if (event?.type === 'empty') {
            patchLast((last) => ({ ...last, content: t('emptyResponseNotice'), error: true }));
          } else if (reason === 'length' && !chunk?.lixbon_quota) {
            patchLast((last) => ({ ...last, aviso: t('cutResponseNotice') }));
          }
        },
      });
      // Stream cerrado sin contenido ni aviso (p. ej. el gateway se reinició a
      // mitad): que no quede "Pensando…" con el botón de enviar activo.
      patchLast((last) => (last.content ? last : { ...last, content: t('emptyResponseNotice'), error: true }));
      if (conVisuals && tieneVisual(respuesta)) await guardarVisual(respuesta, convId, base, patchLast, text);

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
      if (err.quota) setAvisoCuota(err.quota);
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = {
          ...last,
          content: last.content || err.message,
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

  const elegirRazonar = (valor) => {
    setRazonar(valor);
    guardarRazonar(valor);
  };

  const comandos = tieneVisuals(user) ? [{ cmd: '/visual', desc: t('visualCommand') }] : [];

  const usoCtx = contextUso && { ...contextUso, total: contextUso.total || modelInfo[model]?.num_ctx || null };

  const renameConversation = async (id, newTitle) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    if (id === routeConvId) setTitle(newTitle);
    try {
      await api.patch(`/api/conversations/${id}`, { title: newTitle });
    } catch {
      showToast(t('renameFailed'));
      loadConversations();
    }
  };

  const deleteConversation = async (id) => {
    const ok = await confirmar({
      titulo: t('deleteConvTitle'),
      texto: t('deleteConvText'),
      etiqueta: tc('delete'),
    });
    if (!ok) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === routeConvId) navigate('/chat');
    try {
      await api.delete(`/api/conversations/${id}`);
    } catch {
      showToast(t('deleteFailed'));
      loadConversations();
    }
  };

  const handleLogout = async () => {
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
    navigate('/chat');
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
  const ultimo = messages[messages.length - 1];
  const escribiendo = busy && ultimo?.role === 'assistant' && Boolean(ultimo.content);

  return (
    <div className="chat-shell">
      <Sidebar
        user={user}
        conversations={conversations}
        loadingConversations={convsLoading}
        hasMoreConversations={convsMore}
        onLoadMore={loadMoreConversations}
        onSearch={searchConversations}
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
            aria-label={t('openConversationsPanel')}
            aria-controls="sidebar-drawer"
            aria-expanded={drawerOpen}
          >
            <IconMenu />
          </button>
          <h1 className="chat-header__title">{title || (empty ? '' : t('untitled'))}</h1>
          {visual && !panelVisual && (
            <button className="pill-btn chat-header__visual" onClick={() => setPanelVisual(true)}>
              <IconLayers size={15} /> {t('visualShow')}
            </button>
          )}
          {user ? (
            !empty && routeConvId && (
              <button
                className="pill-btn pill-btn--primary chat-header__share"
                onClick={() => setShareOpen(true)}
              >
                <IconShare size={15} /> {t('share')}
              </button>
            )
          ) : (
            <Link to="/auth" className="pill-btn pill-btn--primary chat-header__share">
              {tc('logIn')}
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
              <ChatInput onSend={send} busy models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision} />
            </div>
          </>
        ) : empty ? (
          <div className="chat-hero">
            <div className="chat-hero__cabeza">
              {user && <p className="chat-hero__fecha">{fechaSaludo(t, user.first_name)}</p>}
              <h2 className={`chat-hero__title ${user ? '' : 'chat-hero__title--invitado'}`}>
                {user ? <UltimaEnCursiva texto={t('emptyTitleUser')} /> : t('emptyTitleGuest')}
              </h2>
            </div>
            <div className="chat-hero__input">
              {user && <MascotaChat ocupado={busy} escribiendo={escribiendo} />}
              <ChatInput onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} contextUso={usoCtx}
                nivelesRazonar={nivelesDe(modelInfo[model])} razonar={razonar} onRazonar={elegirRazonar}
                avisoCuota={avisoCuota} onCerrarAviso={() => setAvisoCuota(null)} commands={comandos} />
            </div>
          </div>
        ) : (
          <>
            <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
              <div className="chat-thread">
                {messages.map((m, i) => (
                  m.role === 'user' ? (
                    <div key={i} className="msg msg--user">
                      {m.images?.length > 0 && (
                        <div className="msg__images">
                          {m.images.map((img, j) => <img key={j} src={`data:image/jpeg;base64,${img}`} alt="" />)}
                        </div>
                      )}
                      {m.content}
                    </div>
                  ) : (
                    <div key={i} className={`msg msg--assistant ${m.error ? 'msg--error' : ''}`}>
                      {(m.sources?.length > 0 || m.queries?.length > 0) && (
                        <Sources sources={m.sources || []} queries={m.queries} />
                      )}
                      {searching && i === messages.length - 1 && !m.content && (
                        <span className="msg__searching">
                          <IconGlobe size={14} /> <ShimmerText text={t('searchingWeb')} />
                        </span>
                      )}
                      {m.reasoning && (
                        <Razonamiento texto={m.reasoning} activo={busy && i === messages.length - 1 && !m.content} />
                      )}
                      {(() => {
                        if (m.error) return <MensajeError>{m.content}</MensajeError>;
                        if (!m.content) return !searching && !m.reasoning && <span className="msg__thinking"><ShimmerText text={t('thinking')} /></span>;
                        const activo = busy && i === messages.length - 1;
                        if (!tieneVisual(m.content)) return <Markdown streaming={activo}>{m.content}</Markdown>;
                        const r = aplicarRespuesta([], m.content, { enCurso: true, estricto: true });
                        const nombres = m.visual?.nuevas || [...new Set([...r.files.map((f) => f.name), ...(r.editando ? [r.editando.name] : [])])];
                        const cuerpo = sinBloquesVisuales(m.content);
                        return (
                          <>
                            {cuerpo && <Markdown streaming={activo}>{cuerpo}</Markdown>}
                            <VisualChip nombres={nombres.length ? nombres : ['index.html']} t={t}
                              escribiendo={activo ? (r.abierto?.name || r.editando?.name || nombres[0] || 'index.html') : null}
                              onOpen={() => setPanelVisual(true)} />
                          </>
                        );
                      })()}
                      {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                    </div>
                  )
                ))}
              </div>
            </div>
            <div className="chat-composer">
              {showJump && (
                <button className="chat-jump" onClick={jumpToBottom} aria-label={t('jumpMore')} title={t('jumpMore')}>
                  <IconArrowDown size={16} />
                </button>
              )}
              <MascotaChat ocupado={busy} escribiendo={escribiendo} />
              <ChatInput onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} contextUso={usoCtx}
                nivelesRazonar={nivelesDe(modelInfo[model])} razonar={razonar} onRazonar={elegirRazonar}
                avisoCuota={avisoCuota} onCerrarAviso={() => setAvisoCuota(null)} commands={comandos} />
              <p className="chat-disclaimer">
                {t('disclaimer')}
              </p>
            </div>
          </>
        )}

        {toast && (
          <div className={`chat-toast ${toast.leaving ? 'is-leaving' : ''}`}>{toast.text}</div>
        )}
      </main>

      {panelVisual && (() => {
        const ult = messages[messages.length - 1];
        const vivo = busy && ult?.role === 'assistant' && tieneVisual(ult.content)
          ? aplicarRespuesta(paginasVisual, ult.content, { enCurso: true, estricto: true }) : null;
        return (
          <ChatVisualPanel visual={visual} paginas={paginasVisual} vivo={vivo} error={errorVisual} t={t}
            onClose={() => setPanelVisual(false)} onDiscard={descartarVisual} />
        );
      })()}

      {shareOpen && routeConvId && (
        <ShareDialog conversationId={routeConvId} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}
