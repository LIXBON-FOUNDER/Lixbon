import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { LuActivity, LuZap, LuChartBar, LuHistory, LuRefreshCw, LuTerminal, LuLayoutGrid, LuCircleCheck, LuCircleAlert } from 'react-icons/lu';
import '../../style/Dashboard.css';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sysStatus, setSysStatus] = useState('Consultando estado operativo...');
  const [ollamaOk, setOllamaOk] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState('');

  const fetchDashboardData = async () => {
    try {
      const res = await api.get('/api/dashboard/init');
      setData(res.data);
      
      // Verificamos conexión
      const models = res.data.models || [];
      const hasError = models.length > 0 && String(models[0].id || '').startsWith('error:');
      setOllamaOk(!hasError);
      
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const r = await api.get('/api/status');
      setSysStatus(r.data.ollama_ok ? 'Servicios operativos.' : 'Fallo de conexión al modelo.');
    } catch (e) {
      setSysStatus('Error al conectar.');
    }
  };

  useEffect(() => {
    fetchDashboardData();
    fetchStatus();
  }, []);

  const handleCopy = async (text, platform) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-999999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopyFeedback(`¡Comando copiado! Pégalo en tu ${platform === 'win' ? 'PowerShell' : 'terminal bash'}.`);
      setTimeout(() => setCopyFeedback(''), 3000);
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return <div className="muted dashboard-loading">Cargando resumen...</div>;
  }

  if (!data) {
    return <div className="error-box">No se pudo cargar la información del servidor.</div>;
  }

  const { ollama_url, rate_limit_per_min, server_base_url, usage, conversations } = data;
  const linuxCmd = `curl -fsSL ${server_base_url}/install.sh | bash`;
  const winCmd = `irm ${server_base_url}/install.ps1 | iex`;

  return (
    <div id="overview" className="section-content active">
      <section className="panel hero dashboard-hero">
        <div>
          <h2>System Overview</h2>
          <p className="muted">Real-time metrics and cluster performance</p>
          <p className="small">Servidor Ollama: <strong>{ollama_url}</strong></p>
        </div>
        <div className="hero-status">
          {!ollamaOk ? (
            <span className="badge badge-error">
              <LuCircleAlert className="icon-align" /> Ollama no disponible
            </span>
          ) : (
            <span className="badge badge-ok">
              <LuCircleCheck className="icon-align" /> Ollama conectado
            </span>
          )}
        </div>
      </section>

      <section className="grid-2">
        <article className="quick-card">
          <h3>
            <LuActivity className="icon-align-md" /> 
            Estado del sistema
          </h3>
          <p id="sys-status" className="muted">{sysStatus}</p>
          <p className="small muted limit-text">
            Límite actual: <strong className="limit-value">{rate_limit_per_min}</strong> req/min
          </p>
          <button onClick={() => { fetchDashboardData(); fetchStatus(); }} type="button" className="secondary">
            <LuRefreshCw className="icon-align-sm" /> Refrescar estado
          </button>
        </article>

        <article className="quick-card">
          <h3>
            <LuZap className="icon-align-md" />
            Copiar Comando CLI
          </h3>
          <p className="small muted copy-desc">
            Copia el instalador y pégalo en la terminal del otro equipo para conectarlo a este Gateway.
          </p>
          <div className="btn-row">
            <button onClick={() => handleCopy(linuxCmd, 'linux')} type="button" className="secondary" title="Copia comando bash">
              <LuTerminal className="icon-align-sm" /> Linux/Mac
            </button>
            <button onClick={() => handleCopy(winCmd, 'win')} type="button" className="secondary" title="Copia comando PowerShell">
              <LuLayoutGrid className="icon-align-sm" /> Windows
            </button>
          </div>
          <p 
            id="copy-feedback" 
            className="small copy-feedback" 
            style={{ opacity: copyFeedback ? 1 : 0 }}
          >
            {copyFeedback}
          </p>
        </article>
      </section>

      <section className="panel usage-panel">
        <h2><LuChartBar /> Uso acumulado</h2>
        <div className="stats-cards">
          <div className="stat-card">
            <span>Conversaciones</span>
            <strong>{usage?.conversations ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Mensajes</span>
            <strong>{usage?.messages ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Prompt tokens</span>
            <strong>{usage?.prompt_tokens ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Completion tokens</span>
            <strong>{usage?.completion_tokens ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Total tokens</span>
            <strong>{usage?.total_tokens ?? 0}</strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2><LuHistory /> Conversaciones recientes</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Título</th>
                <th>Última act.</th>
              </tr>
            </thead>
            <tbody>
              {conversations && conversations.length > 0 ? (
                conversations.map((conv, idx) => (
                  <tr key={idx}>
                    <td>
                      <span className="badge badge-ok client-badge">
                        {conv.client_id || 'LAN'}
                      </span>
                    </td>
                    <td>{conv.title}</td>
                    <td className="muted small">{conv.updated_at}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="muted text-center">No hay conversaciones recientes.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
