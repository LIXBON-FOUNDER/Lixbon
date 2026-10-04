// VisualsPage.jsx — Visuals: inicio y galería (/visuals) y el estudio de un visual
// (/visuals/vis_…). El estudio junta el chat con el modelo, el lienzo de páginas
// con inspector y retoques, las piezas de marketing con su render y editor, y el
// historial: todo guardado como versiones del visual en el servidor, así que lo
// que hacen los agentes (MCP) y lo que se hace aquí es el mismo visual.
import { TemaBoton } from '../components/TemaBoton';
import { useSeo } from '../lib/seo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
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
  ANCHOS, DESIGN_SYSTEMS, IDEAS, TAMANOS_IMAGEN, TIPO_IMAGEN, TIPOS, aplicarOps, designSystemPersonalizado,
  documentoPreview, documentoPresentacion, resolverPagina, rotuloDe, esSvg, extraerArchivos, extraerEdiciones, promptVisuals,
  tiempoRelativo,
} from '../lib/visuals';
import {
  baseDe, deleteVisual, eventsUrl, fileUrl, getText, getVisual, listRenders, metaDePieza, paraWeb, piezasDe, pushFiles,
  rendersPorFuente, requestRender, setShare,
} from '../lib/visualsApi';
import {
  actualizarVisual, aplicarRespuesta, cargarPaginas, compactarHistorial, contextoArchivos, crearVisual, guardarRespuesta,
  listarVersiones, listarVisuals,
} from '../lib/visualStudio';
import { Logo } from '../components/Logo';
import { ChatInput } from '../components/ChatInput';
import { Markdown } from '../components/Markdown';
import { VerifyBanner } from '../components/VerifyBanner';
import { Board, DesignSystemPicker, Inspector } from '../components/VisualsPanels';
import { PiezaEditor } from '../components/PiezaEditor';
import { Desplegable } from '../components/Desplegable';
import { MensajeError, Razonamiento } from '../components/Mensajes';
import {
  IconArrowLeft, IconCheck, IconChevron, IconCode, IconCopy, IconDots, IconDownload, IconExternal, IconFile, IconHistory,
  IconGrid, IconImage, IconLayers, IconPanel, IconPencil, IconPhone, IconPointer, IconRedo, IconRows, IconSearch, IconShare, IconTablet, IconTrash, IconUndo, IconWindow, IconX,
} from '../components/Icons';

const CONTEXT_WINDOW = 30;
const esVideo = (p) => /\.(mp4|webm)$/i.test(p || '');
const nombreCorto = (p) => p.split('/').pop().replace(/\.(html?|svg|md)$/, '');

