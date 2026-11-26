import { StatusIcon } from '@lixbon/icons/status';
import { Icono } from '@lixbon/icons';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useMcpStore } from '../store/mcpStore';
import { ResourcesInventory } from './ResourcesInventory';
import { ServiceMark } from '../components/ServiceMark';
import { TASK_STATUS_LABELS } from './projectsSidebarModel';
import { NewAttemptForm } from './NewAttemptForm';

export { CoreTaskMap } from './CoreTaskMap';

export function CoreHosts({ projectId, inventory, status, onRetry, onOpenTask }) {
  const openModal = useAppStore((s) => s.openModal);
  const machine = inventory?.v === 1 && typeof inventory.machine === 'string' ? inventory.machine : null;
  const work = new Map();
  for (const item of inventory?.worktrees || []) {
    if (machine && item.target.machine === machine && item.target.project_id === projectId && typeof item.owner?.task_id === 'string') work.set(item.owner.task_id, {id:item.owner.task_id,status:item.owner.status,branch:item.git?.branch});
  }
  return <div className="ade-core-hosts">
    <aside><header><h2>Hosts</h2><button type="button" className="btn btn--ghost" onClick={() => openModal('remote')}>Conectar un host</button></header>{machine ? <div className="ade-core-hosts__selected"><StatusIcon kind="server" size={20} /><span><b>{machine}</b><small>Equipo informado por el inventario</small></span></div> : <p>No hay hosts informados.</p>}</aside>
    <main><header><h1>{machine || 'Hosts'}</h1><p>Estado de conexión · No informado</p></header><div className="ade-core-hosts__metrics">{['Intentos', 'CPU', 'Memoria'].map((label) => <article key={label}><span>{label}</span><b>No informado</b></article>)}</div><h2>En este host</h2><p>No hay una lista de intentos por host informada.</p>{work.size > 0 && <section className="ade-core-hosts__work"><h3>Trabajo del inventario</h3>{Array.from(work.values()).map(task => <button type="button" key={task.id} disabled={!onOpenTask} onClick={()=>onOpenTask?.(task.id)}><StatusIcon kind="branch" size={16} /><span><b>{task.id}</b><small>{TASK_STATUS_LABELS[task.status] || task.status || 'Estado no informado'}{task.branch ? ` · ${task.branch}` : ''}</small></span></button>)}</section>}<details><summary>Inventario de recursos del proyecto</summary>{projectId ? <ResourcesInventory inventory={inventory} status={status} onRetry={onRetry} projectId={projectId} /> : <p>Selecciona un proyecto en Trabajo para consultar su inventario.</p>}</details></main>
  </div>;
}

export function CoreIntegrations({ projectId, projectName, coreModel, active, onCreated, onCancel }) {
  const servers = useMcpStore((s) => s.servers);
  const loaded = useMcpStore((s) => s.loaded);
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  return <div className="ade-core-integrations"><aside><header><h1>Integraciones</h1><p>Lo que pueden leer los intentos</p></header><div className="ade-core-integrations__list"><button type="button" onClick={() => openSettings('mcp')}><Icono nombre="nodos" size={16} /><span><b>Servidores MCP</b><small>{loaded ? `${Object.values(servers).filter((server) => server.enabled && server.status === 'ready').length} activos` : 'Sin información'}</small></span></button>{Object.values(servers).map((server) => <button type="button" key={server.name} onClick={() => openSettings('mcp')}><ServiceMark name={server.name} size={16} /><span><b>{server.name}</b><small>{!server.enabled ? 'Desactivado' : server.status === 'ready' ? `Conectado · ${Array.isArray(server.tools) ? server.tools.length : 'No informado'} herramientas` : server.status === 'starting' ? 'Conectando…' : server.status === 'error' ? 'Error de conexión' : 'Sin conectar'}</small></span></button>)}</div><button type="button" className="btn btn--ghost" onClick={() => openSettings('mcp')}>Configurar integraciones</button></aside><main><NewAttemptForm key={projectId || 'none'} projectId={projectId} projectName={projectName} coreModel={coreModel} active={active} surface="page" onCreated={onCreated} onCancel={onCancel} /></main></div>;
}
