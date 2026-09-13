// VisualsPage.jsx — diseño con el modelo: chat a la izquierda, lienzo a la
// derecha. Cada respuesta con archivos es una versión (con una o varias
// páginas); el lienzo la pinta en un iframe aislado (sin acceso a la sesión)
// y permite seleccionar elementos y retocarlos sin pasar por el modelo.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useIsCompact } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { descargarBlob } from '../lib/archivos';
import {
  DESIGN_SYSTEMS, TAMANOS_IMAGEN, TIPO_IMAGEN, TIPOS, aplicarOps, designSystemPersonalizado,
  documentoPreview, esConversacionDeImagenes, esSvg, extraerArchivo, extraerArchivos, extraerImagen, promptVisuals,
} from '../lib/visuals';
import { Logo } from '../components/Logo';
import { Sidebar } from '../components/Sidebar';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { VerifyBanner } from '../components/VerifyBanner';
import { Board, DesignSystemPicker, Inspector } from '../components/VisualsPanels';
import { IconCheck, IconCopy, IconDownload, IconExternal, IconMenu, IconPanel, IconLayers } from '../components/Icons';
import { MensajeError, Razonamiento } from '../components/Mensajes';

const CONTEXT_WINDOW = 30;
const AVISO_VACIO = 'El modelo no devolvió nada. Prueba a reformular o a cambiar de modelo.';

/** El texto de la respuesta sin bloques de código: los archivos viven en el
 *  lienzo y el chat solo cuenta qué está haciendo el modelo. */
