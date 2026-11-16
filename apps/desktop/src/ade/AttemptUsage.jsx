import { formatUtc } from './attemptFormat';
import { formatCost, formatTokens, percentOf, windowLabel } from './usageModel';

/**
 * LXO-249 · Lo que el proveedor DECLARÓ de su uso en un Attempt (`attempt_detail.usage`), solo lectura.
 * `null` = el proveedor no declaró nada: se dice, no se pinta ningún cero. Un campo que ningún turno declaró
 * sale «sin dato». `limits` es la cuota de la CUENTA (una foto del último turno que la declaró), no lo que
 * gastó este Attempt: por eso va aparte y con su propio aviso, y la hora de reinicio es absoluta (la foto es vieja).
 */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SOURCE = { provider_declared: 'declarado por el proveedor' };

function Row({ label, children }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

function Quota({ limits }) {
  if (!Array.isArray(limits) || !limits.length) return null;
  const windows = limits.filter(isRecord);
  if (!windows.length) return null;
  return (
    <div data-testid="attempt-usage-limits">
      <p className="ade-missing">Cuota de la cuenta tal como la declaró el proveedor en el último turno que la informó. No es lo que gastó este intento.</p>
      <ul>
        {windows.map((w, i) => {
          const percent = percentOf(w);
          const reset = Number.isSafeInteger(w.resets_at) ? formatUtc(w.resets_at * 1000) : null;
          return (
            <li key={`${w.id}-${i}`}>
              {windowLabel(w)}: {percent.label}{percent.high ? ' · casi agotada' : ''}
              {' · '}{reset ? <>reinicia <time dateTime={reset.iso}>{reset.label}</time></> : 'hora de reinicio desconocida'}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AttemptUsage({ usage }) {
  if (usage === null || usage === undefined) {
    return <p className="ade-missing" data-testid="attempt-usage-none">El proveedor no declaró consumo en este intento.</p>;
  }
  if (!isRecord(usage)) return <p className="ade-missing" data-testid="attempt-usage-none">no disponible</p>;
  const turns = Number.isSafeInteger(usage.turns) && usage.turns > 0 ? usage.turns : null;
  return (
    <>
      <dl data-testid="attempt-usage">
        <Row label="Origen">
          {SOURCE[usage.source] ?? 'origen desconocido'}
          {typeof usage.provider === 'string' && usage.provider ? ` · ${usage.provider}` : ''}
          {turns ? ` · ${turns} ${turns === 1 ? 'turno' : 'turnos'}` : ''}
        </Row>
        <Row label="Tokens de entrada">{formatTokens(usage.input_tokens)}</Row>
        <Row label="Tokens de salida">{formatTokens(usage.output_tokens)}</Row>
        <Row label="Caché leída">{formatTokens(usage.cache_read_tokens)}</Row>
        <Row label="Caché creada">{formatTokens(usage.cache_creation_tokens)}</Row>
        <Row label="Coste">{formatCost(usage.cost_usd)}</Row>
      </dl>
      <Quota limits={usage.limits} />
    </>
  );
}
