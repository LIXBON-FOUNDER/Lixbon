import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { StatsCards } from './StatsCards';
import { UsageChart } from './UsageChart';
import { ModelBreakdown } from './ModelBreakdown';
import { LuRefreshCw } from 'react-icons/lu';

export function Metrics() {
  const [summary, setSummary] = useState({});
  const [chartData, setChartData] = useState([]);
  const [limit, setLimit] = useState(30); // 7 | 14 | 30 días
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchMetrics = async () => {
    setIsLoading(true);
    setError('');
    try {
      const summaryRes = await api.get('/api/monitor/usage');
      const dailyRes = await api.get(`/api/monitor/usage/daily?limit=${limit}`);
      
      if (summaryRes) setSummary(summaryRes);
      if (dailyRes) setChartData(dailyRes);
    } catch (e) {
      setError('Error al obtener métricas de consumo: ' + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, [limit]);

  if (isLoading) {
    return (
      <div className="flex flex-col flex-1 align-center justify-center font-mono" style={{ color: 'var(--text-secondary)' }}>
        <LuRefreshCw size={24} className="spin-icon" style={{ marginBottom: '12px' }} />
        <span>Cargando análisis de uso...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col flex-1 align-center justify-center font-mono" style={{ color: 'var(--text-error)' }}>
        <span>⚠️ {error}</span>
        <button onClick={fetchMetrics} className="btn-retry" style={{ marginTop: '16px' }}>Reintentar</button>
      </div>
    );
  }

  return (
    <div className="metrics-page flex-col flex-1">
      <div className="metrics-header flex justify-between align-center">
        <h2 className="section-title" style={{ marginBottom: 0 }}>Rendimiento y Consumo</h2>
        
        <div className="toggle-group flex">
          {[7, 14, 30].map(days => (
            <button
              key={days}
              onClick={() => setLimit(days)}
              className={`toggle-btn ${limit === days ? 'active' : ''}`}
            >
              {days === 30 ? 'Mensual' : days === 14 ? 'Semanal' : '7 días'}
            </button>
          ))}
        </div>
      </div>

      <StatsCards summary={summary} chartData={chartData} />
      <UsageChart data={chartData} />
      <ModelBreakdown chartData={chartData} />

      <style dangerouslySetInnerHTML={{ __html: `
        .metrics-page {
          overflow-y: auto;
          height: 100%;
        }
        .metrics-header {
          margin-bottom: 24px;
        }
        .toggle-group {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 3px;
        }
        .toggle-btn {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--text-secondary);
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .toggle-btn.active {
          background-color: var(--accent);
          color: #ffffff;
        }
        .spin-icon {
          animation: spin 1s linear infinite;
        }
        .btn-retry {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          color: #fff;
        }
        .btn-retry:hover {
          border-color: var(--accent);
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}} />
    </div>
  );
}
