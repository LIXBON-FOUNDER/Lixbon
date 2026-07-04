// UsageChart.jsx — barras de tokens/día (30 días) para Mi cuenta.
// Una sola serie: color tinta uniforme (la identidad la da el título, no el color),
// barras finas con extremo redondeado, tooltip por barra, labels selectivos.
import { useMemo, useState } from 'react';

const W = 640;
const H = 180;
const PAD = { top: 18, right: 8, bottom: 26, left: 44 };

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function UsageChart({ daily }) {
  const [hover, setHover] = useState(null);

  const data = useMemo(() => {
    const byDate = {};
    for (const row of daily) {
      byDate[row.usage_date] = (byDate[row.usage_date] || 0) + (row.total_tokens || 0);
    }
    return lastNDays(30).map((date) => ({ date, tokens: byDate[date] || 0 }));
  }, [daily]);

  const max = Math.max(1, ...data.map((d) => d.tokens));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = innerW / data.length;
  const barW = Math.max(4, step - 4); // 4px de aire entre barras
  const y = (v) => PAD.top + innerH * (1 - v / max);
  const maxIdx = data.findIndex((d) => d.tokens === max);

  const gridVals = [max, max / 2];

  return (
    <div className="uchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens usados por día, últimos 30 días">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="uchart__grid" />
            <text x={PAD.left - 8} y={y(v) + 4} className="uchart__tick" textAnchor="end">{fmt(Math.round(v))}</text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} className="uchart__axis" />

        {data.map((d, i) => {
          const x = PAD.left + i * step + (step - barW) / 2;
          const h = Math.max(d.tokens > 0 ? 3 : 0, innerH * (d.tokens / max));
          return (
            <g key={d.date}>
              {/* hit target más ancho que la barra */}
              <rect
                x={PAD.left + i * step} y={PAD.top} width={step} height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
              {h > 0 && (
                <rect
                  x={x} y={y(d.tokens)} width={barW} height={h} rx={3}
                  className={`uchart__bar ${hover === i ? 'is-hover' : ''}`}
                  pointerEvents="none"
                />
              )}
              {/* label directo solo en el máximo (selectivo) */}
              {i === maxIdx && d.tokens > 0 && hover === null && (
                <text x={x + barW / 2} y={y(d.tokens) - 6} className="uchart__label" textAnchor="middle">
                  {fmt(d.tokens)}
                </text>
              )}
            </g>
          );
        })}

        {/* etiquetas de fecha: primera, media y última */}
        {[0, 14, 29].map((i) => (
          <text
            key={i}
            x={PAD.left + i * step + step / 2}
            y={H - 8}
            className="uchart__tick"
            textAnchor="middle"
          >
            {data[i].date.slice(5)}
          </text>
        ))}
      </svg>

      {hover !== null && (
        <div
          className="uchart__tooltip"
          style={{ left: `${((PAD.left + hover * step + step / 2) / W) * 100}%` }}
        >
          <strong>{data[hover].date}</strong> · {data[hover].tokens.toLocaleString()} tokens
        </div>
      )}
    </div>
  );
}
