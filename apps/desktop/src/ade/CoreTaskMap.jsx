import { useRef, useState } from 'react';
import { StatusMark } from './StatusMark';
import { IconExternal } from '../components/Icons';
import { ProviderMark } from '../orch/agent/ProviderMark';
import { providerName } from '../orch/agent/agentIdentity';
import { validTaskV2 } from './coreModelContract';
import { TASK_STATUS_LABELS } from './projectsSidebarModel';
import { attemptDuration, formatDurationMs } from './attemptFormat';
import { COPY, attemptStatusInfo, taskStateInfo } from './adeLabels';
import { InboxLaunchApproval } from './InboxLaunchApproval';

const mapKey = (projectId) => `lixbon_core_map_positions:${projectId}`;
const validPoint = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.y >= 0 && p.x <= 5000 && p.y <= 5000;

function MapNode({ task, point, active, drag, onOpenTask, onOpenAttempt }) {
  const [expanded, setExpanded] = useState(false);
  const current = validTaskV2(task) ? task.current_attempt : null;
  const provider = current?.provider || task.provider;
  const status = current?.status || task.status || task.state;
  const statusInfo = current || task.status ? attemptStatusInfo(status) : taskStateInfo(status);
  const label = current ? statusInfo.label : TASK_STATUS_LABELS[status] || statusInfo.label;
  const permission = current && ['pending_approval', 'awaiting_terminal_approval'].includes(current.status);
  const duration = current?.status === 'running' && Number.isSafeInteger(current.started_at) && current.started_at > 0 && Date.now() >= current.started_at ? formatDurationMs(Date.now()-current.started_at) : current ? attemptDuration(current) : COPY.notAvailable;
  const open = () => current && onOpenAttempt ? onOpenAttempt({taskId:task.id,attemptId:current.id}) : onOpenTask(task.id);
  return <article className={`ade-core-map__node${permission ? ' has-permission' : ''}`} style={{left:point.x,top:point.y}}>
    <div className="ade-core-map__nodehead">
      <button type="button" className="ade-core-map__handle" aria-label={`Mover ${task.title || task.id}. Usa las flechas para cambiar su posición.`} {...drag}><StatusMark info={statusInfo} size={14} />{current && task.attempt_count > 1 && !permission ? `${task.attempt_count} intentos` : label}</button>
      <button type="button" className="ic" title={current ? 'Abrir el intento' : 'Abrir la tarea'} aria-label={`${current ? 'Abrir el intento' : 'Abrir la tarea'} de ${task.title || task.id}`} onClick={open}><IconExternal size={14} /></button>
    </div>
    <h2>{task.title || task.id}</h2>
    {permission && <details className="ade-core-map__permission" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>{expanded ? 'Ocultar' : 'Ver qué necesita'}</summary>{expanded && active && <InboxLaunchApproval attemptId={current.id} active={active} />}</details>}
    <div className="ade-core-map__provider" title={current ? 'Agente del intento actual' : undefined}>{provider ? <><ProviderMark provider={provider} size={16} /><span>{providerName(provider)}</span></> : <span>Agente no informado</span>}<small>{duration === COPY.notAvailable ? 'Tiempo no informado' : duration}</small></div>
    <button type="button" className="lk ade-core-map__open" onClick={open}>{current ? 'Abrir el intento' : 'Abrir la tarea'}</button>
  </article>;
}

export function CoreTaskMap({ projectId, projectName, tasks, status, error, onRetry, hasMore, onLoadMore, onOpenTask, onOpenAttempt, active = true, summaryPartial = false }) {
  const [saved, setSaved] = useState(() => {
    try { const value=JSON.parse(localStorage.getItem(mapKey(projectId)) || '{}'); return value && typeof value==='object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  });
  const [notice, setNotice] = useState('');
  const dragging = useRef(null);
  const point = (task, i) => validPoint(saved[task.id]) ? saved[task.id] : {x:28+i%2*310,y:28+Math.floor(i/2)*260};
  const save = (positions) => { setSaved(positions); try { localStorage.setItem(mapKey(projectId),JSON.stringify(positions)); } catch { setNotice('No se pudo guardar el orden en este equipo.'); } };
  const move = (id,p) => save({...saved,[id]:{x:Math.max(0,Math.min(5000,p.x)),y:Math.max(0,Math.min(5000,p.y))}});
  return <div className="ade-core-map">
    <header><div><h1>Mapa de dependencias</h1><p>{projectName || projectId || 'Selecciona un proyecto en Trabajo'}</p></div><span>Dependencias y archivos compartidos · No informado</span></header>
    {summaryPartial && <p className="ade-core-map__summary-note">Resumen de intentos parcial: algunas tarjetas solo muestran la tarea.</p>}
    <div className="ade-core-map__scroll"><div className="ade-core-map__canvas" style={{minHeight:Math.max(440,...tasks.map((task,i)=>point(task,i).y+320)),minWidth:Math.max(660,...tasks.map((task,i)=>point(task,i).x+300))}}>
      {!tasks.length && <p className="ade-view-empty" role="status">{!projectId ? 'Selecciona un proyecto para ver sus tareas.' : ['idle','loading','refreshing'].includes(status) ? 'Cargando las tareas…' : error ? 'No se pudieron leer las tareas del proyecto.' : 'No hay tareas informadas para este proyecto.'}{error && <button type="button" className="lk" onClick={onRetry}>Reintentar</button>}</p>}
      {tasks.map((task,i) => {const p=point(task,i);return <MapNode key={task.id} task={task} point={p} active={active} onOpenTask={onOpenTask} onOpenAttempt={onOpenAttempt} drag={{
        onPointerDown:event=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);dragging.current={id:task.id,x:event.clientX,y:event.clientY,point:p};},
        onPointerMove:event=>{const d=dragging.current;if(d?.id===task.id)move(task.id,{x:d.point.x+event.clientX-d.x,y:d.point.y+event.clientY-d.y});},
        onPointerUp:()=>{dragging.current=null;},onPointerCancel:()=>{dragging.current=null;},
        onKeyDown:event=>{const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];if(delta){event.preventDefault();move(task.id,{x:p.x+delta[0],y:p.y+delta[1]});}},
      }}/>;})}
    </div></div>
    <footer><span>Arrastra las tarjetas para ordenarlas; el orden se guarda por proyecto</span><button type="button" className="btn btn--ghost" onClick={()=>save({})}>Ordenar automáticamente</button>{hasMore && <button type="button" className="lk" onClick={onLoadMore}>Cargar más tareas</button>}</footer>{notice && <p role="status">{notice}</p>}
  </div>;
}
