// ServiceComb.jsx — el panal de uso de Ajustes › Uso: un hexágono por cada
// 200 mil tokens que un servicio gastó un día, con el número del día dentro.
// El mismo panal que la app móvil (src/lib/honeycomb.js).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { useLocale } from '../i18n/LocaleContext';
import { HEX_TOKENS, SERVICES, cellSize, fmtTokens, layout, serviceCells } from '../lib/honeycomb';

const HEX_DOT = '6,0 12,3.5 12,10.5 6,14 0,10.5 0,3.5';

export function ServiceComb({ rows }) {
  const t = useT('account');
  const locale = useLocale();
  const [days, setDays] = useState(7);
  const [hover, setHover] = useState(null);
  const [width, setWidth] = useState(0);
  const box = useRef(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cells, hidden, totals, total } = serviceCells(rows, days);
  const s = cellSize(cells.length, Math.min(width, 520), 20);
  const comb = layout(cells, s);
  const used = SERVICES.filter((x) => totals[x] > 0);
  const label = (service) => t(`usage.services.${service}`);
  const when = (date) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <div className="comb">
      <div className="comb__head">
        <p className="card__muted">{t('usage.combLead', { total: fmtTokens(total, locale), days })}</p>
        <div className="comb__seg" role="tablist" aria-label={t('usage.combPeriod')}>
          {[7, 30].map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={days === d}
              className={days === d ? 'is-on' : undefined}
              onClick={() => {
                setDays(d);
                setHover(null);
              }}
            >
              {t('usage.combDays', { days: d })}
            </button>
          ))}
        </div>
      </div>

      <div className="comb__body">
        <div className="comb__canvas" ref={box}>
          {cells.length === 0 ? (
            <p className="card__muted">{t('usage.combEmpty')}</p>
          ) : (
            width > 0 && (
              <svg
                width={comb.width}
                height={comb.height}
                viewBox={`0 0 ${comb.width} ${comb.height}`}
                role="img"
                aria-label={t('usage.combAria', { detail: used.map((x) => `${label(x)} ${fmtTokens(totals[x], locale)}`).join(', ') })}
                onMouseLeave={() => setHover(null)}
              >
                {comb.hexes.map((h) => (
                  <g
                    key={h.key}
                    className={`comb__cell comb__cell--${h.cell.service}${hover === h ? ' is-hover' : ''}`}
                    onMouseEnter={() => setHover(h)}
                  >
                    <title>{`${label(h.cell.service)} · ${when(h.cell.date)} · ${fmtTokens(h.cell.tokens, locale)}`}</title>
                    <polygon points={h.points} className={h.full ? 'comb__hex' : 'comb__hex is-partial'} />
                    {!h.full && h.partial && <polygon points={h.partial} className="comb__fill" />}
                    {s >= 9 && (
                      <text x={h.cx} y={h.cy + s * 0.2} className={h.full ? 'comb__day' : 'comb__day is-partial'} fontSize={Math.max(7, s * 0.56)} textAnchor="middle">
                        {h.cell.day}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            )
          )}
          {hover && (
            <div className="comb__tip">{`${label(hover.cell.service)} · ${when(hover.cell.date)} · ${fmtTokens(hover.cell.tokens, locale)}`}</div>
          )}
        </div>

        {used.length > 0 && (
          <div className="comb__legend">
            {used.map((x) => (
              <div key={x} className="comb__row">
                <div className="comb__name">
                  <svg width="12" height="14" aria-hidden="true" className={`comb__cell--${x}`}>
                    <polygon points={HEX_DOT} className="comb__hex" />
                  </svg>
                  <span>{label(x)}</span>
                  <span className="comb__total">{fmtTokens(totals[x], locale)}</span>
                </div>
                <span className="comb__detail">
                  {t('usage.combDetail', { hexes: Math.ceil(totals[x] / HEX_TOKENS), pct: Math.round((totals[x] * 100) / total) })}
                </span>
              </div>
            ))}
            <div className="comb__rule" />
            <p className="comb__note">
              {t('usage.combNote')}
              {totals.other > 0 && ` ${t('usage.combOther')}`}
              {hidden > 0 && ` ${t('usage.combHidden', { hidden })}`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
