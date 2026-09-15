// VisualsPage.jsx — Visuals: galería de diseños (/visuals) y editor
// (/visuals/:id). En el editor, el chat es un panel lateral plegable y el
// lienzo pinta cada página en un iframe aislado; se puede seleccionar y
// retocar elementos sin pasar por el modelo.
import { useSeo } from '../lib/seo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useDismiss } from '../hooks/useDismiss';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { descargarBlob } from '../lib/archivos';
import { crearZip } from '../lib/zip';
import {
  DESIGN_SYSTEMS, TAMANOS_IMAGEN, TIPO_IMAGEN, TIPOS, aplicarOps, construirVersiones, designSystemPersonalizado,
  documentoPreview, documentoPresentacion, esConversacionDeImagenes, esSvg, extraerArchivo, extraerArchivos, extraerEdiciones, extraerImagen, promptVisuals,
  tiempoRelativo,
} from '../lib/visuals';
import { Logo } from '../components/Logo';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { VerifyBanner } from '../components/VerifyBanner';
import { Board, DesignSystemPicker, Inspector } from '../components/VisualsPanels';
import { Desplegable } from '../components/Desplegable';
import { MensajeError, Razonamiento } from '../components/Mensajes';
import {
  IconArrowLeft, IconCheck, IconChevron, IconCode, IconCopy, IconDots, IconDownload, IconExternal, IconFile, IconHistory,
  IconLayers, IconPanel, IconPencil, IconPointer, IconShare, IconTrash, IconX,
} from '../components/Icons';

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

function Menu({ abierto, onCerrar, children, className = '' }) {
  const ref = useRef(null);
  useDismiss(abierto, ref, onCerrar);
  return <div className={`vis-menu ${className}`} ref={ref}>{children}</div>;
}

