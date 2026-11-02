import { useSeo } from '../lib/seo';
import { ShimmerText } from '../components/ShimmerText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { Logo, LogoTrabajando } from '../components/Logo';
import { useShell } from '../components/AppShell';
import { ChatInput } from '../components/ChatInput';
import { guardarRazonar, leerRazonar, nivelesDe, thinkDe } from '../lib/razonamiento';
import { Markdown } from '../components/Markdown';
import { ThreadSkeleton } from '../components/Skeleton';
import { ShareDialog } from '../components/ShareDialog';
import { VerifyBanner } from '../components/VerifyBanner';
import { IconShare, IconArrowDown, IconGlobe, IconLayers, IconMenu, IconPencil, IconFile, IconSearch, IconCode, IconChevron, IconTrash, IconCopiar } from '../components/Icons';
import { Desplegable } from '../components/Desplegable';
import { AbrirArchivo } from '../components/FileCard';
import { PanelArchivo } from '../components/PanelArchivo';
import { useDismiss } from '../hooks/useDismiss';
import { MensajeError, Razonamiento } from '../components/Mensajes';
import { MascotaChat } from '../components/Mascota';
import { AvisoChatCerrado, ChatCerrado } from '../components/ChatCerrado';
import { HeroInicio } from '../components/Cielo';
import { useChatWebAbierto } from '../lib/chatWeb';
import { ChatVisualPanel, VISUAL_CHAT_PROMPT, VisualChip, sinBloquesVisuales } from '../components/ChatVisualPanel';
import { FILE_PROMPT } from '../lib/archivos';
import { tieneVisuals } from '../lib/planes';
import { deleteVisual, getVisual } from '../lib/visualsApi';
import {
  aplicarRespuesta, cargarPaginas, compactarHistorial, contextoArchivos, crearVisual, etiquetaDePedido, guardarRespuesta, pedidoVisual, tieneVisual,
  tituloDe, visualDeConversacion,
} from '../lib/visualStudio';

const SEPARADOR_ADJUNTOS = '\n\n---\n\n';

const CONTEXT_WINDOW = 20; // mensajes previos que se envían como contexto

// Sin datos de tokens (conversación recién cargada o sin respuesta aún) el
// contexto se estima por caracteres; el gateway manda el uso real al terminar.
const estimarTokens = (msgs) => Math.round(msgs.reduce((n, m) => n + (m.content?.length || 0), 0) / 3.5);


// «Buenas tardes, Gabriel» según la hora del navegador: sin punto final.
function saludo(t, nombre) {
  const hora = new Date().getHours();
  const s = t(hora < 12 ? 'greetMorning' : hora < 20 ? 'greetAfternoon' : 'greetNight');
  return nombre ? `${s}, ${nombre}` : s;
}

// Tarjetas bajo el cuadro del chat vacío: rellenan el mensaje sin enviarlo;
// «Investigar» además enciende la búsqueda web.
const ATAJOS = [
  { clave: 'qaWrite', Icono: IconPencil },
  { clave: 'qaCreate', Icono: IconFile },
  { clave: 'qaResearch', Icono: IconSearch, web: true },
  { clave: 'qaCode', Icono: IconCode },
];

// Debajo de cada respuesta terminada: copiar el texto.
function AccionesRespuesta({ texto }) {
  const t = useT('chat');
  const [copiado, setCopiado] = useState(false);
  const copiar = () => {
    navigator.clipboard?.writeText(texto).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    }).catch(() => {});
  };
  return (
    <div className="msg-acciones">
      <button type="button" className="msg-accion" onClick={copiar} aria-label={copiado ? t('copied') : t('copyAnswer')} title={copiado ? t('copied') : t('copyAnswer')}>
        <IconCopiar hecho={copiado} size={16} />
      </button>
    </div>
  );
}

// Título de la conversación en la cabecera: al pulsarlo se abre el menú para
// renombrarla (ahí mismo) o eliminarla.
function TituloChat({ titulo, editable, onRename, onDelete }) {
  const t = useT('chat');
  const [menu, setMenu] = useState(false);
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState('');
  const raiz = useRef(null);
  const cerrar = useCallback(() => setMenu(false), []);
  useDismiss(menu, raiz, cerrar);

  if (!editable) return <h1 className="chat-header__title">{titulo}</h1>;
  if (editando) {
    const confirmar = () => {
      setEditando(false);
      const nuevo = borrador.trim();
      if (nuevo && nuevo !== titulo) onRename(nuevo);
    };
    return (
      <input
        className="chat-header__edit"
        value={borrador}
        onChange={(e) => setBorrador(e.target.value)}
        onBlur={confirmar}
        onKeyDown={(e) => { if (e.key === 'Enter') confirmar(); if (e.key === 'Escape') setEditando(false); }}
        aria-label={t('renameChat')}
        autoFocus
      />
    );
  }
  return (
    <div className="chat-header__titulo" ref={raiz}>
      <button type="button" className="chat-header__title-btn" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
        <h1 className="chat-header__title">{titulo}</h1>
        <IconChevron size={14} />
      </button>
      <Desplegable abierto={menu} className="sb-menu chat-header__menu-titulo" role="menu">
        <button role="menuitem" onClick={() => { setMenu(false); setBorrador(titulo); setEditando(true); }}>
          <IconPencil size={14} /> {t('renameChat')}
        </button>
        <button role="menuitem" className="sb-menu__danger" onClick={() => { setMenu(false); onDelete(); }}>
          <IconTrash size={14} /> {t('deleteChat')}
        </button>
      </Desplegable>
    </div>
  );
}

