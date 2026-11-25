import { Icono } from '@lixbon/icons';
import { useMcpStore } from '../../store/mcpStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { usePreviewStore, attemptById, taskOf } from './previewStore';

export function IntegrationsSidebar() {
  const servers = useMcpStore((state) => state.servers);
  const loaded = useMcpStore((state) => state.loaded);
  const list = Object.values(servers);
  return <div className="pv-integrations">
    <p>Lo que pueden leer los intentos</p>
    <button type="button" className="pv-integration" onClick={() => useWorkbenchStore.getState().openSettings('mcp')}><Icono nombre="nodos" size={24} /><span><b>Servidores MCP</b><small>{loaded ? `${list.filter((server) => server.status === 'ready').length} activos` : 'Sin información'}</small></span></button>
    {list.map((server) => <button type="button" className="pv-integration" key={server.name} onClick={() => useWorkbenchStore.getState().openSettings('mcp')}><Icono nombre="nodos" size={24} /><span><b>{server.name}</b><small>{server.status === 'ready' ? `Conectado · ${server.tools?.length || 0} herramientas` : server.status === 'starting' ? 'Conectando…' : server.status === 'error' ? 'Error de conexión' : 'Sin conectar'}</small></span></button>)}
  </div>;
}

export function IntegrationsView() {
  const state = usePreviewStore();
  const attempt = attemptById(state, state.sel.attemptId);
  const task = attempt && taskOf(state, attempt);
  return <div className="pv-integrations-main"><span className="pv-muted">{task?.title}</span><h1>Integraciones</h1><p>Lo que pueden leer los intentos</p><div className="pv-wrap"><button type="button" className="btn btn--ghost" onClick={() => useWorkbenchStore.getState().openSettings('mcp')}>Configurar integraciones</button>{attempt && <button type="button" className="btn btn--primary" onClick={() => state.openFork(attempt.id)}>Nuevo intento</button>}</div></div>;
}