export default function VisualsPage() {
  useSeo({ title: 'Visuals: diseña webs, dashboards y prototipos con IA', description: 'Describe una landing, un dashboard, un email, un logo o un prototipo y el modelo lo construye en HTML; afínalo en el lienzo, compártelo por enlace o conviértelo en un proyecto React.', path: '/visuals', noindex: window.location.pathname !== '/visuals' });
  const { user, loading } = useAuth();
  const confirmar = useConfirmar();
  const { id: routeConvId } = useParams();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [title, setTitle] = useState(null);
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [tipo, setTipo] = useState(null);
  const [version, setVersion] = useState(null);   // índice en `versiones`; null = la última
  const [pagina, setPagina] = useState(null);     // nombre de archivo dentro de la versión
  const [vista, setVista] = useState('pagina');   // 'pagina' | 'lienzo'
  const [chatAbierto, setChatAbierto] = useState(true);
  const [verCodigo, setVerCodigo] = useState(false);
  const [copiado, setCopiado] = useState('');
  const [cargando, setCargando] = useState(false);
  const [imagenes, setImagenes] = useState({ available: false, model: null });
  const [tamano, setTamano] = useState(TAMANOS_IMAGEN[0]);
  const [designSystem, setDesignSystem] = useState(() => dsDesde(local.get('lixbon.visuals.ds', null)));
  const [inspeccion, setInspeccion] = useState(false);
  const [seleccion, setSeleccion] = useState(null);
  const [ops, setOps] = useState({});             // `${indice}:${pagina}` → [{selector, text?, style?}]
  const [prefill, setPrefill] = useState('');
  const [menu, setMenu] = useState(null);         // 'paginas' | 'historial' | 'compartir'
  const [enlace, setEnlace] = useState(null);     // token de compartir
  const [editandoTitulo, setEditandoTitulo] = useState(false);
  const abortRef = useRef(null);
  const loadedConvRef = useRef(null);
  const scrollRef = useRef(null);
  const frameRef = useRef(null);

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
    setMenu(null);
    setEnlace(null);
    if (!routeConvId) {
      loadedConvRef.current = null;
      setMessages([]);
      setTitle(null);
      setVersion(null);
      setPagina(null);
      setOps({});
      setSeleccion(null);
      setTipo(null);
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

  // ── Versiones y página actual ──────────────────────────────────────────
  const modoImagen = tipo?.id === 'imagen' || esConversacionDeImagenes(messages);
  const versiones = useMemo(() => construirVersiones(messages, busy ? messages.length - 1 : -1), [messages, busy]);
  const ultimoContenido = messages[messages.length - 1]?.content;
  const generando = busy && !!extraerArchivo(ultimoContenido) && !extraerArchivo(ultimoContenido).cerrado;
  const indiceVersion = versiones.length ? (version == null ? versiones.length - 1 : Math.min(version, versiones.length - 1)) : -1;
  const actual = indiceVersion >= 0 ? versiones[indiceVersion] : null;
  const paginas = useMemo(() => (actual?.kind === 'file' ? actual.files : []), [actual]);
  const paginaActual = paginas.length ? (paginas.find((f) => f.name === pagina) || paginas[0]) : null;
  const claveOps = actual && paginaActual ? `${actual.indice}:${paginaActual.name}` : '';
  const opsActuales = useMemo(() => ops[claveOps] || [], [ops, claveOps]);
  const doc = useMemo(() => documentoPreview(paginaActual, opsActuales), [paginaActual, opsActuales]);
  useEffect(() => { if (doc) setCargando(true); }, [doc]);

  // ── Mensajes del iframe (selección, navegación entre páginas) ──────────
  useEffect(() => {
    const onMessage = (e) => {
      const m = e.data || {};
      if (m.type === 'lixbon:select') setSeleccion({ selector: m.selector, tag: m.tag, text: m.text, html: m.html, styles: m.styles });
      if (m.type === 'lixbon:navigate' && paginas.some((f) => f.name === m.page)) {
        setPagina(m.page);
        setVista('pagina');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [paginas]);

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
    setChatAbierto(true);
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
        if (last.reasoning && (extraerArchivos(last.reasoning).length || extraerEdiciones(last.reasoning).length)) return { ...last, content: last.reasoning, reasoning: '' };
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

  // ── Acciones: código final, compartir, descargar ───────────────────────
  const codigoFinal = (archivo) => (esSvg(archivo.name) ? archivo.code : aplicarOps(archivo.code, ops[`${actual.indice}:${archivo.name}`] || []));
  const marcarCopiado = (que) => { setCopiado(que); setTimeout(() => setCopiado(''), 1800); };
  const descargar = async () => {
    if (!actual) return;
    if (actual.kind === 'image') {
      descargarBlob(await (await fetch(actual.src)).blob(), actual.name);
      return;
    }
    const archivos = actual.files.map((f) => ({ name: f.name, code: codigoFinal(f) }));
    if (archivos.length === 1) {
      const mime = esSvg(archivos[0].name) ? 'image/svg+xml' : 'text/html';
      descargarBlob(new Blob([archivos[0].code], { type: `${mime};charset=utf-8` }), archivos[0].name);
    } else {
      descargarBlob(crearZip(archivos), `${(title || 'diseño').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
    }
    setMenu(null);
  };
  const copiarCodigo = async () => {
    if (!paginaActual) return;
    try { await navigator.clipboard.writeText(codigoFinal(paginaActual)); marcarCopiado('codigo'); } catch { /* sin portapapeles */ }
  };
  const presentar = () => {
    if (!actual) return;
    if (actual.kind === 'image') { window.open(actual.src, '_blank', 'noopener'); return; }
    const html = documentoPresentacion(paginas, paginaActual?.name, tituloVisible);
    // No se revoca: la pestaña navega entre páginas por hash y al volver atrás
    // el blob tiene que seguir vivo.
    window.open(URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), '_blank', 'noopener');
  };
  const copiarEnlace = async () => {
    try {
      const res = await api.post(`/api/conversations/${routeConvId}/share`);
      const url = `${window.location.origin}/s/${res.data.token}`;
      setEnlace(url);
      await navigator.clipboard.writeText(url);
      marcarCopiado('enlace');
    } catch { /* sin permiso o sin sesión */ }
  };
  const quitarEnlace = async () => {
    try { await api.delete(`/api/conversations/${routeConvId}/share`); setEnlace(null); } catch { /* nada */ }
  };
  const copiarComandoCli = async () => {
    try { await navigator.clipboard.writeText(`/visual ${routeConvId}`); marcarCopiado('cli'); } catch { /* nada */ }
  };
  useEffect(() => {
    if (menu !== 'compartir' || !routeConvId) return;
    api.get(`/api/conversations/${routeConvId}/share`)
      .then((r) => setEnlace(r.data.token ? `${window.location.origin}/s/${r.data.token}` : null))
      .catch(() => {});
  }, [menu, routeConvId]);

  const renameConversation = async (id, newTitle) => {
    const limpio = (newTitle || '').trim();
    if (!limpio) return;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: limpio } : c)));
    if (id === routeConvId) setTitle(limpio);
    try { await api.patch(`/api/conversations/${id}`, { title: limpio }); } catch { loadConversations(); }
  };
  const deleteConversation = async (id) => {
    const ok = await confirmar({ titulo: '¿Eliminar este diseño?', texto: 'Se borrarán la conversación y sus versiones.', etiqueta: 'Eliminar' });
    if (!ok) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === routeConvId) navigate('/visuals');
    try { await api.delete(`/api/conversations/${id}`); } catch { loadConversations(); }
  };

  if (loading) {
    return (
      <div className="app-loading">
        <span className="app-loading__logo"><Logo size={19} /></span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  // ── Galería (sin conversación en la ruta) ──────────────────────────────
  if (!routeConvId) {
    return (
      <div className="vis-page">
        <header className="vis-top">
          <Link to="/" className="vis-top__logo" title="Volver al chat"><Logo /></Link>
          <span className="vis-top__seccion">Visuals</span>
          <div className="vis-top__right">
            {user ? <Link to="/account" className="vis-avatar" title={user.name || user.email}>{(user.name || user.email || '?')[0].toUpperCase()}</Link>
              : <Link to="/auth" className="pill-btn pill-btn--primary">Iniciar sesión</Link>}
          </div>
        </header>
        <VerifyBanner />
        <div className="vis-galeria">
          <section className="vis-hero vis-hero--galeria">
            <div className="vis-hero__inner">
              <h2 className="vis-hero__title">¿Qué diseñamos?</h2>
              <p className="vis-hero__lead">Describe lo que quieres y el modelo lo construye; luego lo afinas hablando con él o tocándolo en el lienzo.</p>
              <div className="vis-tipos">
                {[...TIPOS, TIPO_IMAGEN].map((t) => (
                  <button key={t.id} className={`vis-tipo ${tipo?.id === t.id ? 'is-active' : ''}`}
                    disabled={t.id === 'imagen' && !imagenes.available}
                    title={t.id === 'imagen' && !imagenes.available ? 'Ningún nodo genera imágenes ahora mismo' : undefined}
                    onClick={() => setTipo(tipo?.id === t.id ? null : t)}>
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
              ) : null}
              <div className="vis-hero__input">
                <ChatInput onSend={send} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  tools={tipo?.id !== 'imagen' && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
                  placeholder={tipo ? tipo.hint : 'Una landing para mi cafetería, un dashboard de ventas, un logo para…'} />
              </div>
            </div>
          </section>
          {user && (
            <Galeria conversations={conversations} loading={convsLoading}
              onRename={renameConversation} onDelete={deleteConversation} />
          )}
        </div>
      </div>
    );
  }

  // ── Editor ─────────────────────────────────────────────────────────────
  const tituloVisible = title || 'Diseño sin título';
  return (
    <div className="vis-page vis-editor">
      <header className="vis-top">
        <Link to="/visuals" className="icon-btn" title="Todos los diseños"><IconArrowLeft size={17} /></Link>
        <button className={`icon-btn ${chatAbierto ? 'is-active' : ''}`} onClick={() => setChatAbierto((v) => !v)} title={chatAbierto ? 'Ocultar el chat' : 'Mostrar el chat'} aria-pressed={chatAbierto}>
          <IconPanel size={17} />
        </button>
        <div className="vis-titulo">
          {editandoTitulo ? (
            <input className="vis-titulo__input" autoFocus defaultValue={title || ''} placeholder="Nombre del diseño"
              onKeyDown={(e) => { if (e.key === 'Enter') { renameConversation(routeConvId, e.target.value); setEditandoTitulo(false); } if (e.key === 'Escape') setEditandoTitulo(false); }}
              onBlur={(e) => { renameConversation(routeConvId, e.target.value); setEditandoTitulo(false); }} />
          ) : (
            <button className="vis-titulo__nombre" onClick={() => setEditandoTitulo(true)} title="Renombrar el diseño">{tituloVisible}</button>
          )}
          {!modoImagen && (
            <Menu abierto={menu === 'paginas'} onCerrar={() => setMenu(null)}>
              <button className={`vis-chip ${menu === 'paginas' ? 'is-active' : ''}`} onClick={() => setMenu(menu === 'paginas' ? null : 'paginas')} title="Páginas">
                <IconFile size={14} />
                <span>{vista === 'lienzo' ? 'Lienzo' : paginaActual?.name || (paginas.length ? `${paginas.length} páginas` : 'sin páginas aún')}</span>
                <IconChevron size={13} open={menu === 'paginas'} />
              </button>
              <Desplegable abierto={menu === 'paginas'} className="vis-menu__panel vis-menu__panel--paginas">
                  {paginas.length > 1 && (
                    <>
                      <div className="vis-menu__head">Vista</div>
                      <button className={`vis-menu__item ${vista === 'lienzo' ? 'is-active' : ''}`} onClick={() => { setVista('lienzo'); setInspeccion(false); setMenu(null); }}>
                        <IconLayers size={15} /><span className="vis-menu__item-text"><strong>Lienzo</strong><small>las {paginas.length} páginas a la vez</small></span>
                        {vista === 'lienzo' && <IconCheck size={14} />}
                      </button>
                      <div className="vis-menu__sep" />
                    </>
                  )}
                  <div className="vis-menu__head">Páginas</div>
                  {paginas.map((f) => {
                    const activa = vista === 'pagina' && paginaActual?.name === f.name;
                    return (
                      <button key={f.name} className={`vis-menu__item ${activa ? 'is-active' : ''}`} onClick={() => { setPagina(f.name); setVista('pagina'); setMenu(null); }}>
                        <IconFile size={15} /><span className="vis-menu__item-text"><strong>{f.name.replace(/\.(html?|svg)$/, '')}</strong></span>
                        {activa && <IconCheck size={14} />}
                      </button>
                    );
                  })}
                  {!paginas.length && <p className="vis-menu__vacio">Todavía no hay páginas: pídele algo al modelo.</p>}
                  <div className="vis-menu__sep" />
                  <button className="vis-menu__item" onClick={() => { setEditandoTitulo(true); setMenu(null); }}><IconPencil size={15} /><span>Renombrar el diseño</span></button>
                  <Link className="vis-menu__item" to="/visuals"><IconLayers size={15} /><span>Todos los diseños</span></Link>
              </Desplegable>
            </Menu>
          )}
          {versiones.length > 0 && (
            <Menu abierto={menu === 'historial'} onCerrar={() => setMenu(null)}>
              <button className={`vis-chip ${menu === 'historial' ? 'is-active' : ''}`} onClick={() => setMenu(menu === 'historial' ? null : 'historial')} title="Versiones">
                <IconHistory size={14} /><span>v{indiceVersion + 1}</span><IconChevron size={13} open={menu === 'historial'} />
              </button>
              <Desplegable abierto={menu === 'historial'} className="vis-menu__panel">
                  <div className="vis-menu__head">Versiones</div>
                  {versiones.map((v, n) => (
                    <button key={v.indice} className={`vis-menu__item ${indiceVersion === n ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPagina(null); setMenu(null); }}>
                      <span className="vis-menu__check">{indiceVersion === n && <IconCheck size={14} />}</span>
                      <span className="vis-menu__item-text"><strong>Versión {n + 1}</strong><small>{v.kind === 'image' ? 'imagen' : v.nuevas.join(', ')}</small></span>
                    </button>
                  )).reverse()}
              </Desplegable>
            </Menu>
          )}
        </div>

        <div className="vis-top__right">
          {!modoImagen && (
            <div className="vis-seg">
              <button className={`vis-tool ${inspeccion ? 'is-active' : ''}`} onClick={() => { setInspeccion((v) => !v); setVista('pagina'); setVerCodigo(false); }} disabled={!paginaActual || esSvg(paginaActual.name)} title="Seleccionar elementos en el lienzo">
                <IconPointer size={14} /> Seleccionar
              </button>
              <button className={`vis-tool ${verCodigo ? 'is-active' : ''}`} onClick={() => { setVerCodigo((v) => !v); setInspeccion(false); setVista('pagina'); }} disabled={!paginaActual}>
                <IconCode size={14} /> Código
              </button>
            </div>
          )}
          {!modoImagen && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
          <span className="vis-vdiv" />
          <button className="vis-tool" onClick={presentar} disabled={!actual} title="Abrir en una pestaña"><IconExternal size={14} /> Presentar</button>
          <Menu abierto={menu === 'compartir'} onCerrar={() => setMenu(null)}>
            <button className="vis-tool vis-tool--blanco" onClick={() => setMenu(menu === 'compartir' ? null : 'compartir')} disabled={!actual}><IconShare size={14} /> Compartir</button>
            <Desplegable abierto={menu === 'compartir'} className="vis-menu__panel vis-menu__panel--derecha vis-share">
                <div className="vis-share__head">
                  <strong>Compartir</strong>
                  <button className="icon-btn" onClick={() => setMenu(null)} aria-label="Cerrar"><IconX size={15} /></button>
                </div>
                <div className="vis-share__sec">
                  <div className="vis-share__row">
                    <span className="vis-menu__item-text"><strong>Enlace público</strong><small>{enlace ? 'cualquiera con el enlace puede verlo' : 'crea un enlace de solo lectura'}</small></span>
                    <button className={`vis-switch ${enlace ? 'is-on' : ''}`} role="switch" aria-checked={!!enlace} aria-label="Enlace público" onClick={enlace ? quitarEnlace : copiarEnlace} />
                  </div>
                  {enlace && (
                    <div className="vis-field">
                      <span className="vis-field__valor">{enlace.replace(/^https?:\/\//, '')}</span>
                      <button className="vis-field__btn" onClick={copiarEnlace}><IconCopy size={13} /> {copiado === 'enlace' ? 'Copiado' : 'Copiar'}</button>
                    </div>
                  )}
                </div>
                <div className="vis-share__sec">
                  <div className="vis-menu__head">Lixbon CLI</div>
                  <p className="vis-share__hint">Pega el comando en el CLI y replica el diseño como proyecto (React + Vite, API…).</p>
                  <div className="vis-field">
                    <span className="vis-field__valor mono">/visual {routeConvId.slice(0, 8)}</span>
                    <button className="vis-field__btn" onClick={copiarComandoCli}><IconCopy size={13} /> {copiado === 'cli' ? 'Copiado' : 'Copiar'}</button>
                  </div>
                </div>
                <div className="vis-share__sec">
                  <div className="vis-menu__head">Exportar</div>
                  <div className="vis-share__tiles">
                    <button className="vis-tile" onClick={descargar}>
                      <IconDownload size={16} />
                      <strong>{actual?.kind === 'image' ? 'Descargar' : paginas.length > 1 ? 'Descargar .zip' : 'Descargar HTML'}</strong>
                      <small>{actual?.kind === 'image' ? 'JPEG' : paginas.length > 1 ? `${paginas.length} páginas HTML` : 'autocontenido'}</small>
                    </button>
                    {!modoImagen && (
                      <button className="vis-tile" onClick={copiarCodigo} disabled={!paginaActual}>
                        <IconCode size={16} />
                        <strong>{copiado === 'codigo' ? 'Código copiado' : 'Copiar el código'}</strong>
                        <small>{paginaActual?.name}</small>
                      </button>
                    )}
                  </div>
                </div>
            </Desplegable>
          </Menu>
        </div>
      </header>
      <VerifyBanner />

      <div className={`vis-split ${chatAbierto ? '' : 'is-solo-lienzo'}`}>
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
                          <button className={`vis-thumb ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => setVersion(n)}>
                            <img src={imagen.src} alt={imagen.alt} />
                            <span>v{n + 1}</span>
                          </button>
                        );
                      }
                      const archivos = extraerArchivos(m.content);
                      const ediciones = extraerEdiciones(m.content);
                      const cuerpo = sinArchivos(m.content);
                      const abierto = archivos.find((a) => !a.cerrado);
                      const editando = ediciones.find((e) => !e.cerrado);
                      const activo = busy && i === messages.length - 1;
                      const fallos = n >= 0 ? versiones[n].fallos || [] : [];
                      return (
                        <>
                          {m.reasoning && <Razonamiento texto={m.reasoning} activo={activo && !m.content} />}
                          {cuerpo ? <Markdown streaming={activo}>{cuerpo}</Markdown>
                            : (!archivos.length && !m.reasoning && <span className="msg__thinking">Pensando…</span>)}
                          {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                          {n >= 0 && versiones[n].nuevas.length > 0 && (
                            <button className={`vis-version-chip ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => { setVersion(n); setPagina(null); }}>
                              v{n + 1} · {versiones[n].nuevas.join(', ')}
                            </button>
                          )}
                          {fallos.map((f) => (
                            <p key={f.name} className="msg__aviso">
                              La edición de {f.name} no encaja ({f.motivo}).{' '}
                              <button className="vis-link" onClick={() => send(`El bloque edit de ${f.name} no encaja con el archivo actual. Entrega ${f.name} completo con el cambio aplicado.`)}>Pedir el archivo completo</button>
                            </p>
                          ))}
                          {editando && activo && (
                            <div className="vis-trabajo">
                              <span className="vis-trabajo__dot" />
                              <span>Editando <strong>{editando.name}</strong>…</span>
                              <span className="vis-trabajo__meta">{editando.pares.length} cambio{editando.pares.length === 1 ? '' : 's'}</span>
                            </div>
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
    </div>
  );
}

/** Galería de diseños: miniatura de la última versión, última edición, autor. */
function Galeria({ conversations, loading, onRename, onDelete }) {
  const [miniaturas, setMiniaturas] = useState({}); // id → { files } | null
  const [menuId, setMenuId] = useState(null);
  const [renombrando, setRenombrando] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    conversations.slice(0, 24).forEach((c) => {
      if (miniaturas[c.id] !== undefined) return;
      setMiniaturas((prev) => ({ ...prev, [c.id]: null }));
      api.get(`/api/conversations/${c.id}/files`)
        .then((r) => setMiniaturas((prev) => ({ ...prev, [c.id]: r.data })))
        .catch(() => setMiniaturas((prev) => ({ ...prev, [c.id]: { files: [] } })));
    });
  }, [conversations]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="vis-galeria__vacio">Cargando tus diseños…</div>;
  if (!conversations.length) return <div className="vis-galeria__vacio">Tus diseños aparecerán aquí.</div>;

  return (
    <section className="vis-galeria__lista">
      <h3 className="vis-galeria__titulo">Tus diseños <small>{conversations.length}</small></h3>
      <div className="vis-cards">
        {conversations.map((c) => {
          const mini = miniaturas[c.id];
          const portada = mini?.files?.find((f) => f.name === 'index.html') || mini?.files?.[0];
          return (
            <article key={c.id} className="vis-card">
              <button className="vis-card__preview" onClick={() => navigate(`/visuals/${c.id}`)} title="Abrir">
                {portada ? (
                  <iframe title={c.title || 'diseño'} sandbox="allow-scripts" srcDoc={documentoPreview(portada)} tabIndex={-1} />
                ) : (
                  <span className="vis-card__sin">{mini === null || mini === undefined ? '…' : 'Sin vista previa'}</span>
                )}
              </button>
              <div className="vis-card__body">
                {renombrando === c.id ? (
                  <input className="vis-card__input" autoFocus defaultValue={c.title || ''}
                    onKeyDown={(e) => { if (e.key === 'Enter') { onRename(c.id, e.target.value); setRenombrando(null); } if (e.key === 'Escape') setRenombrando(null); }}
                    onBlur={(e) => { onRename(c.id, e.target.value); setRenombrando(null); }} />
                ) : (
                  <button className="vis-card__title" onClick={() => navigate(`/visuals/${c.id}`)}>{c.title || 'Diseño sin título'}</button>
                )}
                <div className="vis-card__meta">
                  <span>Editado {tiempoRelativo(c.updated_at)}</span>
                  {mini?.files?.length > 0 && <><span>·</span><span>{mini.files.length} página{mini.files.length === 1 ? '' : 's'}</span></>}
                </div>
                <Menu abierto={menuId === c.id} onCerrar={() => setMenuId(null)} className="vis-card__menu">
                  <button className="icon-btn" onClick={() => setMenuId(menuId === c.id ? null : c.id)} aria-label="Más opciones"><IconDots size={16} /></button>
                  <Desplegable abierto={menuId === c.id} className="vis-menu__panel vis-menu__panel--derecha">
                      <button className="vis-menu__item" onClick={() => navigate(`/visuals/${c.id}`)}><IconExternal size={15} /><span>Abrir</span></button>
                      <button className="vis-menu__item" onClick={() => { setRenombrando(c.id); setMenuId(null); }}><IconPencil size={15} /><span>Renombrar</span></button>
                      <div className="vis-menu__sep" />
                      <button className="vis-menu__item is-danger" onClick={() => { setMenuId(null); onDelete(c.id); }}><IconTrash size={15} /><span>Eliminar</span></button>
                  </Desplegable>
                </Menu>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
