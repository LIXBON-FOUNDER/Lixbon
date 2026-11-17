// Coding: sesiones en la nube. Una sesión es una conversación como la del chat
// (mismo cuadro de mensaje, línea de trabajo, «Te necesita» y panel derecho),
// pero con el agente del CLI trabajando en un entorno aislado con el repo
// clonado. La conversación llega por el relay /remote (lib/remote.js).
import '../styles/coding.css';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { useAuth } from '../hooks/useAuth';
import { useConfirmar } from '../hooks/useConfirmar';
import { useDismiss } from '../hooks/useDismiss';
import { api } from '../lib/api';
import { initialRemoteState, openEventStream, remoteReducer } from '../lib/remote';
import { describeRemoteTool } from '../lib/toolText';
import { mensajeDeError } from '../lib/adjuntos';
import {
  cambiarSesion, crearSesion, eliminarSesion, enviarMensaje, estadoCoding, pausarSesion,
  pedirPr, reanudarSesion, reintentarSesion, urlVistaPrevia, MODOS_CODING, prsSesion, entornoActivo,
  ramasRepo, leerEntorno, guardarEntorno, cambiarRemota,
} from '../lib/coding';
import { anadirNota } from '../lib/espacios';
import { MenuEspacio } from './EspacioChat';
import { conectarGithub, estadoGithub, guardarModo, leerModo, reposGithub } from '../lib/github';
import { useShell } from './AppShell';
import { HeroInicio } from './Cielo';
import { ChatInput } from './ChatInput';
import { MenuModo } from './GithubChat';
import { ShimmerText } from './ShimmerText';
import { LineaTrabajo, ResumenTrabajo, iconoDe } from './LineaTrabajo';
import { LogoMark } from './Logo';
import { LogoMarca } from './LogosMarcas';
import { Markdown } from './Markdown';
import { MensajeError } from './Mensajes';
import { Recorte } from './Pulido';
import { Desplegable } from './Desplegable';
import {
  IconAlert, IconChevron, IconCopiar, IconExternal, IconMenu, IconPause, IconPencil, IconRefresh,
  IconTrash, IconX, Icono,
} from './Icons';

// ------------------------------------------------------------------ modelos

function useModelos(user) {
  const [models, setModels] = useState([]);
  const [modelInfo, setModelInfo] = useState({});
  useEffect(() => {
    if (!user) return undefined;
    let vivo = true;
    api.get('/v1/models').then((res) => {
      if (!vivo) return;
      const data = res.data.data || [];
      setModels(data.map((m) => m.id).filter((id) => !String(id).startsWith('error:')));
      setModelInfo(Object.fromEntries(data.map((m) => [m.id, {
        num_ctx: m.num_ctx, context_length: m.context_length, capabilities: m.capabilities || [], name: m.name || m.id,
        reasoning: m.reasoning, real: m.model || m.id,
      }])));
    }).catch(() => {});
    return () => { vivo = false; };
  }, [user]);
  return { models, modelInfo };
}

// Repo y rama de una sesión: se ven en el pie pero no se cambian.
function RepoFijo({ repo, t }) {
  if (!repo) return null;
  return (
    <div className="modelo-menu gh-menu">
      <span className="modelo-menu__btn is-on is-fijo" title={t('repoTitle', { repo })} aria-label={t('repoTitle', { repo })}>
        <LogoMarca id="github" size={15} />
        <span className="modelo-menu__nombre">{repo.split('/')[1]}</span>
      </span>
    </div>
  );
}

function RamaFija({ rama, t }) {
  if (!rama) return null;
  return (
    <div className="modelo-menu gh-menu cd-rama">
      <span className="modelo-menu__btn is-fijo" title={t('branchTitle')} aria-label={`${t('branchTitle')}: ${rama}`}>
        <Icono nombre="bifurcar" size={15} />
        <span className="modelo-menu__nombre">{rama}</span>
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ inicio

export function CodingInicio({ remoto = null }) {
  const t = useT('coding');
  const { user, loading: cargandoUsuario } = useAuth();
  const { loadRemotas, abrirNuevaSesion } = useShell();
  const navigate = useNavigate();
  const { models, modelInfo } = useModelos(user);
  const [model, setModel] = useState('');
  const [estado, setEstado] = useState(null);
  const [entorno, setEntorno] = useState(leerEntorno);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  // Espacio de la sesión: hereda su repo, sus archivos y su memoria aprobada.
  const [espacio, setEspacio] = useState(null);
  const elegirEspacio = (e) => {
    setEspacio(e);
    if (e?.repo && e.repo !== entorno?.repo) {
      const n = { ...(entorno || {}), repo: e.repo, base: undefined };
      guardarEntorno(n);
      setEntorno(n);
    }
  };

  const cargar = useCallback(() => {
    setEstado(null);
    if (!user) return;
    estadoCoding().then(setEstado).catch(() => setEstado({ disponible: false, plan_ok: true, github: true }));
  }, [user]);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (!model && models.length) setModel(models[0]); }, [models, model]);
  // El modal guarda el entorno elegido: al volver se ve aquí.
  useEffect(() => {
    const f = () => setEntorno(leerEntorno());
    window.addEventListener('coding:entorno', f);
    return () => window.removeEventListener('coding:entorno', f);
  }, []);

  const modo = entorno?.mode || leerModo();
  const elegirModo = (m) => {
    guardarModo(m);
    const e = { ...(entorno || {}), mode: m };
    if (entorno) guardarEntorno(e);
    setEntorno(entorno ? e : null);
  };

  const enviar = async (texto, imagenes = []) => {
    // Sin entorno elegido, el modal lo pide y se lleva el mensaje.
    if (!entorno?.repo) { abrirNuevaSesion({ texto, imagenes, model }); return; }
    setEnviando(true);
    setError('');
    let session = null;
    try {
      ({ session } = await crearSesion(entorno.repo, modo, model, entorno.base, espacio?.id));
      await enviarMensaje(session.id, texto, imagenes);
      loadRemotas();
      navigate(`/coding?s=${session.id}`);
    } catch (err) {
      // La sesión ya existe y guardó el mensaje: si el entorno no arrancó, se
      // abre igual y allí se ve el aviso con «Reintentar» (nada se pierde).
      if (session && [429, 503].includes(err.response?.status)) {
        loadRemotas();
        navigate(`/coding?s=${session.id}`);
        return;
      }
      setError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
      setEnviando(false);
    }
  };

  const nombre = user?.first_name;
  let cuerpo;
  if (!user && !cargandoUsuario) {
    cuerpo = (
      <div className="cd-inicio-aviso">
        <h2 className="chat-hero__title">{t('loginTitle')}</h2>
        <p>{t('loginText')}</p>
        <div className="cd-botones">
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => navigate('/auth')}>{t('loginBtn')}</button>
        </div>
        {remoto}
      </div>
    );
  } else if (!estado) {
    cuerpo = null;
  } else if (!estado.plan_ok) {
    cuerpo = (
      <div className="cd-inicio-aviso">
        <h2 className="chat-hero__title">{t('planTitle')}</h2>
        <p>{t('planText')}</p>
        <div className="cd-botones">
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => navigate('/plans')}>{t('planBtn')}</button>
        </div>
        {remoto}
      </div>
    );
  } else if (!estado.github) {
    cuerpo = (
      <div className="cd-inicio-aviso">
        <h2 className="chat-hero__title">{t('connectTitle')}</h2>
        <p>{t('connectText')}</p>
        <div className="cd-botones">
          <button type="button" className="pill-btn pill-btn--primary" onClick={() => conectarGithub('/coding')}>{t('connectBtn')}</button>
        </div>
      </div>
    );
  } else if (!estado.disponible) {
    cuerpo = (
      <div className="cd-inicio-aviso">
        <h2 className="chat-hero__title">{t('unavailableTitle')}</h2>
        <p>{t('unavailableText')}</p>
        <div className="cd-botones">
          <button type="button" className="pill-btn pill-btn--outline" onClick={cargar}>{t('retry')}</button>
        </div>
      </div>
    );
  } else {
    const repoCorto = entorno?.repo?.split('/')[1];
    cuerpo = (
      <div className="cd-inicio">
        <h2 className="chat-hero__title">
          <LogoMark size={34} className="chat-hero__marca" />
          <span>{nombre ? t('greeting', { name: nombre }) : t('greetingNoName')}</span>
        </h2>
        <p className="cd-inicio__sub">{espacio ? t('homeSubSpace', { nombre: espacio.nombre }) : t('homeSub')}</p>
        <div className="chat-hero__input">
          <ChatInput onSend={enviar} busy={enviando} models={models} modelInfo={modelInfo} model={model} onModelChange={setModel}
            placeholder={t('placeholderNew')} contextUso={null}
            tools={(
              <>
                <div className="modelo-menu gh-menu">
                  <button type="button" className={`modelo-menu__btn ${repoCorto ? 'is-on' : 'cd-entorno-vacio'}`} aria-haspopup="dialog"
                    onClick={() => abrirNuevaSesion({ model })} title={t('environmentHint')}>
                    <Icono nombre="remoto" size={16} />
                    <span className="modelo-menu__nombre">{repoCorto ? t('cloudRepo', { repo: repoCorto }) : t('pickEnvironment')}</span>
                    <IconChevron size={14} className="modelo-menu__chevron" />
                  </button>
                </div>
                <MenuEspacio espacio={espacio} onChange={elegirEspacio} />
                <MenuModo modo={modo} onChange={elegirModo} />
              </>
            )} />
          {error && <p className="chat-input__error" role="alert">{error}</p>}
        </div>
        <div className="cd-hechos">
          <span><Icono nombre="bifurcar" size={14} /> {t('factBranch')}</span>
          <span><Icono nombre="candado" size={14} /> {t('factMain', { rama: entorno?.base || 'main' })}</span>
          <span><Icono nombre="servidor" size={14} /> {t('factEnvs', { n: estado.activas ?? 0, max: estado.max_activas ?? 2 })}</span>
        </div>
      </div>
    );
  }
  return <HeroInicio>{cuerpo}</HeroInicio>;
}

// ------------------------------------------------------------------ nueva sesión

