import React from 'react';

export function StatsCards({ summary, chartData }) {
  // Calcular totales del día (última entrada en chartData)
  const todayData = chartData && chartData.length > 0 ? chartData[chartData.length - 1] : null;

  const cards = [
    { 
      label: 'Conversaciones', 
      value: summary.conversations || 0,
      desc: 'Sesiones totales activas en clúster' 
    },
    { 
      label: 'Mensajes Procesados', 
      value: summary.messages || 0,
      desc: 'Interacciones totales registradas' 
    },
    { 
      label: 'Tokens de Entrada', 
      value: summary.prompt_tokens ? summary.prompt_tokens.toLocaleString() : '0', 
      desc: todayData ? `+${todayData.prompt_tokens.toLocaleString()} tokens hoy` : 'Tokens prompt acumulados'
    },
    { 
      label: 'Tokens de Salida', 
      value: summary.completion_tokens ? summary.completion_tokens.toLocaleString() : '0',
      desc: todayData ? `+${todayData.completion_tokens.toLocaleString()} tokens hoy` : 'Tokens completion acumulados'
    }
  ];

  return (
    <div className="dashboard-grid">
      {cards.map((card, index) => (
        <div key={index} className="stat-card">
          <span className="label">{card.label}</span>
          <span className="value">{card.value}</span>
          <span className="desc">{card.desc}</span>
        </div>
      ))}
    </div>
  );
}
