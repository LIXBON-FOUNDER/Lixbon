// VisualsPage.jsx — Visuals: galería de diseños (/visuals) y editor
// (/visuals/:id). En el editor, el chat es un panel lateral plegable y el
// lienzo pinta cada página en un iframe aislado; se puede seleccionar y
// retocar elementos sin pasar por el modelo.
import { TemaBoton } from '../components/TemaBoton';
import { useSeo } from '../lib/seo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useNavigate, Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { useAuth } from '../hooks/useAuth';
import { tieneVisuals } from '../lib/planes';
import { useConfirmar } from '../hooks/useConfirmar';
import { useDismiss } from '../hooks/useDismiss';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { descargarBlob } from '../lib/archivos';
import { crearZip } from '../lib/zip';
import {
  ANCHOS, DESIGN_SYSTEMS, IDEAS, TAMANOS_IMAGEN, TIPO_IMAGEN, TIPOS, aplicarOps, construirVersiones, designSystemPersonalizado,
  documentoPreview, documentoPresentacion, esConversacionDeImagenes, resolverPagina, rotuloDe, esSvg, extraerArchivo, extraerArchivos, extraerEdiciones, extraerImagen, promptVisuals,
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
  IconGrid, IconLayers, IconPanel, IconPencil, IconPhone, IconPointer, IconRedo, IconRows, IconSearch, IconShare, IconTablet, IconTrash, IconUndo, IconWindow, IconX,
} from '../components/Icons';

const CONTEXT_WINDOW = 30;

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

// Qué toca una op: texto, clases o las propiedades de estilo que cambia.
const claveDeOp = (op) => (op.text != null ? 'text' : op.className != null ? 'class' : Object.keys(op.style || {}).sort().join(','));

