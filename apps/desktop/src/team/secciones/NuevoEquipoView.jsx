// NuevoEquipoView.jsx — el asistente de «Nuevo equipo». Cuatro pasos: el
// equipo, la gente, cómo trabaja con las issues y la conexión con GitHub y el
// IDE. Todo trae valores por defecto: se puede crear el equipo en el paso 1.
import { useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { normalizeRepo } from '../lib/githubApi';
import { prefijoDe } from '../lib/prefijo';
import { TPanel } from '../ui/Panel';
import { Casilla } from '../ui/Marcas';
import { IconCheck, IconChevronLeft, IconChevronRight, IconX } from '../../components/Icons';
import { DIAS } from '../lib/issues';

const PASOS = [
  { t: 'Equipo', sub: 'Nombre e identificador' },
  { t: 'Miembros', sub: 'A quién invitas' },
  { t: 'Issues', sub: 'Flujo, etiquetas y ciclos' },
  { t: 'Repositorio', sub: 'GitHub y agentes del IDE' },
];
const ESTADOS = [
  { nombre: 'Sin empezar', estados: [['Backlog', 'backlog', '#5E5E59'], ['Por hacer', 'pendiente', '#85857F']] },
  { nombre: 'Empezado', estados: [['En curso', 'en_curso', '#8EC5FF'], ['En revisión', 'revision', '#E8C872']] },
  { nombre: 'Cerrado', estados: [['Hecho', 'hecho', '#86D694'], ['Cancelado', 'cancelado', '#F08C7C']] },
];
const COLOR_ETQ = { bug: '#F08C7C', mejora: '#86D694', tarea: '#B5B5AF' };

function Interruptor({ on, onCambio, etiqueta }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={etiqueta} className={`tswitch ${on ? 'is-on' : ''}`} onClick={() => onCambio(!on)}>
      <span />
    </button>
  );
}

