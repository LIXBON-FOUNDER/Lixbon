import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { LuServer, LuRefreshCw, LuCircleCheck, LuCircleAlert, LuTriangleAlert, LuCpu, LuActivity, LuHardDrive } from 'react-icons/lu';
import '../../style/Nodes.css';

export default function Nodes() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState(null);

  const fetchNodes = async () => {
    try {
      const res = await api.get('/api/nodes');
      setNodes(res.data.nodos || []);
      setError(null);
    } catch (e) {
      console.error(e);
      setError('Error al obtener el estado de los nodos.');
    } finally {
      setLoading(false);
    }
  };

  const handleReloadConfig = async () => {
    setReloading(true);
    try {
      const res = await api.post('/api/nodes/reload');
      alert(`Configuración recargada. ${res.data.nodos} nodos cargados.`);
      fetchNodes();
    } catch (e) {
      alert('Error al recargar nodos');
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
    // Auto-refresh en tiempo real cada 5 segundos
    const interval = setInterval(fetchNodes, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="muted nodes-loading">Cargando estado de los nodos...</div>;
  }

  return (
    <div id="nodes" className="section-content active">
      <section className="panel">
        <div className="nodes-header-wrap">
          <div>
            <h2><LuServer className="nodes-title-icon" /> Active Nodes</h2>
            <p className="muted nodes-desc">
              Monitoring compute resources across local cluster.
            </p>
          </div>
          <div className="nodes-actions">
            <button 
              onClick={handleReloadConfig} 
              disabled={reloading}
              className="secondary nodes-reload-btn"
            >
              <LuRefreshCw className="nodes-reload-icon" /> 
              {reloading ? 'Recargando...' : 'Recargar Nodos.json'}
            </button>
          </div>
        </div>

        {error && (
          <div className="error-box nodes-error-box">
            <LuTriangleAlert />
            <span>{error}</span>
          </div>
        )}

        <div className="grid-2">
          {nodes && nodes.length > 0 ? (
            nodes.map((n, idx) => {
              const score = n.score ?? 0;
              const isCb = n.circuit_breaker ?? false;
              const isOnline = n.online ?? false;
              const modelos = n.modelos ?? [];
              const metricas = n.metricas || {};
              
              const cpu = metricas.cpu_percent ?? 0;
              const ram = metricas.ram_percent ?? 0;
              const gpuFree = metricas.gpu_free_percent ?? 100;
              const gpuUsed = 100 - gpuFree;

              return (
                <div key={idx} className="quick-card node-card">
                  <div className="node-card-header">
                    <h3 className="node-name">
                      {n.name || n.id || `Nodo ${idx + 1}`}
                    </h3>
                    <span>
                      {isOnline ? (
                        <span className="badge badge-ok node-badge">
                          <LuCircleCheck className="node-badge-icon" /> Online
                        </span>
                      ) : (
                        <span className="badge badge-error node-badge">
                          <LuCircleAlert className="node-badge-icon" /> Offline
                        </span>
                      )}
                    </span>
                  </div>

                  <p className="small muted node-address">
                    Dirección: <code>{n.ollama_url}</code>
                  </p>

                  <div className="stats-cards node-stats">
                    <div className="stat-card node-stat-card">
                      <span className="node-stat-label">Puntuación</span>
                      <strong className="node-stat-value">{score}</strong>
                    </div>
                    <div className="stat-card node-stat-card">
                      <span className="node-stat-label">Circuit Breaker</span>
                      <strong className={`node-stat-value ${isCb ? 'node-cb-active' : 'node-cb-ok'}`}>
                        {isCb ? 'ACTIVO' : 'OK'}
                      </strong>
                    </div>
                  </div>

                  <div className="node-metrics">
                    <div className="metric-item">
                      <div className="metric-header">
                        <span><LuCpu /> CPU</span>
                        <span>{cpu.toFixed(1)}%</span>
                      </div>
                      <div className="progress-bar-bg">
                        <div className="progress-bar-fill" style={{ width: `${Math.min(cpu, 100)}%`, backgroundColor: cpu > 85 ? '#ef4444' : 'var(--primary)' }}></div>
                      </div>
                    </div>
                    
                    <div className="metric-item">
                      <div className="metric-header">
                        <span><LuActivity /> RAM</span>
                        <span>{ram.toFixed(1)}%</span>
                      </div>
                      <div className="progress-bar-bg">
                        <div className="progress-bar-fill" style={{ width: `${Math.min(ram, 100)}%`, backgroundColor: ram > 85 ? '#ef4444' : 'var(--primary)' }}></div>
                      </div>
                    </div>

                    {metricas.gpu_available && (
                      <div className="metric-item">
                        <div className="metric-header">
                          <span><LuHardDrive /> GPU (Usada)</span>
                          <span>{gpuUsed.toFixed(1)}%</span>
                        </div>
                        <div className="progress-bar-bg">
                          <div className="progress-bar-fill" style={{ width: `${Math.min(gpuUsed, 100)}%`, backgroundColor: gpuUsed > 85 ? '#ef4444' : 'var(--primary)' }}></div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="node-models-wrap">
                    <span className="small font-medium node-models-label">
                      Modelos disponibles ({modelos.length}):
                    </span>
                    <div className="node-models-list">
                      {modelos.length > 0 ? (
                        modelos.map((m, mIdx) => (
                          <span 
                            key={mIdx} 
                            className="badge node-model-badge"
                          >
                            {m}
                          </span>
                        ))
                      ) : (
                        <span className="small muted">Ninguno</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="muted text-center nodes-empty">
              No hay nodos del cluster configurados o activos en nodes.json.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
