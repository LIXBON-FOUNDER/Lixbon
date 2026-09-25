// UsagePage.jsx — Ajustes → Uso y límites: sesión y semana (el cupo real del
// chat, compartido por web, desktop, CLI y móvil) y los tokens por día.
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/tauri';

function fmtReset(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  const when = d.toLocaleString('es', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  if (mins <= 0) return 'se reinicia en breve';
  if (mins < 60) return `se reinicia en ${mins} min`;
  if (mins < 60 * 24) return `se reinicia en ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `se reinicia el ${when}`;
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));

const WEEK_MS = 7 * 86400000;

/** Al ritmo de lo que va de semana, dónde acabará el cupo. */
function projection(bucket) {
  if (!bucket?.reset_at || bucket.unlimited || !bucket.percent) return null;
  const elapsed = Date.now() - (new Date(bucket.reset_at).getTime() - WEEK_MS);
  if (elapsed < 12 * 3600000) return null;
  return Math.round(bucket.percent * (WEEK_MS / elapsed));
}

function BigRing({ bucket, label, tone, projected }) {
  const pct = bucket?.unlimited ? 0 : Math.min(100, Math.round(bucket?.percent || 0));
  const r = 48;
  const c = 2 * Math.PI * r;
  return (
    <div className="usagecard">
      <div className="bigring">
        <svg width="112" height="112" viewBox="0 0 112 112">
          <circle cx="56" cy="56" r={r} fill="none" stroke="var(--surface-5)" strokeWidth="8" />
          <circle
            className="bigring__arc"
            cx="56" cy="56" r={r} fill="none" stroke={pct >= 80 ? 'var(--warn)' : tone} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 56 56)"
          />
        </svg>
        <span className="bigring__value">{bucket?.unlimited ? '∞' : `${pct}%`}</span>
      </div>
      <div className="usagecard__text">
        <span className="usagecard__label">{label}</span>
        <span className="usagecard__sub">{bucket?.unlimited ? 'Sin límite en tu plan' : fmtReset(bucket?.reset_at)}</span>
        {projected != null && (
          <span className={`usagecard__proj ${projected >= 100 ? 'is-warn' : ''}`}>
            {projected >= 100 ? 'Al ritmo actual lo agotarás antes del reinicio' : `Al ritmo actual llegarás al ${projected}%`}
          </span>
        )}
        {bucket && <span className="mono usagecard__meta">{bucket.messages} mensajes</span>}
      </div>
    </div>
  );
}

export function UsagePage() {
  const { serverUrl, user } = useAppStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(14);

  useEffect(() => {
    api.get('/api/account/usage').then(setData).catch((e) => setError(String(e.message || e)));
  }, []);

  const { days, models, max } = useMemo(() => {
    const byDay = new Map();
    const byModel = new Map();
    for (const row of data?.daily || []) {
      const day = String(row.usage_date).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + (row.total_tokens || 0));
      byModel.set(row.model, (byModel.get(row.model) || 0) + (row.total_tokens || 0));
    }
    const list = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      list.push({ key, label: i === 0 ? 'Hoy' : d.toLocaleDateString('es', { weekday: 'short' }).replace('.', ''), value: byDay.get(key) || 0, today: i === 0 });
    }
    const total = [...byModel.values()].reduce((a, b) => a + b, 0) || 1;
    return {
      days: list,
      max: Math.max(1, ...list.map((d) => d.value)),
      models: [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([model, v]) => ({ model, v, pct: Math.round((v / total) * 100) })),
    };
  }, [data, range]);

  return (
    <div className="spage">
      <div className="spage__head rise">
        <div className="spage__title">
          <span className="spage__h1">Uso y límites</span>
          <span className="spage__sub">El mismo cupo en web, escritorio, CLI y móvil.</span>
        </div>
        <span className="plantag">{data?.plan?.name || user?.plan_name || 'Gratuito'}</span>
        <button className="btn btn--primary" onClick={() => openExternal(`${serverUrl}/plans`)}>Mejorar plan</button>
      </div>

      {error && <p className="spage__error">{error}</p>}

      <div className="usagegrid rise rise--1">
        <BigRing bucket={data?.buckets?.session} label="Sesión" tone="var(--accent)" />
        <BigRing bucket={data?.buckets?.week} label="Semana" tone="var(--ink-body)" projected={projection(data?.buckets?.week)} />
      </div>

      <section className="ssec ssec--card rise rise--2">
        <div className="ssec__row">
          <span className="ssec__label ssec__label--strong">Tokens por día</span>
          <div className="panelhead__fill" />
          <div className="seg seg--sm">
            <span className="seg__thumb" style={{ width: 56, transform: `translateX(${range === 7 ? 0 : range === 14 ? 56 : 112}px)` }} />
            {[7, 14, 30].map((r) => (
              <button key={r} className={`seg__opt ${range === r ? 'is-active' : ''}`} style={{ width: 56 }} onClick={() => setRange(r)}>{r} d</button>
            ))}
          </div>
        </div>
        <div className="bars" style={{ '--n': days.length }}>
          {days.map((d, i) => (
            <div key={d.key} className="bars__col">
              <span className="bars__tip mono">{fmtTokens(d.value)} tokens</span>
              <div className={`bars__bar ${d.today ? 'is-today' : ''}`} style={{ height: `${Math.max(2, (d.value / max) * 100)}%`, animationDelay: `${i * 25}ms` }} />
              <span className={`bars__label ${d.today ? 'is-today' : ''}`}>{range === 30 && i % 3 && !d.today ? '' : d.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ssec ssec--card rise rise--3">
        <span className="ssec__label ssec__label--strong">Por modelo · últimos 30 días</span>
        {models.length === 0 && <span className="mcpd__muted">{data ? 'Sin consumo registrado todavía.' : 'Cargando…'}</span>}
        {models.map((m) => (
          <div key={m.model} className="meter">
            <div className="meter__row"><span className="mono">{m.model}</span><span className="mono meter__val">{fmtTokens(m.v)} · {m.pct}%</span></div>
            <div className="meter__track"><div className="meter__fill" style={{ width: `${m.pct}%` }} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}
