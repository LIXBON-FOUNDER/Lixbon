// IssuesView.jsx — la sección Issues: índice a la izquierda (vistas, equipos,
// proyectos) y, a la derecha, la cabecera con pestañas, los filtros y el
// tablero o la lista. Al abrir una issue se ve su detalle en el mismo sitio.
import { useMemo, useState } from 'react';
import { useTeamStore } from '../../store/teamStore';
import { useIssuesStore } from '../../store/issuesStore';
import { useTablero } from '../../store/useTablero';
import { TPanel } from '../../ui/Panel';
import { Desplegable, Opciones } from '../../ui/Menu';
import { Rombos, PuntoCuadrado, Barra } from '../../ui/Marcas';
import { Cara } from '../../ui/Panel';
import { IconIssues, IconTablero, IconLista, IconFiltro, IconDiana, IconBandeja } from '../../ui/icons';
import { IconPlus, IconSearch, IconChevronDown } from '../../../components/Icons';
import { PRIORIDADES, esCerrado, avance, plano, diasEntre, hoyISO } from '../../lib/issues';
import { Tablero } from './Tablero';
import { Lista } from './Lista';
import { DetalleIssue } from './Detalle';
import { inicialesDe } from '../../layout/TeamTitleBar';

const leer = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* da igual */ } };

export const useFiltroIssues = () => {
  const [pestana, setPestana] = useState(() => leer('lixbon-team-issues-pestana', 'activas'));
  return [pestana, (p) => { guardar('lixbon-team-issues-pestana', p); setPestana(p); }];
};

function Indice({ t, pestana, setPestana }) {
  const { proyectos, proyectoId, irAProyecto, irA } = useTeamStore();
  const porProyecto = useIssuesStore((s) => s.porProyecto);
  const yo = t.usuario?.id;
  const abiertas = t.issues.filter((i) => !esCerrado(t.estadosPorId[i.estado_id]));
  const mias = abiertas.filter((i) => i.asignado_id === yo).length;
  const vistas = [
    { id: 'mias', nombre: 'Mis issues', Icono: IconDiana, n: mias },
    { id: 'activas', nombre: 'Issues', Icono: IconIssues, n: abiertas.length },
    { id: 'backlog', nombre: 'Backlog', Icono: IconBandeja, n: t.issues.filter((i) => t.estadosPorId[i.estado_id]?.tipo === 'backlog').length },
  ];
  return (
    <TPanel id="indice-issues" className="tidx tidx--issues">
      {vistas.map(({ id, nombre, Icono, n }) => (
        <button key={id} className={`tfila ${pestana === id ? 'is-on' : ''}`} onClick={() => setPestana(id)}>
          <Icono size={15} /><span className="tfila__n">{nombre}</span><span className="tfila__cuenta">{n || ''}</span>
        </button>
      ))}
      <div className="tidx__sec">EQUIPOS</div>
      {proyectos.map((p) => {
        const d = porProyecto[p.id];
        const est = Object.fromEntries((p.tablero?.estados || []).map((e) => [e.id, e]));
        const suyas = d ? d.issues.filter((i) => i.asignado_id === yo && !esCerrado(est[i.estado_id])).length : 0;
        return (
          <button key={p.id} className={`tfila ${p.id === proyectoId ? 'is-on' : ''}`} onClick={() => { irAProyecto(p.id); irA('issues'); }}>
            <span className="tproy">{p.tablero?.prefijo || inicialesDe(p.nombre)}</span>
            <span className="tfila__n">{p.nombre}</span>
            {suyas > 0 && <span className="tfila__cuenta">{suyas}</span>}
          </button>
        );
      })}
      {t.tablero.iniciativas.length > 0 && <div className="tidx__sec">PROYECTOS</div>}
      {t.tablero.iniciativas.map((x) => {
        const a = avance(t.issues.filter((i) => i.iniciativa_id === x.id), t.estadosPorId);
        return (
          <button key={x.id} className="tfila" onClick={() => irA('proyectos')}>
            <span className="tfila__ico"><PuntoCuadrado color={x.color} size={9} /></span>
            <span className="tfila__n">{x.nombre}</span>
            <span className="tfila__avance"><Barra pct={a.pct} color={x.color} />{a.pct}%</span>
          </button>
        );
      })}
      <div className="tfill" />
      <button className="tidx__nuevo" onClick={() => irA('nuevo')}><IconPlus size={14} /> Nuevo equipo</button>
    </TPanel>
  );
}