function sinArchivos(texto) {
  return (texto || '').replace(/(^|\n)[^\n]*\n?```[^\n`]*\n[\s\S]*?(?:\n```|$)/g, '$1').trim();
}

// Lo que no persiste el servidor (design system elegido, retoques manuales)
// vive en el navegador, por conversación.
const local = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const dsDesde = (guardado) => {
  if (!guardado) return DESIGN_SYSTEMS[0];
  if (guardado.custom) return designSystemPersonalizado(guardado.form);
  return DESIGN_SYSTEMS.find((d) => d.id === guardado.id) || DESIGN_SYSTEMS[0];
};
const dsGuardable = (ds) => (ds.custom ? { custom: true, form: ds.form } : { id: ds.id });

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
  const [pagina, setPagina] = useState(null);     // nombre de archivo dentro de la versión
  const [vista, setVista] = useState('pagina');   // 'pagina' | 'lienzo'
  const [disposicion, setDisposicion] = useState('ambos'); // 'ambos' | 'lienzo' | 'chat'
  const [cargando, setCargando] = useState(false);
  const [verCodigo, setVerCodigo] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [panel, setPanel] = useState('lienzo');   // móvil: 'chat' | 'lienzo'
  const [imagenes, setImagenes] = useState({ available: false, model: null });
  const [tamano, setTamano] = useState(TAMANOS_IMAGEN[0]);
  const [designSystem, setDesignSystem] = useState(() => dsDesde(local.get('lixbon.visuals.ds', null)));
  const [inspeccion, setInspeccion] = useState(false);
  const [seleccion, setSeleccion] = useState(null);
  const [ops, setOps] = useState({});             // `${indice}:${pagina}` → [{selector, text?, style?}]
  const [prefill, setPrefill] = useState('');
  const abortRef = useRef(null);
  const loadedConvRef = useRef(null);
  const scrollRef = useRef(null);
  const frameRef = useRef(null);

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
    api.get('/api/images/status').then((r) => setImagenes(r.data)).catch(() => {});
  }, [user, loadConversations, loadModels]);

  // ── Conversación según la ruta (+ lo guardado en el navegador) ────────
  useEffect(() => {
    if (!routeConvId) {
      loadedConvRef.current = null;
      setMessages([]);
      setTitle(null);
      setVersion(null);
      setPagina(null);
      setOps({});
      setSeleccion(null);
      return;
    }
    setOps(local.get(`lixbon.visuals.ops.${routeConvId}`, {}));
    const ds = local.get(`lixbon.visuals.ds.${routeConvId}`, null);
    if (ds) setDesignSystem(dsDesde(ds));
    if (!user || loadedConvRef.current === routeConvId) return;
    loadedConvRef.current = routeConvId;
    api.get(`/api/conversations/${routeConvId}/messages`)
      .then((res) => {
        setMessages(res.data.messages.map((m) => ({ role: m.role, content: m.content })));
        setTitle(res.data.conversation?.title || null);
        setVersion(null);
        setPagina(null);
      })
      .catch(() => navigate('/visuals', { replace: true }));
  }, [routeConvId, user, navigate]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const elegirDesignSystem = (ds) => {
    setDesignSystem(ds);
    local.set('lixbon.visuals.ds', dsGuardable(ds));
    if (routeConvId) local.set(`lixbon.visuals.ds.${routeConvId}`, dsGuardable(ds));
  };

  // ── Versiones: cada respuesta con archivos (o imagen generada) ─────────
  const modoImagen = tipo?.id === 'imagen' || esConversacionDeImagenes(messages);
  const versiones = useMemo(() => {
    const out = [];
    messages.forEach((m, i) => {
      if (m.role !== 'assistant') return;
      const imagen = extraerImagen(m.content);
      if (imagen) { out.push({ kind: 'image', name: `${imagen.alt || 'imagen'}.jpg`, src: imagen.src, indice: i }); return; }
      const enCurso = busy && i === messages.length - 1;
      const archivos = extraerArchivos(m.content).filter((a) => a.cerrado || !enCurso);
      if (!archivos.length) return;
      // Las páginas que esta respuesta no reescribió se heredan de la versión anterior.
      const previa = out.length ? out[out.length - 1] : null;
      const heredadas = previa?.kind === 'file' ? previa.files.filter((f) => !archivos.some((a) => a.name === f.name)) : [];
      const files = [...archivos, ...heredadas].sort((a, b) => (a.name === 'index.html' ? -1 : b.name === 'index.html' ? 1 : 0));
      out.push({ kind: 'file', files, name: files[0].name, indice: i, nuevas: archivos.map((a) => a.name) });
    });
    return out;
  }, [messages, busy]);

  const ultimoContenido = messages[messages.length - 1]?.content;
  const generando = busy && !!extraerArchivo(ultimoContenido) && !extraerArchivo(ultimoContenido).cerrado;
  const actual = versiones.length ? versiones[version == null ? versiones.length - 1 : Math.min(version, versiones.length - 1)] : null;
  const paginaActual = actual?.kind === 'file'
    ? (actual.files.find((f) => f.name === pagina) || actual.files[0])
    : null;
  const claveOps = actual && paginaActual ? `${actual.indice}:${paginaActual.name}` : '';
  const opsActuales = useMemo(() => ops[claveOps] || [], [ops, claveOps]);
  const doc = useMemo(() => documentoPreview(paginaActual, opsActuales), [paginaActual, opsActuales]);
  useEffect(() => { if (doc) setCargando(true); }, [doc]);

  // ── Mensajes del iframe (selección, navegación entre páginas) ──────────
  useEffect(() => {
    const onMessage = (e) => {
      const m = e.data || {};
      if (m.type === 'lixbon:select') setSeleccion({ selector: m.selector, tag: m.tag, text: m.text, html: m.html, styles: m.styles });
      if (m.type === 'lixbon:navigate' && actual?.kind === 'file' && actual.files.some((f) => f.name === m.page)) {
        setPagina(m.page);
        setVista('pagina');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [actual]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:inspect', on: inspeccion }, '*');
    if (!inspeccion) setSeleccion(null);
  }, [inspeccion, doc]);

  const aplicarOp = (op) => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:apply', ...op }, '*');
    setOps((prev) => {
      const next = { ...prev, [claveOps]: [...(prev[claveOps] || []), op] };
      if (routeConvId) local.set(`lixbon.visuals.ops.${routeConvId}`, next);
      return next;
    });
  };

  const pedirAlModelo = (sel) => {
    setPrefill(`Sobre este elemento de ${paginaActual?.name || 'la página'} (<${sel.tag}>): ${sel.html.slice(0, 300)}\n\nCambio: `);
    setInspeccion(false);
    setPanel('chat');
  };

  // ── Imagen: una petición al nodo de difusión, sin stream ──────────────
  const generarImagen = async (prompt) => {
    const convId = routeConvId || crypto.randomUUID();
    if (!routeConvId) {
      loadedConvRef.current = convId;
      navigate(`/visuals/${convId}`, { replace: true });
    }
    setMessages((prev) => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '', generandoImagen: true }]);
    setBusy(true);
    setVersion(null);
    setPanel('lienzo');
    try {
      const r = await api.post('/api/images/generate', {
        prompt, width: tamano.width, height: tamano.height, conversation_id: convId, source: 'visuals',
      }, { timeout: 600000 });
      const src = `data:${r.data.mime || 'image/jpeg'};base64,${r.data.image_base64}`;
      setMessages((prev) => {
        const next = prev.slice();
        next[next.length - 1] = { role: 'assistant', content: `![${prompt.slice(0, 80)}](${src})` };
        return next;
      });
      loadConversations();
    } catch (err) {
      const detalle = err.response?.data?.detail;
      const texto = (detalle && (detalle.message || detalle)) || err.message || 'No se pudo generar la imagen';
      setMessages((prev) => {
        const next = prev.slice();
        next[next.length - 1] = { role: 'assistant', content: typeof texto === 'string' ? texto : JSON.stringify(texto), error: true };
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  // ── Enviar ─────────────────────────────────────────────────────────────
  const send = async (texto, images = []) => {
    if (!user) { navigate('/auth?mode=register'); return; }
    setPrefill('');
    if (modoImagen) { await generarImagen(texto); return; }
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
      local.set(`lixbon.visuals.ds.${convId}`, dsGuardable(designSystem));
    }
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    setVersion(null);
    setVista('pagina');
    setInspeccion(false);
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
        system: promptVisuals(designSystem),
        source: 'visuals',
        webSearch: 'off',  // diseñar no necesita internet; ahorra la llamada del planificador
        // Sin razonamiento previo: un HTML largo con thinking acababa entero
        // dentro del razonamiento y el contenido llegaba vacío.
        think: false,
        onDelta: (delta) => patchLast((last) => ({ ...last, content: last.content + delta })),
        onReasoning: (delta) => patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta })),
        onFinish: (reason) => {
          if (reason === 'length') patchLast((last) => ({ ...last, aviso: 'La respuesta se cortó por longitud: pide «continúa» o divide el encargo.' }));
        },
      });
      patchLast((last) => {
        if (last.content.trim()) return last;
        // El modelo lo escribió todo en el razonamiento: se rescata de ahí.
        if (last.reasoning && extraerArchivos(last.reasoning).length) return { ...last, content: last.reasoning, reasoning: '' };
        return { ...last, content: AVISO_VACIO, error: true };
      });
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
      patchLast((last) => ({ ...last, content: last.content || err.message, error: !last.content }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  // ── Acciones del lienzo ────────────────────────────────────────────────
  const codigoFinal = (archivo) => (esSvg(archivo.name) ? archivo.code : aplicarOps(archivo.code, ops[`${actual.indice}:${archivo.name}`] || []));
  const descargar = async () => {
    if (!actual) return;
    if (actual.kind === 'image') {
      descargarBlob(await (await fetch(actual.src)).blob(), actual.name);
      return;
    }
    for (const archivo of actual.files) {
      const mime = esSvg(archivo.name) ? 'image/svg+xml' : 'text/html';
      descargarBlob(new Blob([codigoFinal(archivo)], { type: `${mime};charset=utf-8` }), archivo.name);
    }
  };
  const copiar = async () => {
    if (!paginaActual) return;
    try {
      await navigator.clipboard.writeText(codigoFinal(paginaActual));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { /* sin portapapeles */ }
  };
  const abrir = () => {
    if (!actual) return;
    if (actual.kind === 'image') { window.open(actual.src, '_blank', 'noopener'); return; }
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
  const paginas = actual?.kind === 'file' ? actual.files : [];
  const alternar = (que) => setDisposicion((d) => (d === que ? 'ambos' : que));

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
          {!empty && !compact && (
            <div className="vis-panel-toggle">
              <button className={disposicion === 'chat' ? 'is-active' : ''} onClick={() => alternar('chat')} title="Solo el chat"><IconPanel size={14} /> Chat</button>
              <button className={disposicion === 'lienzo' ? 'is-active' : ''} onClick={() => alternar('lienzo')} title="Solo el lienzo"><IconLayers size={14} /> Lienzo</button>
            </div>
          )}
          {!empty && !modoImagen && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
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
              <p className="vis-hero__lead">Describe lo que quieres y el modelo lo construye; luego lo afinas hablando con él o tocándolo en el lienzo.</p>
              <div className="vis-tipos">
                {[...TIPOS, TIPO_IMAGEN].map((t) => (
                  <button
                    key={t.id}
                    className={`vis-tipo ${tipo?.id === t.id ? 'is-active' : ''}`}
                    disabled={t.id === 'imagen' && !imagenes.available}
                    title={t.id === 'imagen' && !imagenes.available ? 'Ningún nodo genera imágenes ahora mismo' : undefined}
                    onClick={() => setTipo(tipo?.id === t.id ? null : t)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tipo?.id === 'imagen' ? (
                <div className="vis-tamanos">
                  {TAMANOS_IMAGEN.map((t) => (
                    <button key={t.id} className={`vis-tool ${tamano.id === t.id ? 'is-active' : ''}`} onClick={() => setTamano(t)}>{t.label}</button>
                  ))}
                  <span className="vis-tamanos__modelo">{imagenes.model}</span>
                </div>
              ) : (
                <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} />
              )}
              <div className="vis-hero__input">
                <ChatInput onSend={send} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  placeholder={tipo ? tipo.hint : 'Una landing para mi cafetería, un dashboard de ventas, un logo para…'} />
              </div>
            </div>
          </div>
        ) : (
          <div className={`vis-split ${compact ? `is-${panel}` : disposicion !== 'ambos' ? `is-solo-${disposicion}` : ''}`}>
            <section className="vis-chat">
              <div className="chat-scroll" ref={scrollRef}>
                <div className="chat-thread vis-thread">
                  {messages.map((m, i) => (
                    m.role === 'user' ? (
                      <div key={i} className="msg msg--user">{m.content}</div>
                    ) : (
                      <div key={i} className={`msg msg--assistant ${m.error ? 'msg--error' : ''}`}>
                        {(() => {
                          const n = versiones.findIndex((v) => v.indice === i);
                          if (m.generandoImagen) return <span className="msg__thinking">Generando la imagen… (la primera tarda más: carga el modelo)</span>;
                          if (m.error) return <MensajeError>{m.content}</MensajeError>;
                          const imagen = extraerImagen(m.content);
                          if (imagen) {
                            return (
                              <button className={`vis-thumb ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPanel('lienzo'); }}>
                                <img src={imagen.src} alt={imagen.alt} />
                                <span>v{n + 1}</span>
                              </button>
                            );
                          }
                          const archivos = extraerArchivos(m.content);
                          const cuerpo = sinArchivos(m.content);
                          const abierto = archivos.find((a) => !a.cerrado);
                          const activo = busy && i === messages.length - 1;
                          return (
                            <>
                              {m.reasoning && <Razonamiento texto={m.reasoning} activo={activo && !m.content} />}
                              {cuerpo ? <Markdown streaming={activo}>{cuerpo}</Markdown>
                                : (!archivos.length && !m.reasoning && <span className="msg__thinking">Pensando…</span>)}
                              {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                              {n >= 0 && (
                                <button className={`vis-version-chip ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPagina(null); setPanel('lienzo'); }}>
                                  v{n + 1} · {versiones[n].nuevas.join(', ')}
                                </button>
                              )}
                              {abierto && activo && (
                                <div className="vis-trabajo">
                                  <span className="vis-trabajo__dot" />
                                  <span>Escribiendo <strong>{abierto.name}</strong>{archivos.length > 1 ? ` (${archivos.length - 1} lista${archivos.length > 2 ? 's' : ''})` : ''}…</span>
                                  <span className="vis-trabajo__meta">{abierto.code.split('\n').length} líneas</span>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )
                  ))}
                </div>
              </div>
              <div className="chat-composer vis-composer">
                {modoImagen && (
                  <div className="vis-tamanos vis-tamanos--compacto">
                    {TAMANOS_IMAGEN.map((t) => (
                      <button key={t.id} className={`vis-tool ${tamano.id === t.id ? 'is-active' : ''}`} onClick={() => setTamano(t)}>{t.label}</button>
                    ))}
                  </div>
                )}
                <ChatInput key={prefill} initialText={prefill} onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  placeholder={modoImagen ? 'Otra imagen: describe qué cambia…' : 'Pide un cambio: «más aire en el hero», «versión oscura», «añade testimonios»…'} />
              </div>
            </section>

            <section className="vis-canvas">
              <div className="vis-toolbar">
                <div className="vis-toolbar__group">
                  {versiones.map((v, n) => (
                    <button key={v.indice} className={`vis-version ${actual?.indice === v.indice ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPagina(null); }} title={v.name}>v{n + 1}</button>
                  ))}
                  {generando && <span className="vis-version is-building">generando…</span>}
                </div>
                {paginas.length > 1 && (
                  <div className="vis-toolbar__group vis-paginas">
                    <button className={`vis-tool ${vista === 'lienzo' ? 'is-active' : ''}`} onClick={() => { setVista('lienzo'); setInspeccion(false); }}><IconLayers size={13} /> Lienzo ({paginas.length})</button>
                    {paginas.map((f) => (
                      <button key={f.name} className={`vis-tool ${vista === 'pagina' && paginaActual?.name === f.name ? 'is-active' : ''}`} onClick={() => { setPagina(f.name); setVista('pagina'); }}>{f.name.replace(/\.html$/, '')}</button>
                    ))}
                  </div>
                )}
                <div className="vis-toolbar__group">
                  {!modoImagen && <button className={`vis-tool ${inspeccion ? 'is-active' : ''}`} onClick={() => { setInspeccion((v) => !v); setVista('pagina'); setVerCodigo(false); }} disabled={!paginaActual || esSvg(paginaActual.name)} title="Seleccionar elementos en el lienzo">Seleccionar</button>}
                  {!modoImagen && <button className={`vis-tool ${verCodigo ? 'is-active' : ''}`} onClick={() => { setVerCodigo((v) => !v); setInspeccion(false); }} disabled={!paginaActual}>Código</button>}
                  {!modoImagen && <button className="vis-tool" onClick={copiar} disabled={!paginaActual} title="Copiar código">{copiado ? <IconCheck size={14} /> : <IconCopy size={14} />}</button>}
                  <button className="vis-tool" onClick={abrir} disabled={!actual} title="Abrir en una pestaña"><IconExternal size={14} /></button>
                  <button className="vis-tool vis-tool--primary" onClick={descargar} disabled={!actual}><IconDownload size={14} /> Descargar{paginas.length > 1 ? ` (${paginas.length})` : ''}</button>
                </div>
              </div>
              <div className="vis-stage">
                {actual ? (
                  actual.kind === 'image' ? (
                    <img className="vis-imagen" src={actual.src} alt={actual.name} />
                  ) : vista === 'lienzo' ? (
                    <Board paginas={paginas} documento={(f) => documentoPreview(f, ops[`${actual.indice}:${f.name}`] || [])}
                      onAbrir={(name) => { setPagina(name); setVista('pagina'); }} />
                  ) : verCodigo ? (
                    <pre className="vis-code"><code>{codigoFinal(paginaActual)}</code></pre>
                  ) : (
                    <div className="vis-frame">
                      <iframe ref={frameRef} title="Vista previa" sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={doc}
                        onLoad={() => { setCargando(false); frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:inspect', on: inspeccion }, '*'); }} />
                      {cargando && <div className="vis-stage__loading"><span>Renderizando {paginaActual?.name}…</span></div>}
                    </div>
                  )
                ) : (
                  <div className="vis-stage__empty">
                    {generando ? (
                      <span className="vis-trabajo"><span className="vis-trabajo__dot" />El modelo está escribiendo el diseño… se renderizará al terminar</span>
                    ) : busy && modoImagen ? 'Generando la imagen…' : 'La vista previa aparecerá aquí.'}
                  </div>
                )}
                {generando && actual && <div className="vis-stage__badge">Nueva versión en camino…</div>}
                {inspeccion && (
                  <Inspector seleccion={seleccion} onAplicar={aplicarOp} onPedir={pedirAlModelo} onCerrar={() => setSeleccion(null)} />
                )}
                {inspeccion && !seleccion && <div className="vis-stage__badge">Haz clic en un elemento para editarlo</div>}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
