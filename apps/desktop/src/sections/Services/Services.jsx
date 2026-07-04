import React from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { ServiceRow } from '../../components/ServiceRow';
import { ModelList } from './ModelList';
import { LuActivity, LuRefreshCw } from 'react-icons/lu';

export function Services() {
  const { data, wsStatus } = useWebSocket('/ws/status');

  // Valores por defecto en caso de que cargue el WS
  const server = data?.server || { status: 'offline', version: 'N/A' };
  const database = data?.database || { status: 'offline', latency_ms: 0 };
  const ollama = data?.ollama || { status: 'offline', models: [] };
  const nodes = data?.nodes || [];

  return (
    <div className="services-page flex-col flex-1">
      <div className="services-header flex justify-between align-center">
        <h2 className="section-title" style={{ marginBottom: 0 }}>Estado del Clúster</h2>
        <div className="ws-indicator flex align-center gap-2 font-mono">
          <span className={`pulse-dot ${wsStatus}`}></span>
          <span>WEBSOCKET: {wsStatus.toUpperCase()}</span>
        </div>
      </div>

      <div className="services-list-container">
        <ServiceRow 
          name="Servidor Backend FastAPI" 
          status={server.status}
          details={`Runtime oficial v${server.version} · Puerto 8000`}
        />
        <ServiceRow 
          name="Base de Datos MySQL (Railway)" 
          status={database.status}
          details={database.status === 'online' ? 'Conectado a Railway Cloud Pool' : 'Sin conexión con base de datos'}
          latency={database.latency_ms}
        />
        <ServiceRow 
          name="Motor Ollama LLM Local" 
          status={ollama.status}
          details={ollama.status === 'online' ? `${ollama.models.length} modelos cargados en memoria` : 'Motor offline o no iniciado'}
        />
      </div>

      {/* Listado de Agentes Nodos */}
      <div className="nodes-section font-mono">
        <div className="section-header flex align-center gap-2">
          <LuActivity size={16} style={{ color: 'var(--accent)' }} />
          <h3>ESTADO DE LOS AGENTES NODOS DISTRIBUIDOS</h3>
        </div>
        <div className="nodes-table-wrapper">
          <table className="nodes-table">
            <thead>
              <tr>
                <th className="text-left">NODO ID</th>
                <th className="text-left">DIRECCIÓN IP</th>
                <th className="text-center">ESTADO</th>
                <th className="text-right">CARGA GPU</th>
                <th className="text-right">PETICIONES</th>
              </tr>
            </thead>
            <tbody>
              {nodes.length === 0 ? (
                <tr>
                  <td colSpan="5" className="text-center" style={{ color: 'var(--text-muted)' }}>
                    [NO DISTRIBUTED NODE AGENTS ONLINE]
                  </td>
                </tr>
              ) : (
                nodes.map((node, index) => {
                  const isOnline = node.online;
                  const statusText = isOnline ? 'ONLINE' : 'OFFLINE';
                  const statusColor = isOnline ? 'var(--status-ok)' : 'var(--status-error)';
                  return (
                    <tr key={index}>
                      <td className="text-left" style={{ color: 'var(--accent-alt)' }}>{node.id || 'N/A'}</td>
                      <td className="text-left">{node.host || 'unknown'}</td>
                      <td className="text-center" style={{ color: statusColor, fontWeight: 'bold' }}>{statusText}</td>
                      <td className="text-right">{node.gpu_load ? `${node.gpu_load}%` : '0%'}</td>
                      <td className="text-right">{node.requests || 0}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ModelList />

      <style dangerouslySetInnerHTML={{ __html: `
        .services-page {
          overflow-y: auto;
          height: 100%;
        }
        .services-header {
          margin-bottom: 24px;
        }
        .ws-indicator {
          font-size: 0.75rem;
          color: var(--text-secondary);
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          padding: 6px 12px;
          border-radius: 4px;
        }
        .pulse-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        .pulse-dot.connected {
          background-color: var(--status-ok);
          box-shadow: 0 0 8px var(--status-ok);
        }
        .pulse-dot.connecting {
          background-color: var(--status-warn);
          animation: spin 1s linear infinite;
        }
        .pulse-dot.disconnected {
          background-color: var(--status-error);
          box-shadow: 0 0 8px var(--status-error);
        }
        .nodes-section {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          margin-top: 24px;
        }
        .nodes-section .section-header {
          margin-bottom: 16px;
        }
        .nodes-section h3 {
          font-size: 0.9rem;
          font-weight: 700;
          color: #fff;
          letter-spacing: 0.05em;
        }
        .nodes-table-wrapper {
          overflow-x: auto;
        }
        .nodes-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.8rem;
        }
        .nodes-table th {
          color: var(--text-secondary);
          font-weight: 600;
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          font-size: 0.75rem;
        }
        .nodes-table td {
          padding: 10px;
          border-bottom: 1px solid var(--border);
          color: var(--text-primary);
        }
        .text-left { text-align: left; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }
      `}} />
    </div>
  );
}