/** Las páginas viven en el lienzo: el chat solo cuenta qué hace el modelo. */
const BLOQUE_PAGINA = /```\s*(file|edit):\s*([\w./-]+\.(?:html?|svg))[^\n`]*\n[\s\S]*?(?:\n```|$)/g;
const sinArchivos = (texto) => (texto || '').replace(BLOQUE_PAGINA, '').trim();
const paginasDe = (texto) => [...new Set([...(texto || '').matchAll(BLOQUE_PAGINA)].map((m) => m[2]))];

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

const claveDeOp = (op) => (op.text != null ? 'text' : op.className != null ? 'class' : Object.keys(op.style || {}).sort().join(','));

const errorDe = (err, fallback) => err?.response?.data?.detail?.message || err?.message || fallback;

export default function VisualsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const viejo = id && !id.startsWith('vis_');
  // Los diseños del Visuals anterior vivían en conversaciones y no se migran.
  useEffect(() => { if (viejo) navigate('/visuals', { replace: true }); }, [viejo, navigate]);
  if (!id || viejo) return <Inicio />;
  return <Estudio key={id} id={id} />;
}

function Cargando() {
  return (
    <div className="app-loading">
      <span className="app-loading__logo"><Logo size={19} /></span>
      <span className="app-loading__bar"><span /></span>
    </div>
  );
}

// ── Inicio: crear un visual y la galería ─────────────────────────────────────

function Inicio() {
  const t = useT('visuals');
  const tc = useT('common');
  const locale = useLocale();
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/visuals' });
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [tipo, setTipo] = useState(null);
  const [tamano, setTamano] = useState(TAMANOS_IMAGEN[0]);
  const [imagenes, setImagenes] = useState({ available: false, model: null });
  const [designSystem, setDesignSystem] = useState(() => dsDesde(local.get('lixbon.visuals.ds', null)));
  const [prefill, setPrefill] = useState({ texto: '', n: 0 });
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [model, setModel] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    api.get('/api/images/status').then((r) => setImagenes(r.data)).catch(() => {});
    api.get('/v1/models').then((res) => {
      const ids = res.data.data.map((m) => m.id).filter((x) => !String(x).startsWith('error:'));
      setModels(ids);
      setModelInfo(Object.fromEntries(res.data.data.map((m) => [m.id, { num_ctx: m.num_ctx, capabilities: m.capabilities || [], name: m.name || m.id }])));
      setModel((c) => c || ids[0] || '');
    }).catch(() => {});
  }, [user]);

  const elegirDesignSystem = (ds) => { setDesignSystem(ds); local.set('lixbon.visuals.ds', dsGuardable(ds)); };
  const rellenar = (texto) => setPrefill((p) => ({ texto, n: p.n + 1 }));

  const empezar = async (texto, images = []) => {
    if (!user) { navigate('/auth?mode=register'); return; }
    if (!tieneVisuals(user)) { navigate('/plans'); return; }
    setCreando(true);
    setError('');
    try {
      const esImagen = tipo?.id === 'imagen';
      const vis = await crearVisual({
        kind: 'design',
        title: texto.replace(/\s+/g, ' ').trim().slice(0, 60) || t('untitledDesign'),
        meta: { design_system: dsGuardable(designSystem), origin: 'web', ...(esImagen ? { mode: 'image' } : {}) },
      });
      const prefijo = tipo && !esImagen ? tipo.prefijo[locale] : '';
      navigate(`/visuals/${vis.id}`, { state: { primero: { texto: `${prefijo}${texto}`, images, model, tamano } } });
    } catch (err) {
      setError(errorDe(err, t('emptyModelResponse')));
      setCreando(false);
    }
  };

  if (loading) return <Cargando />;
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
                {tipo?.id === 'imagen' && (
                  <div className="vis-tamanos">
                    {TAMANOS_IMAGEN.map((tm) => (
                      <button key={tm.id} className={`vis-tool ${tamano.id === tm.id ? 'is-active' : ''}`} onClick={() => setTamano(tm)}>{tm.label}</button>
                    ))}
                    <span className="vis-tamanos__modelo">{imagenes.model}</span>
                  </div>
                )}
                <div className="vis-hero__input">
                  <ChatInput key={prefill.n} initialText={prefill.texto} onSend={empezar} busy={creando} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                    tools={tipo?.id !== 'imagen' && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
                    placeholder={tipo ? tipo.hint[locale] : t('inputPlaceholder')} />
                </div>
                {error && <p className="vis-hero__nota" role="alert">{error}</p>}
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
        {user && <Galeria t={t} tc={tc} />}
      </div>
    </div>
  );
}

function Portada({ v, t }) {
  const [doc, setDoc] = useState(null);
  const esImagen = v.cover && /\.(png|jpe?g|webp|gif)$/i.test(v.cover);
  useEffect(() => {
    if (!v.cover || esImagen) return;
    getText(fileUrl(v.id, v.cover)).then((code) => setDoc(documentoPreview({ name: v.cover, code: paraWeb(code) }))).catch(() => setDoc(''));
  }, [v.id, v.cover, v.version, esImagen]);
  if (esImagen) return <img src={fileUrl(v.id, v.cover)} alt="" loading="lazy" />;
  if (doc) return <iframe title={v.title} sandbox="allow-scripts" srcDoc={doc} tabIndex={-1} loading="lazy" />;
  return <span className={`vis-card__sin ${doc === null && v.cover ? 'is-cargando' : ''}`}>{doc === null && v.cover ? '' : t('noPreview')}</span>;
}

/** Galería: todos los visuals del usuario (estudio, chat y agentes), con
 *  búsqueda, filtro por tipo, orden y vista en lista o cuadrícula. */
function Galeria({ t, tc }) {
  const locale = useLocale();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [menuId, setMenuId] = useState(null);
  const [renombrando, setRenombrando] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [tipo, setTipo] = useState('todos');
  const [orden, setOrden] = useState(() => local.get('lixbon.visuals.orden', 'reciente'));
  const [disposicion, setDisposicion] = useState(() => local.get('lixbon.visuals.vista', 'cuadricula'));

  const cargar = useCallback(() => listarVisuals({ limit: 200 }).then(setItems).catch(() => setItems([])), []);
  useEffect(() => { cargar(); }, [cargar]);

  const cambiarOrden = (v) => { setOrden(v); local.set('lixbon.visuals.orden', v); };
  const cambiarDisposicion = (v) => { setDisposicion(v); local.set('lixbon.visuals.vista', v); };

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const lista = (items || []).filter((v) => (tipo === 'todos' || v.kind === tipo) && (!q || v.title.toLowerCase().includes(q)));
    if (orden === 'nombre') return lista.slice().sort((a, b) => a.title.localeCompare(b.title, locale));
    return lista;
  }, [items, busqueda, tipo, orden, locale]);

  const renombrar = async (v, titulo) => {
    setRenombrando(null);
    const limpio = (titulo || '').trim();
    if (!limpio || limpio === v.title) return;
    setItems((prev) => prev.map((x) => (x.id === v.id ? { ...x, title: limpio } : x)));
    try { await actualizarVisual(v.id, { title: limpio }); } catch { cargar(); }
  };
  const borrar = async (v) => {
    setMenuId(null);
    const ok = await confirmar({ titulo: t('deleteConfirmTitle'), texto: t('deleteConfirmText'), etiqueta: tc('delete') });
    if (!ok) return;
    setItems((prev) => prev.filter((x) => x.id !== v.id));
    try { await deleteVisual(v.id); } catch { cargar(); }
  };

  if (items === null) return <div className="vis-galeria__vacio">{t('loadingDesigns')}</div>;
  if (!items.length) return <div className="vis-galeria__vacio">{t('designsWillAppear')}</div>;

  const cuenta = (k) => (items || []).filter((v) => k === 'todos' || v.kind === k).length;
  return (
    <section className="vis-galeria__lista">
      <div className="vis-galeria__barra">
        <h3 className="vis-galeria__titulo">{t('yourDesigns')} <small>{items.length}</small></h3>
        <div className="vis-seg vis-seg--chico" role="group" aria-label={t('kindFilter')}>
          {['todos', 'design', 'marketing'].map((k) => (
            <button key={k} className={`vis-tool ${tipo === k ? 'is-active' : ''}`} onClick={() => setTipo(k)} aria-pressed={tipo === k}>
              {t(`kind_${k}`)} <small className="vis-tool__n">{cuenta(k)}</small>
            </button>
          ))}
        </div>
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
      {!visibles.length && <div className="vis-galeria__vacio">{busqueda.trim() ? t('noDesignsMatch', { q: busqueda.trim() }) : t('noDesignsOfKind')}</div>}
      <div className={`vis-cards ${disposicion === 'cuadricula' ? 'vis-cards--grid' : ''}`}>
        {visibles.map((v) => (
          <article key={v.id} className="vis-card">
            <button className="vis-card__preview" onClick={() => navigate(`/visuals/${v.id}`)} title={t('open')}>
              <Portada v={v} t={t} />
            </button>
            <div className="vis-card__body">
              {renombrando === v.id ? (
                <input className="vis-card__input" autoFocus defaultValue={v.title}
                  onKeyDown={(e) => { if (e.key === 'Enter') renombrar(v, e.target.value); if (e.key === 'Escape') setRenombrando(null); }}
                  onBlur={(e) => renombrar(v, e.target.value)} />
              ) : (
                <button className="vis-card__title" onClick={() => navigate(`/visuals/${v.id}`)}>{v.title}</button>
              )}
              <div className="vis-card__meta">
                <span className={`vis-card__kind is-${v.kind}`}>{t(`kind_${v.kind}`)}</span>
                <span>{t('editedAt', { when: tiempoRelativo(v.updated_at, locale) })}</span>
                {v.pages > 0 && <><span>·</span><span>{v.pages} {v.pages === 1 ? t('page') : t('pagesPlural')}</span></>}
                {v.meta?.origin === 'chat' && <><span>·</span><span>{t('fromChat')}</span></>}
              </div>
              <Menu abierto={menuId === v.id} onCerrar={() => setMenuId(null)} className="vis-card__menu">
                <button className="icon-btn" onClick={() => setMenuId(menuId === v.id ? null : v.id)} aria-label={t('moreOptions')}><IconDots size={16} /></button>
                <Desplegable abierto={menuId === v.id} className="vis-menu__panel vis-menu__panel--derecha">
                  <button className="vis-menu__item" onClick={() => navigate(`/visuals/${v.id}`)}><IconExternal size={15} /><span>{t('open')}</span></button>
                  <button className="vis-menu__item" onClick={() => { setRenombrando(v.id); setMenuId(null); }}><IconPencil size={15} /><span>{tc('rename')}</span></button>
                  <div className="vis-menu__sep" />
                  <button className="vis-menu__item is-danger" onClick={() => borrar(v)}><IconTrash size={15} /><span>{tc('delete')}</span></button>
                </Desplegable>
              </Menu>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── Estudio de un visual ─────────────────────────────────────────────────────

function Salida({ id, version, piece, t }) {
  const [html, setHtml] = useState('');
  const fuente = !piece.output && piece.source;
  useEffect(() => {
    if (!fuente) return;
    getText(fileUrl(id, fuente.path, version)).then((h) => setHtml(paraWeb(h, baseDe(id, fuente.path)))).catch(() => setHtml(''));
  }, [id, fuente, version]);
  // Sin scripts (las piezas animan solo con CSS) y con origen propio: así cargan
  // las fuentes de marca, que un iframe sin origen no puede pedir.
  if (fuente) return <iframe className="vis-pieza__vivo" title={fuente.path} sandbox="allow-same-origin" srcDoc={html} />;
  if (!piece.output) return <p className="vis-stage__empty">{t('notRendered')}</p>;
  const src = fileUrl(id, piece.output.path, version);
  return esVideo(piece.output.path)
    ? <video className="vis-pieza__media" src={src} controls loop muted />
    : <img className="vis-pieza__media" src={src} alt="" />;
}

function Estudio({ id }) {
  const t = useT('visuals');
  const tv = useT('visual');
  const tc = useT('common');
  const locale = useLocale();
  useSeo({ title: t('seoTitle'), noindex: true });
  const { user, loading } = useAuth();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const location = useLocation();

  const [manifest, setManifest] = useState(null);
  const [paginasSrv, setPaginasSrv] = useState([]);
  const [error, setError] = useState('');
  const [verNum, setVerNum] = useState(null);         // null = la última
  const [historial, setHistorial] = useState([]);
  const [nueva, setNueva] = useState(null);           // versión que llegó mientras mirabas otra
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState('');
  const [pagina, setPagina] = useState(null);
  const [vista, setVista] = useState('pagina');       // 'pagina' | 'lienzo'
  const [chatAbierto, setChatAbierto] = useState(true);
  const [verCodigo, setVerCodigo] = useState(false);
  const [copiado, setCopiado] = useState('');
  const [cargando, setCargando] = useState(false);
  const [imagenes, setImagenes] = useState({ available: false, model: null });
  const [tamano, setTamano] = useState(TAMANOS_IMAGEN[0]);
  const [designSystem, setDesignSystem] = useState(DESIGN_SYSTEMS[0]);
  const [inspeccion, setInspeccion] = useState(false);
  const [seleccion, setSeleccion] = useState(null);
  const [ops, setOps] = useState(() => local.get(`lixbon.visuals.ops.${id}`, {}));
  const [prefill, setPrefill] = useState({ texto: '', n: 0 });
  const [menu, setMenu] = useState(null);
  const [editandoTitulo, setEditandoTitulo] = useState(false);
  const [deshechas, setDeshechas] = useState({});
  const [revOps, setRevOps] = useState(0);
  const [ancho, setAncho] = useState(() => local.get('lixbon.visuals.ancho', 'ajustar'));
  const [enlaceRoto, setEnlaceRoto] = useState(null);
  const [panelMovil, setPanelMovil] = useState('chat');
  const [jobs, setJobs] = useState({});
  const [editandoPieza, setEditandoPieza] = useState(null);
  const [doc, setDoc] = useState('');
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const frameRef = useRef(null);
  const hashPendiente = useRef('');
  const paginaRef = useRef(null);
  const stageRef = useRef(null);
  const busyRef = useRef(false);
  const verNumRef = useRef(null);
  const primeroRef = useRef(location.state?.primero || null);
  busyRef.current = busy;
  verNumRef.current = verNum;

  // ── Carga del visual, su chat y su historial ──────────────────────────
  const cargar = useCallback(async (v) => {
    try {
      const m = await getVisual(id, v);
      const paginas = await cargarPaginas(id, m);
      setManifest(m);
      setPaginasSrv(paginas);
      return { manifest: m, paginas };
    } catch (err) {
      setError(err.response?.status === 404 ? tv('notFound') : tv('loadError'));
      return null;
    }
  }, [id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const cargarHistorial = useCallback(() => listarVersiones(id).then(setHistorial).catch(() => {}), [id]);

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate('/auth', { replace: true }); return; }
    cargar(verNum);
  }, [loading, user, verNum, cargar, navigate]);

  const convId = manifest?.meta?.conversation_id || null;
  const cargadoChat = useRef(false);
  useEffect(() => {
    if (!manifest || cargadoChat.current) return;
    cargadoChat.current = true;
    if (manifest.meta?.design_system) setDesignSystem(dsDesde(manifest.meta.design_system));
    if (manifest.meta?.conversation_id) {
      api.get(`/api/conversations/${manifest.meta.conversation_id}/messages`)
        .then((res) => setMessages((prev) => (prev.length ? prev : res.data.messages.map((m) => ({ role: m.role, content: m.content })))))
        .catch(() => {});
    }
    cargarHistorial();
  }, [manifest, cargarHistorial]);

  useEffect(() => {
    if (!user) return;
    api.get('/v1/models').then((res) => {
      const ids = res.data.data.map((m) => m.id).filter((x) => !String(x).startsWith('error:'));
      setModels(ids);
      setModelInfo(Object.fromEntries(res.data.data.map((m) => [m.id, { num_ctx: m.num_ctx, capabilities: m.capabilities || [], name: m.name || m.id }])));
      setModel((c) => c || primeroRef.current?.model || ids[0] || '');
    }).catch(() => {});
    api.get('/api/images/status').then((r) => setImagenes(r.data)).catch(() => {});
    listRenders(id).then((list) => setJobs(rendersPorFuente(list))).catch(() => {});
  }, [user, id]);

  // Avisos en vivo: un agente (MCP), el editor de piezas u otra pestaña guardó.
  useEffect(() => {
    if (loading || !user || error) return undefined;
    const es = new EventSource(eventsUrl(id));
    es.addEventListener('version', (e) => {
      const { version: v } = JSON.parse(e.data);
      cargarHistorial();
      if (busyRef.current) return;
      if (verNumRef.current === null) cargar(null); else setNueva(v);
    });
    es.addEventListener('meta', (e) => {
      const { title } = JSON.parse(e.data);
      setManifest((m) => (m ? { ...m, title } : m));
    });
    es.addEventListener('render', (e) => {
      const ev = JSON.parse(e.data);
      setJobs((prev) => ({ ...prev, [ev.path]: { ...prev[ev.path], status: ev.status, error: ev.error } }));
      if (ev.status === 'done' && !busyRef.current && verNumRef.current === null) cargar(null);
    });
    return () => es.close();
  }, [id, loading, user, error, cargar, cargarHistorial]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── Lo que se ve: la versión guardada o, mientras el modelo escribe, en vivo ──
  const ultimo = messages[messages.length - 1];
  const vivo = useMemo(() => (busy && ultimo?.role === 'assistant' && ultimo.content
    ? aplicarRespuesta(paginasSrv, ultimo.content, { enCurso: true }) : null), [busy, ultimo, paginasSrv]);
  const paginas = vivo ? vivo.files : paginasSrv;
  const viendoUltima = !manifest || manifest.viewing === manifest.version;
  const { pieces, docs } = useMemo(() => (manifest ? piezasDe(manifest) : { pieces: [], docs: [] }), [manifest]);
  const modoImagen = manifest?.meta?.mode === 'image';
  const modoPiezas = !vivo && manifest && (manifest.kind === 'marketing' || modoImagen || pieces.some((p) => p.source?.render)
    || (!paginasSrv.length && pieces.some((p) => p.output)));
  const docActual = docs.find((d) => d.path === pagina);
  const paginaActual = docActual || modoPiezas ? null : (paginas.find((f) => f.name === pagina) || paginas[0] || null);
  const piezaActual = modoPiezas && !docActual
    ? pieces.find((p) => (p.source?.path || p.output?.path) === pagina) || pieces[0] || null : null;
  paginaRef.current = paginaActual?.name || null;
  const versionVista = manifest?.viewing ?? 0;
  const claveOps = paginaActual ? `${versionVista}:${paginaActual.name}` : '';
  const opsActuales = useMemo(() => (vivo ? [] : ops[claveOps] || []), [ops, claveOps, vivo]);
  const generando = !!(vivo && (vivo.abierto || vivo.editando));
  const docPreview = useMemo(() => documentoPreview(paginaActual, opsActuales), [paginaActual, claveOps, revOps]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (docPreview) setCargando(true); }, [docPreview]);

  useEffect(() => {
    if (!docActual) { setDoc(''); return; }
    getText(fileUrl(id, docActual.path, versionVista)).then(setDoc).catch(() => setDoc(''));
  }, [docActual, id, versionVista]);

  // ── Ancho de vista previa ─────────────────────────────────────────────
  const [anchoStage, setAnchoStage] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setAnchoStage(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [manifest?.id, modoPiezas]);
  const anchoFijo = ANCHOS.find((a) => a.id === ancho)?.ancho || 0;
  const marco = anchoFijo && anchoStage ? { ancho: anchoFijo, escala: Math.min(1, anchoStage / anchoFijo), visible: Math.min(anchoFijo, anchoStage) } : null;

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
  useEffect(() => { setEnlaceRoto(null); }, [paginaActual?.name, versionVista]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:inspect', on: inspeccion }, '*');
    if (!inspeccion) setSeleccion(null);
  }, [inspeccion, docPreview]);

  // ── Retoques manuales: se guardan en el navegador hasta convertirlos en versión ──
  const guardarOps = (fn) => setOps((prev) => {
    const next = fn(prev);
    local.set(`lixbon.visuals.ops.${id}`, next);
    return next;
  });
  const aplicarOp = (op) => {
    frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:apply', ...op }, '*');
    guardarOps((prev) => {
      const lista = prev[claveOps] || [];
      const ult = lista[lista.length - 1];
      const mismo = ult && ult.selector === op.selector && claveDeOp(ult) === claveDeOp(op);
      return { ...prev, [claveOps]: mismo ? [...lista.slice(0, -1), op] : [...lista, op] };
    });
    setDeshechas((prev) => (prev[claveOps]?.length ? { ...prev, [claveOps]: [] } : prev));
  };
  const recargarConOps = () => { setSeleccion(null); setRevOps((n) => n + 1); };
  const pilaRehacer = deshechas[claveOps] || [];
  const deshacer = () => {
    if (!opsActuales.length) return;
    const ult = opsActuales[opsActuales.length - 1];
    guardarOps((prev) => ({ ...prev, [claveOps]: (prev[claveOps] || []).slice(0, -1) }));
    setDeshechas((prev) => ({ ...prev, [claveOps]: [...(prev[claveOps] || []), ult] }));
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
  const retocadasDe = (v) => paginasSrv.filter((f) => (ops[`${v}:${f.name}`] || []).length);
  const guardarRetoques = async () => {
    const retocadas = retocadasDe(versionVista);
    if (!retocadas.length) return;
    setGuardando(true);
    setAviso('');
    try {
      const files = retocadas.map((f) => ({ path: f.name, role: 'source', text: aplicarOps(f.code, ops[`${versionVista}:${f.name}`]) }));
      await pushFiles(id, files, manifest.version);
      guardarOps((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${versionVista}:`))));
      setDeshechas({});
      setInspeccion(false);
      setVerNum(null);
      await cargar(null);
      cargarHistorial();
      setAviso(t('manualSaved'));
    } catch (err) {
      setAviso(err.response?.data?.detail?.code === 'stale_base' ? t('manualStale') : errorDe(err, t('saveFailed')));
    } finally {
      setGuardando(false);
    }
  };

  const verVersion = (v) => { setVerNum(v >= (manifest?.version || 0) ? null : v); setNueva(null); setPanelMovil('lienzo'); };
  const elegirAncho = (a) => { setAncho(a); local.set('lixbon.visuals.ancho', a); };
  const irAPagina = (name) => { setPagina(name); setVista('pagina'); };
  const listaNav = modoPiezas ? pieces.map((p) => p.source?.path || p.output?.path) : paginas.map((f) => f.name);
  const paginaRelativa = (paso) => {
    if (listaNav.length < 2) return;
    const actualNom = modoPiezas ? (piezaActual?.source?.path || piezaActual?.output?.path) : paginaActual?.name;
    const i = listaNav.indexOf(actualNom);
    irAPagina(listaNav[(i + paso + listaNav.length) % listaNav.length]);
  };
  const rellenar = (texto) => setPrefill((p) => ({ texto, n: p.n + 1 }));
  const pedirAlModelo = (sel) => {
    rellenar(`${t('elementPrefillBefore')} ${paginaActual?.name || t('thePage')} (<${sel.tag}>): ${sel.html.slice(0, 300)}\n\n${t('elementPrefillMiddle')} `);
    setInspeccion(false);
    setChatAbierto(true);
  };

  const atajosRef = useRef(null);
  atajosRef.current = { deshacer, rehacer, paginaRelativa, inspeccion, verCodigo, menu, paginaActual, editandoPieza };
  useEffect(() => {
    const onKey = (e) => {
      const a = atajosRef.current;
      if (a.editandoPieza) return;
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
      if (k === 'arrowright' || k === ']') { a.paginaRelativa(1); return; }
      if (k === 'arrowleft' || k === '[') { a.paginaRelativa(-1); return; }
      if (!a.paginaActual) return;
      if (k === 'v' && !esSvg(a.paginaActual.name)) { setInspeccion((v) => !v); setVerCodigo(false); setVista('pagina'); }
      else if (k === 'c') { setVerCodigo((v) => !v); setInspeccion(false); setVista('pagina'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Chat del estudio ──────────────────────────────────────────────────
  const asegurarConversacion = async () => {
    if (convId) return convId;
    const nuevo = crypto.randomUUID();
    await actualizarVisual(id, { meta: { conversation_id: nuevo } });
    setManifest((m) => ({ ...m, meta: { ...m.meta, conversation_id: nuevo } }));
    return nuevo;
  };

  const generarImagen = async (prompt, tam = tamano) => {
    const cid = await asegurarConversacion();
    setMessages((prev) => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '', generandoImagen: true }]);
    setBusy(true);
    try {
      const r = await api.post('/api/images/generate', {
        prompt, width: tam.width, height: tam.height, conversation_id: cid, source: 'visuals',
      }, { timeout: 600000 });
      const ext = (r.data.mime || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const n = pieces.filter((p) => p.output && !p.source).length + 1;
      const nombre = `imagen-${n}.${ext}`;
      await pushFiles(id, [{ path: nombre, role: 'output', base64: r.data.image_base64 }], manifest.version);
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: t('imageSaved', { name: nombre }) }]);
      setVerNum(null);
      await cargar(null);
      cargarHistorial();
      setPagina(nombre);
    } catch (err) {
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: errorDe(err, t('couldNotGenerateImage')), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async (texto, images = [], { modelo, tam } = {}) => {
    if (!tieneVisuals(user)) { navigate('/plans'); return; }
    if (modoImagen) { await generarImagen(texto, tam); return; }
    const chosen = modelo || model || models[0];
    if (!chosen) { setAviso(t('noModels')); return; }
    setAviso('');
    setVerNum(null);
    setNueva(null);
    setVista('pagina');
    setInspeccion(false);
    setPanelMovil('lienzo');
    // Siempre sobre la última versión guardada, aunque se estuviera mirando otra.
    const base = verNum === null && manifest ? { manifest, paginas: paginasSrv } : await cargar(null);
    if (!base) return;
    const cid = await asegurarConversacion();
    const isFirst = messages.length === 0;
    const history = [...messages.slice(-CONTEXT_WINDOW), { role: 'user', content: texto, ...(images.length ? { images } : {}) }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
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
        model: chosen,
        messages: compactarHistorial(history),
        conversationId: cid,
        signal: abort.signal,
        system: promptVisuals(designSystem, locale) + contextoArchivos(base.paginas, base.manifest.version),
        source: 'visuals',
        webSearch: 'off',
        think: false,
        onDelta: (delta) => { respuesta += delta; patchLast((last) => ({ ...last, content: last.content + delta })); },
        onReasoning: (delta) => patchLast((last) => ({ ...last, reasoning: (last.reasoning || '') + delta })),
        onFinish: (reason) => { if (reason === 'length') patchLast((last) => ({ ...last, aviso: t('truncatedResponse') })); },
      });
      if (!respuesta.trim()) {
        patchLast((last) => {
          if (last.reasoning && (extraerArchivos(last.reasoning).length || extraerEdiciones(last.reasoning).length)) {
            respuesta = last.reasoning;
            return { ...last, content: last.reasoning, reasoning: '' };
          }
          return { ...last, content: t('emptyModelResponse'), error: true };
        });
      }
      await guardarDe(respuesta, base, patchLast);
      if (isFirst) {
        try {
          const res = await api.post(`/api/conversations/${cid}/generate-title`);
          if (res.data.title) {
            await actualizarVisual(id, { title: res.data.title });
            setManifest((m) => ({ ...m, title: res.data.title }));
          }
        } catch { /* sin título */ }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages((prev) => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)));
        if (respuesta) await guardarDe(respuesta, base, patchLast);
        return;
      }
      patchLast((last) => ({ ...last, content: last.content || err.message, error: !last.content }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  // Convierte lo que escribió el modelo en una versión nueva del visual.
  const guardarDe = async (respuesta, base, patchLast) => {
    const r = aplicarRespuesta(base.paginas, respuesta);
    if (r.fallos.length) patchLast((last) => ({ ...last, fallos: r.fallos }));
    if (!r.cambiadas.length) { await cargar(null); return; }
    try {
      const res = await guardarRespuesta(id, base.manifest.version, r.cambiadas,
        (actuales) => aplicarRespuesta(actuales, respuesta).cambiadas);
      patchLast((last) => ({ ...last, version: res.version, nuevas: r.cambiadas.map((f) => f.name), reaplicada: res.reaplicada }));
      const cargado = await cargar(null);
      cargarHistorial();
      if (cargado && !cargado.paginas.some((f) => f.name === pagina)) setPagina(r.cambiadas[0].name);
    } catch (err) {
      patchLast((last) => ({ ...last, aviso: errorDe(err, t('saveFailed')) }));
      await cargar(null);
    }
  };

  const stop = () => abortRef.current?.abort();

  // Primer mensaje que trae el inicio de Visuals al crear el visual.
  useEffect(() => {
    const p = primeroRef.current;
    if (!p || !manifest || loading) return;
    primeroRef.current = null;
    navigate(location.pathname, { replace: true, state: null });
    send(p.texto, p.images || [], { modelo: p.model, tam: p.tamano });
  }, [manifest, loading]);  // eslint-disable-line react-hooks/exhaustive-deps

  const elegirDesignSystem = (ds) => {
    setDesignSystem(ds);
    local.set('lixbon.visuals.ds', dsGuardable(ds));
    actualizarVisual(id, { meta: { design_system: dsGuardable(ds) } }).catch(() => {});
  };

  const renombrar = async (titulo) => {
    setEditandoTitulo(false);
    const limpio = (titulo || '').trim();
    if (!limpio || limpio === manifest.title) return;
    setManifest((m) => ({ ...m, title: limpio }));
    try { await actualizarVisual(id, { title: limpio }); } catch { cargar(verNum); }
  };

  // ── Piezas de marketing: render y editor ──────────────────────────────
  const renderizar = async (path) => {
    setAviso('');
    try {
      const nuevos = await requestRender(id, [path]);
      setJobs((prev) => ({ ...prev, ...rendersPorFuente(nuevos) }));
    } catch (err) {
      setAviso(errorDe(err, tv('renderFailed', { e: '' })));
    }
  };
  const editarPieza = async () => {
    const html = await getText(fileUrl(id, piezaActual.source.path, versionVista));
    setEditandoPieza({ path: piezaActual.source.path, html, meta: metaDePieza(html) || { kind: 'image', size: '1280x1600', seconds: 0 }, base: manifest.version, msg: '' });
  };
  const guardarPieza = async (html) => {
    setGuardando(true);
    try {
      const res = await pushFiles(id, [{ path: editandoPieza.path, role: 'source', text: html }], editandoPieza.base);
      setEditandoPieza((e) => ({ ...e, base: res.version, msg: res.renders?.length ? tv('editor.savedRendering') : tv('editor.saved') }));
      if (res.renders?.length) setJobs((prev) => ({ ...prev, ...rendersPorFuente(res.renders) }));
      setVerNum(null);
      await cargar(null);
      cargarHistorial();
    } catch (err) {
      const d = err.response?.data?.detail;
      setEditandoPieza((e) => ({ ...e, msg: d?.code === 'stale_base' ? tv('staleSave', { v: d.latest_version }) : tv('editor.saveError') }));
    } finally {
      setGuardando(false);
    }
  };

  // ── Exportar y compartir ──────────────────────────────────────────────
  const codigoFinal = (f) => (esSvg(f.name) ? f.code : aplicarOps(f.code, ops[`${versionVista}:${f.name}`] || []));
  const marcarCopiado = (que) => { setCopiado(que); setTimeout(() => setCopiado(''), 1800); };
  const descargar = async () => {
    setMenu(null);
    if (modoPiezas) {
      const salidas = pieces.filter((p) => p.output);
      if (salidas.length === 1) {
        descargarBlob(await (await fetch(fileUrl(id, salidas[0].output.path, versionVista), { credentials: 'include' })).blob(), salidas[0].output.path.split('/').pop());
        return;
      }
    }
    const archivos = paginasSrv.map((f) => ({ name: f.name, code: codigoFinal(f) }));
    if (archivos.length === 1) {
      descargarBlob(new Blob([archivos[0].code], { type: `${esSvg(archivos[0].name) ? 'image/svg+xml' : 'text/html'};charset=utf-8` }), archivos[0].name);
    } else if (archivos.length) {
      descargarBlob(crearZip(archivos), `${(manifest.title || 'visual').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
    }
  };
  const copiarCodigo = async () => {
    if (!paginaActual) return;
    try { await navigator.clipboard.writeText(codigoFinal(paginaActual)); marcarCopiado('codigo'); } catch { /* sin portapapeles */ }
  };
  const presentar = () => {
    if (!paginas.length) return;
    const html = documentoPresentacion(paginas.map((f) => ({ ...f, code: codigoFinal(f) })), paginaActual?.name, manifest.title);
    window.open(URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), '_blank', 'noopener');
  };
  const enlace = manifest?.share_token ? `${window.location.origin}/s/v/${manifest.share_token}` : null;
  const alternarEnlace = async () => {
    try {
      const r = await setShare(id, !enlace);
      setManifest((m) => ({ ...m, share_token: r.shared ? r.token : null }));
      if (r.shared) { await navigator.clipboard.writeText(`${window.location.origin}/s/v/${r.token}`).catch(() => {}); marcarCopiado('enlace'); }
    } catch { /* sin permiso */ }
  };
  const copiarTexto = async (texto, que) => { try { await navigator.clipboard.writeText(texto); marcarCopiado(que); } catch { /* nada */ } };
  const borrarVisual = async () => {
    setMenu(null);
    const ok = await confirmar({ titulo: t('deleteConfirmTitle'), texto: t('deleteConfirmText'), etiqueta: tc('delete') });
    if (!ok) return;
    await deleteVisual(id);
    navigate('/visuals');
  };

  if (loading || (!manifest && !error)) return <Cargando />;
  if (error) {
    return (
      <div className="vis-page">
        <header className="vis-top"><Link to="/visuals" className="icon-btn" title={t('allDesigns')}><IconArrowLeft size={17} /></Link></header>
        <div className="vis-stage__empty" role="alert">{error}</div>
      </div>
    );
  }
  if (editandoPieza) {
    return (
      <PiezaEditor html={editandoPieza.html} meta={editandoPieza.meta} baseHref={baseDe(id, editandoPieza.path)} saving={guardando}
        message={editandoPieza.msg} onSave={guardarPieza} onClose={() => setEditandoPieza(null)} />
    );
  }

  const puedeEditar = tieneVisuals(user);
  const retocadas = retocadasDe(versionVista);
  const job = piezaActual?.source ? jobs[piezaActual.source.path] : null;
  const renderOcupado = ['queued', 'running'].includes(job?.status);
  const pestanas = modoPiezas
    ? pieces.map((p) => ({ key: p.source?.path || p.output.path, label: nombreCorto(p.source?.path || p.output.path), icono: p.output && !p.source ? IconImage : IconFile, stale: p.stale }))
    : paginas.map((f) => ({ key: f.name, label: nombreCorto(f.name), icono: IconFile, nueva: vivo?.cambiadas.some((c) => c.name === f.name) || vivo?.abierto?.name === f.name, retocada: (ops[`${versionVista}:${f.name}`] || []).length > 0 }));
  const activa = docActual ? docActual.path : modoPiezas ? (piezaActual?.source?.path || piezaActual?.output?.path) : paginaActual?.name;
  const hayAlgo = paginas.length || pieces.length || docs.length;

  return (
    <div className="vis-page vis-editor">
      <header className="vis-top">
        <Link to="/visuals" className="icon-btn" title={t('allDesigns')}><IconArrowLeft size={17} /></Link>
        <button className={`icon-btn vis-top__panel ${chatAbierto ? 'is-active' : ''}`} onClick={() => setChatAbierto((v) => !v)} title={chatAbierto ? t('hideChat') : t('showChat')} aria-pressed={chatAbierto}>
          <IconPanel size={17} />
        </button>
        <div className="vis-titulo">
          {editandoTitulo ? (
            <input className="vis-titulo__input" autoFocus defaultValue={manifest.title} placeholder={t('designNamePlaceholder')}
              onKeyDown={(e) => { if (e.key === 'Enter') renombrar(e.target.value); if (e.key === 'Escape') setEditandoTitulo(false); }}
              onBlur={(e) => renombrar(e.target.value)} />
          ) : (
            <button className="vis-titulo__nombre" onClick={() => setEditandoTitulo(true)} title={t('renameDesign')}>{manifest.title}</button>
          )}
          {manifest.version > 0 && (
            <Menu abierto={menu === 'historial'} onCerrar={() => setMenu(null)}>
              <button className={`vis-chip ${menu === 'historial' ? 'is-active' : ''}`} onClick={() => setMenu(menu === 'historial' ? null : 'historial')} title={t('versions')}>
                <IconHistory size={14} /><span>v{versionVista}</span><IconChevron size={13} open={menu === 'historial'} />
              </button>
              <Desplegable abierto={menu === 'historial'} className="vis-menu__panel">
                <div className="vis-menu__head">{t('versions')}</div>
                {historial.map((h) => (
                  <button key={h.version} className={`vis-menu__item ${versionVista === h.version ? 'is-active' : ''}`} onClick={() => { verVersion(h.version); setMenu(null); }}>
                    <span className="vis-menu__check">{versionVista === h.version && <IconCheck size={14} />}</span>
                    <span className="vis-menu__item-text">
                      <strong>{t('version', { n: h.version })} <small>· {tiempoRelativo(h.created_at, locale)}</small></strong>
                      <small>{[...h.sources, ...h.outputs].map((p) => p.split('/').pop()).join(', ')}</small>
                    </span>
                  </button>
                ))}
              </Desplegable>
            </Menu>
          )}
        </div>

        <div className="vis-top__right">
          <TemaBoton />
          {!modoPiezas && (
            <div className="vis-seg">
              <button className={`vis-tool ${inspeccion ? 'is-active' : ''}`} onClick={() => { setInspeccion((v) => !v); setVista('pagina'); setVerCodigo(false); }} disabled={!paginaActual || esSvg(paginaActual.name) || !!vivo || !viendoUltima} title={`${t('selectHint')} (V)`}>
                <IconPointer size={14} /> {t('select')}
              </button>
              <button className={`vis-tool ${verCodigo ? 'is-active' : ''}`} onClick={() => { setVerCodigo((v) => !v); setInspeccion(false); setVista('pagina'); }} disabled={!paginaActual} title={`${t('codeHint')} (C)`}>
                <IconCode size={14} /> {t('code')}
              </button>
            </div>
          )}
          {!modoPiezas && <DesignSystemPicker value={designSystem} onChange={elegirDesignSystem} compacto />}
          <span className="vis-vdiv" />
          {!modoPiezas && <button className="vis-tool" onClick={presentar} disabled={!paginas.length} title={t('presentHint')}><IconExternal size={14} /> {t('present')}</button>}
          <Menu abierto={menu === 'compartir'} onCerrar={() => setMenu(null)}>
            <button className="vis-tool vis-tool--blanco" onClick={() => setMenu(menu === 'compartir' ? null : 'compartir')}><IconShare size={14} /> {t('share')}</button>
            <Desplegable abierto={menu === 'compartir'} className="vis-menu__panel vis-menu__panel--derecha vis-share">
              <div className="vis-share__head">
                <strong>{t('share')}</strong>
                <button className="icon-btn" onClick={() => setMenu(null)} aria-label={t('close')}><IconX size={15} /></button>
              </div>
              <div className="vis-share__sec">
                <div className="vis-share__row">
                  <span className="vis-menu__item-text"><strong>{t('publicLink')}</strong><small>{enlace ? t('publicLinkOn') : t('publicLinkOff')}</small></span>
                  <button className={`vis-switch ${enlace ? 'is-on' : ''}`} role="switch" aria-checked={!!enlace} aria-label={t('publicLink')} onClick={alternarEnlace} />
                </div>
                {enlace && (
                  <div className="vis-field">
                    <span className="vis-field__valor">{enlace.replace(/^https?:\/\//, '')}</span>
                    <button className="vis-field__btn" onClick={() => copiarTexto(enlace, 'enlace')}><IconCopy size={13} /> {copiado === 'enlace' ? t('copied') : t('copy')}</button>
                  </div>
                )}
              </div>
              <div className="vis-share__sec">
                <div className="vis-menu__head">{t('cliTitle')}</div>
                <p className="vis-share__hint">{t('cliHint')}</p>
                <div className="vis-field">
                  <span className="vis-field__valor mono">/visual codigo {id}</span>
                  <button className="vis-field__btn" onClick={() => copiarTexto(`/visual codigo ${id}`, 'cli')}><IconCopy size={13} /> {copiado === 'cli' ? t('copied') : t('copy')}</button>
                </div>
              </div>
              <div className="vis-share__sec">
                <div className="vis-menu__head">{t('export')}</div>
                <div className="vis-share__tiles">
                  <button className="vis-tile" onClick={descargar} disabled={!hayAlgo}>
                    <IconDownload size={16} />
                    <strong>{paginasSrv.length > 1 ? t('downloadZip') : modoPiezas ? t('download') : t('downloadHtml')}</strong>
                    <small>{paginasSrv.length > 1 ? t('pagesHtml', { n: paginasSrv.length }) : t('selfContained')}</small>
                  </button>
                  {!modoPiezas && (
                    <button className="vis-tile" onClick={copiarCodigo} disabled={!paginaActual}>
                      <IconCode size={16} />
                      <strong>{copiado === 'codigo' ? t('codeCopied') : t('copyCode')}</strong>
                      <small>{paginaActual?.name}</small>
                    </button>
                  )}
                </div>
              </div>
              <div className="vis-share__sec">
                <button className="vis-menu__item is-danger" onClick={borrarVisual}><IconTrash size={15} /><span>{tc('delete')}</span></button>
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
            {t('mobileDesign')}{manifest.version > 0 && <span className="vis-panel-toggle__n">v{versionVista}</span>}
          </button>
        </div>
      </div>

      <div className={`vis-split ${chatAbierto ? '' : 'is-solo-lienzo'} ${inspeccion && seleccion ? 'con-inspector' : ''} ${panelMovil === 'lienzo' ? 'is-lienzo' : 'is-chat'}`}>
        <section className="vis-chat">
          <div className="chat-scroll" ref={scrollRef}>
            <div className="chat-thread vis-thread">
              {!messages.length && (
                <p className="vis-thread__vacio">{!manifest.meta?.conversation_id && manifest.version > 0 ? t('studioFromAgent') : t('studioEmpty')}</p>
              )}
              {messages.map((m, i) => (
                m.role === 'user' ? (
                  <div key={i} className="msg msg--user">{m.content}</div>
                ) : (
                  <div key={i} className={`msg msg--assistant ${m.error ? 'msg--error' : ''}`}>
                    {(() => {
                      if (m.generandoImagen) return <span className="msg__thinking">{t('generatingImage')}</span>;
                      if (m.error) return <MensajeError>{m.content}</MensajeError>;
                      const activo = busy && i === messages.length - 1;
                      const r = activo && vivo ? vivo : null;
                      const archivos = paginasDe(m.content);
                      const cuerpo = sinArchivos(m.content);
                      return (
                        <>
                          {m.reasoning && <Razonamiento texto={m.reasoning} activo={activo && !m.content} />}
                          {cuerpo ? <Markdown streaming={activo}>{cuerpo}</Markdown>
                            : (!archivos.length && !m.reasoning && <span className="msg__thinking">{t('thinking')}</span>)}
                          {m.aviso && <p className="msg__aviso">{m.aviso}</p>}
                          {m.version ? (
                            <button className={`vis-version-chip ${versionVista === m.version ? 'is-active' : ''}`} onClick={() => verVersion(m.version)}>
                              v{m.version} · {m.nuevas.join(', ')}
                            </button>
                          ) : archivos.length > 0 && !activo && (
                            <button className="vis-version-chip" onClick={() => { verVersion(manifest.version); irAPagina(archivos[0]); }}>
                              {archivos.join(', ')}
                            </button>
                          )}
                          {m.reaplicada && <p className="msg__aviso">{t('reappliedOnLatest')}</p>}
                          {(m.fallos || []).map((f) => (
                            <p key={f.name} className="msg__aviso">
                              {t('editDoesntFit', { name: f.name, motivo: f.motivo })}{' '}
                              <button className="vis-link" onClick={() => send(t('requestFullFileMessage', { name: f.name }))}>{t('requestFullFile')}</button>
                            </p>
                          ))}
                          {r?.editando && (
                            <div className="vis-trabajo">
                              <span className="vis-trabajo__dot" />
                              <span>{t('editingBefore')} <strong>{r.editando.name}</strong>{t('editingAfter')}</span>
                              <span className="vis-trabajo__meta">{r.editando.pares.length} {r.editando.pares.length === 1 ? t('change') : t('changes')}</span>
                            </div>
                          )}
                          {r?.abierto && (
                            <div className="vis-trabajo">
                              <span className="vis-trabajo__dot" />
                              <span>{t('writingBefore')} <strong>{r.abierto.name}</strong>{t('writingAfter')}</span>
                              <span className="vis-trabajo__meta">{r.abierto.code.split('\n').length} {t('lines')}</span>
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
            {puedeEditar ? (
              <>
                {modoImagen && (
                  <div className="vis-tamanos vis-tamanos--compacto">
                    {TAMANOS_IMAGEN.map((tm) => (
                      <button key={tm.id} className={`vis-tool ${tamano.id === tm.id ? 'is-active' : ''}`} onClick={() => setTamano(tm)} disabled={!imagenes.available}>{tm.label}</button>
                    ))}
                  </div>
                )}
                <ChatInput key={prefill.n} initialText={prefill.texto} onSend={send} onStop={stop} busy={busy || guardando} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
                  placeholder={modoImagen ? t('imagePlaceholder') : t('editPlaceholder')} />
              </>
            ) : (
              <p className="vis-composer__bloqueo">{t('viewOnly')} <Link to="/plans">{t('seePlans')}</Link></p>
            )}
          </div>
        </section>

        <section className="vis-canvas">
          <div className="vis-lienzo">
            {(pestanas.length > 0 || docs.length > 0) && (
              <div className="vis-stagebar">
                <div className="vis-pestanas" role="tablist" aria-label={t('pages')}>
                  {!modoPiezas && paginas.length > 1 && (
                    <button role="tab" aria-selected={vista === 'lienzo'} className={`vis-pestana ${vista === 'lienzo' ? 'is-on' : ''}`}
                      onClick={() => { setVista('lienzo'); setInspeccion(false); setVerCodigo(false); }} title={t('allPagesAtOnce', { n: paginas.length })}>
                      <IconLayers size={14} /> {t('canvas')}
                    </button>
                  )}
                  {pestanas.map((p) => {
                    const Icono = p.icono;
                    const on = (modoPiezas || vista === 'pagina') && activa === p.key;
                    return (
                      <button key={p.key} role="tab" aria-selected={on} className={`vis-pestana ${on ? 'is-on' : ''}`} onClick={() => irAPagina(p.key)} title={p.key}>
                        <Icono size={13} /> {p.label}
                        {p.nueva && <span className="vis-pestana__nueva" title={t('changedInVersion')} />}
                        {p.retocada && <span className="vis-pestana__retoque" title={t('hasManualEdits')}>✎</span>}
                        {p.stale && <span className="vis-pestana__nueva is-warn" title={tv('staleOutput')} />}
                      </button>
                    );
                  })}
                  {docs.map((d) => (
                    <button key={d.path} role="tab" aria-selected={activa === d.path} className={`vis-pestana ${activa === d.path ? 'is-on' : ''}`} onClick={() => irAPagina(d.path)} title={d.path}>
                      <IconFile size={13} /> {d.path.split('/').pop()}
                    </button>
                  ))}
                </div>
                <div className="vis-stagebar__der">
                  {!modoPiezas && vista === 'pagina' && (opsActuales.length > 0 || pilaRehacer.length > 0) && (
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
                  {!modoPiezas && retocadas.length > 0 && viendoUltima && !vivo && (
                    <button className="vis-tool vis-tool--blanco" onClick={guardarRetoques} disabled={guardando} title={t('saveManualHint')}>
                      <IconCheck size={14} /> {guardando ? t('saving') : t('saveManual', { n: retocadas.length })}
                    </button>
                  )}
                  {modoPiezas && piezaActual && (
                    <>
                      {piezaActual.source && viendoUltima && puedeEditar && <button className="vis-tool" onClick={editarPieza}><IconPencil size={14} /> {tv('edit')}</button>}
                      {piezaActual.source?.render && viendoUltima && puedeEditar && (
                        <button className="vis-tool" onClick={() => renderizar(piezaActual.source.path)} disabled={renderOcupado}>
                          {renderOcupado ? tv('rendering') : piezaActual.output ? tv('rerender') : tv('render')}
                        </button>
                      )}
                      {piezaActual.output && (
                        <a className="vis-tool" href={fileUrl(id, piezaActual.output.path, versionVista)} download={piezaActual.output.path.split('/').pop()}><IconDownload size={14} /> {tv('download')}</a>
                      )}
                    </>
                  )}
                  {!modoPiezas && vista === 'pagina' && !verCodigo && !docActual && (
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
            {!viendoUltima && (
              <div className="vis-aviso" role="status">
                <IconHistory size={14} />
                <span>{t('viewingOldVersion', { n: versionVista, total: manifest.version })}</span>
                <button className="vis-aviso__btn" onClick={() => verVersion(manifest.version)}>{t('backToLatest')}</button>
              </div>
            )}
            {viendoUltima && nueva && nueva > manifest.version && (
              <div className="vis-aviso" role="status">
                <span>{tv('liveNew', { v: nueva })}</span>
                <button className="vis-aviso__btn" onClick={() => { setNueva(null); cargar(null); }}>{tv('liveShow')}</button>
              </div>
            )}
            {aviso && (
              <div className="vis-aviso" role="status">
                <span>{aviso}</span>
                <button className="icon-btn" onClick={() => setAviso('')} aria-label={t('close')}><IconX size={13} /></button>
              </div>
            )}
            {modoPiezas && job?.status === 'failed' && <div className="vis-aviso" role="status"><span>{tv('renderFailed', { e: job.error || '' })}</span></div>}
            {modoPiezas && piezaActual?.stale && !renderOcupado && <div className="vis-aviso" role="status"><span>{tv('staleOutput')}</span></div>}
            <div className="vis-stage" ref={stageRef}>
              {docActual ? (
                <div className="vis-doc"><Markdown>{doc}</Markdown></div>
              ) : modoPiezas ? (
                piezaActual ? <div className="vis-pieza"><Salida id={id} version={versionVista} piece={piezaActual} t={tv} /></div>
                  : <div className="vis-stage__empty">{busy ? t('generatingImageShort') : t('previewWillAppear')}</div>
              ) : paginaActual ? (
                vista === 'lienzo' ? (
                  <Board paginas={paginas} documento={(f) => documentoPreview(f, vivo ? [] : ops[`${versionVista}:${f.name}`] || [])}
                    onAbrir={irAPagina} clave={id} activa={paginaActual?.name} />
                ) : verCodigo ? (
                  <CodigoVista nombre={paginaActual.name} codigo={codigoFinal(paginaActual)} retoques={opsActuales.length}
                    copiado={copiado === 'codigo'} onCopiar={copiarCodigo} t={t} />
                ) : (
                  <div className={`vis-frame ${marco ? 'is-fijo' : ''}`} style={marco ? { width: marco.visible } : undefined}>
                    <iframe key={revOps} ref={frameRef} title={t('previewTitle')} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={docPreview}
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
                  {generando ? <span className="vis-trabajo"><span className="vis-trabajo__dot" />{t('writingDesign')}</span> : t('previewWillAppear')}
                </div>
              )}
              {enlaceRoto && vista === 'pagina' && !verCodigo && (
                <div className="vis-enlace-roto" role="status">
                  <span>{t('brokenLink', { page: enlaceRoto })}</span>
                  <button className="vis-aviso__btn" onClick={() => { rellenar(t('createMissingPage', { page: /\.html?$/i.test(enlaceRoto) ? enlaceRoto : `${enlaceRoto.replace(/^\/+/, '') || 'index'}.html`, from: paginaActual?.name || 'index.html' })); setEnlaceRoto(null); setPanelMovil('chat'); setChatAbierto(true); }}>{t('askToCreateIt')}</button>
                  <button className="icon-btn" onClick={() => setEnlaceRoto(null)} aria-label={t('close')}><IconX size={13} /></button>
                </div>
              )}
              {generando && paginaActual && <div className="vis-stage__badge">{t('newVersionOnTheWay')}</div>}
              {inspeccion && !seleccion && <div className="vis-stage__badge">{t('clickToEdit')}</div>}
            </div>
          </div>
          {inspeccion && seleccion && (
            <Inspector seleccion={seleccion} onAplicar={aplicarOp} onPedir={pedirAlModelo}
              onCerrar={() => { setSeleccion(null); frameRef.current?.contentWindow?.postMessage({ type: 'lixbon:deselect' }, '*'); }} />
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