const hostDe = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// El icono de la web, pedido a la propia web; si no tiene, su inicial.
function IconoFuente({ host }) {
  const [roto, setRoto] = useState(false);
  return (
    <span className="msg-fuentes__icono" title={host}>
      {roto || !host
        ? (host[0] || '?').toUpperCase()
        : <img src={`https://${host}/favicon.ico`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setRoto(true)} />}
    </span>
  );
}

// La búsqueda se cuenta como «Pensando…»: una línea de acción, sin caja. A la
// izquierda qué se buscó; al final, los iconos de las fuentes. Al pulsarla se
// despliega la lista.
function Sources({ sources, queries }) {
  const t = useT('chat');
  const hosts = [...new Set(sources.map((s) => hostDe(s.url)).filter(Boolean))];
  const cuenta = sources.length === 1 ? t('sourceOne') : t('sourcesCount', { n: sources.length });
  const frase = queries?.length
    ? t('searchedFor', { queries: queries.map((q) => `«${q}»`).join(', ') })
    : t('searchedWeb');
  return (
    <details className="msg-fuentes">
      <summary className="msg-fuentes__linea">
        <IconGlobe size={14} />
        <span className="msg-fuentes__frase">{frase}</span>
        {sources.length === 0 ? (
          <span className="msg-fuentes__cuenta">{t('noResults')}</span>
        ) : (
          <span className="msg-fuentes__pila" aria-label={cuenta}>
            {hosts.slice(0, 4).map((h) => <IconoFuente key={h} host={h} />)}
            <span className="msg-fuentes__cuenta">{cuenta}</span>
          </span>
        )}
      </summary>
      {sources.length > 0 && (
        <ol className="msg-fuentes__lista">
          {sources.map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noreferrer" title={s.snippet}>
                <span className="msg-fuentes__host">{hostDe(s.url)}</span>
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

export default function ChatPage() {
  const t = useT('chat');
  const tc = useT('common');
  useSeo({ title: t('seoTitle'), path: '/chat', noindex: true });
  const { user, loading } = useAuth();
  const confirmar = useConfirmar();
  const { id: routeConvId } = useParams();
  const navigate = useNavigate();

  // El historial, el cajón y la barra lateral viven en el marco (AppShell).
  const {
    conversations, loadConversations, renameConversation: renombrarEnMarco,
    deleteConversation: borrarEnMarco, openDrawer, drawerOpen, aviso,
  } = useShell();
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [title, setTitle] = useState(null);
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [contextUso, setContextUso] = useState(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
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
  // Archivo creado en el chat abierto en el panel de la derecha; comparte el
  // sitio con el panel del diseño, así que abrir uno cierra el otro.
  const [archivoAbierto, setArchivoAbierto] = useState(null);
  const abrirArchivo = useCallback((a) => { setPanelVisual(false); setArchivoAbierto(a); }, []);
  const cerrarArchivo = useCallback(() => setArchivoAbierto(null), []);
  useEffect(() => { if (panelVisual) setArchivoAbierto(null); }, [panelVisual]);
  useEffect(() => { setArchivoAbierto(null); }, [routeConvId]);
  const [errorVisual, setErrorVisual] = useState('');
  // null mientras se pregunta al gateway si el chat web está abierto.
  const chatAbierto = useChatWebAbierto();
  const [sugerida, setSugerida] = useState('');

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
    if (!user) return;
    loadModels().catch(() => setModels([]));
  }, [user, loadModels]);

  // Avisos del marco (renombrar o borrar desde la barra lateral).
  useEffect(() => {
    if (aviso) showToast(aviso.texto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aviso]);

  // Si se renombra desde la barra lateral, la cabecera lo refleja.
  useEffect(() => {
    const c = routeConvId && conversations.find((x) => x.id === routeConvId);
    if (c?.title) setTitle((actual) => (actual === c.title ? actual : c.title));
  }, [conversations, routeConvId]);

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
    if (id === routeConvId) setTitle(newTitle);
    await renombrarEnMarco(id, newTitle);
  };

  const deleteConversation = (id) => borrarEnMarco(id);

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
    <>
      <AbrirArchivo.Provider value={abrirArchivo}>
      <main className="chat-main">
        <header className="chat-header">
          <button
            className="icon-btn chat-header__menu"
            onClick={openDrawer}
            aria-label={t('openConversationsPanel')}
            aria-controls="sidebar-drawer"
            aria-expanded={drawerOpen}
          >
            <IconMenu />
          </button>
          <TituloChat
            titulo={title || (empty ? '' : t('untitled'))}
            editable={Boolean(user && routeConvId && !empty)}
            onRename={(nuevo) => renameConversation(routeConvId, nuevo)}
            onDelete={() => deleteConversation(routeConvId)}
          />
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
              {chatAbierto === false && <AvisoChatCerrado />}
              {chatAbierto && (
                <ChatInput onSend={send} busy models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision} />
              )}
            </div>
          </>
        ) : empty && chatAbierto === null ? (
          <div className="chat-hero" />
        ) : empty && !chatAbierto ? (
          <ChatCerrado />
        ) : empty ? (
          <HeroInicio cielo>
            <h2 className={`chat-hero__title ${user ? '' : 'chat-hero__title--invitado'}`}>
              {user ? <>{saludo(t, user.first_name)}<br /><em>{t('emptyTitleUser')}</em></> : t('emptyTitleGuest')}
            </h2>
            <div className="chat-hero__input">
              {/* Al enviar se olvida el atajo: el próximo chat vacío no debe traerlo relleno. */}
              <ChatInput onSend={(...args) => { setSugerida(''); return send(...args); }} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision}
                webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} contextUso={usoCtx}
                nivelesRazonar={nivelesDe(modelInfo[model])} razonar={razonar} onRazonar={elegirRazonar}
                avisoCuota={avisoCuota} onCerrarAviso={() => setAvisoCuota(null)} commands={comandos}
                initialText={sugerida} />
            </div>
            <div className="chat-atajos">
              {ATAJOS.map(({ clave, Icono, web }) => (
                <button key={clave} type="button" className="chat-atajo"
                  onClick={() => { if (web) setWebSearch(true); setSugerida(t(`${clave}Prompt`)); }}>
                  <span className="chat-atajo__icono"><Icono size={18} /></span>
                  <span className="chat-atajo__titulo">{t(clave)}</span>
                  <span className="chat-atajo__texto">{t(`${clave}Sub`)}</span>
                </button>
              ))}
            </div>
            <p className="chat-disclaimer chat-disclaimer--hero">{t('privacyNote')}</p>
          </HeroInicio>
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
                        <span className="msg__trabajo" role="status">
                          <LogoTrabajando /> <ShimmerText text={t('searchingWeb')} />
                        </span>
                      )}
                      {m.reasoning && (
                        <Razonamiento texto={m.reasoning} activo={busy && i === messages.length - 1 && !m.content} />
                      )}
                      {(() => {
                        if (m.error) return <MensajeError>{m.content}</MensajeError>;
                        if (!m.content) return !searching && !m.reasoning && <span className="msg__trabajo" role="status"><LogoTrabajando /><ShimmerText text={t('thinking')} /></span>;
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
                      {m.content && !m.error && !(busy && i === messages.length - 1) && <AccionesRespuesta texto={sinBloquesVisuales(m.content)} />}
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
              {chatAbierto === false && <AvisoChatCerrado />}
              {chatAbierto && (
                <>
                  <MascotaChat ocupado={busy} escribiendo={escribiendo} />
                  <ChatInput onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel} modelVision={modelVision}
                    placeholder={t('replyPlaceholder')} webSearch={webSearch} onToggleWeb={() => setWebSearch((v) => !v)} contextUso={usoCtx}
                    nivelesRazonar={nivelesDe(modelInfo[model])} razonar={razonar} onRazonar={elegirRazonar}
                    avisoCuota={avisoCuota} onCerrarAviso={() => setAvisoCuota(null)} commands={comandos} />
                  <p className="chat-disclaimer">
                    {t('disclaimer')}
                  </p>
                </>
              )}
            </div>
          </>
        )}

        {toast && (
          <div className={`chat-toast ${toast.leaving ? 'is-leaving' : ''}`}>{toast.text}</div>
        )}
      </main>
      </AbrirArchivo.Provider>

      {archivoAbierto && <PanelArchivo archivo={archivoAbierto} onClose={cerrarArchivo} />}

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
    </>
  );
}
