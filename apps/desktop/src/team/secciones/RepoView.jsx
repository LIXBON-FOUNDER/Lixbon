// RepoView.jsx — el repositorio de GitHub del proyecto, en solo lectura:
// árbol, archivo con números de línea y el historial al lado.
import { useEffect, useMemo, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useRepoStore } from '../store/repoStore';
import { useMensajesStore } from '../store/mensajesStore';
import { Conectar, Aviso } from './Conectar';
import { TPanel, TGutter } from '../ui/Panel';
import { TOKEN_URL, normalizeRepo } from '../lib/githubApi';
import { hace, fechaLarga } from '../lib/tiempo';
import { peso } from '../chat/Adjunto';
import { openExternal } from '../../lib/tauri';
import {
  IconGitBranch, IconRefresh, IconLogout, IconWarn, IconExternal, IconChevronRight, IconChevronDown, IconX, IconFile, IconChat,
} from '../../components/Icons';
import { IconGitHub, IconLock, IconStar, IconFork } from '../ui/icons';

function armar(entradas) {
  const raiz = { hijos: new Map() };
  for (const nodo of entradas) {
    const partes = nodo.path.split('/');
    let actual = raiz;
    partes.forEach((nombre, i) => {
      const hoja = i === partes.length - 1;
      if (!actual.hijos.has(nombre)) {
        actual.hijos.set(nombre, { nombre, ruta: partes.slice(0, i + 1).join('/'), carpeta: !hoja || nodo.type === 'tree', bytes: hoja ? nodo.size : undefined, hijos: new Map() });
      }
      actual = actual.hijos.get(nombre);
    });
  }
  return raiz;
}

const ordenar = (mapa) => [...mapa.values()].sort((a, b) => (a.carpeta !== b.carpeta ? (a.carpeta ? -1 : 1) : a.nombre.localeCompare(b.nombre, 'es')));

// Solo se pinta lo desplegado: un repositorio grande abierto entero ahoga el DOM.
function Rama({ nodos, nivel, desplegadas, rutaAbierta, onCarpeta, onArchivo }) {
  return nodos.map((n) => {
    const abierta = desplegadas.has(n.ruta);
    return (
      <div key={n.ruta}>
        <button className={`tarbol__fila ${rutaAbierta === n.ruta ? 'is-on' : ''} ${n.carpeta ? 'is-carpeta' : ''}`} style={{ paddingLeft: 8 + nivel * 14 }} onClick={() => (n.carpeta ? onCarpeta(n.ruta) : onArchivo(n.ruta))} title={n.ruta}>
          <span className="tarbol__flecha">{n.carpeta && (abierta ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)}</span>
          <span className="tarbol__n">{n.nombre}</span>
        </button>
        {n.carpeta && abierta && <Rama nodos={ordenar(n.hijos)} nivel={nivel + 1} desplegadas={desplegadas} rutaAbierta={rutaAbierta} onCarpeta={onCarpeta} onArchivo={onArchivo} />}
      </div>
    );
  });
}

