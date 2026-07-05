// Metrics.jsx — consumo del plan: cuotas del período y tokens por día.
// Datos de GET /api/account/usage: { plan, usage, daily }.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { planColor } from '../../lib/planColors';
import { UsageChart } from './UsageChart';

const fmtInt = (n) => Number(n || 0).toLocaleString('es');

function QuotaTile({ label, used, limit, resetsAt }) {
  const unlimited = limit === -1 || limit == null;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const nearLimit = !unlimited && pct >= 90;

  const resetText = resetsAt
    ? new Date(resetsAt).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="quota-tile">
      <span className="quota-tile__label">{label}</span>
      <span className="quota-tile__value">
        {fmtInt(used)}
        <span className="quota-tile__limit">
          {unlimited ? ' · sin límite' : ` / ${fmtInt(limit)}`}
        </span>
      </span>
      {!unlimited && (
        <span className="quota-tile__meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span
            className={`quota-tile__fill ${nearLimit ? 'is-warning' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
      {resetText && <span className="quota-tile__reset">Se restablece el {resetText}</span>}
    </div>
  );
}

export function Metrics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/account/usage')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="metrics">
        <h2 className="center-view__title">Consumo</h2>
        <p className="metrics__error">No se pudo cargar el consumo: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="metrics">
        <h2 className="center-view__title">Consumo</h2>
        <div className="metrics__tiles">
          <span className="skeleton metrics__skeleton-tile" />
          <span className="skeleton metrics__skeleton-tile" />
        </div>
        <span className="skeleton metrics__skeleton-chart" />
      </div>
    );
  }

  const { plan, usage, daily } = data;

  return (
    <div className="metrics">
      <div className="metrics__head">
        <h2 className="center-view__title">Consumo</h2>
        {plan && (
          <span className="metrics__plan" style={{ color: planColor(plan.id) }}>
            Plan {plan.name}
          </span>
        )}
      </div>

      <div className="metrics__tiles">
        <QuotaTile
          label="Mensajes hoy"
          used={usage.messages_today}
          limit={usage.messages_per_day}
          resetsAt={usage.day_resets_at}
        />
        <QuotaTile
          label="Tokens este mes"
          used={usage.tokens_month}
          limit={usage.tokens_per_month}
          resetsAt={usage.month_resets_at}
        />
      </div>

      <h3 className="metrics__subtitle">Tokens por día · últimos 30 días</h3>
      <UsageChart daily={daily || []} />
    </div>
  );
}
