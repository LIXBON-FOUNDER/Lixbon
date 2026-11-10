// GitHub en el chat: el desplegable del repo adjunto, el del modo del agente,
// la línea de progreso de las herramientas y la tarjeta para aceptar una
// acción (modo manual). Los desplegables son botones sin fondo, como el del
// modelo: comparten sus clases `modelo-menu__*`.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { useDismiss } from '../hooks/useDismiss';
import { useSalida } from '../hooks/useSalida';
import { IconCheck, IconChevron, IconExternal, IconSearch } from './Icons';
import { LogoMarca } from './LogosMarcas';
import { MODOS, estadoGithub, reposGithub } from '../lib/github';
import { ConectarGithub } from './ConectarGithub';
import '../styles/github.css';

const MARGEN = 12;

export function useMenu() {
  const [abierto, setAbierto] = useState(false);
  const [abajo, setAbajo] = useState(false);
  const raiz = useRef(null);
  const panel = useRef(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useDismiss(abierto, raiz, cerrar);
  // Hacia donde haya sitio: abajo en la portada, arriba con la conversación.
  useLayoutEffect(() => {
    if (!abierto) return;
    const btn = raiz.current?.getBoundingClientRect();
    const p = panel.current?.getBoundingClientRect();
    if (!btn || !p) return;
    setAbajo(window.innerHeight - btn.bottom - MARGEN >= p.height);
  }, [abierto]);
  const { montado, cerrando } = useSalida(abierto, 140);
  return { abierto, setAbierto, cerrar, abajo, raiz, panel, montado, cerrando };
}

/** Repo adjunto al chat. Sin cuenta conectada ofrece conectarla. */
export function MenuRepo({ repo, onChange, fijo = null }) {
  const t = useT('github');
  const m = useMenu();
  const [estado, setEstado] = useState(null);
  const [repos, setRepos] = useState(undefined);
  const [manage, setManage] = useState('');
  const [busca, setBusca] = useState('');
  const [conectar, setConectar] = useState(false);

  useEffect(() => {
    let vivo = true;
    estadoGithub().then((e) => vivo && setEstado(e)).catch(() => vivo && setEstado({ configured: false }));
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (!m.abierto || !estado?.connected || repos !== undefined) return;
    reposGithub()
      .then((d) => { setRepos(d.repos || []); setManage(d.manage_url || ''); })
      .catch(() => setRepos(null));
  }, [m.abierto, estado, repos]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (repos || []).filter((r) => !q || r.full_name.toLowerCase().includes(q));
  }, [repos, busca]);

  // Sin el conector configurado en el servidor, el chat no enseña nada.
  if (!estado?.configured) return null;

  const elegir = (r) => { onChange(r); m.cerrar(); };
  const nombre = repo ? repo.full_name.split('/')[1] : t('repo');

  // Repo del espacio: se ve, pero no se cambia desde el chat (se cambia en el espacio).
  if (fijo && repo) {
    return (
      <div className="modelo-menu gh-menu">
        <span className="modelo-menu__btn is-on is-fijo" title={t('repoFromSpace', { repo: repo.full_name, espacio: fijo })}
          aria-label={t('repoFromSpace', { repo: repo.full_name, espacio: fijo })}>
          <LogoMarca id="github" size={15} />
          <span className="modelo-menu__nombre">{nombre}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="modelo-menu gh-menu" ref={m.raiz}>
      <button type="button" className={`modelo-menu__btn ${m.abierto ? 'is-open' : ''} ${repo ? 'is-on' : ''}`}
        onClick={() => m.setAbierto(!m.abierto)} aria-haspopup="menu" aria-expanded={m.abierto}
        aria-label={t('repoAria')} title={repo?.full_name || t('repoAria')}>
        <LogoMarca id="github" size={15} />
        <span className="modelo-menu__nombre">{nombre}</span>
        <IconChevron size={14} open={m.abierto} className="modelo-menu__chevron" />
      </button>

      {m.montado && (
        <div ref={m.panel} className={`modelo-menu__panel gh-menu__panel ${m.abajo ? 'is-abajo' : 'is-arriba'} ${m.cerrando ? 'is-cerrando' : ''}`}
          role="menu" aria-label={t('repoAria')}>
          {!estado.connected ? (
            <button type="button" role="menuitem" className="modelo-menu__opt gh-menu__conectar" onClick={() => { m.cerrar(); setConectar(true); }}>
              <LogoMarca id="github" size={16} />
              <span className="gh-menu__dos">
                <span>{t('connect')}</span>
                <small>{t('connectHint')}</small>
              </span>
            </button>
          ) : (
            <>
              {repos && repos.length > 8 && (
                <label className="gh-menu__buscar">
                  <IconSearch size={14} />
                  <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)}
                    placeholder={t('search')} aria-label={t('search')} />
                </label>
              )}
              <div className="modelo-menu__lista">
                {repos === undefined && <p className="gh-menu__nota">{t('loading')}</p>}
                {repos === null && <p className="gh-menu__nota">{t('loadError')}</p>}
                {repos && !repos.length && <p className="gh-menu__nota">{t('noRepos')}</p>}
                {lista.map((r) => {
                  const sel = repo?.full_name === r.full_name;
                  return (
                    <button key={r.full_name} type="button" role="menuitemradio" aria-checked={sel}
                      className={`modelo-menu__opt ${sel ? 'is-sel' : ''}`} onClick={() => elegir(r)}>
                      <span className="modelo-menu__txt">{r.full_name}</span>
                      {r.private && <span className="modelo-menu__valor">{t('private')}</span>}
                      {sel && <IconCheck size={14} />}
                    </button>
                  );
                })}
              </div>
              <div className="modelo-menu__sep" />
              {repo && (
                <button type="button" role="menuitem" className="modelo-menu__opt" onClick={() => elegir(null)}>
                  <span className="modelo-menu__txt">{t('none')}</span>
                </button>
              )}
              {manage && (
                <a role="menuitem" className="modelo-menu__opt" href={manage} target="_blank" rel="noreferrer">
                  <span className="modelo-menu__txt">{t('manage')}</span>
                  <IconExternal size={14} />
                </a>
              )}
            </>
          )}
        </div>
      )}
      {conectar && <ConectarGithub onClose={() => setConectar(false)} />}
    </div>
  );
}

