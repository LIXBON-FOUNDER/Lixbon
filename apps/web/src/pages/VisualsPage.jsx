// VisualsPage.jsx — diseño con el modelo: chat a la izquierda, lienzo a la
// derecha. Cada respuesta con un archivo es una versión; el lienzo la pinta
// en un iframe aislado (sin acceso a la sesión).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useIsCompact } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { descargarBlob } from '../lib/archivos';
import { DISPOSITIVOS, TIPOS, VISUALS_PROMPT, documentoPreview, esSvg, extraerArchivo } from '../lib/visuals';
import { Logo } from '../components/Logo';
import { Sidebar } from '../components/Sidebar';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { VerifyBanner } from '../components/VerifyBanner';
import { IconCheck, IconCopy, IconDownload, IconMenu } from '../components/Icons';

const CONTEXT_WINDOW = 30;
const AVISO_VACIO = 'El modelo no devolvió nada. Prueba a reformular o a cambiar de modelo.';

/** El texto de la respuesta sin el bloque del archivo (que vive en el lienzo). */
function sinArchivo(texto) {
  return (texto || '').replace(/```file:[^\n`]+\n[\s\S]*?(?:\n```|$)/g, '').trim();
}

function VersionChip({ n, name, activa, onClick }) {
  return (
    <button className={`vis-version ${activa ? 'is-active' : ''}`} onClick={onClick} title={name}>
      v{n}
    </button>
  );
}

export default function VisualsPage() {
  const { user, loading, logout } = useAuth();
  const confirmar = useConfirmar();
  const { id: routeConvId } = useParams();
  const navigate = useNavigate();
  const compact = useIsCompact();

  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [title, setTitle] = useState(null);
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tipo, setTipo] = useState(null);
  const [version, setVersion] = useState(null);   // índice en `versiones`; null = la última
  const [dispositivo, setDispositivo] = useState('escritorio');
  const [verCodigo, setVerCodigo] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [panel, setPanel] = useState('lienzo');   // móvil: 'chat' | 'lienzo'
  const abortRef = useRef(null);
  const loadedConvRef = useRef(null);
  const scrollRef = useRef(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get('/api/conversations', { params: { source: 'visuals' } });
      setConversations(res.data.conversations);
    } catch { /* sin sesión */ } finally {
      setConvsLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    const res = await api.get('/v1/models');
    const ids = res.data.data.map((m) => m.id).filter((id) => !String(id).startsWith('error:'));
    setModels(ids);
    setModelInfo(Object.fromEntries(res.data.data.map((m) => [m.id, {
      num_ctx: m.num_ctx, capabilities: m.capabilities || [], name: m.name || m.id,
    }])));
    setModel((current) => current || ids[0] || '');
    return ids;
  }, []);

  useEffect(() => {
    if (!user) { setConvsLoading(false); return; }
    loadConversations();
    loadModels().catch(() => setModels([]));
  }, [user, loadConversations, loadModels]);

  useEffect(() => {
    if (!routeConvId) {
      loadedConvRef.current = null;
      setMessages([]);
      setTitle(null);
      setVersion(null);
      return;
    }
    if (!user || loadedConvRef.current === routeConvId) return;
    loadedConvRef.current = routeConvId;
    api.get(`/api/conversations/${routeConvId}/messages`)
      .then((res) => {
        setMessages(res.data.messages.map((m) => ({ role: m.role, content: m.content })));
        setTitle(res.data.conversation?.title || null);
        setVersion(null);
      })
      .catch(() => navigate('/visuals', { replace: true }));
  }, [routeConvId, user, navigate]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── Versiones: cada respuesta con archivo ─────────────────────────────
  const versiones = useMemo(() => {
    const out = [];
    messages.forEach((m, i) => {
      if (m.role !== 'assistant') return;
      const archivo = extraerArchivo(m.content);
      if (archivo && (archivo.cerrado || !(busy && i === messages.length - 1))) out.push({ ...archivo, indice: i });
    });
    return out;
  }, [messages, busy]);

  const generando = busy && messages.length > 0 && !!extraerArchivo(messages[messages.length - 1]?.content)
    && !extraerArchivo(messages[messages.length - 1]?.content).cerrado;
  const actual = versiones.length ? versiones[version == null ? versiones.length - 1 : Math.min(version, versiones.length - 1)] : null;
  const doc = useMemo(() => documentoPreview(actual), [actual]);

  // ── Enviar ─────────────────────────────────────────────────────────────
  const send = async (texto, images = []) => {
    if (!user) { navigate('/auth?mode=register'); return; }
    let chosenModel = model;
    if (!chosenModel) {
      try { chosenModel = (await loadModels())[0] || ''; } catch { /* abajo */ }
      if (!chosenModel) return;
    }
    const text = tipo && messages.length === 0 ? `${tipo.prefijo}${texto}` : texto;
    const convId = routeConvId || crypto.randomUUID();
    const isFirst = messages.length === 0;
    const history = [...messages.slice(-CONTEXT_WINDOW), { role: 'user', content: text, ...(images.length ? { images } : {}) }];
    if (!routeConvId) {
      loadedConvRef.current = convId;
      navigate(`/visuals/${convId}`, { replace: true });
    }
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    setVersion(null);
    setPanel('lienzo');
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
        signal: abort.signal,
        system: VISUALS_PROMPT,
        source: 'visuals',
        webSearch: 'off',  // diseñar no necesita internet; ahorra la llamada del planificador
        onDelta: (delta) => patchLast((last) => ({ ...last, content: last.content + delta })),
        onReasoning: (delta) => patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta })),
        onFinish: (reason, chunk) => {
          if (chunk?.lixbon_event?.type === 'empty') patchLast((last) => ({ ...last, content: `⚠️ ${AVISO_VACIO}`, error: true }));
        },
      });
      patchLast((last) => (last.content ? last : { ...last, content: `⚠️ ${AVISO_VACIO}`, error: true }));
      if (isFirst) {
        try {
          const res = await api.post(`/api/conversations/${convId}/generate-title`);
          setTitle(res.data.title);
        } catch { /* sin título */ }
      }
      loadConversations();
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages((prev) => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)));
        return;
      }
      patchLast((last) => ({ ...last, content: last.content || `⚠️ ${err.message}`, error: !last.content }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  // ── Acciones del lienzo ────────────────────────────────────────────────
  const descargar = () => {
    if (!actual) return;
    const mime = esSvg(actual.name) ? 'image/svg+xml' : 'text/html';
    descargarBlob(new Blob([actual.code], { type: `${mime};charset=utf-8` }), actual.name);
  };
  const copiar = async () => {
    if (!actual) return;
    try {
      await navigator.clipboard.writeText(actual.code);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { /* sin portapapeles */ }
  };
  const abrir = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const renameConversation = async (id, newTitle) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    if (id === routeConvId) setTitle(newTitle);
    try { await api.patch(`/api/conversations/${id}`, { title: newTitle }); } catch { loadConversations(); }
  };
  const deleteConversation = async (id) => {
    const ok = await confirmar({ titulo: '¿Eliminar este diseño?', texto: 'Se borrarán la conversación y sus versiones.', etiqueta: 'Eliminar' });
    if (!ok) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === routeConvId) navigate('/visuals');
    try { await api.delete(`/api/conversations/${id}`); } catch { loadConversations(); }
  };
  const handleLogout = async () => {
    const ok = await confirmar({ titulo: '¿Cerrar sesión?', texto: 'Tendrás que volver a iniciar sesión para ver tus diseños.', etiqueta: 'Cerrar sesión', peligro: false });
    if (!ok) return;
    await logout();
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
  const anchoDispositivo = DISPOSITIVOS.find((d) => d.id === dispositivo)?.ancho || 0;

  return (
    <div className="chat-shell vis-shell">
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
        historyBase="/visuals"
        newPath="/visuals"
        seccion="visuals"
      />
      {compact && drawerOpen && <div className="sidebar-scrim" onClick={closeDrawer} aria-hidden="true" />}

      <main className="chat-main vis-main">
        <header className="chat-header vis-header">
          <button className="icon-btn chat-header__menu" onClick={() => setDrawerOpen(true)} aria-label="Abrir panel" aria-controls="sidebar-drawer">
            <IconMenu />
          </button>
          <h1 className="chat-header__title">{title || (empty ? 'Visuals' : 'Diseño sin título')}</h1>
          {compact && !empty && (
            <div className="vis-panel-toggle">
              <button className={panel === 'chat' ? 'is-active' : ''} onClick={() => setPanel('chat')}>Chat</button>
              <button className={panel === 'lienzo' ? 'is-active' : ''} onClick={() => setPanel('lienzo')}>Lienzo</button>
            </div>
          )}
          {!user && <Link to="/auth" className="pill-btn pill-btn--primary chat-header__share">Iniciar sesión</Link>}
        </header>
        <VerifyBanner />

        {empty ? (
          <div className="vis-hero">
            <div className="vis-hero__inner">
              <h2 className="vis-hero__title">¿Qué diseñamos?</h2>
              <p className="vis-hero__lead">Describe lo que quieres y el modelo lo construye; luego lo afinas hablando con él.</p>
              <div className="vis-tipos">
                {TIPOS.map((t) => (
                  <button key={t.id} className={`vis-tipo ${tipo?.id === t.id ? 'is-active' : ''}`} onClick={() => setTipo(tipo?.id === t.id ? null : t)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="vis-hero__input">
                <ChatInput onSend={send} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  placeholder={tipo ? tipo.hint : 'Una landing para mi cafetería, un dashboard de ventas, un logo para…'} />
              </div>
            </div>
          </div>
        ) : (
          <div className={`vis-split ${compact ? `is-${panel}` : ''}`}>
            <section className="vis-chat">
              <div className="chat-scroll" ref={scrollRef}>
                <div className="chat-thread vis-thread">
                  {messages.map((m, i) => (
                    m.role === 'user' ? (
                      <div key={i} className="msg msg--user">{m.content}</div>
                    ) : (
                      <div key={i} className={`msg msg--assistant ${m.error ? 'msg--error' : ''}`}>
                        {(() => {
                          const archivo = extraerArchivo(m.content);
                          const n = versiones.findIndex((v) => v.indice === i);
                          const cuerpo = sinArchivo(m.content);
                          return (
                            <>
                              {cuerpo ? <Markdown streaming={busy && i === messages.length - 1}>{cuerpo}</Markdown>
                                : (!archivo && <span className="msg__thinking">Pensando…</span>)}
                              {archivo && n >= 0 && (
                                <button className={`vis-version-chip ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPanel('lienzo'); }}>
                                  v{n + 1} · {archivo.name}
                                </button>
                              )}
                              {archivo && n < 0 && <span className="vis-version-chip is-building">construyendo {archivo.name}… {archivo.code.split('\n').length} líneas</span>}
                            </>
                          );
                        })()}
                      </div>
                    )
                  ))}
                </div>
              </div>
              <div className="chat-composer vis-composer">
                <ChatInput onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  placeholder="Pide un cambio: «más aire en el hero», «versión oscura», «añade testimonios»…" />
              </div>
            </section>

            <section className="vis-canvas">
              <div className="vis-toolbar">
                <div className="vis-toolbar__group">
                  {versiones.map((v, n) => (
                    <VersionChip key={v.indice} n={n + 1} name={v.name} activa={actual?.indice === v.indice} onClick={() => setVersion(n)} />
                  ))}
                  {generando && <span className="vis-version is-building">generando…</span>}
                </div>
                <div className="vis-toolbar__group">
                  {DISPOSITIVOS.map((d) => (
                    <button key={d.id} className={`vis-tool ${dispositivo === d.id ? 'is-active' : ''}`} onClick={() => setDispositivo(d.id)}>{d.label}</button>
                  ))}
                </div>
                <div className="vis-toolbar__group">
                  <button className={`vis-tool ${verCodigo ? 'is-active' : ''}`} onClick={() => setVerCodigo((v) => !v)} disabled={!actual}>Código</button>
                  <button className="vis-tool" onClick={copiar} disabled={!actual} title="Copiar código">{copiado ? <IconCheck size={14} /> : <IconCopy size={14} />}</button>
                  <button className="vis-tool" onClick={abrir} disabled={!actual} title="Abrir en una pestaña">↗</button>
                  <button className="vis-tool vis-tool--primary" onClick={descargar} disabled={!actual}><IconDownload size={14} /> Descargar</button>
                </div>
              </div>
              <div className="vis-stage">
                {actual ? (
                  verCodigo ? (
                    <pre className="vis-code"><code>{actual.code}</code></pre>
                  ) : (
                    <div className="vis-frame" style={anchoDispositivo ? { width: anchoDispositivo } : undefined}>
                      <iframe title="Vista previa" sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={doc} />
                    </div>
                  )
                ) : (
                  <div className="vis-stage__empty">
                    {generando ? 'El modelo está escribiendo el diseño…' : 'La vista previa aparecerá aquí.'}
                  </div>
                )}
                {generando && actual && <div className="vis-stage__badge">Nueva versión en camino…</div>}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
