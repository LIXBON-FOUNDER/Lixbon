// Espacios: la lista (o qué es un espacio, si aún no hay) y el detalle de uno
// con su composer, sus agentes, sus chats y el panel de tarjetas de la
// derecha (instrucciones, archivos, memoria, repositorio, accesos).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { Link, useNavigate } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useShell } from '../components/AppShell';
import { useConfirmar } from '../hooks/useConfirmar';
import { Icono, IconMenu, IconSearch, IconX, IconSend } from '../components/Icons';
import { LogoMarca } from '../components/LogosMarcas';
import { useMenu } from '../components/GithubChat';
import {
  Baldosa, Estado, VentanaAgente, VentanaEspacio, VentanaInstrucciones, useFechaCorta, useHorario,
} from '../components/Espacios';
import {
  anadirNota, aprobarNota, borrarArchivo, borrarEspacio, borrarNota, editarEspacio, errorDe,
  leerEspacio, listarEspacios, subirArchivo, tipoArchivo,
} from '../lib/espacios';
import { fmtBytes } from '../lib/archivos';
import { estadoGithub, reposGithub } from '../lib/github';
import '../styles/espacios.css';

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function Cabecera({ children, acciones }) {
  const tch = useT('chat');
  const { openDrawer, drawerOpen } = useShell();
  return (
    <header className="chat-header int-cab">
      <button className="icon-btn chat-header__menu" onClick={openDrawer} aria-label={tch('openConversationsPanel')}
        aria-controls="sidebar-drawer" aria-expanded={drawerOpen}>
        <IconMenu />
      </button>
      <span className="esp-migas">{children}</span>
      {acciones && <span className="esp-cab-acciones">{acciones}</span>}
    </header>
  );
}

function IconoBtn({ icono, etiqueta, onClick, fijo = false, disabled = false }) {
  return (
    <button type="button" className={`icon-btn ${fijo ? 'is-fijo' : ''}`} onClick={onClick} disabled={disabled}
      aria-label={etiqueta} title={etiqueta}>
      <Icono nombre={icono} size={16} />
    </button>
  );
}