/** Modo del agente. Solo cambia el modo: los permisos los pone el backend. */
export function MenuModo({ modo, onChange }) {
  const t = useT('github');
  const m = useMenu();
  return (
    <div className="modelo-menu gh-menu" ref={m.raiz}>
      <button type="button" className={`modelo-menu__btn ${m.abierto ? 'is-open' : ''}`}
        onClick={() => m.setAbierto(!m.abierto)} aria-haspopup="menu" aria-expanded={m.abierto} aria-label={t('modeAria')}>
        <span className="modelo-menu__nombre">{t(`mode_${modo}`)}</span>
        <IconChevron size={14} open={m.abierto} className="modelo-menu__chevron" />
      </button>
      {m.montado && (
        <div ref={m.panel} className={`modelo-menu__panel gh-menu__panel ${m.abajo ? 'is-abajo' : 'is-arriba'} ${m.cerrando ? 'is-cerrando' : ''}`}
          role="menu" aria-label={t('modeAria')}>
          <div className="modelo-menu__lista">
            {MODOS.map((id) => (
              <button key={id} type="button" role="menuitemradio" aria-checked={id === modo}
                className={`modelo-menu__opt ${id === modo ? 'is-sel' : ''}`}
                onClick={() => { onChange(id); m.cerrar(); }}>
                <span className="gh-menu__dos">
                  <span>{t(`mode_${id}`)}</span>
                  <small>{t(`mode_${id}_d`)}</small>
                </span>
                {id === modo && <IconCheck size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Lo que va en el pie del cuadro de mensaje: repo y, con repo, el modo. */
export function GithubComposer({ repo, onRepo, modo, onModo, fijo = null }) {
  return (
    <>
      <MenuRepo repo={repo} onChange={onRepo} fijo={fijo} />
      {repo && <MenuModo modo={modo} onChange={onModo} />}
    </>
  );
}

/** Frase de la línea de progreso para el evento `lixbon_tool` en curso. */
export function useTextoHerramienta() {
  const t = useT('github');
  return useCallback((ev) => {
    if (!ev) return '';
    const clave = `tool_${ev.name}`;
    const texto = t(clave, { x: ev.target || '' });
    return texto === clave ? t('tool_default') : texto.replace(/\s+$/, '');
  }, [t]);
}

/** Acción que espera al usuario (modo manual). `estado`: undefined | enviando | aceptada | rechazada.
 *  Se lee como una petición de Lixbon («Lixbon quiere…»), con la rama y los
 *  archivos como en un commit: + escribir, − borrar. */
export function ConfirmacionGithub({ accion, estado, onResolver, deshabilitada = false }) {
  const t = useT('github');
  const escribir = accion.tool === 'github_write_files';
  const titulo = escribir ? t('confirmWrite')
    : accion.tool === 'github_delete_branch' ? t('confirmDeleteBranch') : t('confirmGeneric');
  const resuelta = estado === 'aceptada' || estado === 'rechazada';
  const bloqueada = deshabilitada || estado === 'enviando';

  if (resuelta) {
    return (
      <p className={`gh-confirma-hecha ${estado === 'rechazada' ? 'is-rechazada' : ''}`}>
        <LogoMarca id="github" size={14} />
        <span>{titulo}</span>
        {accion.branch && <code>{accion.branch}</code>}
        <span className="gh-confirma-hecha__estado">· {estado === 'aceptada' ? t('accepted') : t('rejected')}</span>
      </p>
    );
  }

  return (
    <div className="gh-confirma" role="group" aria-label={titulo}>
      <div className="gh-confirma__cab">
        <span className="gh-confirma__icono"><LogoMarca id="github" size={18} /></span>
        <div className="gh-confirma__titulos">
          <strong>{titulo}</strong>
          <span>
            {accion.repo}
            {accion.branch && <> · <code className="gh-confirma__rama">{accion.branch}</code></>}
          </span>
        </div>
        {/* «Te necesita» en ámbar: el único color de este estado, en toda la app. */}
        <span className="estado estado--espera">{t('needsYou')}</span>
      </div>

      {accion.message && <p className="gh-confirma__commit">{accion.message}</p>}

      {accion.files?.length > 0 && (
        <ul className="gh-confirma__archivos">
          {accion.files.map((f) => (
            <li key={`${f.accion}:${f.path}`} className={f.accion === 'borrar' ? 'is-borrar' : 'is-escribir'}>
              <span className="gh-confirma__signo" aria-label={f.accion === 'borrar' ? t('fileDelete') : t('fileWrite')}>
                {f.accion === 'borrar' ? '−' : '+'}
              </span>
              <code>{f.path}</code>
              {f.lineas ? <span className="gh-confirma__lineas">{(f.lineas === 1 ? t('line') : t('lines', { n: f.lineas }))}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {accion.riesgo && <p className="gh-confirma__riesgo">{t(`risk_${accion.riesgo}`)}</p>}

      <div className="gh-confirma__acciones">
        <button type="button" className="pill-btn pill-btn--outline" disabled={bloqueada}
          onClick={() => onResolver(false)}>{t('reject')}</button>
        <button type="button" className="pill-btn pill-btn--primary" disabled={bloqueada}
          onClick={() => onResolver(true)}>{estado === 'enviando' ? t('resolving') : t('accept')}</button>
      </div>
    </div>
  );
}
