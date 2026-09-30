// Lista.jsx — la vista densa: issues agrupadas por estado, una fila cada una.
import { useState } from 'react';
import { useIssuesStore } from '../../store/issuesStore';
import { Rombos, Etiqueta, Agente, Casilla, PuntoCuadrado } from '../../ui/Marcas';
import { Cara, nombreDe } from '../../ui/Panel';
import { IconChevronDown, IconChevronRight, IconPlus } from '../../../components/Icons';
import { vencimiento, nombreEstimacion, esCerrado } from '../../lib/issues';

export function Fila({ issue, t, onAbrir, compacta = false }) {
  const estado = t.estadosPorId[issue.estado_id];
  const venc = vencimiento(issue.fecha_limite, esCerrado(estado));
  const persona = t.gente[issue.asignado_id];
  const ini = t.iniciativasPorId[issue.iniciativa_id];
  const ciclo = t.ciclosPorId[issue.ciclo_id];
  const escala = t.tablero.config?.estimacion || 'fib';
  return (
    <button type="button" className={`tfilai ${compacta ? 'is-compacta' : ''}`} onClick={() => onAbrir(issue.id)}>
      <span className="tfilai__prio">{issue.prioridad > 0 ? <Rombos prioridad={issue.prioridad} /> : <span className="tfilai__sinprio">—</span>}</span>
      <span className="tfilai__clave mono">{issue.clave}</span>
      <Casilla estado={estado} size={15} />
      <span className="tfilai__titulo">
        <span className="tfilai__texto">{issue.titulo}</span>
        {!compacta && issue.etiquetas.map((id) => <Etiqueta key={id} etiqueta={t.etiquetasPorId[id]} />)}
        {issue.agente_rol && <Agente rol={issue.agente_rol} corto />}
      </span>
      {!compacta && <span className="tfilai__ini">{ini ? <><PuntoCuadrado color={ini.color} />{ini.nombre}</> : ''}</span>}
      <span className="tfilai__persona">{persona ? <><Cara usuario={persona.usuario} size={20} />{!compacta && nombreDe(persona.usuario)}</> : ''}</span>
      {!compacta && <span className="tfilai__ciclo">{ciclo ? `Ciclo ${ciclo.numero}` : ''}</span>}
      {!compacta && <span className="tfilai__est mono">{issue.estimacion != null ? nombreEstimacion(escala, issue.estimacion) : ''}</span>}
      <span className={`tfilai__fecha tvence is-${venc?.tono || 'normal'}`}>{venc?.texto || ''}</span>
    </button>
  );
}

function Grupo({ estado, issues, t, onAbrir }) {
  const [abierto, setAbierto] = useState(estado.tipo !== 'cancelado');
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  return (
    <div className="tlgrupo">
      <div className="tlgrupo__cab">
        <button className="tlgrupo__plegar" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
          {abierto ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <Casilla estado={estado} size={15} />
          <span className="tlgrupo__nombre">{estado.nombre}</span>
          <span className="tdim">{issues.length}</span>
        </button>
        <span className="tfill" />
        <button className="ic" onClick={() => abrirCreacion({ proyectoId: t.proyectoId, estadoId: estado.id })} aria-label={`Nueva issue en ${estado.nombre}`}><IconPlus size={14} /></button>
      </div>
      {abierto && issues.map((i) => <Fila key={i.id} issue={i} t={t} onAbrir={onAbrir} />)}
    </div>
  );
}

export function Lista({ t, columnas, issues, onAbrir }) {
  const grupos = columnas.map((e) => ({ estado: e, issues: issues.filter((i) => i.estado_id === e.id) }))
    .filter((g) => g.issues.length);
  if (!grupos.length) return null;
  return (
    <div className="tilista">
      <div className="tilista__cab" aria-hidden="true">
        <span /><span>ID</span><span /><span>Título</span><span>Proyecto</span><span>Asignada</span><span>Ciclo</span><span>Est.</span><span>Fecha</span>
      </div>
      {grupos.map((g) => <Grupo key={g.estado.id} estado={g.estado} issues={g.issues} t={t} onAbrir={onAbrir} />)}
    </div>
  );
}
