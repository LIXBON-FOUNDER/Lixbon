import { useEffect, useId, useState } from 'react';
import {
  describeProvider, filterOptions, filterReport, formatCost, formatTokens, percentOf, resetText, supportList, windowLabel,
} from './usageModel';
import { useUsageReport } from './useUsageReport';
import './UsageView.css';

/**
 * LXO-206 · Uso de los proveedores (SOLO LECTURA): la cuota de la CUENTA de cada proveedor, tal como el Core la normaliza. No es por
 * modelo (la cuota es de la cuenta), no hay totales (sumar porcentajes de un proveedor con tokens de otro no significa nada) y la
 * interfaz no llama a ningún proveedor: lee `usage_report` del Core, que consulta en segundo plano.
 *
 * Lo que el proveedor no da se dice «sin dato»: nunca se pinta como 0. La frescura va siempre visible. Un fallo de uso no pinta al
 * proveedor ni a ningún Attempt como fallido: es una nota sobre el uso.
 */
function Window({ w, now }) {
  const pct = percentOf(w);
  const reset = resetText(w, now);
  const label = windowLabel(w);
  return (
    <li className="usage-window" data-window={w.id} data-known={pct.known ? 'true' : 'false'}>
      <div className="usage-window__head">
        <span className="usage-window__name">{label}</span>
        <span className="usage-window__pct">{pct.label}{pct.high && <strong className="usage-high"> · casi agotada</strong>}</span>
      </div>
      {pct.known ? (
        <div className="usage-bar" role="progressbar" aria-label={`${label}: ${pct.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct.value)}>
          <div className={`usage-bar__fill${pct.high ? ' usage-bar__fill--high' : ''}`} style={{ width: `${pct.value}%` }} />
        </div>
      ) : (
        <div className="usage-bar usage-bar--unknown" aria-hidden="true" />
      )}
      <span className="usage-window__reset">{reset.iso ? <time dateTime={reset.iso} title={reset.iso}>{reset.text}</time> : reset.text}</span>
    </li>
  );
}

function Models({ models }) {
  return (
    <table className="usage-models" data-testid="usage-models">
      <caption className="usage-sr">Uso por modelo</caption>
      <thead>
        <tr><th scope="col">Modelo</th><th scope="col">Entrada</th><th scope="col">Salida</th><th scope="col">Caché leída</th><th scope="col">Caché creada</th><th scope="col">Coste</th></tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model} data-model={m.model}>
            <th scope="row" className="mono">{m.model}</th>
            <td>{formatTokens(m.input_tokens)}</td>
            <td>{formatTokens(m.output_tokens)}</td>
            <td>{formatTokens(m.cache_read_tokens)}</td>
            <td>{formatTokens(m.cache_creation_tokens)}</td>
            <td>{formatCost(m.cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Card({ p, now }) {
  const d = describeProvider(p, now);
  const snap = p.snapshot ?? null;
  const windows = snap?.windows ?? [];
  const models = snap?.models ?? [];
  return (
    <li className={`usage-card usage-card--${d.tone}`} data-testid={`usage-card-${p.provider}`} data-status={p.status} data-provider={p.provider}>
      <div className="usage-card__head">
        <h4 className="usage-card__name mono">{p.provider}</h4>
        <span className={`usage-badge usage-badge--${d.tone}`} title={d.help}><span aria-hidden="true">{d.glyph}</span> {d.label}</span>
        {snap?.limit_reached === true && <span className="usage-badge usage-badge--warn" data-testid={`usage-limit-${p.provider}`}><span aria-hidden="true">!</span> Límite alcanzado</span>}
      </div>
      {d.headline && <p className="usage-note" data-testid={`usage-headline-${p.provider}`}>{d.headline}</p>}
      {d.throttled && <p className="usage-note usage-note--info" data-testid={`usage-throttled-${p.provider}`}>Se consultó hace muy poco: se muestra el dato guardado.</p>}
      {d.freshness && (
        <p className="usage-fresh" data-testid={`usage-fresh-${p.provider}`}>
          Observado <time dateTime={d.freshness.iso} title={d.freshness.iso}>{d.freshness.age}</time> · {d.freshness.source}
          {snap.account && <> · cuenta <code className="mono" title="Huella de la cuenta: no es su identificador">{snap.account}</code></>}
          {snap.plan && <> · plan {snap.plan}</>}
        </p>
      )}
      {windows.length > 0 && <ul className="usage-windows" aria-label={`Cuota de ${p.provider}`}>{windows.map((w) => <Window key={w.id} w={w} now={now} />)}</ul>}
      {snap?.credits && (
        <p className="usage-credits" data-testid={`usage-credits-${p.provider}`}>
          Créditos: {snap.credits.unlimited === true ? 'ilimitados' : snap.credits.has_credits === false ? 'sin créditos' : snap.credits.has_credits === true ? 'con créditos' : 'sin dato'}
          {typeof snap.credits.balance === 'string' && <> · saldo <strong>{snap.credits.balance}</strong> <span className="usage-sub">(en la unidad del proveedor, no son dólares)</span></>}
        </p>
      )}
      {models.length > 0 && <Models models={models} />}
      <details className="usage-support">
        <summary>Qué informa este proveedor</summary>
        <ul className="usage-list" data-testid={`usage-support-${p.provider}`}>
          {supportList(p).map((f) => <li key={f.field} data-field={f.field} data-state={f.state}>{f.label}: {f.word}</li>)}
        </ul>
      </details>
    </li>
  );
}

function Filter({ label, value, options, onChange, testId }) {
  const id = useId();
  return (
    <label className="usage-filter" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <option value="">Todos</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** `now` solo lo fija una prueba; en la app corre el reloj (se repinta cada 20 s para que «hace 2 min» no se quede congelado). */
export function UsageView({ active = true, now: fixedNow = null }) {
  const uid = useId();
  const { report, loading, refreshing, status, unsupported, refresh, manual, retry } = useUsageReport({ enabled: active });
  const [clock, setClock] = useState(() => Date.now());
  const [filters, setFilters] = useState({ provider: '', account: '', model: '' });
  useEffect(() => {
    if (fixedNow !== null || !active) return undefined;
    const t = setInterval(() => setClock(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [fixedNow, active]);
  const now = fixedNow ?? clock;
  const headingId = `${uid}-h`;

  let body;
  if (unsupported) {
    body = <p className="usage-note" role="status" data-testid="usage-unsupported">Este Core no informa del uso de los proveedores.</p>;
  } else if (!report) {
    body = status === 'error'
      ? <p className="usage-note usage-note--warn" role="alert" data-testid="usage-error">No se pudo leer el uso. <button type="button" className="lk" onClick={retry}>Reintentar</button></p>
      : <p className="usage-note" role="status" data-testid="usage-loading">{loading ? 'El Core está consultando el uso de los proveedores…' : 'Leyendo el uso…'}</p>;
  } else if (report.providers.length === 0) {
    body = <p className="usage-note" role="status" data-testid="usage-empty">El Core no tiene proveedores registrados.</p>;
  } else {
    const options = filterOptions(report);
    const shown = filterReport(report, filters);
    body = (
      <>
        {status === 'stale' && <p className="usage-note usage-note--warn" role="status" data-testid="usage-core-stale">El Core no respondió: se muestra el último informe conocido.</p>}
        {(options.providers.length > 1 || options.accounts.length > 1 || options.models.length > 1) && (
          <div className="usage-filters" data-testid="usage-filters">
            {options.providers.length > 1 && <Filter label="Proveedor" value={filters.provider} options={options.providers} onChange={(provider) => setFilters((f) => ({ ...f, provider }))} testId="usage-filter-provider" />}
            {options.accounts.length > 1 && <Filter label="Cuenta" value={filters.account} options={options.accounts} onChange={(account) => setFilters((f) => ({ ...f, account }))} testId="usage-filter-account" />}
            {options.models.length > 1 && <Filter label="Modelo" value={filters.model} options={options.models} onChange={(model) => setFilters((f) => ({ ...f, model }))} testId="usage-filter-model" />}
          </div>
        )}
        {shown.providers.length === 0
          ? <p className="usage-note" role="status" data-testid="usage-no-match">Ningún proveedor coincide con el filtro.</p>
          : <ul className="usage-cards" aria-label="Uso por proveedor">{shown.providers.map((p) => <Card key={p.provider} p={p} now={now} />)}</ul>}
        <p className="usage-note">La cuota es de la cuenta de cada proveedor, no de un modelo. Los porcentajes y los tokens de proveedores distintos no se suman ni se comparan.</p>
      </>
    );
  }
  return (
    <section className="usage" aria-labelledby={headingId} data-testid="usage-view">
      <div className="usage__bar">
        <h3 className="usage__h" id={headingId}>Uso de los proveedores</h3>
        <button type="button" className="lk usage__refresh" onClick={refresh} disabled={manual === 'pending' || refreshing || unsupported} data-testid="usage-refresh">
          {refreshing || manual === 'pending' ? 'Consultando…' : 'Actualizar'}
        </button>
      </div>
      {manual === 'error' && <p className="usage-note usage-note--warn" role="alert" data-testid="usage-refresh-error">No se pudo pedir la actualización.</p>}
      <div aria-live="polite">{body}</div>
    </section>
  );
}
