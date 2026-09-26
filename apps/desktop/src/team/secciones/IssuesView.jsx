// IssuesView.jsx — las issues de Linear del proyecto: vistas a la izquierda,
// lista por estado en el centro y el detalle a la derecha. Cada integrante
// consulta con su propia clave; el proyecto solo guarda a qué equipo apunta.
import { useEffect, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { Conectar, Aviso } from './Conectar';
import { TPanel, TGutter, tintaDe } from '../ui/Panel';
import { KEY_URL, PRIORITIES, fecha } from '../lib/linear';
import { hace } from '../lib/tiempo';
import { openExternal } from '../../lib/tauri';
import { IconRefresh, IconPlus, IconExternal, IconLogout, IconX, IconWarn, IconChevronDown, IconArrowUp } from '../../components/Icons';
import { IconLinear } from '../ui/icons';

const ORDEN = ['started', 'triage', 'unstarted', 'backlog', 'completed', 'canceled'];
const rango = (tipo) => { const i = ORDEN.indexOf(tipo); return i === -1 ? ORDEN.length : i; };

function Prioridad({ p }) {
  return (
    <span className="tprio" title={PRIORITIES[p] || 'Sin prioridad'}>
      <i style={{ height: 5, background: p ? 'var(--ink-soft)' : 'var(--surface-6)' }} />
      <i style={{ height: 8, background: p && p <= 3 ? 'var(--ink-soft)' : 'var(--surface-6)' }} />
      <i style={{ height: 12, background: p === 1 ? 'var(--danger)' : p && p <= 2 ? '#F2C98A' : 'var(--surface-6)' }} />
    </span>
  );
}

function Quien({ persona, size = 20 }) {
  if (!persona) return <span className="tquien tquien--nadie" title="Sin asignar" style={{ width: size, height: size }} />;
  return persona.avatarUrl
    ? <img className="tquien" src={persona.avatarUrl} alt="" title={persona.name} style={{ width: size, height: size }} />
    : <span className="tquien" title={persona.name} style={{ width: size, height: size, background: tintaDe(persona.id) }}>{(persona.name || '?')[0]}</span>;
}

function NuevaIssue({ proyecto, crear }) {
  const [titulo, setTitulo] = useState('');
  const [error, setError] = useState('');
  const [creando, setCreando] = useState(false);
  const mandar = async (e) => {
    e.preventDefault();
    if (!titulo.trim() || creando) return;
    setCreando(true);
    const fallo = await crear(proyecto, titulo.trim());
    setCreando(false);
    if (fallo) { setError(fallo); return; }
    setTitulo('');
    setError('');
  };
  return (
    <form className="tnueva" onSubmit={mandar}>
      <IconPlus size={14} className="tdim" />
      <input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Apunta una issue nueva y pulsa Enter" maxLength={250} aria-label="Issue nueva" />
      {creando ? <span className="tdim">Creando…</span> : <span className="mono tdim">Enter</span>}
      {error && <span className="terror" title={error}>{error} <button type="button" className="ic" onClick={() => setError('')} aria-label="Descartar"><IconX size={11} /></button></span>}
    </form>
  );
}

function Vincular({ proyecto, lider, guardar }) {
  const { equipos, cargarEquipos, error } = useIssuesStore();
  const [equipoId, setEquipoId] = useState('');
  const [proyectoLinear, setProyectoLinear] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState('');
  useEffect(() => { if (lider) cargarEquipos(); }, [lider, cargarEquipos]);
  if (!lider) {
    return (
      <Aviso icono={<IconLinear size={22} />} titulo="Sin equipo de Linear">
        <p>Este proyecto todavía no está vinculado a ningún equipo de Linear. Lo hace su líder desde Ajustes; en cuanto lo haga, las issues aparecen aquí con tu propia clave.</p>
      </Aviso>
    );
  }
  const elegido = equipos.find((e) => e.id === equipoId);
  const aplicar = async () => {
    setGuardando(true);
    setFallo(await guardar(proyecto.id, { linear_team_id: equipoId, linear_project_id: proyectoLinear || null }));
    setGuardando(false);
  };
  return (
    <Aviso icono={<IconLinear size={22} />} titulo="Vincula el proyecto con Linear">
      <p>Elige a qué equipo de Linear corresponde {proyecto.nombre}. Se guarda el identificador, nunca tu clave.</p>
      <div className="tcampos">
        <label className="tcampo">Equipo
          <select className="tinput" value={equipoId} onChange={(e) => { setEquipoId(e.target.value); setProyectoLinear(''); }}>
            <option value="">Elige un equipo</option>
            {equipos.map((e) => <option key={e.id} value={e.id}>{e.key} · {e.name}</option>)}
          </select>
        </label>
        {elegido?.projects?.nodes?.length > 0 && (
          <label className="tcampo">Proyecto de Linear (opcional)
            <select className="tinput" value={proyectoLinear} onChange={(e) => setProyectoLinear(e.target.value)}>
              <option value="">Todo el equipo</option>
              {elegido.projects.nodes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn--primary" onClick={aplicar} disabled={!equipoId || guardando}>{guardando ? 'Guardando…' : 'Vincular'}</button>
        {(fallo || error) && <p className="terror">{fallo || error}</p>}
        {!equipos.length && !error && <p className="tnota">Pidiendo tus equipos a Linear…</p>}
      </div>
    </Aviso>
  );
}

function Detalle({ proyectoId }) {
  const { abierta, cargandoAbierta, cerrar, comentar, mover, equipos, estadosDe } = useIssuesStore();
  const teamId = useTeamStore((s) => s.proyectoActivo()?.linear_team_id);
  const [texto, setTexto] = useState('');
  const [mandando, setMandando] = useState(false);
  const [error, setError] = useState('');
  if (cargandoAbierta) return <p className="testado">Abriendo…</p>;
  if (!abierta) return <div className="tvacio">Elige una issue para ver su detalle.</div>;

  const comentarios = abierta.comments?.nodes || [];
  const etiquetas = abierta.labels?.nodes || [];
  const hijas = abierta.children?.nodes || [];
  const estados = teamId && equipos.length ? estadosDe(teamId) : [];
  const lista = !abierta.state || estados.some((e) => e.id === abierta.state.id) ? estados : [abierta.state, ...estados];
  const mandar = async (e) => {
    e.preventDefault();
    if (!texto.trim() || mandando) return;
    setMandando(true);
    const fallo = await comentar(abierta.id, texto.trim());
    setMandando(false);
    if (fallo) { setError(fallo); return; }
    setTexto('');
    setError('');
  };

  return (
    <>
      <header className="tpanelhead">
        <span className="mono tdim">{abierta.identifier}</span>
        <div className="tfill" />
        <button className="ic" onClick={() => openExternal(abierta.url)} aria-label="Abrir en Linear"><IconExternal size={14} /></button>
        <button className="ic" onClick={cerrar} aria-label="Cerrar el detalle"><IconX size={14} /></button>
      </header>
      <div className="tdetalle">
        <h2 className="tdetalle__t">{abierta.title}</h2>
        <dl className="tprops">
          <dt>Estado</dt>
          <dd>
            {lista.length ? (
              <span className="tselect">
                <span className="tpunto" style={{ background: abierta.state?.color }} />
                <select value={abierta.state?.id || ''} onChange={(e) => mover(proyectoId, abierta.id, e.target.value)} aria-label="Mover a">
                  {lista.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <IconChevronDown size={12} />
              </span>
            ) : <span><span className="tpunto" style={{ background: abierta.state?.color }} /> {abierta.state?.name}</span>}
          </dd>
          <dt>Prioridad</dt><dd>{PRIORITIES[abierta.priority] || '—'}</dd>
          <dt>Asignada</dt><dd className="tprops__quien"><Quien persona={abierta.assignee} size={18} />{abierta.assignee?.displayName || abierta.assignee?.name || 'Sin asignar'}</dd>
          {abierta.project && <><dt>Proyecto</dt><dd>{abierta.project.name}</dd></>}
          {abierta.dueDate && <><dt>Vence</dt><dd>{fecha(abierta.dueDate)}</dd></>}
          {etiquetas.length > 0 && <><dt>Etiquetas</dt><dd className="tetiquetas">{etiquetas.map((l) => <span key={l.id} className="mono" style={{ '--c': l.color }}>{l.name}</span>)}</dd></>}
        </dl>
        {abierta.description && <p className="tdetalle__desc">{abierta.description}</p>}
        {abierta.parent && <p className="tnota">Depende de <span className="mono">{abierta.parent.identifier}</span> — {abierta.parent.title}</p>}
        {hijas.length > 0 && (
          <section className="tdetalle__bloque">
            <span className="tcap">Subtareas · {hijas.length}</span>
            {hijas.map((h) => (
              <div key={h.id} className="tdetalle__hija"><span className="tpunto" style={{ background: h.state?.color }} /><span className="mono tdim">{h.identifier}</span><span>{h.title}</span></div>
            ))}
          </section>
        )}
        <section className="tdetalle__bloque">
          <span className="tcap">Actividad · {comentarios.length} comentarios</span>
          <p className="tnota mono">Actualizada {hace(abierta.updatedAt)}{abierta.creator ? ` · la abrió ${abierta.creator.displayName || abierta.creator.name}` : ''}</p>
          {comentarios.map((c) => (
            <article key={c.id} className="tcoment">
              <div className="tmsg__cab"><span className="tmsg__autor" style={{ color: tintaDe(c.user?.id) }}>{c.user?.displayName || c.user?.name || 'Alguien'}</span><time className="mono">{hace(c.createdAt)}</time></div>
              <p className="tmsg__texto">{c.body}</p>
            </article>
          ))}
        </section>
      </div>
      <form className="tcomposer" onSubmit={mandar}>
        <div className="tcomposer__caja">
          <textarea className="tcomposer__campo" rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Comenta en Linear" aria-label="Comentario en Linear" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) mandar(e); }} />
          <div className="tcomposer__barra">
            {error && <span className="terror">{error}</span>}
            <div className="tcomposer__fill" />
            <button className="tcomposer__enviar" type="submit" disabled={!texto.trim() || mandando} aria-label="Comentar"><IconArrowUp size={14} /></button>
          </div>
        </div>
      </form>
    </>
  );
}

export function IssuesView() {
  const { proyectoActivo, soyLider, editarProyecto, anchos } = useTeamStore();
  const { estado, error, token, viewer, mirarClave, conectar, desconectar, cargar, del, abierta, cargandoAbierta, abrir, crear } = useIssuesStore();
  const [filtro, setFiltro] = useState('todas');
  const proyecto = proyectoActivo();
  const vinculado = proyecto?.linear_team_id || '';

  useEffect(() => { mirarClave(); }, [mirarClave]);
  useEffect(() => { if (token && proyecto && vinculado) cargar(proyecto); }, [token, proyecto?.id, vinculado]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!proyecto) return null;
  let contenido = null;
  if (estado === 'mirando' || estado === 'comprobando') contenido = <p className="testado">Comprobando la clave de Linear…</p>;
  else if (estado === 'sin-clave' || !token) {
    contenido = (
      <Conectar
        icono={<IconLinear size={22} />}
        titulo="Conecta tu Linear"
        explicacion="Con tu propia API key. Se guarda cifrada en este equipo y las consultas van directas a Linear, sin pasar por Lixbon. Nadie ve más issues de las que su cuenta le permite."
        marcador="lin_api_…"
        enlace={KEY_URL}
        enlaceTexto="Crear una API key en Linear"
        estado={estado}
        error={error}
        onConectar={conectar}
      />
    );
  } else if (estado === 'error') {
    contenido = (
      <Aviso icono={<IconWarn size={22} />} titulo="Linear no contestó" acciones={<button className="btn btn--ghost" onClick={desconectar}><IconLogout size={13} /> Usar otra clave</button>}>
        <p>{error}</p>
      </Aviso>
    );
  } else if (!vinculado) contenido = <Vincular proyecto={proyecto} lider={soyLider()} guardar={editarProyecto} />;

  if (contenido) return <TPanel id="issues" className="wb__grow">{contenido}</TPanel>;

  const datos = del(proyecto.id);
  const mias = (i) => viewer && i.assignee?.id === viewer.id;
  const VISTAS = [
    ['mias', 'Mis issues', datos.issues.filter(mias).length],
    ['todas', 'Todas', datos.issues.length],
    ['abiertas', 'Abiertas', datos.issues.filter((i) => !['completed', 'canceled'].includes(i.state?.type)).length],
    ['sin', 'Sin asignar', datos.issues.filter((i) => !i.assignee).length],
  ];
  const lista = datos.issues.filter((i) => (
    filtro === 'mias' ? mias(i)
      : filtro === 'abiertas' ? !['completed', 'canceled'].includes(i.state?.type)
        : filtro === 'sin' ? !i.assignee : true));
  const grupos = [...lista.reduce((m, i) => {
    const k = i.state?.id || 'sin';
    if (!m.has(k)) m.set(k, { estado: i.state, lista: [] });
    m.get(k).lista.push(i);
    return m;
  }, new Map()).values()].sort((a, b) => rango(a.estado?.type) - rango(b.estado?.type));
  const hechas = datos.issues.filter((i) => i.state?.type === 'completed').length;
  const enCurso = datos.issues.filter((i) => i.state?.type === 'started').length;
  const total = datos.issues.length || 1;

  return (
    <>
      <TPanel id="issues-lado" style={{ width: anchos.lista }}>
        <header className="tpanelhead">
          <IconLinear size={14} className="tlinear" />
          <span className="tpanelhead__s">{viewer?.name ? `Linear · ${viewer.name}` : 'Linear'}</span>
          <div className="tfill" />
          <button className="ic" onClick={desconectar} aria-label="Desconectar Linear"><IconLogout size={14} /></button>
        </header>
        <div className="tlado">
          {VISTAS.map(([id, nombre, n]) => (
            <button key={id} className={`tfila ${filtro === id ? 'is-on' : ''}`} onClick={() => setFiltro(id)}>
              <span className="tfila__n">{nombre}</span><span className="mono tdim">{n}</span>
            </button>
          ))}
          {datos.issues.length > 0 && (
            <div className="tprogreso">
              <span className="tcap">Progreso</span>
              <div className="tprogreso__barra"><span style={{ width: `${(hechas / total) * 100}%`, background: 'var(--good)' }} /><span style={{ width: `${(enCurso / total) * 100}%`, background: 'var(--warn)' }} /></div>
              <div className="mono tprogreso__leyenda"><span><b style={{ color: 'var(--good)' }}>{hechas}</b> hechas</span><span><b style={{ color: 'var(--warn)' }}>{enCurso}</b> en curso</span></div>
            </div>
          )}
        </div>
      </TPanel>
      <TGutter clave="lista" min={180} max={320} />
      <TPanel id="issues" className="wb__grow">
        <header className="tpanelhead">
          <span className="tpanelhead__t">{VISTAS.find((v) => v[0] === filtro)[1]}</span>
          <span className="mono tdim">{lista.length}</span>
          {proyecto.linear_project_id && <span className="tchip mono">un proyecto</span>}
          <div className="tfill" />
          <button className="ic" onClick={() => cargar(proyecto, { forzar: true })} disabled={datos.cargando} aria-label="Recargar desde Linear"><IconRefresh size={14} /></button>
        </header>
        <NuevaIssue proyecto={proyecto} crear={crear} />
        <div className="tlista">
          {datos.cargando && !datos.issues.length && <p className="testado">Pidiendo las issues…</p>}
          {datos.error && <p className="terror">{datos.error}</p>}
          {datos.cargado && !lista.length && !datos.error && <p className="tidx__vacio">No hay issues aquí.</p>}
          {grupos.map((g) => (
            <section key={g.estado?.id || 'sin'}>
              <div className="tgrupo__cab"><span className="tpunto" style={{ background: g.estado?.color || 'var(--ink-35)' }} />{g.estado?.name || 'Sin estado'}<span className="mono tdim">{g.lista.length}</span></div>
              {g.lista.map((i) => (
                <div key={i.id} className={`tissue ${abierta?.id === i.id ? 'is-on' : ''} ${i._moviendo ? 'is-moviendo' : ''} ${i.state?.type === 'completed' ? 'is-hecha' : ''}`}>
                  <button className="tissue__main" onClick={() => abrir(i.id)}>
                    <Prioridad p={i.priority} />
                    <span className="mono tissue__id">{i.identifier}</span>
                    <span className="tissue__t">{i.title}</span>
                    {i.project && !proyecto.linear_project_id && <span className="tchip mono">{i.project.name}</span>}
                    <span className="mono tdim tissue__cuando">{hace(i.updatedAt)}</span>
                    <Quien persona={i.assignee} />
                  </button>
                  <button className="ic tissue__fuera" onClick={() => openExternal(i.url)} aria-label="Abrir en Linear"><IconExternal size={12} /></button>
                </div>
              ))}
            </section>
          ))}
        </div>
      </TPanel>
      {(abierta || cargandoAbierta) && (
        <>
          <TGutter clave="detalle" min={320} max={640} lado="izquierda" />
          <TPanel id="issue" style={{ width: anchos.detalle }}><Detalle proyectoId={proyecto.id} /></TPanel>
        </>
      )}
    </>
  );
}