// «Nueva sesión»: dónde trabaja el agente. En la nube (repo, rama base, modo)
// o en tu equipo (/remote desde el CLI o el IDE). Lo abre la barra, Ctrl K o
// el selector de entorno del inicio; si trae un mensaje, lo envía al crear.
export function NuevaSesionModal({ inicial = {}, onClose }) {
  const t = useT('coding');
  const tg = useT('github');
  const navigate = useNavigate();
  const { loadRemotas, remotas = [] } = useShell();
  const previo = leerEntorno();
  const [tab, setTab] = useState(inicial.tab || 'nube');
  const [gh, setGh] = useState(null);
  const [repos, setRepos] = useState(null);
  const [repo, setRepo] = useState(previo?.repo || '');
  const [ramas, setRamas] = useState(null);
  const [base, setBase] = useState(previo?.base || '');
  const [modo, setModo] = useState(previo?.mode || leerModo());
  const [estado, setEstado] = useState(null);
  const [abierto, setAbierto] = useState(null); // 'repo' | 'base' | 'modo' | 'red' | 'prep'
  const [busca, setBusca] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    estadoGithub().then(setGh).catch(() => setGh({ configured: false }));
    estadoCoding().then(setEstado).catch(() => {});
  }, []);
  useEffect(() => {
    if (!gh?.connected) return;
    reposGithub().then((d) => setRepos(d.repos || [])).catch(() => setRepos([]));
  }, [gh]);
  useEffect(() => {
    if (!repo) { setRamas(null); return; }
    let vivo = true;
    setRamas(null);
    ramasRepo(repo).then((d) => {
      if (!vivo) return;
      setRamas(d.branches || []);
      setBase((b) => (b && d.branches.includes(b) ? b : d.default_branch));
    }).catch(() => { if (vivo) setRamas([]); });
    return () => { vivo = false; };
  }, [repo]);
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [onClose]);

  // «En tu equipo»: cuando aparece una sesión nueva del CLI o el IDE, se abre.
  const conocidas = useRef(new Set(remotas.map((r) => r.id)));
  useEffect(() => {
    if (tab !== 'equipo') return;
    const nueva = remotas.find((r) => r.source !== 'cloud' && r.status === 'online' && !conocidas.current.has(r.id));
    if (nueva) { navigate(`/remote?s=${nueva.id}`); onClose(); }
  }, [remotas, tab, navigate, onClose]);
  useEffect(() => {
    if (tab !== 'equipo') return undefined;
    const timer = setInterval(loadRemotas, 3000);
    return () => clearInterval(timer);
  }, [tab, loadRemotas]);

  const crear = async () => {
    if (!repo || creando) return;
    setCreando(true);
    setError('');
    guardarEntorno({ repo, base, mode: modo });
    guardarModo(modo);
    window.dispatchEvent(new Event('coding:entorno'));
    let session = null;
    try {
      ({ session } = await crearSesion(repo, modo, inicial.model, base));
      if (inicial.texto || inicial.imagenes?.length) await enviarMensaje(session.id, inicial.texto || '', inicial.imagenes || []);
      loadRemotas();
      navigate(`/coding?s=${session.id}`);
      onClose();
    } catch (err) {
      if (session) { loadRemotas(); navigate(`/coding?s=${session.id}`); onClose(); return; }
      setError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
      setCreando(false);
    }
  };

  const lista = (repos || []).filter((r) => !busca.trim() || r.full_name.toLowerCase().includes(busca.trim().toLowerCase()));
  const alternar = (k) => setAbierto((a) => (a === k ? null : k));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cd-modal" role="dialog" aria-modal="true" aria-labelledby="cd-modal-t" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title" id="cd-modal-t">{t('newSession')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}><IconX /></button>
        </div>
        <div className="cd-mtabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'nube'} className={`cd-mtab ${tab === 'nube' ? 'is-on' : ''}`} onClick={() => setTab('nube')}>
            <Icono nombre="remoto" size={16} /> {t('inCloud')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'equipo'} className={`cd-mtab ${tab === 'equipo' ? 'is-on' : ''}`} onClick={() => setTab('equipo')}>
            <Icono nombre="monitor" size={16} /> {t('onYourMachine')}
          </button>
        </div>

        {tab === 'nube' ? (
          gh && !gh.connected ? (
            <div className="cd-modal__vacio">
              <p className="cd-ayuda">{t('connectText')}</p>
              <button type="button" className="pill-btn pill-btn--primary" onClick={() => conectarGithub('/coding')}>{t('connectBtn')}</button>
            </div>
          ) : (
            <>
              <div className="cd-campo">
                <span className="cd-lab" id="cd-l-repo">{t('repository')}</span>
                <button type="button" className={`cd-sel ${repo ? '' : 'is-vacio'}`} aria-labelledby="cd-l-repo" aria-expanded={abierto === 'repo'}
                  onClick={() => alternar('repo')}>
                  <LogoMarca id="github" size={16} /><span>{repo || t('pickRepo')}</span><IconChevron size={16} open={abierto === 'repo'} className="cd-sel__chev" />
                </button>
                {abierto === 'repo' && (
                  <div className="cd-opciones" role="listbox" aria-labelledby="cd-l-repo">
                    <input className="cd-opciones__busca" placeholder={tg('searchRepo')} value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus />
                    {repos === null ? <p className="cd-ayuda">{t('loading')}</p>
                      : lista.length === 0 ? <p className="cd-ayuda">{t('noRepos')}</p>
                        : lista.map((r) => (
                          <button key={r.full_name} type="button" role="option" aria-selected={repo === r.full_name}
                            className={`cd-opcion ${repo === r.full_name ? 'is-sel' : ''}`}
                            onClick={() => { setRepo(r.full_name); setAbierto(null); setBusca(''); }}>
                            <span>{r.full_name}</span>{r.private && <small>{tg('private')}</small>}
                          </button>
                        ))}
                  </div>
                )}
                <p className="cd-ayuda">{t('repoHelp')}</p>
              </div>
              <div className="cd-dos">
                <div className="cd-campo">
                  <span className="cd-lab" id="cd-l-base">{t('baseBranch')}</span>
                  <button type="button" className="cd-sel" aria-labelledby="cd-l-base" disabled={!repo || !ramas} aria-expanded={abierto === 'base'}
                    onClick={() => alternar('base')}>
                    <Icono nombre="bifurcar" size={16} /><span>{base || (repo ? t('loading') : '—')}</span><IconChevron size={16} open={abierto === 'base'} className="cd-sel__chev" />
                  </button>
                  {abierto === 'base' && ramas && (
                    <div className="cd-opciones" role="listbox" aria-labelledby="cd-l-base">
                      {ramas.map((b) => (
                        <button key={b} type="button" role="option" aria-selected={base === b} className={`cd-opcion ${base === b ? 'is-sel' : ''}`}
                          onClick={() => { setBase(b); setAbierto(null); }}><span>{b}</span></button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cd-campo">
                  <span className="cd-lab" id="cd-l-modo">{t('agentMode')}</span>
                  <button type="button" className="cd-sel" aria-labelledby="cd-l-modo" aria-expanded={abierto === 'modo'} onClick={() => alternar('modo')}>
                    <span>{tg(`mode_${modo}`)}</span><IconChevron size={16} open={abierto === 'modo'} className="cd-sel__chev" />
                  </button>
                  {abierto === 'modo' && (
                    <div className="cd-opciones" role="listbox" aria-labelledby="cd-l-modo">
                      {MODOS_CODING.map((m) => (
                        <button key={m} type="button" role="option" aria-selected={modo === m} className={`cd-opcion cd-opcion--dos ${modo === m ? 'is-sel' : ''}`}
                          onClick={() => { setModo(m); setAbierto(null); }}>
                          <span>{tg(`mode_${m}`)}</span><small>{tg(`mode_${m}_d`)}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="cd-ajustes">
                <button type="button" className="cd-ajuste" aria-expanded={abierto === 'red'} onClick={() => alternar('red')}>
                  <Icono nombre="globo" size={18} />
                  <span><b>{t('networkAccess')}</b><small>{abierto === 'red' ? t('networkDetail') : t('networkSummary')}</small></span>
                  <IconChevron size={16} open={abierto === 'red'} />
                </button>
                <button type="button" className="cd-ajuste" aria-expanded={abierto === 'prep'} onClick={() => alternar('prep')}>
                  <Icono nombre="terminal" size={18} />
                  <span><b>{t('setup')}</b><small>{abierto === 'prep' ? t('setupDetail') : t('setupSummary')}</small></span>
                  <IconChevron size={16} open={abierto === 'prep'} />
                </button>
                <div className="cd-ajuste is-off" aria-disabled="true">
                  <Icono nombre="llave" size={18} />
                  <span><b>{t('envVars')}</b><small>{t('comingSoon')}</small></span>
                </div>
              </div>
              {error && <p className="page__error" role="alert">{error}</p>}
              <div className="cd-mpie">
                {estado && <small><Icono nombre="servidor" size={14} /> {t('factEnvs', { n: estado.activas ?? 0, max: estado.max_activas ?? 2 })}</small>}
                <span className="cd-botones">
                  <button type="button" className="pill-btn pill-btn--outline" onClick={onClose}>{t('cancel')}</button>
                  <button type="button" className="pill-btn pill-btn--primary" onClick={crear} disabled={!repo || !base || creando}>
                    {creando ? t('creating') : t('createSession')}
                  </button>
                </span>
              </div>
            </>
          )
        ) : (
          <>
            <p className="cd-ayuda cd-ayuda--grande">{t('machineIntro')}</p>
            <div className="cd-paso"><i>1</i><b>{t('machineStep1')}</b><span>{t('machineStep1d')}</span></div>
            <div className="cd-paso"><i>2</i><b>{t('machineStep2')}</b><span>{t('machineStep2d')}</span>
              <span className="cd-cmd"><code>/remote</code>
                <button type="button" className="icon-btn" aria-label={t('copy')} onClick={() => navigator.clipboard?.writeText('/remote').catch(() => {})}>
                  <IconCopiar size={16} />
                </button>
              </span>
            </div>
            <div className="cd-espera"><ShimmerText text={t('waitingMachine')} /></div>
            <div className="cd-mpie">
              <button type="button" className="cd-link" onClick={() => { navigate('/docs/remote'); onClose(); }}>
                <Icono nombre="docs" size={14} /> {t('howRemote')}
              </button>
              <span className="cd-botones"><button type="button" className="pill-btn pill-btn--outline" onClick={onClose}>{t('close')}</button></span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sesión

function agrupar(items) {
  const out = [];
  let turno = null;
  for (const it of items) {
    if (it.kind === 'user') {
      out.push({ tipo: 'user', key: it.key, it });
      turno = null;
      continue;
    }
    if (!turno) {
      turno = { tipo: 'turno', key: it.key, tools: [], partes: [] };
      out.push(turno);
    }
    if (it.kind === 'tool') turno.tools.push(it);
    else turno.partes.push(it);
  }
  return out;
}

const baseDe = (s) => String(s || '').split(/[\\/]/).filter(Boolean).pop() || s;

function fichasDeTools(tools) {
  const vistas = new Set();
  const out = [];
  for (const tl of tools) {
    const texto = String(tl.summary || '').trim();
    if (!texto || vistas.has(texto)) continue;
    vistas.add(texto);
    out.push({ icono: iconoDe(tl.tool), texto: tl.tool === 'run_command' ? texto : baseDe(texto) });
  }
  return out;
}

export function CodingSesion({ session }) {
  const t = useT('coding');
  const tch = useT('chat');
  const tg = useT('github');
  const locale = useLocale();
  const { user } = useAuth();
  const confirmar = useConfirmar();
  const navigate = useNavigate();
  const { loadRemotas, openDrawer, drawerOpen, remotas = [] } = useShell();
  const { models, modelInfo } = useModelos(user);
  const [state, dispatch] = useReducer(remoteReducer, initialRemoteState);
  const movil = useMovil();
  const [foco, setFoco] = useState(null); // archivo a abrir en Cambios: { path, n }
  const [puerto, setPuerto] = useState(null); // puerto elegido en la vista previa
  const [abiertos, setAbiertos] = useState([]); // puertos con pestaña en la vista previa
  const [verSalida, setVerSalida] = useState(false);
  const [resueltas, setResueltas] = useState(() => leerResueltas(session.id));
  const [, setAvisosPermiso] = useState(0);
  const [panel, setPanel] = useState(null); // 'resumen' | 'cambios' | 'codigo' | 'vista' | 'prs'
  const [menu, setMenu] = useState(false);
  const [renombrando, setRenombrando] = useState(false);
  const [borrador, setBorrador] = useState('');
  const [enCola, setEnCola] = useState([]);
  const [sendError, setSendError] = useState('');
  const [creandoPr, setCreandoPr] = useState(false);
  const [limite, setLimite] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const seqRef = useRef(0);
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const menuRef = useRef(null);
  const cerrarMenu = useCallback(() => setMenu(false), []);
  useDismiss(menu, menuRef, cerrarMenu);

  useEffect(() => { seqRef.current = state.lastSeq; }, [state.lastSeq]);

  // Conversación en vivo por el relay (la misma que Remoto).
  useEffect(() => {
    const abort = new AbortController();
    let backoff = 2000;
    let vivo = true;
    (async () => {
      while (vivo) {
        try {
          await openEventStream({
            path: `/api/remote/sessions/${session.id}/stream?from_seq=${seqRef.current}`,
            signal: abort.signal,
            onEvent: (ev) => { backoff = 2000; dispatch(ev); },
          });
        } catch (err) {
          if (!vivo || abort.signal.aborted) return;
          if (err.status === 404 || err.status === 410) { dispatch({ type: 'session_ended' }); return; }
        }
        if (!vivo) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    })();
    return () => { vivo = false; abort.abort(); };
  }, [session.id]);

  const sb = session.sandbox || {};
  const repo = sb.repo || state.meta?.repo || session.workspace;
  const base = sb.default_branch || state.meta?.default_branch || 'main';
  const rama = state.branch || sb.branch || null;
  const estado = (state.sandbox?.estado === 'clonando' ? 'preparando' : state.sandbox?.estado) || sb.estado || 'creada';
  const clonando = state.sandbox?.estado === 'clonando';
  const pausada = estado === 'pausada';
  const conError = estado === 'error';
  const activa = estado === 'activa' && state.hostConnected && !state.ended;
  const trabajando = activa && state.agentState === 'thinking';
  const pr = state.pr || (sb.pr_url ? { url: sb.pr_url, number: Number(sb.pr_url.split('/').pop()) || null } : null);
  // El modo elegido se ve al momento: el entorno lo confirma en su próximo
  // hello (o al reanudar, si está en pausa), y hasta entonces manda la elección.
  const [modoElegido, setModoElegido] = useState(null);
  useEffect(() => {
    if (modoElegido && state.meta?.mode === modoElegido) setModoElegido(null);
  }, [modoElegido, state.meta?.mode]);
  const modo = modoElegido || state.meta?.mode || sb.mode || 'manual';
  const [modeloElegido, setModeloElegido] = useState(null);
  useEffect(() => {
    if (modeloElegido && state.meta?.model_value === modeloElegido) setModeloElegido(null);
  }, [modeloElegido, state.meta?.model_value]);
  // Modelo que ya no sirve ningún nodo: la sesión sigue con otro y se avisa.
  const modeloGuardado = state.meta?.model_value || sb.model || null;
  const modeloCaido = models.length > 0 && modeloGuardado && !models.includes(modeloGuardado) ? modeloGuardado : null;
  const modelo = modeloElegido || (modeloCaido ? models[0] : modeloGuardado) || models[0] || '';
  const fijada = remotas.find((r) => r.id === session.id)?.pinned ?? !!session.pinned;
  const dias = sb.conservar_dias || { normal: 7, fijada: 30 };
  const caduca = useMemo(() => {
    const d = new Date(sb.last_activity_at || '');
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + (fijada ? dias.fijada : dias.normal) * 864e5);
  }, [sb.last_activity_at, fijada, dias.fijada, dias.normal]);
  const fechaCaduca = caduca ? caduca.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : '';
  const espacioSesion = sb.espacio || state.meta?.espacio || null;
  // Los comandos «/» que anuncia el entorno (los mismos que el CLI).
  const comandos = useMemo(() => (state.meta?.commands || [])
    .map((c) => ({ cmd: `/${c.name}`, desc: c.args ? `${c.args} · ${c.description}` : c.description })),
  [state.meta?.commands]);
  const titulo = session.title || t('sessionTitle');

  // El mensaje enviado antes de que el entorno esté listo se ve ya en el hilo;
  // se quita cuando el host lo publica como user_msg.
  const usuarios = state.items.filter((i) => i.kind === 'user').length;
  const usuariosRef = useRef(usuarios);
  useEffect(() => {
    if (usuarios > usuariosRef.current) setEnCola((c) => c.slice(usuarios - usuariosRef.current));
    usuariosRef.current = usuarios;
  }, [usuarios]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.approvals, state.choices, enCola, estado]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // El agente abre la vista previa con show_preview; también la reabre el usuario.
  // Solo la abre un show_preview en vivo: los del historial (al abrir la
  // sesión) no, o cada visita empezaría con el panel abierto.
  const previaVista = useRef(state.preview?.n || 0);
  const montada = useRef(Date.now());
  useEffect(() => {
    const p = state.preview;
    if (p) {
      setAbiertos((a) => (a.includes(p.port) ? a : [...a, p.port]));
      if (p.n > previaVista.current) setPuerto(p.port);
    }
    if (p && p.n > previaVista.current && p.ts >= montada.current - 2000) setPanel('vista');
    previaVista.current = p?.n || 0;
  }, [state.preview]);
  const abrirPuerto = useCallback((port) => {
    setAbiertos((a) => (a.includes(port) ? a : [...a, port]));
    setPuerto(port);
    setPanel('vista');
  }, []);
  // Un servidor nuevo que nadie abrió todavía (solo si llegó en vivo).
  const [puertosVistos, setPuertosVistos] = useState([]);
  const puertoNuevo = (state.ports?.items || []).find((x) => !abiertos.includes(x.port) && !puertosVistos.includes(x.port));
  const avisoPuerto = puertoNuevo && state.ports.ts >= montada.current - 2000 ? puertoNuevo : null;

  // «Te necesita» con la pestaña en segundo plano: título, icono y, si se
  // permitió, una notificación del navegador.
  const necesita = state.approvals.length + state.choices.length;
  useAvisoPestana(necesita, session.title || t('sessionTitle'), t);
  const notificadas = useRef(new Set());
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    [...state.approvals, ...state.choices].forEach((a) => {
      if (notificadas.current.has(a.id)) return;
      notificadas.current.add(a.id);
      if (!document.hidden) return;
      try {
        const n = new Notification(t('notifTitle', { titulo: session.title || t('sessionTitle') }), {
          body: a.command || a.summary || a.title || '', tag: `lixbon-${session.id}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* sin notificaciones en este navegador */ }
    });
  }, [state.approvals, state.choices, session.id, session.title, t]);
  const pedirAvisos = useCallback(async () => {
    try { await Notification.requestPermission(); } catch { /* el navegador no deja */ }
    setAvisosPermiso((n) => n + 1);
  }, []);
  const ahoraNoAvisos = useCallback(() => {
    try { localStorage.setItem('lixbon.avisos.no', '1'); } catch { /* sin almacenamiento */ }
    setAvisosPermiso((n) => n + 1);
  }, []);
  const ofrecerAvisos = necesita > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default'
    && !leerFlag('lixbon.avisos.no');

  const sendCommand = useCallback(async (command) => {
    try {
      await api.post(`/api/remote/sessions/${session.id}/commands`, command);
      return true;
    } catch (err) {
      setSendError(mensajeDeError(err, tch('message')));
      return false;
    }
  }, [session.id, tch]);

  // Abrir un panel pide sus datos al entorno (solo lectura).
  useEffect(() => {
    if (!activa) return;
    if (panel === 'cambios' || panel === 'resumen') sendCommand({ type: 'git_diff' });
    if (panel === 'codigo') sendCommand({ type: 'tree' });
    if (panel === 'prs' || panel === 'resumen') sendCommand({ type: 'git_log' });
    if (panel === 'resumen') sendCommand({ type: 'procs' });
  }, [panel, activa, sendCommand]);

  // PRs de la sesión (estado y checks desde GitHub).
  const [prs, setPrs] = useState([]);
  const cargarPrs = useCallback(() => { prsSesion(session.id).then(setPrs).catch(() => {}); }, [session.id]);
  useEffect(() => {
    if (panel === 'prs' || panel === 'resumen' || pr) cargarPrs();
  }, [panel, state.pr, cargarPrs]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mientras haya checks en curso se vuelve a mirar cada minuto.
  const enCurso = prs.some((p) => p.checks?.pending > 0);
  useEffect(() => {
    if (!enCurso) return undefined;
    const id = setInterval(cargarPrs, 60000);
    return () => clearInterval(id);
  }, [enCurso, cargarPrs]);
  const prFallo = prs.find((p) => p.state === 'open' && p.checks?.failed > 0);
  const checkFallo = prFallo?.check_runs?.find((c) => c.result === 'failed');
  const arreglarCi = (p, c) => enviar(t('fixCiPrompt', {
    check: c?.name || '', n: p.number, resumen: (c?.summary || '').slice(0, 3000),
  }).trim());
  const resolverRevision = (p, r) => enviar(t('reviewPrompt', {
    autor: r.author, n: p.number,
    comentarios: [r.body, ...(r.comments || []).map((c) => `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`)].filter(Boolean).join('\n'),
  }));

  const enviar = async (texto, imagenes = []) => {
    stick.current = true;
    setSendError('');
    // /mode, /model y /diff se resuelven aquí: guardan el cambio en la sesión
    // (sobrevive a pausar) o abren el panel. El resto de «/» los ejecuta el entorno.
    const [, nombre, arg = ''] = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(texto.trim()) || [];
    if (nombre === 'mode' && MODOS_CODING.includes(arg.trim())) { await cambiarModo(arg.trim()); return; }
    if (nombre === 'model' && arg.trim()) { await cambiarModelo(arg.trim()); return; }
    if (nombre === 'diff') { setPanel('cambios'); return; }
    if (!activa) setEnCola((c) => [...c, texto]);
    try {
      await enviarMensaje(session.id, texto, imagenes);
      if (!activa) loadRemotas();
    } catch (err) {
      setEnCola((c) => c.filter((x) => x !== texto));
      if (err.response?.data?.detail?.code === 'max_active_sessions') { setLimite(true); return; }
      setSendError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
    }
  };

  const accion = async (fn) => {
    try {
      await fn();
    } catch (err) {
      if (err.response?.data?.detail?.code === 'max_active_sessions') setLimite(true);
      else setSendError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
    }
    loadRemotas();
  };

  const crearPr = async () => {
    setCreandoPr(true);
    await accion(() => pedirPr(session.id));
  };
  useEffect(() => { if (state.pr) setCreandoPr(false); }, [state.pr]);

  const borrar = async () => {
    setMenu(false);
    const ok = await confirmar({ titulo: t('deleteConfirmTitle'), texto: t('deleteConfirmText'), etiqueta: t('delete') });
    if (!ok) return;
    await accion(() => eliminarSesion(session.id));
    navigate('/coding');
  };

  const renombrar = async () => {
    setRenombrando(false);
    const nuevo = borrador.trim();
    if (nuevo && nuevo !== titulo) await accion(() => cambiarSesion(session.id, { title: nuevo }));
  };

  const cambiarModelo = async (m) => {
    if (m === modelo) return;
    setModeloElegido(m);
    try {
      await cambiarSesion(session.id, { model: m });
    } catch (err) {
      setModeloElegido(null);
      setSendError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
    }
  };

  const cambiarModo = async (m) => {
    if (m === modo) return;
    setModoElegido(m);
    try {
      await cambiarSesion(session.id, { mode: m });
    } catch (err) {
      setModoElegido(null);
      setSendError(err.response?.data?.detail?.message || mensajeDeError(err, t('sendError')));
    }
  };

  const fijarSesion = async () => {
    try {
      await cambiarRemota(session.id, { pinned: true });
      loadRemotas();
    } catch (err) {
      setSendError(mensajeDeError(err, t('sendError')));
    }
  };

  const copiarRama = () => {
    navigator.clipboard?.writeText(rama || '').then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    }).catch(() => {});
    setMenu(false);
  };

  const grupos = useMemo(() => agrupar(state.items), [state.items]);
  const ultimoTurno = [...grupos].reverse().find((g) => g.tipo === 'turno');
  const abrirCambio = (path) => { setFoco({ path, n: Date.now() }); setPanel('cambios'); };
  const textoPaso = (p) => (p.archivo ? (
    <button type="button" className="nv-paso-link" title={t('seeChange')}
      onClick={(e) => { e.preventDefault(); abrirCambio(p.archivo); }}>{p.texto}</button>
  ) : p.texto);
  const guardarPropuesta = async (x) => {
    const id = x.espacio?.id || espacioSesion?.id;
    try {
      if (id) await anadirNota(id, x.text);
      marcarResuelta(x.id);
    } catch (err) {
      setSendError(mensajeDeError(err, t('sendError')));
    }
  };
  const marcarResuelta = (id) => setResueltas((r) => {
    const n = [...r, id];
    try { localStorage.setItem(`lixbon.coding.memoria.${session.id}`, JSON.stringify(n)); } catch { /* sin almacenamiento */ }
    return n;
  });
  const setup = state.setup;
  const bloqueSetup = setup && setup.estado ? (
    <div key="setup" className="msg msg--assistant">
      {setup.estado === 'instalando' ? (
        <LineaTrabajo texto={t('installingDeps')} inicio={setup.inicio || Date.now()}
          fichas={[{ icono: 'github', texto: repo }, { icono: 'bifurcar', texto: base },
            ...(setup.lockfile ? [{ icono: 'archivo', texto: setup.lockfile }] : []),
            ...(setup.comando ? [{ icono: 'terminal', texto: setup.comando }] : [])]} />
      ) : (
        <details className="trabajo-resumen">
          <summary className="trabajo-resumen__linea">
            <span>{t('setupDone', { t: duracionCorta(setup.ms) })}</span>
            {setup.pasos.length > 0 && <span className="trabajo-resumen__dato">· {t('stepsN', { n: setup.pasos.length })}</span>}
          </summary>
          {setup.pasos.length > 0 && (
            <ol className="trabajo-resumen__pasos">
              {setup.pasos.map((x, i) => <li key={i}><Icono nombre="terminal" size={14} /><span>{x}</span></li>)}
            </ol>
          )}
        </details>
      )}
    </div>
  ) : null;
  const lineaTexto = (tools) => {
    const enCurso = [...tools].reverse().find((x) => x.running);
    if (enCurso) return describeRemoteTool(enCurso, locale);
    if (state.activityLabel) return state.activityLabel;
    return tch('thinking');
  };

  const accionBtn = (id, icono, label) => (
    <button type="button" className={`icon-btn cd-accion cd-accion--panel ${panel === id ? 'is-on' : ''}`} aria-label={label} title={label}
      aria-pressed={panel === id} onClick={() => setPanel((p) => (p === id ? null : id))}>
      <Icono nombre={icono} size={18} />
    </button>
  );

  const placeholder = pausada ? t('placeholderPaused') : t('placeholder');

  return (
    <>
      <section className="chat-main cd-main">
        <header className="chat-header">
          <button className="icon-btn chat-header__menu" onClick={openDrawer} aria-label={tch('openConversationsPanel')}
            aria-controls="sidebar-drawer" aria-expanded={drawerOpen}>
            <IconMenu />
          </button>
          {renombrando ? (
            <input className="chat-header__edit" value={borrador} autoFocus aria-label={t('rename')}
              onChange={(e) => setBorrador(e.target.value)} onBlur={renombrar}
              onKeyDown={(e) => { if (e.key === 'Enter') renombrar(); if (e.key === 'Escape') setRenombrando(false); }} />
          ) : (
            <div className="chat-header__titulo">
              <button type="button" className="chat-header__title-btn" onClick={() => setMenu((v) => !v)}
                aria-haspopup="menu" aria-expanded={menu}>
                <Recorte as="h1" texto={titulo} className="chat-header__title" />
                <IconChevron size={14} />
              </button>
            </div>
          )}
          <button type="button" className={`icon-btn nv-btn-panel ${panel ? 'is-on' : ''}`} aria-label={t('sessionPanel')}
            title={t('sessionPanel')} aria-expanded={!!panel} onClick={() => setPanel((p) => (p ? null : 'resumen'))}>
            <Icono nombre="panel-der" size={18} />
          </button>
          <div className="cd-acciones" ref={menuRef}>
            {accionBtn('resumen', 'lista', t('summary'))}
            {accionBtn('cambios', 'git', t('tab_cambios'))}
            {accionBtn('codigo', 'carpeta', t('tab_codigo'))}
            {accionBtn('vista', 'navegador', t('tab_vista'))}
            <button type="button" className={`icon-btn cd-accion ${menu ? 'is-on' : ''}`} aria-label={t('moreActions')}
              title={t('moreActions')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <Icono nombre="opciones" size={18} />
            </button>
            <Desplegable abierto={menu} className="sb-menu chat-header__menu-titulo" role="menu">
              {rama && (
                <a role="menuitem" href={`https://github.com/${repo}/tree/${rama}`} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                  <IconExternal size={14} /> {t('viewBranch')}
                </a>
              )}
              {rama && (
                <button role="menuitem" onClick={copiarRama}>
                  <IconCopiar size={14} /> {copiado ? t('copied') : t('copyBranch')}
                </button>
              )}
              <button role="menuitem" onClick={() => { setMenu(false); setBorrador(titulo); setRenombrando(true); }}>
                <IconPencil size={14} /> {t('rename')}
              </button>
              {!pausada && estado !== 'creada' && estado !== 'terminada' && (
                <button role="menuitem" title={t('pauseHint')} onClick={() => { setMenu(false); accion(() => pausarSesion(session.id)); }}>
                  <IconPause size={14} /> {t('pause')}
                </button>
              )}
              <button role="menuitem" className="sb-menu__danger" title={t('deleteHint')} onClick={borrar}>
                <IconTrash size={14} /> {t('delete')}
              </button>
            </Desplegable>
          </div>
          {(pausada || conError) ? (
            <button type="button" className="pill-btn pill-btn--primary chat-header__share"
              onClick={() => accion(() => (conError ? reintentarSesion(session.id) : reanudarSesion(session.id)))}>
              {conError ? t('retry') : t('resume')}
            </button>
          ) : pr ? (
            <a className="pill-btn pill-btn--primary chat-header__share" href={pr.url} target="_blank" rel="noreferrer">
              <Icono nombre="pull-request" size={15} /> {pr.number ? t('viewPr', { n: pr.number }) : t('openOnGithub')}
            </a>
          ) : rama && activa ? (
            <button type="button" className="pill-btn pill-btn--primary chat-header__share" onClick={crearPr} disabled={creandoPr}>
              <Icono nombre="pull-request" size={15} /> {creandoPr ? t('creatingPr') : t('createPr')}
            </button>
          ) : null}
        </header>

        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-thread">
            {grupos.map((g, gi) => {
              if (g.tipo === 'user') {
                const msg = <div key={g.key} className="msg msg--user">{g.it.text}</div>;
                return gi === 0 && bloqueSetup ? [msg, bloqueSetup] : msg;
              }
              const enCurso = trabajando && g === ultimoTurno;
              const ms = [...g.partes].reverse().find((p) => p.kind === 'assistant' && p.ms)?.ms;
              const pasos = g.tools.map((x) => ({ name: x.tool, texto: describeRemoteTool(x, locale), archivo: rutaDeTool(x) }));
              return (
                <div key={g.key} className="msg msg--assistant">
                  {!enCurso && pasos.length > 0 && (
                    <ResumenTrabajo inicio={1} fin={1 + (ms || 0)} pasos={pasos} textoPaso={textoPaso} />
                  )}
                  {g.partes.map((p) => {
                    if (p.kind === 'assistant') return p.text ? <Markdown key={p.key} streaming={p.open}>{p.text}</Markdown> : null;
                    if (p.kind === 'notice') return <p key={p.key} className="msg__aviso" role="status"><IconAlert size={15} /><span>{p.text}</span></p>;
                    if (p.kind === 'error') return <MensajeError key={p.key}>{p.text}</MensajeError>;
                    if (p.kind === 'image') return <ImagenSesion key={p.key} sessionId={session.id} item={p} />;
                    if (p.kind === 'pr') return <TarjetaPr key={p.key} pr={p} titulo={titulo} t={t} />;
                    return null;
                  })}
                  {enCurso && (
                    <LineaTrabajo texto={lineaTexto(g.tools)} inicio={state.turnStart} fichas={fichasDeTools(g.tools)} />
                  )}
                </div>
              );
            })}
            {[...(estado !== 'activa' ? (sb.pendientes || []).filter((x) => !enCola.includes(x)) : []), ...enCola]
              .map((texto, i) => <div key={`cola${i}`} className="msg msg--user">{texto}</div>)}
            {estado === 'preparando' && (
              <div className="msg msg--assistant">
                <LineaTrabajo texto={clonando ? t('cloning', { repo }) : t('preparing')} inicio={state.turnStart || Date.now()}
                  fichas={[{ icono: 'github', texto: repo }, { icono: 'bifurcar', texto: base }]} />
              </div>
            )}
            {ofrecerAvisos && (
              <Aviso tipo="info" icono="campana" titulo={t('notifAskTitle')} texto={t('notifAskText')}>
                <button type="button" className="pill-btn pill-btn--primary" onClick={pedirAvisos}>{t('notifEnable')}</button>
                <button type="button" className="pill-btn pill-btn--outline" onClick={ahoraNoAvisos}>{t('notNow')}</button>
              </Aviso>
            )}
            {state.approvals.map((a) => (
              <div key={a.id} className="msg msg--assistant">
                <Confirmacion a={a} repo={repo} rama={rama} t={t} tg={tg}
                  onResolver={(si) => sendCommand({ type: 'approve', id: a.id, decision: si ? 'allow' : 'deny' })} />
              </div>
            ))}
            {state.choices.map((c) => (
              <div key={c.id} className="msg msg--assistant">
                <Pregunta c={c} t={t} onResponder={(valor) => sendCommand({ type: 'approve', id: c.id, decision: valor })} />
              </div>
            ))}
            {pausada && (state.sandbox?.motivo === 'entorno_perdido' ? (
              <Aviso tipo="warn" icono="alerta" titulo={t('lostTitle')} texto={t('lostText', { rama: rama || base })}
                extra={caduca && <Caduca fecha={fechaCaduca} fijada={fijada} dias={dias.fijada} t={t} onFijar={() => fijarSesion()} />}>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => accion(() => reanudarSesion(session.id))}>{t('resume')}</button>
              </Aviso>
            ) : (
              <Aviso tipo="info" icono="en-pausa" titulo={t('pausedTitle')}
                texto={[state.sandbox?.motivo === 'manual' ? t('pausedManual') : t('pausedIdle'), t('pausedKept', { rama: rama || base })].filter(Boolean).join(' ')}
                extra={caduca && <Caduca fecha={fechaCaduca} fijada={fijada} dias={dias.fijada} t={t} onFijar={() => fijarSesion()} />}>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => accion(() => reanudarSesion(session.id))}>{t('resume')}</button>
              </Aviso>
            ))}
            {conError && (
              <Aviso tipo="error" icono="fallo" titulo={t('errorTitle')}
                texto={`${state.sandbox?.detalle || sb.error || ''} ${t('errorKept')}`.trim()}
                extra={caduca && <Caduca fecha={fechaCaduca} fijada={fijada} dias={dias.fijada} t={t} onFijar={() => fijarSesion()} />}>
                <button type="button" className="pill-btn pill-btn--primary" onClick={() => accion(() => reintentarSesion(session.id))}>{t('retry')}</button>
              </Aviso>
            )}
            {setup?.estado === 'fallo' && (
              <Aviso tipo="warn" icono="alerta" titulo={t('setupFailTitle')}
                texto={`${setup.detalle || t('setupFailCmd', { cmd: setup.comando })} ${t('setupFailText')}`}
                extra={verSalida && setup.salida && <pre className="cd-fuente cd-salida">{setup.salida}</pre>}>
                <button type="button" className="pill-btn pill-btn--primary"
                  onClick={() => enviar(t('setupFixPrompt', { cmd: setup.comando, salida: setup.salida.slice(-3000) }))}>{t('setupFix')}</button>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => sendCommand({ type: 'setup_retry' })}>{t('retry')}</button>
                {setup.salida && (
                  <button type="button" className="pill-btn pill-btn--outline" onClick={() => setVerSalida((v) => !v)}>
                    {verSalida ? t('hideOutput') : t('seeOutput')}
                  </button>
                )}
              </Aviso>
            )}
            {avisoPuerto && (
              <Aviso tipo="info" icono="navegador" titulo={t('newPortTitle', { n: avisoPuerto.port })}
                texto={avisoPuerto.command ? t('newPortBy', { cmd: avisoPuerto.command }) : t('newPortText')}>
                <button type="button" className="pill-btn pill-btn--outline"
                  onClick={() => { setPuertosVistos((v) => [...v, avisoPuerto.port]); abrirPuerto(avisoPuerto.port); }}>{t('openPreview')}</button>
              </Aviso>
            )}
            {state.turnLimit && (
              <Aviso tipo="warn" icono="reloj" titulo={t('turnLimitTitle', { n: state.turnLimit.minutes || state.meta?.limits?.turn_minutes || 30 })}
                texto={`${t('turnLimitText')}${state.turnLimit.detalle ? ` ${state.turnLimit.detalle}` : ''} ${t('turnLimitContinue')}`}>
                <button type="button" className="pill-btn pill-btn--primary" onClick={() => enviar(t('continuePrompt'))}>{t('continue')}</button>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => setPanel('cambios')}>{t('seeChanges')}</button>
              </Aviso>
            )}
            {prFallo && checkFallo && !trabajando && (
              <Aviso tipo="error" icono="fallo" titulo={t('ciFailTitle', { check: checkFallo.name, n: prFallo.number })}
                texto={t('ciFailText', { ok: prFallo.checks.ok, total: prFallo.checks.total })}>
                <button type="button" className="pill-btn pill-btn--primary" onClick={() => arreglarCi(prFallo, checkFallo)}>{t('fixCi')}</button>
                {checkFallo.url && <a className="pill-btn pill-btn--outline" href={checkFallo.url} target="_blank" rel="noreferrer">{t('seeLog')}</a>}
              </Aviso>
            )}
            {(state.propuestas || []).filter((x) => !resueltas.includes(x.id)).map((x) => (
              <Aviso key={x.id} tipo="info" icono="libro"
                titulo={t('memoryTitle', { nombre: x.espacio?.nombre || espacioSesion?.nombre || '' })}
                texto={`«${x.text}». ${t('memoryNote')}`}>
                <button type="button" className="pill-btn pill-btn--primary" onClick={() => guardarPropuesta(x)}>{t('memorySave')}</button>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => marcarResuelta(x.id)}>{t('discard')}</button>
              </Aviso>
            ))}
            {limite && <AvisoLimite t={t} onPausado={() => { setLimite(false); accion(() => reanudarSesion(session.id)); }} />}
          </div>
        </div>

        <div className="chat-composer">
          {estado === 'preparando' && <p className="chat-disclaimer cd-nota">{t('preparingNote')}</p>}
          {pausada && <p className="chat-disclaimer cd-nota">{t('pausedNote')}</p>}
          {sendError && <p className="remote__send-error" role="alert">{sendError}</p>}
          {!sendError && modeloCaido && !modeloElegido && (
            <p className="remote__send-error" role="alert">{t('modelGone', { a: modeloCaido, b: modelo })}</p>
          )}
          <ChatInput onSend={enviar} onStop={() => sendCommand({ type: 'interrupt' })} busy={trabajando}
            models={models} modelInfo={modelInfo} model={modelo} onModelChange={cambiarModelo} commands={comandos}
            modelsOff={modeloCaido ? { [modeloCaido]: t('modelOff') } : undefined}
            placeholder={placeholder} contextUso={state.context}
            usoExtra={<UsoSesion state={state} trabajando={trabajando} t={t} />}
            tools={(
              <>
                <RepoFijo repo={repo} t={t} />
                {espacioSesion && <MenuEspacio espacio={espacioSesion} fijo />}
                <RamaFija rama={rama} t={t} />
                <MenuModo modo={modo} onChange={cambiarModo} />
              </>
            )} />
          <p className="chat-disclaimer">{tch('disclaimer')}</p>
        </div>
      </section>

      {panel && (
        <Hoja movil={movil} onClose={() => setPanel(null)} label={panel === 'resumen' ? t('summary') : t('sessionPanel')}>
          {panel === 'resumen' ? (
            <PanelResumen state={state} t={t} sb={sb} repo={repo} rama={rama} base={base} estado={estado} activa={activa} prs={prs}
              onClose={() => setPanel(null)} setPanel={setPanel} creandoPr={creandoPr} onCrearPr={crearPr} sendCommand={sendCommand}
              caduca={(pausada || conError) && caduca ? { fecha: fechaCaduca, fijada, dias } : null} onFijar={() => fijarSesion()}
              onPausar={() => accion(() => pausarSesion(session.id))} onReanudar={() => accion(() => reanudarSesion(session.id))} />
          ) : (
            <PanelCoding panel={panel} setPanel={setPanel} onClose={() => setPanel(null)} state={state} session={session} t={t}
              rama={rama} base={base} activa={activa} prs={prs} sendCommand={sendCommand} repo={repo} foco={foco}
              puerto={puerto} abiertos={abiertos} onPuerto={abrirPuerto}
              onArreglarCi={arreglarCi} onResolver={resolverRevision}
              creandoPr={creandoPr} onCrearPr={crearPr} onPedir={(p) => enviar(t('askChangesPrompt', { n: p.number }))} />
          )}
        </Hoja>
      )}
    </>
  );
}

// ------------------------------------------------------------------ piezas

// Aviso en el hilo: qué pasó, qué significa y qué hacer (sin línea roja suelta).
export function Aviso({ tipo = 'info', icono = 'alerta', titulo, texto, extra = null, children }) {
  return (
    <div className={`cd-aviso cd-aviso--${tipo}`} role={tipo === 'error' ? 'alert' : 'status'}>
      <span className="cd-aviso__ico"><Icono nombre={icono} size={20} /></span>
      <strong className="cd-aviso__t">{titulo}</strong>
      {texto && <span className="cd-aviso__x">{texto}</span>}
      {extra && <span className="cd-aviso__x">{extra}</span>}
      {children && <span className="cd-aviso__acc">{children}</span>}
    </div>
  );
}

// Límite de entornos: pausar uno aquí mismo y seguir.
function AvisoLimite({ t, onPausado }) {
  const { remotas = [], loadRemotas } = useShell();
  const activas = remotas.filter((r) => r.source === 'cloud' && entornoActivo(r));
  const [pausando, setPausando] = useState(null);
  const pausar = async (id) => {
    setPausando(id);
    try { await pausarSesion(id); loadRemotas(); onPausado(); } catch { setPausando(null); }
  };
  return (
    <Aviso tipo="warn" icono="te-necesita" titulo={t('limitTitle', { n: activas.length || 2 })} texto={t('limitText')}>
      <span className="cd-aviso__lista">
        {activas.map((r) => (
          <span key={r.id} className="cd-mini">
            <Icono nombre="remoto" size={16} /><span>{r.title || t('sessionTitle')}</span>
            <button type="button" className="pill-btn pill-btn--outline" disabled={pausando === r.id} onClick={() => pausar(r.id)}>
              {pausando === r.id ? t('pausing') : t('pause')}
            </button>
          </span>
        ))}
      </span>
    </Aviso>
  );
}

// La misma tarjeta «Te necesita» que el chat con GitHub (ConfirmacionGithub).
function Confirmacion({ a, repo, rama, t, tg, onResolver }) {
  const [enviando, setEnviando] = useState(false);
  const edicion = a.risk === 'edit';
  const titulo = edicion ? tg('confirmWrite')
    : String(a.tool || '').startsWith('browser') ? t('browserApproval') : t('commandApproval');
  const resolver = (si) => { setEnviando(true); onResolver(si); };
  return (
    <div className="gh-confirma" role="group" aria-label={titulo}>
      <div className="gh-confirma__cab">
        <span className="gh-confirma__icono"><LogoMarca id="github" size={18} /></span>
        <div className="gh-confirma__titulos">
          <strong>{titulo}</strong>
          <span>{repo}{rama && <> · <code className="gh-confirma__rama">{rama}</code></>}</span>
        </div>
        <span className="estado estado--espera">{tg('needsYou')}</span>
      </div>
      {edicion && a.path ? (
        <ul className="gh-confirma__archivos">
          <li className="is-escribir">
            <span className="gh-confirma__signo" aria-label={tg('fileWrite')}>+</span>
            <code>{a.path}</code>
            <span className="gh-confirma__lineas"><span className="cd-mas">+{a.adds}</span> <span className="cd-menos">−{a.dels}</span></span>
          </li>
        </ul>
      ) : (
        <p className="gh-confirma__commit">{a.summary}</p>
      )}
      <div className="gh-confirma__acciones">
        <button type="button" className="pill-btn pill-btn--outline" disabled={enviando} onClick={() => resolver(false)}>{tg('reject')}</button>
        <button type="button" className="pill-btn pill-btn--primary" disabled={enviando} onClick={() => resolver(true)}>
          {enviando ? tg('resolving') : tg('accept')}
        </button>
      </div>
    </div>
  );
}

function Pregunta({ c, t, onResponder }) {
  const [libre, setLibre] = useState('');
  return (
    <div className="cd-pregunta" role="group" aria-label={c.title}>
      <span className="estado estado--espera">{t('question')}</span>
      <Markdown>{c.title}</Markdown>
      {c.options.length > 0 && (
        <div className="cd-pregunta__opciones">
          {c.options.map((o) => (
            <button key={o.value || o.label} type="button" className="pill-btn pill-btn--outline" title={o.description || undefined}
              onClick={() => onResponder(o.value || o.label)}>{o.label}</button>
          ))}
        </div>
      )}
      {c.free && (
        <form className="cd-pregunta__libre" onSubmit={(e) => { e.preventDefault(); if (libre.trim()) onResponder(libre.trim()); }}>
          <input value={libre} onChange={(e) => setLibre(e.target.value)} placeholder={t('answerPlaceholder')} aria-label={t('answerPlaceholder')} />
          <button type="submit" className="pill-btn pill-btn--primary">{t('answer')}</button>
          <button type="button" className="pill-btn pill-btn--outline" onClick={() => onResponder('')}>{t('skip')}</button>
        </form>
      )}
    </div>
  );
}

function TarjetaPr({ pr, titulo, t }) {
  return (
    <div className="cd-pr">
      <div className="cd-pr__fila">
        <Icono nombre="pull-request" size={18} />
        <span>{titulo}</span>
        {pr.number && <span style={{ color: 'var(--ink-muted)' }}>#{pr.number}</span>}
        <a className="pill-btn pill-btn--outline" href={pr.url} target="_blank" rel="noreferrer">
          {t('openOnGithub')} <IconExternal size={14} />
        </a>
      </div>
      {pr.branch && <div className="cd-pr__meta"><span>{t('prCard', { rama: pr.branch, base: pr.base || 'main' })}</span></div>}
    </div>
  );
}

const API_BASE = import.meta.env.VITE_API_URL || '';

function ImagenSesion({ sessionId, item }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let vivo = true;
    let actual = '';
    fetch(`${API_BASE}/api/remote/sessions/${sessionId}/images/${item.id}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && vivo) { actual = URL.createObjectURL(b); setUrl(actual); } })
      .catch(() => {});
    return () => { vivo = false; if (actual) URL.revokeObjectURL(actual); };
  }, [sessionId, item.id]);
  return (
    <figure className="remote__shown">
      {url ? <img src={url} alt={item.caption || item.name} /> : null}
      <figcaption>{item.caption ? `${item.caption} · ${item.name}` : item.name}</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ panel derecho

// Pestañas del panel, en una sola línea: Cambios · Código · Vista previa · PRs.
const PESTANAS = [['cambios', 'git'], ['codigo', 'carpeta'], ['vista', 'navegador'], ['prs', 'pull-request']];

function Tabs({ panel, setPanel, t, cuentas }) {
  return (
    <div className="cd-tabs" role="tablist" aria-label={t('panelTabs')}>
      {PESTANAS.map(([id, icono]) => (
        <button key={id} type="button" role="tab" aria-selected={panel === id} className={`cd-tab ${panel === id ? 'is-on' : ''}`}
          onClick={() => setPanel(id)}>
          <Icono nombre={icono} size={16} />
          <span>{t(`tab_${id}`)}</span>
          {cuentas[id] > 0 && <small>{cuentas[id]}</small>}
        </button>
      ))}
    </div>
  );
}

function PanelCoding({ panel, setPanel, onClose, state, session, t, rama, base, activa, prs, sendCommand, repo, onPedir, onCrearPr, creandoPr,
  foco, puerto, abiertos = [], onPuerto, onArreglarCi, onResolver }) {
  const [recarga, setRecarga] = useState(0);
  const [sel, setSel] = useState(null);
  const [verArchivo, setVerArchivo] = useState(false);
  const [fuera, setFuera] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const fueraRef = useRef(null);
  const cerrarFuera = useCallback(() => setFuera(false), []);
  useDismiss(fuera, fueraRef, cerrarFuera);
  useEffect(() => { if (foco?.path) { setSel(foco.path); setVerArchivo(false); } }, [foco]);
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  }, [onClose]);

  const cuentas = { cambios: state.diff?.files?.length || 0, prs: prs.length };
  const cab = (
    <header className="panel-archivo__cab">
      <Tabs panel={panel} setPanel={setPanel} t={t} cuentas={cuentas} />
      <button type="button" className="msg-accion" onClick={onClose} aria-label={t('closePanel')} title={t('closePanel')}>
        <IconX size={16} />
      </button>
    </header>
  );
  let cuerpo = null;

  if (panel === 'vista') {
    const detectados = state.ports?.items || [];
    const etiqueta = (port) => detectados.find((x) => x.port === port)?.label || '';
    const elegido = puerto ?? state.preview?.port ?? null;
    const p = elegido == null ? null : {
      port: elegido, path: state.preview?.port === elegido ? state.preview.path : '/',
    };
    const nuevo = detectados.find((x) => !abiertos.includes(x.port));
    const url = p ? urlVistaPrevia(session.id, p.port, p.path) : '';
    const copiar = () => {
      navigator.clipboard?.writeText(new URL(url, window.location.origin).href)
        .then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }).catch(() => {});
      setFuera(false);
    };
    cuerpo = p && activa ? (
      <div className="cd-vista-marco">
        {(abiertos.length > 1 || nuevo) && (
          <div className="nv-puertos" role="tablist" aria-label={t('ports')}>
            {abiertos.map((port) => (
              <button key={port} type="button" role="tab" aria-selected={port === p.port}
                className={`nv-puerto ${port === p.port ? 'is-on' : ''}`} onClick={() => onPuerto(port)}>
                {port}{etiqueta(port) && <small>{etiqueta(port)}</small>}
              </button>
            ))}
            {nuevo && (
              <button type="button" className="nv-puerto nv-puerto--nuevo" onClick={() => onPuerto(nuevo.port)}>
                <i />{t('portDetected', { n: nuevo.port })}
              </button>
            )}
          </div>
        )}
        <div className="cd-vista-barra">
          <div className="cd-url"><Icono nombre="globo" size={15} /><span>localhost:{p.port}</span><span>{p.path}</span></div>
          <button type="button" className="msg-accion" onClick={() => setRecarga((n) => n + 1)} aria-label={t('reload')} title={t('reload')}>
            <IconRefresh size={16} />
          </button>
          <div className="cd-fuera" ref={fueraRef}>
            <button type="button" className={`msg-accion ${fuera ? 'is-on' : ''}`} aria-haspopup="menu" aria-expanded={fuera}
              onClick={() => setFuera((v) => !v)} aria-label={t('openOutside')} title={copiado ? t('copied') : t('openOutside')}>
              <IconExternal size={16} />
            </button>
            {fuera && (
              <div className="modelo-menu__panel is-abajo nv-flota cd-fuera__menu" role="menu" aria-label={t('openOutside')}>
                <div className="modelo-menu__lista">
                  <a role="menuitem" className="modelo-menu__opt" href={url} target="_blank" rel="noreferrer" onClick={() => setFuera(false)}>
                    <span className="modelo-menu__txt">
                      <span className="modelo-menu__nom">{t('openTab')}</span>
                      <span className="modelo-menu__det">{t('openTabDet')}</span>
                    </span>
                  </a>
                  <button type="button" role="menuitem" className="modelo-menu__opt" onClick={copiar}>
                    <span className="modelo-menu__txt">
                      <span className="modelo-menu__nom">{t('copyLink')}</span>
                      <span className="modelo-menu__det">{t('copyLinkDet')}</span>
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Contenido NO confiable (la app del repo): sin allow-same-origin, y
            el gateway lo sirve además con CSP sandbox (origen opaco). */}
        <iframe key={`${recarga}-${p.port}`} className="cd-vista" title={t('tab_vista')} src={url}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" />
      </div>
    ) : (
      <div className="cd-vacio">
        {activa ? t('previewEmpty') : t('needsActive')}
        {activa && nuevo && (
          <button type="button" className="pill-btn pill-btn--outline" onClick={() => onPuerto(nuevo.port)}>{t('portDetected', { n: nuevo.port })}</button>
        )}
      </div>
    );
  } else if (panel === 'cambios') {
    const d = state.diff;
    const files = d?.files || [];
    const actual = files.find((f) => f.path === sel) || files[0];
    cuerpo = !activa && !d ? <div className="cd-vacio">{t('needsActive')}</div>
      : !d ? <div className="cd-vacio">{t('loading')}</div>
        : !files.length ? <div className="cd-vacio">{t('noChanges')}</div> : (
          <>
            <div className="cd-archivos">
              {files.map((f) => (
                <button key={f.path} type="button" className={`cd-archivo ${actual?.path === f.path ? 'is-sel' : ''}`} onClick={() => setSel(f.path)}>
                  <Icono nombre="archivo-codigo" size={16} />
                  <span>{f.path}</span>
                  <span className="cd-n"><span className="cd-mas">+{f.adds}</span><span className="cd-menos">−{f.dels}</span></span>
                </button>
              ))}
            </div>
            {actual && (
              <div className="nv-barra-archivo">
                <Icono nombre="archivo-codigo" size={16} />
                <span>{actual.path}</span>
                <span className="cd-seg" role="group" aria-label={t('whatToSee')}>
                  <button type="button" className={!verArchivo ? 'is-on' : ''} aria-pressed={!verArchivo} onClick={() => setVerArchivo(false)}>{t('viewChanges')}</button>
                  <button type="button" className={verArchivo ? 'is-on' : ''} aria-pressed={verArchivo}
                    onClick={() => { setVerArchivo(true); sendCommand({ type: 'read_file', path: actual.path }); }}>{t('viewFile')}</button>
                </span>
                <button type="button" className="msg-accion" aria-label={t('openInCode')} title={t('openInCode')}
                  onClick={() => { setSel(actual.path); sendCommand({ type: 'read_file', path: actual.path }); setPanel('codigo'); }}>
                  <Icono nombre="carpeta" size={16} />
                </button>
              </div>
            )}
            {actual && (verArchivo
              ? <Fuente archivo={state.archivo} path={actual.path} t={t} />
              : <Diff patch={actual.binary ? '' : actual.patch} binario={actual.binary} t={t} />)}
            {d.truncated && <p className="cd-vacio">{t('truncated')}</p>}
          </>
        );
  } else if (panel === 'codigo') {
    cuerpo = !activa && !state.tree ? <div className="cd-vacio">{t('needsActive')}</div>
      : !state.tree ? <div className="cd-vacio">{t('loading')}</div> : (
        <div className="cd-split">
          <Arbol entries={state.tree.entries} truncated={state.tree.truncated} t={t} sel={sel}
            onAbrir={(path) => { setSel(path); sendCommand({ type: 'read_file', path }); if (!state.diff) sendCommand({ type: 'git_diff' }); }} />
          <VisorCodigo path={sel} archivo={state.archivo} diff={state.diff} t={t} />
        </div>
      );
  } else if (panel === 'prs') {
    cuerpo = <PanelPrs state={state} t={t} rama={rama} base={base} repo={repo} prs={prs} activa={activa}
      onPedir={onPedir} onCrearPr={onCrearPr} creandoPr={creandoPr} onArreglarCi={onArreglarCi} onResolver={onResolver} />;
  }

  return (
    <aside className="panel-archivo cd-panel" aria-label={t(`tab_${panel}`)}>
      {cab}
      <div className="panel-archivo__cuerpo">{cuerpo}</div>
    </aside>
  );
}

// Código de solo lectura: el contenido lo manda el entorno (read_file).
function VisorCodigo({ path, archivo, diff, t }) {
  const [modo, setModo] = useState('codigo');
  useEffect(() => { setModo('codigo'); }, [path]);
  if (!path) return <div className="cd-codigo"><div className="cd-vacio">{t('pickFile')}</div></div>;
  const cambio = diff?.files?.find((f) => f.path === path);
  let cuerpo;
  if (modo === 'cambios') {
    cuerpo = cambio ? <Diff patch={cambio.binary ? '' : cambio.patch} binario={cambio.binary} t={t} />
      : <div className="cd-vacio">{t('fileUnchanged')}</div>;
  } else {
    cuerpo = <Fuente archivo={archivo} path={path} t={t} />;
  }
  return (
    <div className="cd-codigo">
      <div className="cd-codigo__cab">
        <Icono nombre="archivo-codigo" size={16} />
        <span>{path}</span>
        <span className="cd-seg" role="group" aria-label={t('viewMode')}>
          <button type="button" className={modo === 'codigo' ? 'is-on' : ''} aria-pressed={modo === 'codigo'} onClick={() => setModo('codigo')}>{t('viewCode')}</button>
          <button type="button" className={modo === 'cambios' ? 'is-on' : ''} aria-pressed={modo === 'cambios'} onClick={() => setModo('cambios')}
            disabled={!cambio}>{t('viewChanges')}</button>
        </span>
      </div>
      {cuerpo}
    </div>
  );
}

// Contenido de un archivo (read_file), con números de línea.
function Fuente({ archivo, path, t }) {
  if (!archivo || archivo.path !== path) return <div className="cd-vacio">{t('loading')}</div>;
  if (archivo.error) return <div className="cd-vacio">{archivo.error}</div>;
  if (archivo.binary) return <div className="cd-vacio">{t('binary')}</div>;
  const lineas = String(archivo.text || '').split('\n');
  if (lineas.length > 1 && lineas[lineas.length - 1] === '') lineas.pop();
  return (
    <pre className="cd-fuente">
      {lineas.map((l, i) => <div key={i} className="cd-ln"><b>{i + 1}</b><span>{l || ' '}</span></div>)}
      {archivo.truncated && <div className="cd-ln"><b /><span className="cd-recortado">{t('fileTruncated')}</span></div>}
    </pre>
  );
}

function hace(fecha, locale) {
  const s = (Date.now() - new Date(fecha).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function PanelPrs({ state, t, rama, base, repo, prs, activa, onPedir, onCrearPr, creandoPr, onArreglarCi, onResolver }) {
  const locale = useLocale();
  const [copiado, setCopiado] = useState(false);
  const c = state.commits;
  const copiar = () => navigator.clipboard?.writeText(rama || '').then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }).catch(() => {});
  return (
    <div className="cd-prs">
      <section className="cd-sec">
        <h3>{t('branch')}</h3>
        {rama ? (
          <>
            <div className="cd-rama-fila">
              <Icono nombre="bifurcar" size={16} /><code>{rama}</code>
              <button type="button" className="icon-btn" onClick={copiar} aria-label={t('copyBranch')} title={copiado ? t('copied') : t('copyBranch')}>
                <IconCopiar size={16} />
              </button>
            </div>
            <div className="cd-meta">
              <span>{t('fromBase', { base })}</span>
              {c && <span>{t('commitsAhead', { n: c.items.length })}</span>}
              {c && <span>{c.pushed ? t('pushed') : t('notPushed')}</span>}
            </div>
            <div className="cd-botones">
              <a className="pill-btn pill-btn--outline" href={`https://github.com/${repo}/tree/${rama}`} target="_blank" rel="noreferrer">
                <IconExternal size={14} /> {t('viewOnGithub')}
              </a>
            </div>
          </>
        ) : <p className="cd-sec__vacio">{t('branchPending')}</p>}
      </section>
      {c && c.items.length > 0 && (
        <section className="cd-sec">
          <h3>{t('commits')}</h3>
          {c.items.map((x) => (
            <div key={x.hash} className="cd-commit"><code>{x.hash}</code><span>{x.subject}</span><small>{hace(x.date, locale)}</small></div>
          ))}
        </section>
      )}
      <section className="cd-sec">
        <h3>{t('sessionPrs')}</h3>
        {prs.length === 0 ? (
          <div className="cd-dato">
            <Icono nombre="pull-request" size={16} /><span>{t('noPrYet')}</span>
            {rama && activa && (
              <button type="button" className="pill-btn pill-btn--primary" onClick={onCrearPr} disabled={creandoPr}>
                {creandoPr ? t('creatingPr') : t('createPr')}
              </button>
            )}
          </div>
        ) : prs.map((p) => (
          <div key={p.number || p.url} className="cd-pr">
            <div className="cd-pr__fila">
              <Icono nombre="pull-request" size={16} />
              <span>#{p.number} {p.title}</span>
              <span className={`cd-estado cd-estado--${p.state}`}>{t(`pr_${p.state}`)}</span>
            </div>
            <div className="cd-meta">
              {p.checks?.total > 0 && (
                <span>{p.checks.failed ? t('checksFailed', { n: p.checks.failed, total: p.checks.total })
                  : p.checks.pending ? t('checksPending', { n: p.checks.pending, total: p.checks.total })
                    : t('checksOk', { n: p.checks.ok, total: p.checks.total })}</span>
              )}
              {p.changed_files != null && <span>{t('filesN', { n: p.changed_files })}</span>}
              {p.additions != null && <span className="cd-mas">+{p.additions}</span>}
              {p.deletions != null && <span className="cd-menos">−{p.deletions}</span>}
              {p.updated_at && <span>{t('updatedAgo', { t: hace(p.updated_at, locale) })}</span>}
            </div>
            <div className="cd-botones">
              <a className="pill-btn pill-btn--outline" href={p.url} target="_blank" rel="noreferrer"><IconExternal size={14} /> {t('viewOnGithub')}</a>
              {activa && p.state === 'open' && (
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => onPedir(p)}>{t('askChanges')}</button>
              )}
            </div>
          </div>
        ))}
      </section>
      {prs.filter((p) => (p.check_runs || []).length > 0).map((p) => (
        <section key={`checks-${p.number}`} className="cd-sec">
          <h3>{t('checks')} <em>{t('nOfTotal', { n: p.checks.ok, total: p.checks.total })}</em></h3>
          {p.check_runs.map((c, i) => (
            <div key={`${c.name}-${i}`} className="nv-check">
              <Icono nombre={c.result === 'ok' ? 'completado' : c.result === 'failed' ? 'fallo' : 'en-curso'} size={16}
                className={c.result === 'ok' ? 'nv-ok' : c.result === 'failed' ? 'nv-mal' : 'nv-curso'} />
              <span>{c.name}</span>
              {c.seconds != null && <small>{duracionCorta(c.seconds * 1000)}</small>}
              {c.result === 'failed' && activa && p.state === 'open' && (
                <button type="button" className="pill-btn pill-btn--primary" onClick={() => onArreglarCi(p, c)}>{t('fixCi')}</button>
              )}
            </div>
          ))}
        </section>
      ))}
      {prs.filter((p) => (p.reviews || []).length > 0).map((p) => {
        const piden = p.reviews.filter((r) => r.state === 'changes_requested').length;
        return (
          <section key={`rev-${p.number}`} className="cd-sec">
            <h3>{t('reviews')} {piden > 0 && <em>{t('nRequestChanges', { n: piden })}</em>}</h3>
            {p.reviews.map((r) => (
              <div key={r.author} className="nv-rev">
                <i aria-hidden="true">{r.author.slice(0, 2).toUpperCase()}</i>
                <span>{t(`review_${r.state}`, { autor: r.author })}</span>
                {r.state === 'changes_requested' && activa && p.state === 'open' ? (
                  <button type="button" className="pill-btn pill-btn--outline" onClick={() => onResolver(p, r)}>{t('resolveWithAgent')}</button>
                ) : <span />}
                {r.body && <p>{r.body}</p>}
                {(r.comments || []).map((c, i) => (
                  <p key={i}><code>{c.path}{c.line ? `:${c.line}` : ''}</code> {c.body}</p>
                ))}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// Resumen de la sesión al lado del hilo: entorno, contexto, vista previa,
// cambios, PRs y lo que corre en segundo plano.
function PanelResumen({ state, t, sb, repo, rama, base, estado, activa, prs, onClose, setPanel, onPausar, onReanudar, onCrearPr, creandoPr, sendCommand,
  caduca = null, onFijar }) {
  const files = state.diff?.files || [];
  const adds = files.reduce((n, f) => n + (f.adds || 0), 0);
  const dels = files.reduce((n, f) => n + (f.dels || 0), 0);
  const ctx = state.context;
  const pct = ctx?.total ? Math.min(100, Math.round((ctx.used / ctx.total) * 100)) : null;
  const vivos = (state.procs || []).filter((p) => p.alive);
  const pr = prs[0];
  return (
    <aside className="cd-lado" aria-label={t('summary')}>
      <header className="cd-lado__cab">
        <strong>{t('summary')}</strong>
        <button type="button" className="msg-accion" onClick={onClose} aria-label={t('closePanel')} title={t('closePanel')}><IconX size={16} /></button>
      </header>
      <section>
        <h3>{t('environment')}</h3>
        <div className="cd-dato">
          <Icono nombre="remoto" size={16} />
          <span>{t(`estado_${estado}`)}</span>
          {activa && <button type="button" className="cd-link" onClick={onPausar}>{t('pause')}</button>}
          {estado === 'pausada' && <button type="button" className="cd-link" onClick={onReanudar}>{t('resume')}</button>}
        </div>
        <div className="cd-dato"><LogoMarca id="github" size={16} /><span>{repo}</span></div>
        <div className="cd-dato"><Icono nombre="bifurcar" size={16} /><span>{rama || t('branchPending')}</span><small>{t('fromBase', { base })}</small></div>
      </section>
      {caduca && (
        <section>
          <h3>{t('retention')}</h3>
          <div className="cd-dato"><Icono nombre="reloj" size={16} /><span>{t('deletedOn', { fecha: caduca.fecha })}</span>
            <small>{t('daysIdle', { n: caduca.fijada ? caduca.dias.fijada : caduca.dias.normal })}</small></div>
          {!caduca.fijada && (
            <div className="cd-dato"><Icono nombre="fijar" size={16} /><span>{t('pinnedLasts', { n: caduca.dias.fijada })}</span>
              <button type="button" className="cd-link" onClick={onFijar}>{t('pin')}</button></div>
          )}
        </section>
      )}
      {pct != null && (
        <section>
          <h3>{t('context')} <em>{pct} % <span className="cd-barrita"><i style={{ width: `${pct}%` }} /></span></em></h3>
        </section>
      )}
      {state.preview && (
        <section>
          <h3>{t('tab_vista')}</h3>
          <div className="cd-dato"><Icono nombre="navegador" size={16} /><span>{t('port', { n: state.preview.port })}</span>
            <button type="button" className="cd-link" onClick={() => setPanel('vista')}>{t('open')}</button></div>
        </section>
      )}
      <section>
        <h3>{t('tab_cambios')} {files.length > 0 && <em><span className="cd-mas">+{adds}</span> <span className="cd-menos">−{dels}</span></em>}</h3>
        <div className="cd-dato">
          <Icono nombre="git" size={16} />
          <span>{!state.diff ? t('loading') : files.length ? t('filesN', { n: files.length }) : t('noChanges')}</span>
          {files.length > 0 && <button type="button" className="pill-btn pill-btn--outline" onClick={() => setPanel('cambios')}>{t('see')}</button>}
        </div>
      </section>
      <section>
        <h3>{t('tab_prs')}</h3>
        {pr ? (
          <div className="cd-dato"><Icono nombre="pull-request" size={16} /><span>#{pr.number} {pr.title}</span>
            <span className={`cd-estado cd-estado--${pr.state}`}>{t(`pr_${pr.state}`)}</span></div>
        ) : (
          <div className="cd-dato"><Icono nombre="pull-request" size={16} /><span>{t('noPrYet')}</span>
            {rama && activa && (
              <button type="button" className="pill-btn pill-btn--primary" onClick={onCrearPr} disabled={creandoPr}>{creandoPr ? t('creatingPr') : t('createPr')}</button>
            )}</div>
        )}
      </section>
      {vivos.length > 0 && (
        <section>
          <h3>{t('background')}</h3>
          {vivos.map((p) => (
            <div key={p.id} className="cd-dato">
              <Icono nombre="terminal" size={16} /><span title={p.command}>{p.command}</span>
              <button type="button" className="cd-parar" aria-label={t('stopProc')} title={t('stopProc')}
                onClick={() => sendCommand({ type: 'stop_proc', id: p.id })}><i /></button>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}

function Diff({ patch, binario, t }) {
  if (binario) return <div className="cd-vacio">{t('binary')}</div>;
  // Fuera las cabeceras de git (diff, index, modos, renombres, ---/+++): la
  // ruta ya está en la lista de archivos. «\ No newline…» va como nota.
  const lineas = String(patch || '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')
    && !/^(diff --git|index |--- |\+\+\+ |(new|deleted) file mode |old mode |new mode |similarity index |rename (from|to) |Binary files )/.test(l));
  return (
    <pre className="cd-diff">
      {lineas.map((l, i) => {
        const tipo = l.startsWith('@@') || l.startsWith('\\') ? 'hunk' : l.startsWith('+') ? 'mas' : l.startsWith('-') ? 'menos' : '';
        const signo = tipo === 'mas' ? '+' : tipo === 'menos' ? '−' : '';
        const texto = tipo === 'hunk' ? l.replace(/^\\ /, '') : l.slice(1);
        return (
          <div key={i} className={`cd-dl ${tipo ? `cd-dl--${tipo}` : ''}`}>
            <span>{signo}</span><span>{texto}</span>
          </div>
        );
      })}
    </pre>
  );
}

// Árbol de solo lectura a partir de la lista de rutas que da el entorno.
function Arbol({ entries, truncated, t, sel, onAbrir }) {
  const [abiertas, setAbiertas] = useState(() => new Set(['']));
  const raiz = useMemo(() => {
    const r = { dirs: new Map(), files: [] };
    for (const e of entries) {
      const partes = e.path.split('/');
      let nodo = r;
      partes.slice(0, -1).forEach((p) => {
        if (!nodo.dirs.has(p)) nodo.dirs.set(p, { dirs: new Map(), files: [] });
        nodo = nodo.dirs.get(p);
      });
      nodo.files.push({ name: partes[partes.length - 1], status: e.status, path: e.path });
    }
    return r;
  }, [entries]);
  const alternar = (ruta) => setAbiertas((s) => {
    const n = new Set(s);
    if (n.has(ruta)) n.delete(ruta); else n.add(ruta);
    return n;
  });
  const marca = { M: 'cd-m', A: 'cd-a', D: 'cd-d' };
  const filas = [];
  const recorrer = (nodo, ruta, nivel) => {
    [...nodo.dirs.keys()].sort().forEach((nombre) => {
      const sub = ruta ? `${ruta}/${nombre}` : nombre;
      const abierta = abiertas.has(sub);
      filas.push(
        <button key={`d:${sub}`} type="button" className="cd-nodo" style={{ paddingLeft: 8 + nivel * 16 }} onClick={() => alternar(sub)}
          aria-expanded={abierta}>
          <Icono nombre={abierta ? 'carpeta-abierta' : 'carpeta'} size={16} /><span>{nombre}</span>
        </button>,
      );
      if (abierta) recorrer(nodo.dirs.get(nombre), sub, nivel + 1);
    });
    nodo.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
      filas.push(
        <button key={`f:${f.path}`} type="button" className={`cd-nodo ${sel === f.path ? 'is-sel' : ''}`} style={{ paddingLeft: 8 + nivel * 16 }}
          onClick={() => onAbrir(f.path)} disabled={f.status === 'D'}>
          <Icono nombre={f.name.endsWith('.md') ? 'archivo-markdown' : 'archivo-codigo'} size={16} /><span>{f.name}</span>
          {f.status && <small className={marca[f.status] || ''}>{f.status}</small>}
        </button>,
      );
    });
  };
  recorrer(raiz, '', 0);
  return (
    <div className="cd-arbol">
      {filas}
      {truncated && <p className="cd-vacio">{t('truncated')}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ v5

// Ruta del archivo que tocó una herramienta de escritura (para enlazar el paso).
function rutaDeTool(x) {
  if (!/edit|write|patch|create|replace/i.test(x.tool || '')) return null;
  const r = String(x.summary || '').trim();
  return /^[\w@./-]+\.[\w]+$/.test(r) && !r.startsWith('/') ? r : null;
}

function duracionCorta(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${m} min`;
}

const leerFlag = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
function leerResueltas(id) {
  try { return JSON.parse(localStorage.getItem(`lixbon.coding.memoria.${id}`) || '[]'); } catch { return []; }
}

// Pantallas estrechas: los paneles pasan a hoja inferior.
function useMovil() {
  const q = '(max-width: 640px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return undefined;
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return !!m;
}

function Hoja({ movil, onClose, label, children }) {
  if (!movil) return children;
  return (
    <div className="nv-hoja-velo" onClick={onClose}>
      <div className="nv-hoja" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <span className="nv-hoja__asa" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

// «(1) Te necesita · título» y un punto en el icono de la pestaña.
function useAvisoPestana(n, titulo, t) {
  useEffect(() => {
    if (!n) return undefined;
    const antes = document.title;
    document.title = `(${n}) ${t('needsYou')} · ${titulo}`;
    const link = document.querySelector('link[rel~="icon"]');
    const href = link?.getAttribute('href');
    if (link && href) {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 64; c.height = 64;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, 64, 64);
          g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#E5A23B';
          g.beginPath(); g.arc(50, 14, 13, 0, Math.PI * 2); g.fill();
          link.setAttribute('href', c.toDataURL('image/png'));
        } catch { /* sin canvas */ }
      };
      img.src = href;
    }
    return () => {
      document.title = antes;
      if (link && href) link.setAttribute('href', href);
    };
  }, [n, titulo, t]);
}

// Fecha de borrado de una sesión parada y «Fijar» para que dure más.
function Caduca({ fecha, fijada, dias, t, onFijar }) {
  return (
    <span className="nv-caduca">
      <Icono nombre="reloj" size={15} />
      <span>{t('keptUntil', { fecha })}</span>
      {!fijada && <button type="button" className="cd-link" onClick={onFijar}>{t('pinToKeep', { n: dias })}</button>}
    </span>
  );
}

// Bloques de Coding en el anillo de contexto: sesión, turno y segundo plano.
function UsoSesion({ state, trabajando, t }) {
  const lim = state.meta?.limits || {};
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!trabajando || !lim.turn_minutes) return undefined;
    const id = setInterval(() => setAhora(Date.now()), 15000);
    return () => clearInterval(id);
  }, [trabajando, lim.turn_minutes]);
  const u = state.usage;
  const turnoMin = trabajando && state.turnStart ? Math.floor((ahora - state.turnStart) / 60000) : 0;
  const vivos = (state.procs || []).filter((p) => p.alive).length;
  if (!u && !lim.turn_minutes && !lim.background_max) return null;
  const tramo = (frac) => (
    <div className="ctx-tramos">
      <span className="is-messages" style={{ width: `${Math.min(100, Math.round(frac * 100))}%` }} />
      <span className="is-free" />
    </div>
  );
  return (
    <section className="ctx-pop__bloque">
      <div className="ctx-pop__cab">
        <span>{t('usageSession')}{u && <b className="ctx-pop__valor">{duracionCorta(u.seconds * 1000)}</b>}</span>
        {u && <span className="ctx-pop__dato">{t('tokensK', { n: Math.round(u.tokens / 1000) })}</span>}
      </div>
      {lim.turn_minutes > 0 && (
        <div className="nv-limite">
          <div className="ctx-pop__cab"><span>{t('usageTurn')}</span>
            <span className="ctx-pop__dato">{t('minOf', { n: turnoMin, max: lim.turn_minutes })}</span></div>
          {tramo(turnoMin / lim.turn_minutes)}
        </div>
      )}
      {lim.background_max > 0 && (
        <div className="nv-limite">
          <div className="ctx-pop__cab"><span>{t('background')}</span>
            <span className="ctx-pop__dato">{t('procsOf', { n: vivos, max: lim.background_max })}</span></div>
          {tramo(vivos / lim.background_max)}
        </div>
      )}
    </section>
  );
}