export default function VisualsPage() {
  const t = useT('visuals');
  const tc = useT('common');
  const locale = useLocale();
  useSeo({
    title: t('seoTitle'),
    description: t('seoDescription'),
    path: '/visuals',
    noindex: typeof window !== 'undefined' && !window.location.pathname.endsWith('/visuals'),
  });
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
  const [prefill, setPrefill] = useState({ texto: '', n: 0 });
  const [menu, setMenu] = useState(null);         // 'paginas' | 'historial' | 'compartir'
  const [enlace, setEnlace] = useState(null);     // token de compartir
  const [editandoTitulo, setEditandoTitulo] = useState(false);
  const [deshechas, setDeshechas] = useState({}); // clave de ops → ops deshechas (para rehacer)
  const [revOps, setRevOps] = useState(0);        // sube al deshacer: el iframe se rehace sin la op
  const [ancho, setAncho] = useState(() => local.get('lixbon.visuals.ancho', 'ajustar'));
  const [enlaceRoto, setEnlaceRoto] = useState(null); // página que pidió un enlace y no existe
  const [panelMovil, setPanelMovil] = useState('chat'); // pantallas estrechas: un panel cada vez
  const abortRef = useRef(null);
  const loadedConvRef = useRef(null);
  const scrollRef = useRef(null);
  const frameRef = useRef(null);
  const hashPendiente = useRef('');
  const paginaRef = useRef(null);
  const stageRef = useRef(null);

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
      setDeshechas({});
      setSeleccion(null);
      setTipo(null);
      return;
    }
    setOps(local.get(`lixbon.visuals.ops.${routeConvId}`, {}));
    setDeshechas({});
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
  paginaRef.current = paginaActual?.name || null;
  const claveOps = actual && paginaActual ? `${actual.indice}:${paginaActual.name}` : '';
  const opsActuales = useMemo(() => ops[claveOps] || [], [ops, claveOps]);
  // Las ediciones de después se aplican en vivo por postMessage: si entraran en
  // las dependencias, cada cambio recargaría el iframe y perdería la selección.
  const doc = useMemo(() => documentoPreview(paginaActual, opsActuales), [paginaActual, claveOps, revOps]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (doc) setCargando(true); }, [doc]);

  // ── Ancho de vista previa: fijo en px, a escala si no cabe ────────────
  const [anchoStage, setAnchoStage] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setAnchoStage(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [routeConvId, actual?.kind]);
  const anchoFijo = ANCHOS.find((a) => a.id === ancho)?.ancho || 0;
  const marco = anchoFijo && anchoStage ? {
    ancho: anchoFijo,
    escala: Math.min(1, anchoStage / anchoFijo),
    visible: Math.min(anchoFijo, anchoStage),
  } : null;

  // ── Mensajes del iframe (selección, navegación entre páginas) ──────────
  useEffect(() => {
    const onMessage = (e) => {
      const m = e.data || {};
      if (m.type === 'lixbon:select') { const { type: _tipo, ...datos } = m; setSeleccion(datos); }
      if (m.type === 'lixbon:navigate' && e.source === frameRef.current?.contentWindow) {
        const destino = resolverPagina(paginas.map((f) => f.name), m.page, m.texto, Object.fromEntries(paginas.map((f) => [f.name, rotuloDe(f.code)])));
        if (!destino) { setEnlaceRoto(m.page || '/'); return; }
        setEnlaceRoto(null);
        if (destino === paginaRef.current) { if (m.hash) frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:hash', hash: m.hash }, '*'); return; }
        hashPendiente.current = m.hash || '';
        setPagina(destino);
        setVista('pagina');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [paginas]);
  useEffect(() => { setEnlaceRoto(null); }, [paginaActual?.name, indiceVersion]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:inspect', on: inspeccion }, '*');
    if (!inspeccion) setSeleccion(null);
  }, [inspeccion, doc]);

  const guardarOps = (fn) => setOps((prev) => {
    const next = fn(prev);
    if (routeConvId) local.set(`lixbon.visuals.ops.${routeConvId}`, next);
    return next;
  });
  const aplicarOp = (op) => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:apply', ...op }, '*');
    guardarOps((prev) => {
      const lista = prev[claveOps] || [];
      // Un cambio seguido sobre lo mismo (arrastrar el selector de color,
      // corregir un valor) sustituye al anterior en vez de apilarse.
      const ultima = lista[lista.length - 1];
      const mismo = ultima && ultima.selector === op.selector && claveDeOp(ultima) === claveDeOp(op);
      return { ...prev, [claveOps]: mismo ? [...lista.slice(0, -1), op] : [...lista, op] };
    });
    setDeshechas((prev) => (prev[claveOps]?.length ? { ...prev, [claveOps]: [] } : prev));
  };
  // Una op no se puede retirar en vivo: se rehace el documento sin ella.
  const recargarConOps = () => { setSeleccion(null); setRevOps((n) => n + 1); };
  const pilaRehacer = deshechas[claveOps] || [];
  const deshacer = () => {
    if (!opsActuales.length) return;
    const ultima = opsActuales[opsActuales.length - 1];
    guardarOps((prev) => ({ ...prev, [claveOps]: (prev[claveOps] || []).slice(0, -1) }));
    setDeshechas((prev) => ({ ...prev, [claveOps]: [...(prev[claveOps] || []), ultima] }));
    recargarConOps();
  };
  const rehacer = () => {
    if (!pilaRehacer.length) return;
    const op = pilaRehacer[pilaRehacer.length - 1];
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:apply', ...op }, '*');
    guardarOps((prev) => ({ ...prev, [claveOps]: [...(prev[claveOps] || []), op] }));
    setDeshechas((prev) => ({ ...prev, [claveOps]: (prev[claveOps] || []).slice(0, -1) }));
  };
  const descartarRetoques = async () => {
    const ok = await confirmar({ titulo: t('discardTitle'), texto: t('discardText', { n: opsActuales.length, name: paginaActual?.name || '' }), etiqueta: t('discard') });
    if (!ok) return;
    guardarOps((prev) => { const { [claveOps]: _fuera, ...resto } = prev; return resto; });
    setDeshechas((prev) => ({ ...prev, [claveOps]: [] }));
    recargarConOps();
  };
  // La última se guarda como null: así las versiones nuevas se muestran solas.
  const verVersion = (n) => { setVersion(n >= versiones.length - 1 ? null : n); setPanelMovil('lienzo'); };
  const elegirAncho = (id) => { setAncho(id); local.set('lixbon.visuals.ancho', id); };
  const irAPagina = (name) => { setPagina(name); setVista('pagina'); };
  const paginaRelativa = (paso) => {
    if (paginas.length < 2 || !paginaActual) return;
    const i = paginas.findIndex((f) => f.name === paginaActual.name);
    irAPagina(paginas[(i + paso + paginas.length) % paginas.length].name);
  };

  // Texto para el campo del chat; la clave fuerza a rellenarlo aunque se repita.
  const rellenar = (texto) => setPrefill((p) => ({ texto, n: p.n + 1 }));

  const pedirAlModelo = (sel) => {
    rellenar(`${t('elementPrefillBefore')} ${paginaActual?.name || t('thePage')} (<${sel.tag}>): ${sel.html.slice(0, 300)}\n\n${t('elementPrefillMiddle')} `);
    setInspeccion(false);
    setChatAbierto(true);
  };

  // ── Atajos del editor (fuera de campos de texto) ──────────────────────
  const atajosRef = useRef(null);
  atajosRef.current = { deshacer, rehacer, paginaRelativa, inspeccion, verCodigo, menu, paginaActual, modoImagen, routeConvId };
  useEffect(() => {
    const onKey = (e) => {
      const a = atajosRef.current;
      if (!a.routeConvId || a.modoImagen) return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) a.rehacer(); else a.deshacer(); return; }
      if (mod && k === 'y') { e.preventDefault(); a.rehacer(); return; }
      if (mod || e.altKey) return;
      if (k === 'escape') {
        if (a.menu) setMenu(null);
        else if (a.inspeccion) setInspeccion(false);
        else if (a.verCodigo) setVerCodigo(false);
        return;
      }
      if (!a.paginaActual) return;
      if (k === 'v' && !/\.svg$/i.test(a.paginaActual.name)) { setInspeccion((v) => !v); setVerCodigo(false); setVista('pagina'); }
      else if (k === 'c') { setVerCodigo((v) => !v); setInspeccion(false); setVista('pagina'); }
      else if (k === 'arrowright' || k === ']') a.paginaRelativa(1);
      else if (k === 'arrowleft' || k === '[') a.paginaRelativa(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      const texto = (detalle && (detalle.message || detalle)) || err.message || t('couldNotGenerateImage');
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
    if (!tieneVisuals(user)) { navigate('/plans'); return; }
    setPrefill((p) => (p.texto ? { texto: '', n: p.n } : p));
    if (modoImagen) { await generarImagen(texto); return; }
    let chosenModel = model;
    if (!chosenModel) {
      try { chosenModel = (await loadModels())[0] || ''; } catch { /* abajo */ }
      if (!chosenModel) return;
    }
    const text = tipo && messages.length === 0 ? `${tipo.prefijo[locale]}${texto}` : texto;
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
        system: promptVisuals(designSystem, locale),
        source: 'visuals',
        webSearch: 'off',  // diseñar no necesita internet; ahorra la llamada del planificador
        // Sin razonamiento previo: un HTML largo con thinking acababa entero
        // dentro del razonamiento y el contenido llegaba vacío.
        think: false,
        onDelta: (delta) => patchLast((last) => ({ ...last, content: last.content + delta })),
        onReasoning: (delta) => patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta })),
        onFinish: (reason) => {
          if (reason === 'length') patchLast((last) => ({ ...last, aviso: t('truncatedResponse') }));
        },
      });
      patchLast((last) => {
        if (last.content.trim()) return last;
        if (last.reasoning && (extraerArchivos(last.reasoning).length || extraerEdiciones(last.reasoning).length)) return { ...last, content: last.reasoning, reasoning: '' };
        return { ...last, content: t('emptyModelResponse'), error: true };
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
    const ok = await confirmar({ titulo: t('deleteConfirmTitle'), texto: t('deleteConfirmText'), etiqueta: tc('delete') });
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
          <Link to="/chat" className="vis-top__logo" title={t('backToChat')}><Logo /></Link>
          <span className="vis-top__seccion">Visuals</span>
          <div className="vis-top__right">
            <TemaBoton />
            {user ? <Link to="/account" className="vis-avatar" title={user.name || user.email}>{(user.name || user.email || '?')[0].toUpperCase()}</Link>
              : <Link to="/auth" className="pill-btn pill-btn--primary">{tc('logIn')}</Link>}
          </div>
        </header>
        <VerifyBanner />
        <div className="vis-galeria">
          <section className="vis-hero vis-hero--galeria">
            <div className="vis-hero__inner">
              <h2 className="vis-hero__title">{t('heroTitle')}</h2>
              <p className="vis-hero__lead">{t('heroLead')}</p>
              {user && !tieneVisuals(user) ? (
                <div className="vis-bloqueo">
                  <span className="vis-bloqueo__icono"><IconLayers size={20} /></span>
                  <div className="vis-bloqueo__cuerpo">
                    <h3>{t('lockedTitle')}</h3>
                    <p>{t('lockedPlanBefore')} {user.plan_name || tc('freePlan')} {t('lockedPlanAfter')}</p>
                    <ul>
                      <li><IconCheck size={14} /> {t('lockedFeature1')}</li>
                      <li><IconCheck size={14} /> {t('lockedFeature2')}</li>
                      <li><IconCheck size={14} /> {t('lockedFeature3')}</li>
                    </ul>
                    <div className="vis-bloqueo__acciones">
                      <Link to="/plans" className="pill-btn pill-btn--primary">{t('seePlans')}</Link>
                      <Link to="/docs/visuals" className="pill-btn pill-btn--outline">{t('howItWorks')}</Link>
                    </div>
                  </div>
                </div>
              ) : (
              <>
              <div className="vis-tipos">
                {[...TIPOS, TIPO_IMAGEN].map((tp) => (
                  <button key={tp.id} className={`vis-tipo ${tipo?.id === tp.id ? 'is-active' : ''}`}
                    disabled={tp.id === 'imagen' && !imagenes.available}
                    title={tp.id === 'imagen' && !imagenes.available ? t('noImageNodes') : undefined}
                    onClick={() => setTipo(tipo?.id === tp.id ? null : tp)}>
                    {tp.label[locale]}
                  </button>
                ))}
              </div>
              {tipo?.id === 'imagen' ? (
                <div className="vis-tamanos">
                  {TAMANOS_IMAGEN.map((tm) => (
                    <button key={tm.id} className={`vis-tool ${tamano.id === tm.id ? 'is-active' : ''}`} onClick={() => setTamano(tm)}>{tm.label}</button>
                  ))}
                  <span className="vis-tamanos__modelo">{imagenes.model}</span>
                </div>
              ) : null}
              <div className="vis-hero__input">
                <ChatInput key={prefill.n} initialText={prefill.texto} onSend={send} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  tools={tipo?.id !== 'imagen' && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
                  placeholder={tipo ? tipo.hint[locale] : t('inputPlaceholder')} />
              </div>
              <div className="vis-ideas">
                <span className="vis-ideas__label">{t('ideas')}</span>
                {(IDEAS[tipo?.id] || IDEAS.general)[locale === 'en' ? 'en' : 'es'].map((idea) => (
                  <button key={idea} className="vis-idea" onClick={() => rellenar(idea)}>{idea}</button>
                ))}
              </div>
              {!user && <p className="vis-hero__nota">{t('proAdvanceNote')}</p>}
              </>
              )}
            </div>
          </section>
          {user && (tieneVisuals(user) || conversations.length > 0) && (
            <Galeria conversations={conversations} loading={convsLoading}
              onRename={renameConversation} onDelete={deleteConversation} t={t} tc={tc} />
          )}
        </div>
      </div>
    );
  }

  // ── Editor ─────────────────────────────────────────────────────────────
  const tituloVisible = title || t('untitledDesign');
  return (
    <div className="vis-page vis-editor">
      <header className="vis-top">
        <Link to="/visuals" className="icon-btn" title={t('allDesigns')}><IconArrowLeft size={17} /></Link>
        <button className={`icon-btn vis-top__panel ${chatAbierto ? 'is-active' : ''}`} onClick={() => setChatAbierto((v) => !v)} title={chatAbierto ? t('hideChat') : t('showChat')} aria-pressed={chatAbierto}>
          <IconPanel size={17} />
        </button>
        <div className="vis-titulo">
          {editandoTitulo ? (
            <input className="vis-titulo__input" autoFocus defaultValue={title || ''} placeholder={t('designNamePlaceholder')}
              onKeyDown={(e) => { if (e.key === 'Enter') { renameConversation(routeConvId, e.target.value); setEditandoTitulo(false); } if (e.key === 'Escape') setEditandoTitulo(false); }}
              onBlur={(e) => { renameConversation(routeConvId, e.target.value); setEditandoTitulo(false); }} />
          ) : (
            <button className="vis-titulo__nombre" onClick={() => setEditandoTitulo(true)} title={t('renameDesign')}>{tituloVisible}</button>
          )}
          {versiones.length > 0 && (
            <Menu abierto={menu === 'historial'} onCerrar={() => setMenu(null)}>
              <button className={`vis-chip ${menu === 'historial' ? 'is-active' : ''}`} onClick={() => setMenu(menu === 'historial' ? null : 'historial')} title={t('versions')}>
                <IconHistory size={14} /><span>v{indiceVersion + 1}</span><IconChevron size={13} open={menu === 'historial'} />
              </button>
              <Desplegable abierto={menu === 'historial'} className="vis-menu__panel">
                  <div className="vis-menu__head">{t('versions')}</div>
                  {versiones.map((v, n) => (
                    <button key={v.indice} className={`vis-menu__item ${indiceVersion === n ? 'is-active' : ''}`} onClick={() => { verVersion(n); setMenu(null); }}>
                      <span className="vis-menu__check">{indiceVersion === n && <IconCheck size={14} />}</span>
                      <span className="vis-menu__item-text"><strong>{t('version', { n: n + 1 })}</strong><small>{v.kind === 'image' ? t('image') : v.nuevas.join(', ')}</small></span>
                    </button>
                  )).reverse()}
              </Desplegable>
            </Menu>
          )}
        </div>

        <div className="vis-top__right">
          <TemaBoton />
          {!modoImagen && (
            <div className="vis-seg">
              <button className={`vis-tool ${inspeccion ? 'is-active' : ''}`} onClick={() => { setInspeccion((v) => !v); setVista('pagina'); setVerCodigo(false); }} disabled={!paginaActual || esSvg(paginaActual.name)} title={`${t('selectHint')} (V)`}>
                <IconPointer size={14} /> {t('select')}
              </button>
              <button className={`vis-tool ${verCodigo ? 'is-active' : ''}`} onClick={() => { setVerCodigo((v) => !v); setInspeccion(false); setVista('pagina'); }} disabled={!paginaActual} title={`${t('codeHint')} (C)`}>
                <IconCode size={14} /> {t('code')}
              </button>
            </div>
          )}
          {!modoImagen && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
          <span className="vis-vdiv" />
          <button className="vis-tool" onClick={presentar} disabled={!actual} title={t('presentHint')}><IconExternal size={14} /> {t('present')}</button>
          <Menu abierto={menu === 'compartir'} onCerrar={() => setMenu(null)}>
            <button className="vis-tool vis-tool--blanco" onClick={() => setMenu(menu === 'compartir' ? null : 'compartir')} disabled={!actual}><IconShare size={14} /> {t('share')}</button>
            <Desplegable abierto={menu === 'compartir'} className="vis-menu__panel vis-menu__panel--derecha vis-share">
                <div className="vis-share__head">
                  <strong>{t('share')}</strong>
                  <button className="icon-btn" onClick={() => setMenu(null)} aria-label={t('close')}><IconX size={15} /></button>
                </div>
                <div className="vis-share__sec">
                  <div className="vis-share__row">
                    <span className="vis-menu__item-text"><strong>{t('publicLink')}</strong><small>{enlace ? t('publicLinkOn') : t('publicLinkOff')}</small></span>
                    <button className={`vis-switch ${enlace ? 'is-on' : ''}`} role="switch" aria-checked={!!enlace} aria-label={t('publicLink')} onClick={enlace ? quitarEnlace : copiarEnlace} />
                  </div>
                  {enlace && (
                    <div className="vis-field">
                      <span className="vis-field__valor">{enlace.replace(/^https?:\/\//, '')}</span>
                      <button className="vis-field__btn" onClick={copiarEnlace}><IconCopy size={13} /> {copiado === 'enlace' ? t('copied') : t('copy')}</button>
                    </div>
                  )}
                </div>
                <div className="vis-share__sec">
                  <div className="vis-menu__head">{t('cliTitle')}</div>
                  <p className="vis-share__hint">{t('cliHint')}</p>
                  <div className="vis-field">
                    <span className="vis-field__valor mono">/visual {routeConvId.slice(0, 8)}</span>
                    <button className="vis-field__btn" onClick={copiarComandoCli}><IconCopy size={13} /> {copiado === 'cli' ? t('copied') : t('copy')}</button>
                  </div>
                </div>
                <div className="vis-share__sec">
                  <div className="vis-menu__head">{t('export')}</div>
                  <div className="vis-share__tiles">
                    <button className="vis-tile" onClick={descargar}>
                      <IconDownload size={16} />
                      <strong>{actual?.kind === 'image' ? t('download') : paginas.length > 1 ? t('downloadZip') : t('downloadHtml')}</strong>
                      <small>{actual?.kind === 'image' ? 'JPEG' : paginas.length > 1 ? t('pagesHtml', { n: paginas.length }) : t('selfContained')}</small>
                    </button>
                    {!modoImagen && (
                      <button className="vis-tile" onClick={copiarCodigo} disabled={!paginaActual}>
                        <IconCode size={16} />
                        <strong>{copiado === 'codigo' ? t('codeCopied') : t('copyCode')}</strong>
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

      <div className="vis-movil">
        <div className="vis-panel-toggle" role="tablist">
          <button role="tab" aria-selected={panelMovil === 'chat'} className={panelMovil === 'chat' ? 'is-active' : ''} onClick={() => setPanelMovil('chat')}>{t('mobileChat')}</button>
          <button role="tab" aria-selected={panelMovil === 'lienzo'} className={panelMovil === 'lienzo' ? 'is-active' : ''} onClick={() => setPanelMovil('lienzo')}>
            {t('mobileDesign')}{versiones.length > 0 && <span className="vis-panel-toggle__n">v{indiceVersion + 1}</span>}
          </button>
        </div>
      </div>

      <div className={`vis-split ${chatAbierto ? '' : 'is-solo-lienzo'} ${inspeccion && seleccion ? 'con-inspector' : ''} ${panelMovil === 'lienzo' ? 'is-lienzo' : 'is-chat'}`}>
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
                      if (m.generandoImagen) return <span className="msg__thinking">{t('generatingImage')}</span>;
                      if (m.error) return <MensajeError>{m.content}</MensajeError>;
                      const imagen = extraerImagen(m.content);
                      if (imagen) {
                        return (
                          <button className={`vis-thumb ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => verVersion(n)}>
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
                            : (!archivos.length && !m.reasoning && <span className="msg__thinking">{t('thinking')}</span>)}
                          {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                          {n >= 0 && versiones[n].nuevas.length > 0 && (
                            <button className={`vis-version-chip ${actual?.indice === i ? 'is-active' : ''}`} onClick={() => verVersion(n)}>
                              v{n + 1} · {versiones[n].nuevas.join(', ')}
                            </button>
                          )}
                          {fallos.map((f) => (
                            <p key={f.name} className="msg__aviso">
                              {t('editDoesntFit', { name: f.name, motivo: f.motivo })}{' '}
                              <button className="vis-link" onClick={() => send(t('requestFullFileMessage', { name: f.name }))}>{t('requestFullFile')}</button>
                            </p>
                          ))}
                          {editando && activo && (
                            <div className="vis-trabajo">
                              <span className="vis-trabajo__dot" />
                              <span>{t('editingBefore')} <strong>{editando.name}</strong>{t('editingAfter')}</span>
                              <span className="vis-trabajo__meta">{editando.pares.length} {editando.pares.length === 1 ? t('change') : t('changes')}</span>
                            </div>
                          )}
                          {abierto && activo && (
                            <div className="vis-trabajo">
                              <span className="vis-trabajo__dot" />
                              <span>{t('writingBefore')} <strong>{abierto.name}</strong>{archivos.length > 1 ? t('readyCountSuffix', { n: archivos.length - 1 }) : ''}{t('writingAfter')}</span>
                              <span className="vis-trabajo__meta">{abierto.code.split('\n').length} {t('lines')}</span>
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
            <ChatInput key={prefill.n} initialText={prefill.texto} onSend={send} onStop={stop} busy={busy} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
              placeholder={modoImagen ? t('imagePlaceholder') : t('editPlaceholder')} />
          </div>
        </section>

        <section className="vis-canvas">
          <div className="vis-lienzo">
          {actual?.kind === 'file' && (
            <div className="vis-stagebar">
              <div className="vis-pestanas" role="tablist" aria-label={t('pages')}>
                {paginas.length > 1 && (
                  <button role="tab" aria-selected={vista === 'lienzo'} className={`vis-pestana ${vista === 'lienzo' ? 'is-on' : ''}`}
                    onClick={() => { setVista('lienzo'); setInspeccion(false); setVerCodigo(false); }} title={t('allPagesAtOnce', { n: paginas.length })}>
                    <IconLayers size={14} /> {t('canvas')}
                  </button>
                )}
                {paginas.map((f) => {
                  const activa = vista === 'pagina' && paginaActual?.name === f.name;
                  const retocada = (ops[`${actual.indice}:${f.name}`] || []).length > 0;
                  return (
                    <button key={f.name} role="tab" aria-selected={activa} className={`vis-pestana ${activa ? 'is-on' : ''}`} onClick={() => irAPagina(f.name)} title={f.name}>
                      <IconFile size={13} /> {f.name.replace(/\.(html?|svg)$/, '')}
                      {actual.nuevas?.includes(f.name) && indiceVersion > 0 && <span className="vis-pestana__nueva" title={t('changedInVersion')} />}
                      {retocada && <span className="vis-pestana__retoque" title={t('hasManualEdits')}>✎</span>}
                    </button>
                  );
                })}
              </div>
              <div className="vis-stagebar__der">
                {vista === 'pagina' && (opsActuales.length > 0 || pilaRehacer.length > 0) && (
                  <div className="vis-retoques">
                    <button className="vis-tool vis-tool--icono" onClick={deshacer} disabled={!opsActuales.length} title={`${t('undo')} (Ctrl+Z)`} aria-label={t('undo')}><IconUndo size={15} /></button>
                    <button className="vis-tool vis-tool--icono" onClick={rehacer} disabled={!pilaRehacer.length} title={`${t('redo')} (Ctrl+Shift+Z)`} aria-label={t('redo')}><IconRedo size={15} /></button>
                    {opsActuales.length > 0 && (
                      <button className="vis-tool vis-tool--icono vis-retoques__n" onClick={descartarRetoques}
                        title={`${t(opsActuales.length === 1 ? 'manualEditsOne' : 'manualEditsCount', { n: opsActuales.length })} · ${t('discardHint')}`} aria-label={t('discardHint')}>
                        <IconTrash size={14} /><span>{opsActuales.length}</span>
                      </button>
                    )}
                  </div>
                )}
                {vista === 'pagina' && !verCodigo && (
                  <div className="vis-seg vis-seg--chico" role="group" aria-label={t('previewWidth')}>
                    {ANCHOS.map((a) => {
                      const Icono = { ajustar: IconPanel, escritorio: IconWindow, tablet: IconTablet, movil: IconPhone }[a.id];
                      const etiqueta = a.ancho ? `${t(`width_${a.id}`)} · ${a.ancho}px` : t('width_ajustar');
                      return (
                        <button key={a.id} className={`vis-tool vis-tool--icono ${ancho === a.id ? 'is-active' : ''}`} onClick={() => elegirAncho(a.id)} title={etiqueta} aria-label={etiqueta} aria-pressed={ancho === a.id}>
                          <Icono size={15} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {versiones.length > 1 && indiceVersion < versiones.length - 1 && (
            <div className="vis-aviso" role="status">
              <IconHistory size={14} />
              <span>{t('viewingOldVersion', { n: indiceVersion + 1, total: versiones.length })}</span>
              <button className="vis-aviso__btn" onClick={() => setVersion(null)}>{t('backToLatest')}</button>
            </div>
          )}
          <div className="vis-stage" ref={stageRef}>
            {actual ? (
              actual.kind === 'image' ? (
                <img className="vis-imagen" src={actual.src} alt={actual.name} />
              ) : vista === 'lienzo' ? (
                <Board paginas={paginas} documento={(f) => documentoPreview(f, ops[`${actual.indice}:${f.name}`] || [])}
                  onAbrir={irAPagina} clave={routeConvId} activa={paginaActual?.name} />
              ) : verCodigo ? (
                <CodigoVista nombre={paginaActual.name} codigo={codigoFinal(paginaActual)} retoques={opsActuales.length}
                  copiado={copiado === 'codigo'} onCopiar={copiarCodigo} t={t} />
              ) : (
                <div className={`vis-frame ${marco ? 'is-fijo' : ''}`} style={marco ? { width: marco.visible } : undefined}>
                  <iframe key={revOps} ref={frameRef} title={t('previewTitle')} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={doc}
                    style={marco ? { width: marco.ancho, height: `${100 / marco.escala}%`, transform: `scale(${marco.escala})`, transformOrigin: '0 0' } : undefined}
                    onLoad={() => {
                      setCargando(false);
                      const w = frameRef.current?.contentWindow;
                      w?.postMessage({ type: 'lixbon:inspect', on: inspeccion }, '*');
                      if (hashPendiente.current) { w?.postMessage({ type: 'lixbon:hash', hash: hashPendiente.current }, '*'); hashPendiente.current = ''; }
                    }} />
                  {cargando && <div className="vis-stage__loading"><span>{t('rendering', { name: paginaActual?.name })}</span></div>}
                  {marco && <span className="vis-frame__medida">{marco.ancho}px{marco.escala < 1 ? ` · ${Math.round(marco.escala * 100)}%` : ''}</span>}
                </div>
              )
            ) : (
              <div className="vis-stage__empty">
                {generando ? (
                  <span className="vis-trabajo"><span className="vis-trabajo__dot" />{t('writingDesign')}</span>
                ) : busy && modoImagen ? t('generatingImageShort') : t('previewWillAppear')}
              </div>
            )}
            {enlaceRoto && vista === 'pagina' && !verCodigo && (
              <div className="vis-enlace-roto" role="status">
                <span>{t('brokenLink', { page: enlaceRoto })}</span>
                <button className="vis-aviso__btn" onClick={() => { rellenar(t('createMissingPage', { page: /\.html?$/i.test(enlaceRoto) ? enlaceRoto : `${enlaceRoto.replace(/^\/+/, '') || 'index'}.html`, from: paginaActual?.name || 'index.html' })); setEnlaceRoto(null); setPanelMovil('chat'); setChatAbierto(true); }}>{t('askToCreateIt')}</button>
                <button className="icon-btn" onClick={() => setEnlaceRoto(null)} aria-label={t('close')}><IconX size={13} /></button>
              </div>
            )}
            {generando && actual && <div className="vis-stage__badge">{t('newVersionOnTheWay')}</div>}
            {inspeccion && !seleccion && <div className="vis-stage__badge">{t('clickToEdit')}</div>}
          </div>
          </div>
          {inspeccion && seleccion && (
            <Inspector
              seleccion={seleccion}
              onAplicar={aplicarOp}
              onPedir={pedirAlModelo}
              onCerrar={() => {
                setSeleccion(null);
                frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:deselect' }, '*');
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** Código de la página con números de línea; incluye los retoques manuales. */
function CodigoVista({ nombre, codigo, retoques, copiado, onCopiar, t }) {
  const lineas = useMemo(() => codigo.split('\n'), [codigo]);
  return (
    <div className="vis-code">
      <div className="vis-code__cab">
        <IconFile size={13} />
        <span className="vis-code__nombre">{nombre}</span>
        <span className="vis-code__meta">{t('linesCount', { n: lineas.length })}{retoques ? ` · ${t('includesManualEdits')}` : ''}</span>
        <button className="vis-field__btn" onClick={onCopiar}>{copiado ? <IconCheck size={13} /> : <IconCopy size={13} />} {copiado ? t('copied') : t('copy')}</button>
      </div>
      <pre className="vis-code__cuerpo"><code>{lineas.map((l, i) => <span key={i} className="vis-code__l">{l || ' '}{'\n'}</span>)}</code></pre>
    </div>
  );
}

/** Galería de diseños: miniatura de la última versión, última edición y
 *  número de páginas; se busca por nombre, se ordena y se ve en lista o en
 *  cuadrícula (lo elegido se recuerda en el navegador). */
function Galeria({ conversations, loading, onRename, onDelete, t, tc }) {
  const locale = useLocale();
  const [miniaturas, setMiniaturas] = useState({}); // id → { files } | null
  const [menuId, setMenuId] = useState(null);
  const [renombrando, setRenombrando] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [orden, setOrden] = useState(() => local.get('lixbon.visuals.orden', 'reciente'));
  const [disposicion, setDisposicion] = useState(() => local.get('lixbon.visuals.vista', 'lista'));
  const navigate = useNavigate();

  const cambiarOrden = (v) => { setOrden(v); local.set('lixbon.visuals.orden', v); };
  const cambiarDisposicion = (v) => { setDisposicion(v); local.set('lixbon.visuals.vista', v); };

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const lista = conversations.filter((c) => !q || (c.title || t('untitledDesign')).toLowerCase().includes(q));
    if (orden === 'nombre') return lista.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', locale));
    return lista.slice().sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }, [conversations, busqueda, orden, locale, t]);

  useEffect(() => {
    visibles.slice(0, 24).forEach((c) => {
      if (miniaturas[c.id] !== undefined) return;
      setMiniaturas((prev) => ({ ...prev, [c.id]: null }));
      api.get(`/api/conversations/${c.id}/files`)
        .then((r) => setMiniaturas((prev) => ({ ...prev, [c.id]: r.data })))
        .catch(() => setMiniaturas((prev) => ({ ...prev, [c.id]: { files: [] } })));
    });
  }, [visibles]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="vis-galeria__vacio">{t('loadingDesigns')}</div>;
  if (!conversations.length) return <div className="vis-galeria__vacio">{t('designsWillAppear')}</div>;

  return (
    <section className="vis-galeria__lista">
      <div className="vis-galeria__barra">
        <h3 className="vis-galeria__titulo">{t('yourDesigns')} <small>{conversations.length}</small></h3>
        <label className="vis-buscar">
          <IconSearch size={14} />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder={t('searchDesigns')} aria-label={t('searchDesigns')}
            onKeyDown={(e) => { if (e.key === 'Escape') setBusqueda(''); }} />
          {busqueda && <button className="vis-buscar__x" onClick={() => setBusqueda('')} aria-label={t('clearSearch')}><IconX size={12} /></button>}
        </label>
        <div className="vis-seg vis-seg--chico" role="group" aria-label={t('sortBy')}>
          <button className={`vis-tool ${orden === 'reciente' ? 'is-active' : ''}`} onClick={() => cambiarOrden('reciente')}>{t('sortRecent')}</button>
          <button className={`vis-tool ${orden === 'nombre' ? 'is-active' : ''}`} onClick={() => cambiarOrden('nombre')}>{t('sortName')}</button>
        </div>
        <div className="vis-seg vis-seg--chico" role="group" aria-label={t('layout')}>
          <button className={`vis-tool ${disposicion === 'lista' ? 'is-active' : ''}`} onClick={() => cambiarDisposicion('lista')} title={t('layoutList')} aria-label={t('layoutList')} aria-pressed={disposicion === 'lista'}><IconRows size={15} /></button>
          <button className={`vis-tool ${disposicion === 'cuadricula' ? 'is-active' : ''}`} onClick={() => cambiarDisposicion('cuadricula')} title={t('layoutGrid')} aria-label={t('layoutGrid')} aria-pressed={disposicion === 'cuadricula'}><IconGrid size={15} /></button>
        </div>
      </div>
      {!visibles.length && <div className="vis-galeria__vacio">{t('noDesignsMatch', { q: busqueda.trim() })}</div>}
      <div className={`vis-cards ${disposicion === 'cuadricula' ? 'vis-cards--grid' : ''}`}>
        {visibles.map((c) => {
          const mini = miniaturas[c.id];
          const portada = mini?.files?.find((f) => f.name === 'index.html') || mini?.files?.[0];
          return (
            <article key={c.id} className="vis-card">
              <button className="vis-card__preview" onClick={() => navigate(`/visuals/${c.id}`)} title={t('open')}>
                {portada ? (
                  <iframe title={c.title || t('untitledDesign')} sandbox="allow-scripts" srcDoc={documentoPreview(portada)} tabIndex={-1} loading="lazy" />
                ) : (
                  <span className={`vis-card__sin ${mini === null || mini === undefined ? 'is-cargando' : ''}`}>{mini === null || mini === undefined ? '' : t('noPreview')}</span>
                )}
              </button>
              <div className="vis-card__body">
                {renombrando === c.id ? (
                  <input className="vis-card__input" autoFocus defaultValue={c.title || ''}
                    onKeyDown={(e) => { if (e.key === 'Enter') { onRename(c.id, e.target.value); setRenombrando(null); } if (e.key === 'Escape') setRenombrando(null); }}
                    onBlur={(e) => { onRename(c.id, e.target.value); setRenombrando(null); }} />
                ) : (
                  <button className="vis-card__title" onClick={() => navigate(`/visuals/${c.id}`)}>{c.title || t('untitledDesign')}</button>
                )}
                <div className="vis-card__meta">
                  <span>{t('editedAt', { when: tiempoRelativo(c.updated_at, locale) })}</span>
                  {mini?.files?.length > 0 && <><span>·</span><span>{mini.files.length} {mini.files.length === 1 ? t('page') : t('pagesPlural')}</span></>}
                </div>
                <Menu abierto={menuId === c.id} onCerrar={() => setMenuId(null)} className="vis-card__menu">
                  <button className="icon-btn" onClick={() => setMenuId(menuId === c.id ? null : c.id)} aria-label={t('moreOptions')}><IconDots size={16} /></button>
                  <Desplegable abierto={menuId === c.id} className="vis-menu__panel vis-menu__panel--derecha">
                      <button className="vis-menu__item" onClick={() => navigate(`/visuals/${c.id}`)}><IconExternal size={15} /><span>{t('open')}</span></button>
                      <button className="vis-menu__item" onClick={() => { setRenombrando(c.id); setMenuId(null); }}><IconPencil size={15} /><span>{tc('rename')}</span></button>
                      <div className="vis-menu__sep" />
                      <button className="vis-menu__item is-danger" onClick={() => { setMenuId(null); onDelete(c.id); }}><IconTrash size={15} /><span>{tc('delete')}</span></button>
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
