import React from 'react';

export function ModelBreakdown({ chartData }) {
  // Agregar uso por modelo
  const modelTotals = {};
  let totalAllModels = 0;

  if (chartData) {
    chartData.forEach(day => {
      if (day.models) {
        Object.entries(day.models).forEach(([model, tokens]) => {
          if (!modelTotals[model]) {
            modelTotals[model] = { name: model, tokens: 0, requests: 0 };
          }
          modelTotals[model].tokens += tokens;
          totalAllModels += tokens;
        });
      }
      // También podemos contar peticiones si están registradas
      if (day.requests && day.models) {
        // Asignación aproximada de requests proporcional al uso de tokens
        Object.keys(day.models).forEach(model => {
          modelTotals[model].requests += 1; // Contar días activos por simplicidad
        });
      }
    });
  }

  const rows = Object.values(modelTotals).sort((a, b) => b.tokens - a.tokens);

  return (
    <div className="breakdown-container">
      <h3>CONSUMO POR MODELO DE INTELIGENCIA ARTIFICIAL</h3>
      
      <div className="table-wrapper">
        <table className="breakdown-table">
          <thead>
            <tr>
              <th className="text-left">MODELO</th>
              <th className="text-right">TOKENS TOTALES</th>
              <th className="text-right">DÍAS ACTIVO</th>
              <th className="text-right">PORCENTAJE</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan="4" className="text-center font-mono" style={{ color: 'var(--text-muted)' }}>
                  [NO MODEL USAGE REGISTERED]
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const percentage = totalAllModels > 0 ? Math.round((row.tokens / totalAllModels) * 100) : 0;
                return (
                  <tr key={index}>
                    <td className="text-left font-mono" style={{ color: 'var(--accent-alt)' }}>
                      {row.name}
                    </td>
                    <td className="text-right font-mono">{row.tokens.toLocaleString()}</td>
                    <td className="text-right font-mono">{row.requests}</td>
                    <td className="text-right font-mono">
                      <div className="pct-badge" style={{ backgroundColor: 'rgba(var(--accent-rgb), 0.1)', color: 'var(--accent)' }}>
                        {percentage}%
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .breakdown-container {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
        }
        .breakdown-container h3 {
          font-size: 0.9rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 16px;
          letter-spacing: 0.05em;
        }
        .table-wrapper {
          overflow-x: auto;
        }
        .breakdown-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.85rem;
        }
        .breakdown-table th {
          color: var(--text-secondary);
          font-weight: 600;
          padding: 10px;
          border-bottom: 1px solid var(--border);
          font-size: 0.75rem;
          letter-spacing: 0.05em;
        }
        .breakdown-table td {
          padding: 12px 10px;
          border-bottom: 1px solid var(--border);
          color: var(--text-primary);
        }
        .text-left { text-align: left; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }
        .pct-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 700;
          font-size: 0.75rem;
        }
      `}} />
    </div>
  );
}