export function NuevoEquipoView() {
  const { crearProyecto, invitar, editarProyecto, irA, proyectos, volverAlChat } = useTeamStore();
  const [paso, setPaso] = useState(0);
  const [nombre, setNombre] = useState('');
  const [prefijo, setPrefijo] = useState('');
  const [prefijoTocado, setPrefijoTocado] = useState(false);
  const [invitados, setInvitados] = useState([]);
  const [quien, setQuien] = useState('');
  const [etiquetas, setEtiquetas] = useState(['Bug', 'Mejora', 'Tarea']);
  const [etq, setEtq] = useState('');
  const [ciclos, setCiclos] = useState({ activos: true, semanas: 2, dia_inicio: 0 });
  const [estimacion, setEstimacion] = useState('fib');
  const [repo, setRepo] = useState('');
  const [auto, setAuto] = useState({ rama: true, pr: true, agentes: true });
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState('');

  const pref = prefijoTocado ? prefijo : prefijoDe(nombre);
  const prefValido = /^[A-Z][A-Z0-9]{0,4}$/.test(pref);
  const puedeSeguir = paso === 0 ? nombre.trim() && prefValido : true;

  const anadirInvitado = (e) => {
    e.preventDefault();
    const v = quien.trim();
    if (v && !invitados.includes(v)) setInvitados([...invitados, v]);
    setQuien('');
  };

  const crear = async () => {
    const normal = normalizeRepo(repo.trim());
    if (repo.trim() && !normal) { setPaso(3); setError('Ese repositorio no se entiende. Pon «owner/repo».'); return; }
    setCreando(true);
    setError('');
    const fallo = await crearProyecto(nombre.trim(), {
      prefijo: pref,
      etiquetas,
      config: { ciclos, estimacion, automatismos: auto },
    });
    if (fallo) { setCreando(false); setError(fallo); return; }
    const nuevo = useTeamStore.getState().proyectoActivo();
    const avisos = [];
    for (const i of invitados) {
      const f = await invitar(nuevo.id, i);
      if (f) avisos.push(`${i}: ${f}`);
    }
    if (normal) {
      const f = await editarProyecto(nuevo.id, { github_repo: normal });
      if (f) avisos.push(f);
    }
    setCreando(false);
    if (avisos.length) { setError(`El equipo ya existe, pero: ${avisos.join(' · ')}`); return; }
    irA('issues');
  };

  return (
    <TPanel id="nuevo" className="wb__grow tnuevo">
      <div className="tnuevo__caja" role="dialog" aria-label="Nuevo equipo">
        <nav className="tnuevo__pasos" aria-label="Pasos">
          <span className="tidx__sec">NUEVO EQUIPO</span>
          {PASOS.map((p, n) => (
            <button key={p.t} className={`tnuevo__paso ${n === paso ? 'is-on' : ''} ${n < paso ? 'is-hecho' : ''}`} onClick={() => (n <= paso || puedeSeguir) && setPaso(n)} disabled={n > paso && !puedeSeguir}>
              <span className="tnuevo__num">{n < paso ? <IconCheck size={13} /> : n + 1}</span>
              <span className="tnuevo__ptxt"><b>{p.t}</b><span>{p.sub}</span></span>
            </button>
          ))}
          <span className="tfill" />
          {nombre.trim() && (
            <div className="tnuevo__resumen">
              <span className="tproy tproy--l">{pref || '?'}</span>
              <span><b>{nombre.trim()}</b><span className="tdim">{invitados.length ? `Tú y ${invitados.length} ${invitados.length === 1 ? 'invitado' : 'invitados'}` : 'Solo tú, por ahora'}</span></span>
            </div>
          )}
        </nav>

        <div className="tnuevo__form">
          <span className="tdim">Paso {paso + 1} de {PASOS.length}</span>

          {paso === 0 && (
            <>
              <h1>Un equipo nuevo</h1>
              <p className="tnuevo__lead">Un equipo tiene su chat, sus issues, su repositorio y su gente. Quien lo crea es su líder.</p>
              <label className="tcampo">Nombre del equipo
                <input className="tinput tinput--l" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Lixbon Desktop" maxLength={60}
                  onKeyDown={(e) => { if (e.key === 'Enter' && puedeSeguir) setPaso(1); }} />
              </label>
              <div className="tnuevo__prefijo">
                <label className="tcampo">Identificador
                  <input className="tinput mono tinput--l" value={pref} maxLength={5} onChange={(e) => { setPrefijoTocado(true); setPrefijo(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); }} aria-describedby="pref-ayuda" />
                </label>
                <p id="pref-ayuda" className="tnota">
                  {prefValido
                    ? <>Las issues se numerarán <span className="mono">{pref}-1</span>, <span className="mono">{pref}-2</span>… y el mismo código nombra las ramas del IDE.</>
                    : 'De 1 a 5 letras o números, empezando por letra.'}
                </p>
              </div>
            </>
          )}

          {paso === 1 && (
            <>
              <h1>¿Quién está en el equipo?</h1>
              <p className="tnuevo__lead">Invita con el correo o el @usuario de Lixbon. Entran como integrantes; puedes hacerlo también más tarde.</p>
              <form className="tajustes__fila" onSubmit={anadirInvitado}>
                <input className="tinput tfill" autoFocus value={quien} onChange={(e) => setQuien(e.target.value)} placeholder="correo o @usuario" spellCheck={false} aria-label="Invitar" />
                <button className="btn" type="submit" disabled={!quien.trim()}>Añadir</button>
              </form>
              <div className="tnuevo__chips">
                {invitados.map((i) => (
                  <span key={i} className="tchipq">{i}<button type="button" onClick={() => setInvitados(invitados.filter((x) => x !== i))} aria-label={`Quitar ${i}`}><IconX size={11} /></button></span>
                ))}
                {!invitados.length && <span className="tnota">Nadie todavía. Puedes seguir y crear el equipo solo.</span>}
              </div>
            </>
          )}

          {paso === 2 && (
            <>
              <h1>¿Cómo trabaja el equipo con las issues?</h1>
              <p className="tnuevo__lead">Te lo dejamos listo con lo habitual. Cualquier cosa se cambia después en Ajustes del equipo.</p>
              <div className="tnuevo__bloque">
                <span className="tnuevo__h2">Flujo de estados</span>
                {ESTADOS.map((g) => (
                  <div key={g.nombre} className="tnuevo__grupo">
                    <span className="tdim">{g.nombre}</span>
                    <span className="tnuevo__estados">
                      {g.estados.map(([n, tipo, color]) => <span key={n} className="tnuevo__estado"><Casilla estado={{ tipo, color, nombre: n }} size={15} />{n}</span>)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="tnuevo__bloque">
                <span className="tnuevo__h2">Etiquetas iniciales</span>
                <div className="tnuevo__chips">
                  {etiquetas.map((e) => (
                    <span key={e} className="tetq" style={{ '--c': COLOR_ETQ[e.toLowerCase()] || '#8EC5FF' }}>{e}
                      <button type="button" onClick={() => setEtiquetas(etiquetas.filter((x) => x !== e))} aria-label={`Quitar ${e}`}>×</button>
                    </span>
                  ))}
                  <form onSubmit={(ev) => { ev.preventDefault(); const v = etq.trim(); if (v && !etiquetas.includes(v)) setEtiquetas([...etiquetas, v]); setEtq(''); }}>
                    <input className="tinput tinput--s" value={etq} onChange={(e) => setEtq(e.target.value)} placeholder="+ Etiqueta" maxLength={40} aria-label="Nueva etiqueta" />
                  </form>
                </div>
              </div>
              <div className="tnuevo__dos">
                <div className="tnuevo__tarjeta">
                  <span className="tnuevo__fila"><b>Trabajar por ciclos</b><span className="tfill" /><Interruptor on={ciclos.activos} etiqueta="Trabajar por ciclos" onCambio={(v) => setCiclos({ ...ciclos, activos: v })} /></span>
                  {ciclos.activos && (
                    <span className="tnuevo__fila">
                      <select className="tinput" value={ciclos.semanas} onChange={(e) => setCiclos({ ...ciclos, semanas: Number(e.target.value) })} aria-label="Duración">
                        {[1, 2, 3, 4].map((n) => <option key={n} value={n}>Cada {n === 1 ? 'semana' : `${n} semanas`}</option>)}
                      </select>
                      <select className="tinput" value={ciclos.dia_inicio} onChange={(e) => setCiclos({ ...ciclos, dia_inicio: Number(e.target.value) })} aria-label="Día de inicio">
                        {DIAS.map((d, n) => <option key={d} value={n}>Empiezan el {d}</option>)}
                      </select>
                    </span>
                  )}
                  <span className="tnota">{ciclos.activos ? 'Lo que no se termine pasa solo al siguiente ciclo.' : 'Sin ciclos, las issues se ordenan solo por estado.'}</span>
                </div>
                <div className="tnuevo__tarjeta">
                  <b>Estimación</b>
                  <div className="tseg tseg--lleno" role="group" aria-label="Escala de estimación">
                    {[['ninguna', 'Sin estimar'], ['fib', '1 · 2 · 3 · 5 · 8'], ['tallas', 'S · M · L']].map(([v, n]) => (
                      <button key={v} type="button" className={estimacion === v ? 'is-on' : ''} aria-pressed={estimacion === v} onClick={() => setEstimacion(v)}>{n}</button>
                    ))}
                  </div>
                  <span className="tnota">Alimenta la carga por persona y el avance del ciclo.</span>
                </div>
              </div>
            </>
          )}

          {paso === 3 && (
            <>
              <h1>Conectado con GitHub y Lixbon IDE</h1>
              <p className="tnuevo__lead">Con el repositorio, Team lo enseña en Repositorio y el IDE reconoce el equipo al abrirlo. Las issues se mueven solas mientras trabajas.</p>
              <label className="tcampo">Repositorio de GitHub (opcional)
                <input className="tinput mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" spellCheck={false} />
              </label>
              <div className="tnuevo__autos">
                {[
                  ['rama', 'Rama al empezar', 'Vincular una rama lx/… pasa la issue a En curso.'],
                  ['pr', 'Seguir el PR', 'Abrir el PR la pasa a En revisión; fusionarlo, a Hecho.'],
                  ['agentes', 'Delegar a agentes', 'El orquestador del IDE toma issues y deja su informe como comentario.'],
                ].map(([k, tt, sub]) => (
                  <div key={k} className="tnuevo__tarjeta tnuevo__fila">
                    <span className="tnuevo__ptxt"><b>{tt}</b><span>{sub}</span></span>
                    <span className="tfill" />
                    <Interruptor on={auto[k]} etiqueta={tt} onCambio={(v) => setAuto({ ...auto, [k]: v })} />
                  </div>
                ))}
              </div>
            </>
          )}

          {error && <p className="terror">{error}</p>}
          <span className="tfill" />
          <div className="tnuevo__pie">
            {paso > 0
              ? <button className="btn btn--ghost" onClick={() => setPaso(paso - 1)}><IconChevronLeft size={14} /> Atrás</button>
              : proyectos.length > 0 && <button className="btn btn--ghost" onClick={volverAlChat}>Cancelar</button>}
            <span className="tfill" />
            {paso < PASOS.length - 1 && <button className="btn btn--ghost" disabled={!nombre.trim() || !prefValido || creando} onClick={crear}>Crear con lo de siempre</button>}
            {paso < PASOS.length - 1
              ? <button className="btn btn--acento" disabled={!puedeSeguir} onClick={() => setPaso(paso + 1)}>Continuar <IconChevronRight size={14} /></button>
              : <button className="btn btn--acento" disabled={!nombre.trim() || !prefValido || creando} onClick={crear}>{creando ? 'Creando…' : 'Crear equipo'}</button>}
          </div>
        </div>
      </div>
    </TPanel>
  );
}