function Compartir({ repo, rama, ruta, desde, hasta, onListo }) {
  const { proyectoActivo, usuario } = useTeamStore();
  const enviar = useMensajesStore((s) => s.enviar);
  const canales = proyectoActivo()?.canales || [];
  const [destino, setDestino] = useState(canales[0]?.id || '');
  const lineas = desde === hasta ? `${desde}` : `${desde}-${hasta}`;
  const mandar = () => {
    const enlace = `https://github.com/${repo}/blob/${rama}/${ruta}#L${desde}${desde === hasta ? '' : `-L${hasta}`}`;
    enviar(destino, `\`${ruta}:${lineas}\` en \`${rama}\`\n${enlace}`, usuario?.id);
    onListo(canales.find((c) => c.id === destino)?.nombre);
  };
  if (!canales.length) return null;
  return (
    <div className="tcompartir">
      <IconChat size={13} />
      <span>Líneas {lineas}</span>
      <select value={destino} onChange={(e) => setDestino(e.target.value)} aria-label="Canal">
        {canales.map((c) => <option key={c.id} value={c.id}>#{c.nombre}</option>)}
      </select>
      <button className="btn btn--primary btn--sm" onClick={mandar}>Compartir</button>
    </div>
  );
}

function Archivo({ repo, rama, ruta, datos, onCerrar }) {
  const [sel, setSel] = useState(null);
  const [aviso, setAviso] = useState('');
  useEffect(() => { setSel(null); setAviso(''); }, [ruta]);
  const lineas = datos?.texto ? datos.texto.replace(/\n$/, '').split('\n') : [];
  const ultimo = datos?.historia?.[0];
  const elegir = (n, e) => setSel((s) => (e.shiftKey && s ? { desde: Math.min(s.desde, n), hasta: Math.max(s.desde, n) } : { desde: n, hasta: n }));
  return (
    <>
      <header className="tpanelhead">
        <span className="mono tarchivo__ruta" title={ruta}>{ruta.split('/').slice(0, -1).map((p) => `${p} / `)}<b>{ruta.split('/').pop()}</b></span>
        {datos && !datos.cargando && <span className="mono tdim">{lineas.length ? `${lineas.length} líneas · ` : ''}{peso(datos.bytes)}</span>}
        <div className="tfill" />
        <button className="ic" onClick={() => openExternal(datos?.url || `https://github.com/${repo}/blob/${rama}/${ruta}`)} aria-label="Abrir en GitHub"><IconExternal size={14} /></button>
        <button className="ic" onClick={onCerrar} aria-label="Cerrar el archivo"><IconX size={14} /></button>
      </header>
      {ultimo && (
        <p className="tultimo mono" title={fechaLarga(ultimo.commit?.author?.date)}>
          <span className="tdim">{ultimo.author?.login || ultimo.commit?.author?.name}</span>
          <span className="tultimo__m">{(ultimo.commit?.message || '').split('\n')[0]}</span>
          <span className="tdim">{hace(ultimo.commit?.author?.date)}</span>
        </p>
      )}
      {sel && <Compartir repo={repo} rama={rama} ruta={ruta} desde={sel.desde} hasta={sel.hasta} onListo={(c) => { setSel(null); setAviso(`Enviado a #${c}.`); }} />}
      {aviso && <p className="tok tarchivo__aviso">{aviso}</p>}
      {datos?.cargando && <p className="testado">Bajando…</p>}
      {datos?.error && <p className="terror">{datos.error}</p>}
      {datos && !datos.cargando && datos.binario && <p className="tnota tarchivo__aviso"><IconWarn size={12} /> No es texto o pesa demasiado para leerlo aquí. Ábrelo en GitHub.</p>}
      {!datos?.binario && lineas.length > 0 && (
        <div className="tcodigo mono">
          {lineas.map((l, i) => {
            const n = i + 1;
            const on = sel && n >= sel.desde && n <= sel.hasta;
            return (
              <div key={n} className={`tcodigo__l ${on ? 'is-on' : ''}`}>
                <button className="tcodigo__n" onClick={(e) => elegir(n, e)} aria-label={`Elegir la línea ${n}`}>{n}</button>
                <span className="tcodigo__t">{l || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Historial({ repo, rama, datosRepo, commits, onRama }) {
  const [tab, setTab] = useState('commits');
  const ramas = [...(datosRepo?.ramas || [])].sort((a, b) => (Date.parse(b.ultimo?.fecha || 0) || 0) - (Date.parse(a.ultimo?.fecha || 0) || 0));
  return (
    <>
      <header className="tpanelhead ttabs">
        <button className={`lk ${tab === 'commits' ? 'is-on' : ''}`} onClick={() => setTab('commits')}>Commits</button>
        <button className={`lk ${tab === 'ramas' ? 'is-on' : ''}`} onClick={() => setTab('ramas')}>Ramas <span className="mono tdim">{ramas.length}</span></button>
      </header>
      <div className="tlista">
        {tab === 'commits' && (
          <>
            {commits?.cargando && <p className="testado">Pidiendo los commits…</p>}
            {commits?.error && <p className="terror">{commits.error}</p>}
            {(commits?.lista || []).map((c) => (
              <button key={c.sha} className="tcommit" onClick={() => openExternal(c.html_url)} title={c.commit?.message}>
                {c.author?.avatar_url ? <img className="tquien" src={c.author.avatar_url} alt="" /> : <span className="tquien tquien--nadie" />}
                <span className="tcommit__t">
                  <span>{(c.commit?.message || '').split('\n')[0]}</span>
                  <span className="mono tdim">{c.sha.slice(0, 7)} · {c.author?.login || c.commit?.author?.name} · {hace(c.commit?.author?.date)}</span>
                </span>
              </button>
            ))}
          </>
        )}
        {tab === 'ramas' && ramas.map((r) => (
          <button key={r.name} className={`tcommit ${r.name === rama ? 'is-on' : ''}`} onClick={() => onRama(r.name)}>
            <IconGitBranch size={14} className="tdim" />
            <span className="tcommit__t">
              <span className="mono">{r.name}{r.name === datosRepo?.porDefecto ? ' · por defecto' : ''}</span>
              <span className="mono tdim">{r.ultimo ? `${r.ultimo.autor} · ${hace(r.ultimo.fecha)}` : 'sin detalle'}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export function RepoView() {
  const { proyectoActivo, soyLider, irA, anchos } = useTeamStore();
  const {
    estado, error, token, usuario, mirarToken, conectar, desconectar, porRepo, arboles, commits, archivos,
    rama, ruta, abiertas, cargarRepo, elegirRama, plegar, abrirArchivo, cerrarArchivo, cargarArbol, cargarCommits,
  } = useRepoStore();
  const proyecto = proyectoActivo();
  const crudo = proyecto?.github_repo || '';
  const repo = normalizeRepo(crudo);

  useEffect(() => { mirarToken(); }, [mirarToken]);
  useEffect(() => { if (token && crudo) cargarRepo(crudo); }, [token, crudo, cargarRepo]);

  const ramaActual = rama[repo] || '';
  const clave = `${repo}@${ramaActual}`;
  const arbol = arboles[clave];
  const raiz = useMemo(() => armar(arbol?.entradas || []), [arbol?.entradas]);

  if (!proyecto) return null;
  let aviso = null;
  if (estado === 'mirando' || estado === 'comprobando') aviso = <p className="testado">Comprobando el acceso a GitHub…</p>;
  else if (!crudo) {
    aviso = (
      <Aviso icono={<IconGitHub size={22} />} titulo="Vincula el repositorio" acciones={soyLider() && <button className="btn btn--primary" onClick={() => irA('proyecto')}>Ir a Ajustes</button>}>
        <p>Cuando {proyecto.nombre} apunte a un repositorio de GitHub, todo el equipo verá aquí sus archivos rama por rama y el historial de commits, sin clonar nada.</p>
        <p className="tnota"><IconLock size={12} /> El proyecto guarda solo a dónde apunta, nunca una credencial.{soyLider() ? '' : ' Lo vincula el líder desde Ajustes.'}</p>
      </Aviso>
    );
  } else if (estado === 'sin-token' || !token) {
    aviso = (
      <Conectar
        icono={<IconGitHub size={22} />}
        titulo="Conecta tu GitHub"
        explicacion="Si tienes la CLI gh con sesión iniciada, Team la usa sola. Si no, pega un token personal: se guarda cifrado en este equipo. Los repositorios privados necesitan el permiso «repo»."
        marcador="ghp_… o github_pat_…"
        enlace={TOKEN_URL}
        enlaceTexto="Crear un token en GitHub"
        estado={estado}
        error={error}
        onConectar={conectar}
      />
    );
  } else if (estado === 'error') {
    aviso = <Aviso icono={<IconWarn size={22} />} titulo="GitHub no contestó" acciones={<button className="btn btn--ghost" onClick={desconectar}><IconLogout size={13} /> Usar otro token</button>}><p>{error}</p></Aviso>;
  } else if (!repo) {
    aviso = <Aviso icono={<IconWarn size={22} />} titulo="Ese no es un repositorio"><p>El proyecto tiene guardado «{crudo}». Se espera <span className="mono">owner/repo</span> o la dirección completa del repositorio.</p></Aviso>;
  }
  if (aviso) return <TPanel id="repo" className="wb__grow">{aviso}</TPanel>;

  const datosRepo = porRepo[repo];
  const info = datosRepo?.datos;
  const rutaAbierta = ruta[repo] || '';
  const desplegadas = new Set(abiertas[clave] || []);

  return (
    <>
      <TPanel id="repo-arbol" style={{ width: anchos.arbol }}>
        <header className="tpanelhead">
          <IconGitHub size={14} />
          <button className="lk mono tarbol__repo" onClick={() => openExternal(`https://github.com/${repo}`)} title="Abrir en GitHub">{repo}</button>
          {info?.private && <IconLock size={12} className="tdim" />}
          <div className="tfill" />
          <button className="ic" onClick={() => { cargarRepo(crudo, { forzar: true }); cargarArbol(repo, ramaActual, { forzar: true }); cargarCommits(repo, ramaActual, { forzar: true }); }} aria-label="Recargar desde GitHub"><IconRefresh size={14} /></button>
        </header>
        {datosRepo?.ramas?.length > 0 && (
          <label className="tramas mono">
            <IconGitBranch size={13} />
            <select value={ramaActual} onChange={(e) => elegirRama(repo, e.target.value)} aria-label="Rama">
              {datosRepo.ramas.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
            <IconChevronDown size={12} />
          </label>
        )}
        <div className="tarbol">
          {(datosRepo?.error || porRepo[crudo]?.error) && <p className="terror">{datosRepo?.error || porRepo[crudo]?.error}</p>}
          {arbol?.cargando && <p className="testado">Leyendo la rama…</p>}
          {arbol?.error && <p className="terror">{arbol.error}</p>}
          {arbol?.truncado && <p className="tnota"><IconWarn size={12} /> GitHub cortó el listado: faltan archivos.</p>}
          {arbol?.entradas && <Rama nodos={ordenar(raiz.hijos)} nivel={0} desplegadas={desplegadas} rutaAbierta={rutaAbierta} onCarpeta={(r) => plegar(repo, ramaActual, r)} onArchivo={(r) => abrirArchivo(repo, ramaActual, r)} />}
        </div>
        {info && (
          <div className="tarbol__pie mono">
            <span><IconStar size={11} /> {info.stargazers_count ?? 0}</span>
            <span><IconFork size={11} /> {info.forks_count ?? 0}</span>
            {usuario && <span className="tfill tdim tarbol__user">{usuario.login}</span>}
            <button className="ic" onClick={desconectar} aria-label="Desconectar GitHub"><IconLogout size={12} /></button>
          </div>
        )}
      </TPanel>
      <TGutter clave="arbol" min={200} max={480} />
      <TPanel id="repo" className="wb__grow">
        {rutaAbierta ? (
          <Archivo repo={repo} rama={ramaActual} ruta={rutaAbierta} datos={archivos[`${repo}@${ramaActual}:${rutaAbierta}`]} onCerrar={() => cerrarArchivo(repo)} />
        ) : (
          <div className="tvacio">
            <IconFile size={22} />
            <p>Elige un archivo del árbol para leerlo.</p>
            <span className="tnota">Solo lectura. Elige líneas por su número para compartirlas en un canal; Mayús amplía la selección.</span>
          </div>
        )}
      </TPanel>
      <TGutter clave="detalle" min={280} max={520} lado="izquierda" />
      <TPanel id="repo-historial" style={{ width: Math.min(anchos.detalle, 380) }}>
        <Historial repo={repo} rama={ramaActual} datosRepo={datosRepo} commits={commits[clave]} onRama={(r) => elegirRama(repo, r)} />
      </TPanel>
    </>
  );
}
