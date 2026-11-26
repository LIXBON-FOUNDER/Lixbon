import { useRef, useState } from 'react';
import { StatusIcon } from '@lixbon/icons/status';
import { Icono } from '@lixbon/icons';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useMcpStore } from '../store/mcpStore';
import { ResourcesInventory } from './ResourcesInventory';
import { ProviderMark } from '../orch/agent/ProviderMark';
import { providerName } from '../orch/agent/agentIdentity';
import { TASK_STATUS_LABELS } from './projectsSidebarModel';
import { ServiceMark } from '../components/ServiceMark';

const mapKey = (projectId) => `lixbon_core_map_positions:${projectId}`;
const validPoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.y >= 0 && point.x <= 5000 && point.y <= 5000;
const statusKind = (status) => status === 'done' ? 'done' : status === 'failed' ? 'failed' : ['running', 'starting'].includes(status) ? 'working' : status === 'pending_approval' ? 'permission' : 'paused';

export function CoreTaskMap({ projectId, projectName, tasks, status, error, onRetry, hasMore, onLoadMore, onOpenTask }) {
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem(mapKey(projectId)) || '{}'); } catch { return {}; } });
  const [notice, setNotice] = useState('');
  const dragging = useRef(null);
  const point = (task, index) => validPoint(saved?.[task.id]) ? saved[task.id] : { x: 28 + index % 2 * 310, y: 28 + Math.floor(index / 2) * 164 };
  const save = (positions) => { setSaved(positions); try { localStorage.setItem(mapKey(projectId), JSON.stringify(positions)); } catch { setNotice('No se pudo guardar el orden en este equipo.'); } };
  const move = (id, p) => save({ ...saved, [id]: { x: Math.max(0, Math.min(5000, p.x)), y: Math.max(0, Math.min(5000, p.y)) } });
  return <div className="ade-core-map">
    <header><div><h1>Mapa de dependencias</h1><p>{projectName || projectId || 'Selecciona un proyecto en Trabajo'}</p></div><span>Dependencias y archivos compartidos · No informado</span></header>
    <div className="ade-core-map__scroll"><div className="ade-core-map__canvas" style={{ minHeight: Math.max(440, ...tasks.map((task, i) => point(task, i).y + 160)), minWidth: Math.max(660, ...tasks.map((task, i) => point(task, i).x + 300)) }}>
      {!tasks.length && <p className="ade-view-empty" role="status">{!projectId ? 'Selecciona un proyecto para ver sus tareas.' : ['idle', 'loading', 'refreshing'].includes(status) ? 'Cargando las tareas…' : error ? 'No se pudieron leer las tareas del proyecto.' : 'No hay tareas informadas para este proyecto.'}{error && <button type="button" className="lk" onClick={onRetry}>Reintentar</button>}</p>}
      {tasks.map((task, index) => { const p = point(task, index); return <article key={task.id} className="ade-core-map__node" style={{ left: p.x, top: p.y }}>
        <button type="button" className="ade-core-map__handle" aria-label={`Mover ${task.title || task.id}. Usa las flechas para cambiar su posición.`} onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragging.current = { id: task.id, x: event.clientX, y: event.clientY, point: p }; }} onPointerMove={(event) => { const drag = dragging.current; if (drag?.id === task.id) move(task.id, { x: drag.point.x + event.clientX - drag.x, y: drag.point.y + event.clientY - drag.y }); }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} onKeyDown={(event) => { const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key]; if (delta) { event.preventDefault(); move(task.id, {x: p.x + delta[0], y: p.y + delta[1]}); } }}><StatusIcon kind={statusKind(task.status)} size={14} />{TASK_STATUS_LABELS[task.status] || task.status}</button>
        <h2>{task.title || task.id}</h2><div className="ade-core-map__provider">{task.provider ? <><ProviderMark provider={task.provider} size={14} />{providerName(task.provider)}</> : 'Agente no informado'}</div><button type="button" className="lk" onClick={() => onOpenTask(task.id)}>Abrir la tarea</button>
      </article>; })}
    </div></div>
    <footer><span>Arrastra las tarjetas para ordenarlas; el orden se guarda por proyecto</span><button type="button" className="btn btn--ghost" onClick={() => save({})}>Ordenar automáticamente</button>{hasMore && <button type="button" className="lk" onClick={onLoadMore}>Cargar más tareas</button>}</footer>{notice && <p role="status">{notice}</p>}
  </div>;
}

export function CoreHosts({ projectId, inventory, status, onRetry }) {
  const openModal = useAppStore((s) => s.openModal);
  const machine = inventory?.v === 1 && typeof inventory.machine === 'string' ? inventory.machine : null;
  return <div className="ade-core-hosts">
    <aside><header><h2>Hosts</h2><button type="button" className="btn btn--ghost" onClick={() => openModal('remote')}>Conectar un host</button></header>{machine ? <div className="ade-core-hosts__selected"><StatusIcon kind="server" size={20} /><span><b>{machine}</b><small>Equipo informado por el inventario</small></span></div> : <p>No hay hosts informados.</p>}</aside>
    <main><header><h1>{machine || 'Hosts'}</h1><p>Estado de conexión · No informado</p></header><div className="ade-core-hosts__metrics">{['Intentos', 'CPU', 'Memoria'].map((label) => <article key={label}><span>{label}</span><b>No informado</b></article>)}</div><h2>En este host</h2><p>No hay una lista de intentos por host informada.</p><details><summary>Inventario de recursos del proyecto</summary>{projectId ? <ResourcesInventory inventory={inventory} status={status} onRetry={onRetry} projectId={projectId} /> : <p>Selecciona un proyecto en Trabajo para consultar su inventario.</p>}</details></main>
  </div>;
}

export function CoreIntegrations() {
  const servers = useMcpStore((s) => s.servers);
  const loaded = useMcpStore((s) => s.loaded);
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  return <div className="ade-core-integrations"><header><h1>Integraciones</h1><p>Lo que pueden leer los intentos</p></header><div className="ade-core-integrations__list"><button type="button" onClick={() => openSettings('mcp')}><Icono nombre="nodos" size={20} /><span><b>Servidores MCP</b><small>{loaded ? `${Object.values(servers).filter((server) => server.enabled && server.status === 'ready').length} activos` : 'Sin información'}</small></span></button>{Object.values(servers).map((server) => <button type="button" key={server.name} onClick={() => openSettings('mcp')}><ServiceMark name={server.name} size={20} /><span><b>{server.name}</b><small>{!server.enabled ? 'Desactivado' : server.status === 'ready' ? `Conectado · ${Array.isArray(server.tools) ? server.tools.length : 'No informado'} herramientas` : server.status === 'starting' ? 'Conectando…' : server.status === 'error' ? 'Error de conexión' : 'Sin conectar'}</small></span></button>)}</div><button type="button" className="btn btn--ghost" onClick={() => openSettings('mcp')}>Configurar integraciones</button></div>;
}