// ── Lista ───────────────────────────────────────────────────────────────────
function Lista() {
  const t = useT('espacios');
  useSeo({ title: t('seoTitle'), noindex: true });
  const fecha = useFechaCorta();
  const navigate = useNavigate();
  const [espacios, setEspacios] = useState(undefined);
  const [nuevo, setNuevo] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    listarEspacios().then(setEspacios).catch(() => setEspacios(null));
  }, []);

  const q = norm(busca.trim());
  const visibles = (espacios || []).filter((e) => !q || norm(`${e.nombre} ${e.descripcion}`).includes(q));
  const vacio = espacios && !espacios.length;

  const que = [
    ['texto', 'instrucciones'], ['archivo', 'archivos'], ['github', 'repo'],
    ['llave', 'accesos'], ['agente', 'agentes'], ['bombilla', 'memoria'],
  ];

  return (
    <section className="chat-main int-page">
      <Cabecera>{t('title')}</Cabecera>
      <div className="int-cuerpo">
        <div className="int-col">
          <div className="esp-titulo-fila">
            <h1 className="int-titulo">{t('title')}</h1>
            {espacios?.length > 0 && <IconoBtn icono="buscar" etiqueta={t('searchSpaces')} onClick={() => { setBuscando((v) => !v); setBusca(''); }} />}
            <button type="button" className="pill-btn pill-btn--primary" onClick={() => setNuevo(true)}>
              <Icono nombre="mas" size={15} /> {t('newSpace')}
            </button>
          </div>
          {(vacio || espacios === undefined) && <p className="int-sub">{t('sub')}</p>}
          {buscando && (
            <label className="int-buscar" style={{ marginTop: 16 }}>
              <IconSearch size={16} />
              <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={t('searchSpaces')} aria-label={t('searchSpaces')} />
              {busca && <button type="button" className="int-buscar__x" onClick={() => setBusca('')} aria-label="×"><IconX size={14} /></button>}
            </label>
          )}

          {espacios === undefined && <p className="int-vacio">{t('loading')}</p>}
          {espacios === null && <p className="int-vacio">{t('loadError')}</p>}

          {vacio && (
            <div className="esp-seccion">
              <div className="esp-seccion__cab"><h2>{t('whatTitle')}</h2></div>
              <div className="esp-rejilla">
                {que.map(([icono, id]) => (
                  <div key={id} className="esp-tarjeta">
                    <Baldosa icono={icono} />
                    <span className="esp-tarjeta__texto">
                      <span className="esp-tarjeta__titulo">{t(`what_${id}`)}</span>
                      <span className="esp-tarjeta__sub">{t(`what_${id}_d`)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {espacios?.length > 0 && (
            <div className="esp-seccion">
              {!visibles.length && <p className="int-vacio">{t('noResults')}</p>}
              <div className="esp-rejilla">
                {visibles.map((e) => {
                  const partes = [
                    e.repo,
                    e.agentes ? t(e.agentes === 1 ? 'nAgents_one' : 'nAgents_other', { n: e.agentes }) : null,
                    e.archivos ? t(e.archivos === 1 ? 'nFiles_one' : 'nFiles_other', { n: e.archivos }) : null,
                  ].filter(Boolean);
                  return (
                    <Link key={e.id} to={`/espacios/${e.id}`} className="esp-tarjeta">
                      <Baldosa icono="carpeta" />
                      <span className="esp-tarjeta__texto">
                        <span className="esp-tarjeta__titulo">{e.nombre}</span>
                        <span className="esp-tarjeta__sub">
                          {partes.length ? partes.join(' · ') : e.descripcion || t('editedAgo', { cuando: fecha(e.updated_at).toLowerCase() })}
                        </span>
                      </span>
                      <Estado estado={e.ultima?.estado} />
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {nuevo && <VentanaEspacio onClose={() => setNuevo(false)} onListo={(e) => navigate(`/espacios/${e.id}`)} />}
    </section>
  );
}

// ── Panel de la derecha ─────────────────────────────────────────────────────
function Carta({ icono, titulo, accion, children }) {
  return (
    <section className="esp-carta">
      <div className="esp-carta__cab">
        {typeof icono === 'string' ? <Icono nombre={icono} size={18} /> : icono}
        <h3>{titulo}</h3>
        {accion}
      </div>
      {children && <div className="esp-carta__cuerpo">{children}</div>}
    </section>
  );
}

function CartaArchivos({ espacio, onCambio }) {
  const t = useT('espacios');
  const ref = useRef(null);
  const [error, setError] = useState('');
  const [subiendo, setSubiendo] = useState(false);
  const subir = async (lista) => {
    setError('');
    setSubiendo(true);
    try {
      for (const f of lista) await subirArchivo(espacio.id, f);
    } catch (e) {
      setError(errorDe(e, t('loadError')));
    } finally {
      setSubiendo(false);
      if (ref.current) ref.current.value = '';
      onCambio();
    }
  };
  return (
    <Carta icono="archivo" titulo={t('files')}
      accion={<IconoBtn icono="mas" etiqueta={t('addFile')} disabled={subiendo} onClick={() => ref.current?.click()} />}>
      <input ref={ref} type="file" hidden multiple accept=".md,.txt,.csv,.json,.html,.xml,.yaml,.yml,text/*,application/json"
        onChange={(e) => subir([...e.target.files])} />
      {!espacio.archivos.length && <p className="esp-carta__texto">{t('noFiles')}</p>}
      {espacio.archivos.map((a) => {
        const tipo = tipoArchivo(a.nombre);
        return (
        <div key={a.id} className="esp-linea esp-archivo">
          <span className={`esp-archivo__icono esp-archivo__icono--${tipo.clave}`} aria-hidden="true"><Icono nombre={tipo.icono} size={18} /></span>
          <span className="esp-linea__texto">
            <span className="esp-archivo__nombre" title={a.nombre}>{a.nombre}</span>
            <span className="esp-linea__sub">{t(`type_${tipo.clave}`)} · {fmtBytes(a.size)}</span>
          </span>
          <IconoBtn icono="borrar" etiqueta={t('removeFile')} onClick={async () => { await borrarArchivo(espacio.id, a.id); onCambio(); }} />
        </div>
        );
      })}
      {error && <p className="esp-error" role="alert">{error}</p>}
    </Carta>
  );
}

function CartaMemoria({ espacio, onCambio }) {
  const t = useT('espacios');
  const [anadiendo, setAnadiendo] = useState(false);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState('');
  const guardar = async (e) => {
    e.preventDefault();
    if (!texto.trim()) return;
    try {
      await anadirNota(espacio.id, texto.trim());
      setTexto('');
      setAnadiendo(false);
      onCambio();
    } catch (err) {
      setError(errorDe(err, t('loadError')));
    }
  };
  return (
    <Carta icono="bombilla" titulo={t('memory')}
      accion={<IconoBtn icono={anadiendo ? 'cerrar' : 'mas'} etiqueta={t('addNote')} onClick={() => { setAnadiendo((v) => !v); setError(''); }} />}>
      {!espacio.memoria.length && !anadiendo && <p className="esp-carta__texto">{t('noMemory')}</p>}
      {espacio.memoria.map((m) => (
        <div key={m.id} className="esp-linea">
          <span className="esp-linea__texto">{m.texto}{!m.aprobada && <span className="esp-linea__sub">{t('proposedByAgent')}</span>}</span>
          {!m.aprobada && <IconoBtn icono="guardar" fijo etiqueta={t('saveToMemory')} onClick={async () => { await aprobarNota(espacio.id, m.id); onCambio(); }} />}
          <IconoBtn icono="borrar" etiqueta={t('removeNote')} onClick={async () => { await borrarNota(espacio.id, m.id); onCambio(); }} />
        </div>
      ))}
      {anadiendo && (
        <form className="esp-nota-form" onSubmit={guardar}>
          <input className="set-input" autoFocus maxLength={500} value={texto} placeholder={t('notePlaceholder')}
            aria-label={t('addNote')} onChange={(e) => setTexto(e.target.value)} />
          <button type="submit" className="icon-btn" aria-label={t('save')} title={t('save')} disabled={!texto.trim()}>
            <Icono nombre="hecho" size={16} />
          </button>
        </form>
      )}
      {error && <p className="esp-error" role="alert">{error}</p>}
    </Carta>
  );
}

function CartaRepo({ espacio, github, onCambio }) {
  const t = useT('espacios');
  const tg = useT('github');
  const m = useMenu();
  const [repos, setRepos] = useState(undefined);
  useEffect(() => {
    if (!m.abierto || repos !== undefined) return;
    reposGithub().then((d) => setRepos(d.repos || [])).catch(() => setRepos(null));
  }, [m.abierto, repos]);
  const poner = async (repo) => {
    m.cerrar();
    await editarEspacio(espacio.id, { repo });
    onCambio();
  };
  const conectado = github?.connected;
  const accion = espacio.repo
    ? <IconoBtn icono="cerrar" etiqueta={t('unlinkRepo')} onClick={() => poner(null)} />
    : conectado ? (
      <div className="modelo-menu gh-menu" ref={m.raiz}>
        <IconoBtn icono="mas" etiqueta={t('linkRepo')} onClick={() => m.setAbierto(!m.abierto)} />
        {m.montado && (
          <div ref={m.panel} className={`modelo-menu__panel gh-menu__panel ${m.abajo ? 'is-abajo' : 'is-arriba'} ${m.cerrando ? 'is-cerrando' : ''}`}
            style={{ right: 0, left: 'auto' }} role="menu" aria-label={t('linkRepo')}>
            <div className="modelo-menu__lista">
              {repos === undefined && <p className="gh-menu__nota">{tg('loading')}</p>}
              {repos === null && <p className="gh-menu__nota">{tg('loadError')}</p>}
              {repos && !repos.length && <p className="gh-menu__nota">{tg('noRepos')}</p>}
              {(repos || []).map((r) => (
                <button key={r.full_name} type="button" role="menuitem" className="modelo-menu__opt" onClick={() => poner(r.full_name)}>
                  <span className="modelo-menu__txt">{r.full_name}</span>
                  {r.private && <span className="modelo-menu__valor">{tg('private')}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    ) : <Link to="/integraciones" className="icon-btn" aria-label={t('accessManage')} title={t('accessManage')}><Icono nombre="mas" size={16} /></Link>;
  return (
    <Carta icono="github" titulo={t('repo')} accion={accion}>
      {espacio.repo
        ? <div className="esp-linea"><span className="esp-linea__texto">{espacio.repo}</span></div>
        : <p className="esp-carta__texto">{t('noRepo')}</p>}
    </Carta>
  );
}

function CartaAccesos({ github }) {
  const t = useT('espacios');
  return (
    <Carta icono="llave" titulo={t('access')}
      accion={<Link to="/integraciones" className="icon-btn" aria-label={t('accessManage')} title={t('accessManage')}><Icono nombre="siguiente" size={16} /></Link>}>
      {github?.connected ? (
        <div className="esp-linea">
          <LogoMarca id="github" size={14} />
          <span className="esp-linea__texto">{t('accessGithub', { login: github.login })}</span>
          <Estado estado="hecho" />
        </div>
      ) : <p className="esp-carta__texto">{t('accessNone')}</p>}
    </Carta>
  );
}

// ── Detalle ─────────────────────────────────────────────────────────────────
function Detalle({ id }) {
  const t = useT('espacios');
  const navigate = useNavigate();
  const confirmar = useConfirmar();
  const horario = useHorario();
  const fecha = useFechaCorta();
  const { user } = useAuth();
  const [espacio, setEspacio] = useState(undefined);
  const [github, setGithub] = useState(null);
  const [ventana, setVentana] = useState(null); // editar | instrucciones | agente
  const [texto, setTexto] = useState('');
  useSeo({ title: espacio?.nombre || t('seoTitle'), noindex: true });

  const cargar = useCallback(() => {
    leerEspacio(id).then(setEspacio).catch((e) => setEspacio(e?.response?.status === 404 ? null : false));
  }, [id]);
  useEffect(cargar, [cargar]);
  useEffect(() => {
    if (user) estadoGithub().then(setGithub).catch(() => setGithub(null));
  }, [user]);

  const empezarChat = (e) => {
    e?.preventDefault();
    const mensaje = texto.trim();
    if (!mensaje) return;
    navigate('/chat', { state: { espacio: { id: espacio.id, nombre: espacio.nombre, repo: espacio.repo || null }, mensaje } });
  };

  const borrar = async () => {
    const ok = await confirmar({ titulo: t('deleteSpaceTitle'), texto: t('deleteSpaceText'), etiqueta: t('delete') });
    if (!ok) return;
    await borrarEspacio(espacio.id);
    navigate('/espacios', { replace: true });
  };

  if (espacio === undefined) {
    return <section className="chat-main int-page"><Cabecera><Link to="/espacios">{t('breadcrumb')}</Link></Cabecera><div className="int-cuerpo"><p className="int-vacio">{t('loading')}</p></div></section>;
  }
  if (!espacio) {
    return <section className="chat-main int-page"><Cabecera><Link to="/espacios">{t('breadcrumb')}</Link></Cabecera><div className="int-cuerpo"><p className="int-vacio">{t('loadError')}</p></div></section>;
  }

  return (
    <section className="chat-main int-page">
      <Cabecera acciones={<>
        <IconoBtn icono="editar" etiqueta={t('editSpace')} onClick={() => setVentana('editar')} />
        <IconoBtn icono="borrar" etiqueta={t('delete')} onClick={borrar} />
      </>}>
        <Link to="/espacios">{t('breadcrumb')}</Link>
        <span className="esp-migas__sep">/</span>
        <span>{espacio.nombre}</span>
      </Cabecera>

      <div className="int-cuerpo">
        <div className="esp-detalle">
          <div className="esp-detalle__main">
            <h1 className="esp-nombre">{espacio.nombre}</h1>
            {espacio.descripcion && <p className="int-sub" style={{ marginBottom: 0 }}>{espacio.descripcion}</p>}

            <form className="chat-input esp-composer" onSubmit={empezarChat}>
              <div className="chat-input__box">
                <textarea className="chat-input__text" rows={2} value={texto} placeholder={t('composerPlaceholder')}
                  aria-label={t('composerPlaceholder')} onChange={(e) => setTexto(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) empezarChat(e); }} />
                <div className="chat-input__bar">
                  <div className="chat-input__tools" />
                  <div className="chat-input__meta">
                    <button type="submit" className="chat-input__send" disabled={!texto.trim()} aria-label={t('send')}><IconSend /></button>
                  </div>
                </div>
              </div>
            </form>

            <section className="esp-seccion">
              <div className="esp-seccion__cab">
                <h2>{t('agents')}</h2>
                <button type="button" className="pill-btn pill-btn--outline" onClick={() => setVentana('agente')}>
                  <Icono nombre="mas" size={15} /> {t('newAgent')}
                </button>
              </div>
              {!espacio.agentes.length && <p className="esp-vacio">{t('noAgents')}</p>}
              <div className="esp-rejilla">
                {espacio.agentes.map((a) => (
                  <Link key={a.id} to={`/agentes/${a.id}`} className="esp-tarjeta">
                    <Baldosa icono="agente" />
                    <span className="esp-tarjeta__texto">
                      <span className="esp-tarjeta__titulo">{a.nombre}</span>
                      <span className="esp-tarjeta__sub">{a.pausado ? t('paused') : horario(a)}</span>
                    </span>
                    <Estado estado={a.pausado ? 'pausa' : a.ultima?.estado} />
                  </Link>
                ))}
              </div>
            </section>

            <section className="esp-seccion">
              <div className="esp-seccion__cab"><h2>{t('chats')}</h2></div>
              {!espacio.chats.length && <p className="esp-vacio">{t('noChats')}</p>}
              <div className="esp-pila">
                {espacio.chats.map((c) => (
                  <Link key={c.id} to={`/c/${c.id}`} className="esp-tarjeta esp-tarjeta--compacta">
                    <Baldosa icono="chat" />
                    <span className="esp-tarjeta__texto">
                      <span className="esp-tarjeta__titulo">{c.title || t('chats')}</span>
                      <span className="esp-tarjeta__sub">{fecha(c.updated_at)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          </div>

          <aside className="esp-lateral">
            <Carta icono="texto" titulo={t('instructions')}
              accion={<IconoBtn icono="editar" etiqueta={t('editInstructions')} onClick={() => setVentana('instrucciones')} />}>
              <p className="esp-carta__texto">{espacio.instrucciones || t('noInstructions')}</p>
            </Carta>
            <CartaArchivos espacio={espacio} onCambio={cargar} />
            <CartaMemoria espacio={espacio} onCambio={cargar} />
            <CartaRepo espacio={espacio} github={github} onCambio={cargar} />
            <CartaAccesos github={github} />
            <p className="esp-privado"><Icono nombre="candado" size={14} /> {t('private')}</p>
          </aside>
        </div>
      </div>

      {ventana === 'editar' && <VentanaEspacio espacio={espacio} onClose={() => setVentana(null)} onListo={cargar} />}
      {ventana === 'instrucciones' && <VentanaInstrucciones espacio={espacio} onClose={() => setVentana(null)} onListo={cargar} />}
      {ventana === 'agente' && <VentanaAgente espacio={espacio} onClose={() => setVentana(null)} onListo={(a) => navigate(`/agentes/${a.id}`)} />}
    </section>
  );
}

export default function EspaciosPage() {
  const { id } = useParams();
  return id ? <Detalle key={id} id={id} /> : <Lista />;
}