function Filtro({ nombre, activo, children, ancho }) {
  return (
    <Desplegable ancho={ancho} alinear="derecha" boton={({ alternar, abierto }) => (
      <button className={`tbtn ${activo ? 'is-activo' : ''} ${abierto ? 'is-abierto' : ''}`} onClick={alternar}>
        {nombre}<IconChevronDown size={12} />
      </button>
    )}>
      {children}
    </Desplegable>
  );
}

export function IssuesView() {
  const t = useTablero();
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  const abiertaId = useIssuesStore((s) => s.abiertaId);
  const abrir = useIssuesStore((s) => s.abrir);
  const [pestana, setPestana] = useFiltroIssues();
  const [modo, setModoCrudo] = useState(() => leer('lixbon-team-issues-modo', 'tablero'));
  const setModo = (m) => { guardar('lixbon-team-issues-modo', m); setModoCrudo(m); };
  const [prios, setPrios] = useState([]);
  const [etqs, setEtqs] = useState([]);
  const [personas, setPersonas] = useState([]);
  const [q, setQ] = useState('');

  const ciclosActivos = !!t.tablero.config?.ciclos?.activos;
  const yo = t.usuario?.id;
  const recientes = (i) => !i.cerrado_en || diasEntre(i.cerrado_en.slice(0, 10), hoyISO()) <= 14;

  const pestanas = useMemo(() => {
    const tipo = (i) => t.estadosPorId[i.estado_id]?.tipo;
    const lista = [];
    if (ciclosActivos && t.cicloHoy) {
      lista.push({ id: 'ciclo', nombre: `Ciclo ${t.cicloHoy.numero}`, filtro: (i) => i.ciclo_id === t.cicloHoy.id && tipo(i) !== 'cancelado' });
    }
    lista.push(
      { id: 'activas', nombre: 'Activas', filtro: (i) => tipo(i) !== 'backlog' && tipo(i) !== 'cancelado' && recientes(i) },
      { id: 'backlog', nombre: 'Backlog', filtro: (i) => tipo(i) === 'backlog' },
      { id: 'mias', nombre: 'Mías', filtro: (i) => i.asignado_id === yo && tipo(i) !== 'cancelado' && recientes(i) },
      { id: 'todas', nombre: 'Todas', filtro: () => true },
    );
    return lista.map((p) => ({ ...p, n: t.issues.filter(p.filtro).length }));
  }, [t, ciclosActivos, yo]); // eslint-disable-line react-hooks/exhaustive-deps

  const actual = pestanas.find((p) => p.id === pestana) || pestanas.find((p) => p.id === 'activas');
  const filtradas = t.issues.filter(actual.filtro)
    .filter((i) => !prios.length || prios.includes(i.prioridad))
    .filter((i) => !etqs.length || i.etiquetas.some((e) => etqs.includes(e)))
    .filter((i) => !personas.length || personas.includes(i.asignado_id ?? 0))
    .filter((i) => !q || plano(`${i.clave} ${i.titulo}`).includes(plano(q)));
  const columnas = t.estados.filter((e) => {
    if (actual.id === 'backlog') return e.tipo === 'backlog';
    if (actual.id === 'todas') return true;
    return e.tipo !== 'backlog' && e.tipo !== 'cancelado';
  });

  const abiertas = t.issues.filter((i) => !esCerrado(t.estadosPorId[i.estado_id]));
  const urgentes = abiertas.filter((i) => i.prioridad === 4).length;
  const vencidas = abiertas.filter((i) => i.fecha_limite && i.fecha_limite < hoyISO()).length;
  const quedan = t.cicloHoy ? diasEntre(hoyISO(), t.cicloHoy.termina) : null;
  const hayFiltros = prios.length || etqs.length || personas.length || q;
  const alternar = (lista, set) => (v) => set(lista.includes(v) ? lista.filter((x) => x !== v) : [...lista, v]);

  if (!t.proyecto) return null;
  if (abiertaId) {
    return (
      <>
        <Indice t={t} pestana={pestana} setPestana={setPestana} />
        <DetalleIssue t={t} />
      </>
    );
  }

  return (
    <>
      <Indice t={t} pestana={pestana} setPestana={setPestana} />
      <TPanel id="issues" className="wb__grow tissues">
        <div className="tcabeza">
          <div className="tcabeza__fila">
            <span className="tcabeza__ico"><IconIssues size={17} /></span>
            <h1 className="tcabeza__titulo">Issues</h1>
            <span className="tchip mono">{t.tablero.prefijo} · {t.proyecto.nombre}</span>
            <span className="tfill" />
            <div className="tcaras">
              {t.miembros.slice(0, 5).map((m) => <Cara key={m.usuario.id} usuario={m.usuario} estado={m.estado} size={26} />)}
              {t.miembros.length > 5 && <span className="tcaras__mas">+{t.miembros.length - 5}</span>}
            </div>
          </div>
          <p className="tcabeza__sub">
            {abiertas.length} abiertas
            {urgentes > 0 && <> · <span className="tpeligro">{urgentes} {urgentes === 1 ? 'urgente' : 'urgentes'}</span></>}
            {vencidas > 0 && <> · {vencidas} {vencidas === 1 ? 'vencida' : 'vencidas'}</>}
            {quedan != null && <> · el ciclo {t.cicloHoy.numero} cierra {quedan === 0 ? 'hoy' : quedan === 1 ? 'mañana' : `en ${quedan} días`}</>}
          </p>
          <nav className="tpestanas" aria-label="Qué issues">
            {pestanas.map((p) => (
              <button key={p.id} className={`tpestana ${actual.id === p.id ? 'is-on' : ''}`} aria-current={actual.id === p.id ? 'page' : undefined} onClick={() => setPestana(p.id)}>
                {p.nombre}<span>{p.n}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="therr">
          <div className="tseg" role="group" aria-label="Vista">
            <button className={modo === 'tablero' ? 'is-on' : ''} aria-pressed={modo === 'tablero'} onClick={() => setModo('tablero')}><IconTablero size={14} /> Tablero</button>
            <button className={modo === 'lista' ? 'is-on' : ''} aria-pressed={modo === 'lista'} onClick={() => setModo('lista')}><IconLista size={14} /> Lista</button>
          </div>
          <label className="tbuscar">
            <IconSearch size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por título o clave" aria-label="Filtrar issues" />
          </label>
          <span className="tfill" />
          <Filtro nombre={prios.length ? `Prioridad · ${prios.length}` : 'Prioridad'} activo={prios.length > 0}>
            {() => <Opciones multiple valor={prios} onElegir={alternar(prios, setPrios)}
              opciones={PRIORIDADES.map((p) => ({ valor: p.valor, nombre: p.nombre, icono: <Rombos prioridad={p.valor} /> }))} />}
          </Filtro>
          <Filtro nombre={etqs.length ? `Etiqueta · ${etqs.length}` : 'Etiqueta'} activo={etqs.length > 0}>
            {() => <Opciones multiple buscar valor={etqs} onElegir={alternar(etqs, setEtqs)} vacio="Sin etiquetas."
              opciones={t.tablero.etiquetas.map((e) => ({ valor: e.id, nombre: e.nombre, icono: <PuntoCuadrado color={e.color} /> }))} />}
          </Filtro>
          <Filtro nombre={personas.length ? `Persona · ${personas.length}` : 'Persona'} activo={personas.length > 0}>
            {() => <Opciones multiple valor={personas} onElegir={alternar(personas, setPersonas)}
              opciones={[{ valor: 0, nombre: 'Sin asignar' }, ...t.miembros.map((m) => ({ valor: m.usuario.id, nombre: m.usuario.first_name || m.usuario.username, icono: <Cara usuario={m.usuario} size={18} /> }))]} />}
          </Filtro>
          {hayFiltros ? (
            <button className="tbtn" onClick={() => { setPrios([]); setEtqs([]); setPersonas([]); setQ(''); }}><IconFiltro size={13} /> Quitar filtros</button>
          ) : null}
          <button className="btn btn--acento tbtnnueva" onClick={() => abrirCreacion({ proyectoId: t.proyectoId })}>
            <IconPlus size={14} /> Nueva issue <kbd>C</kbd>
          </button>
        </div>

        {t.error && <p className="testado terror">{t.error}</p>}
        {t.cargando && <p className="testado">Cargando las issues…</p>}
        {!t.cargando && !t.error && !t.issues.length && (
          <div className="tvacio">
            <IconIssues size={26} />
            <p>Todavía no hay issues en {t.proyecto.nombre}.</p>
            <span>Crea la primera con <kbd>C</kbd> o desde un mensaje del chat.</span>
            <button className="btn btn--primary" onClick={() => abrirCreacion({ proyectoId: t.proyectoId })}><IconPlus size={14} /> Nueva issue</button>
          </div>
        )}
        {!t.cargando && t.issues.length > 0 && (
          modo === 'lista'
            ? (filtradas.length ? <Lista t={t} columnas={columnas} issues={filtradas} onAbrir={abrir} /> : <p className="testado">Ninguna issue coincide con los filtros.</p>)
            : <Tablero t={t} columnas={columnas} issues={filtradas} onAbrir={abrir} />
        )}
      </TPanel>
    </>
  );
}
