const LIMIT_RE = /^Current ([^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?$/i;
const PERIOD_RE = /^Last (\S+)\s*·\s*(.+)$/i;

const LIMIT_LABELS = {
  session: 'Sesión actual',
  'week (all models)': 'Semana · todos los modelos',
};

const limitLabel = (raw) => {
  const key = raw.trim().toLowerCase();
  if (LIMIT_LABELS[key]) return LIMIT_LABELS[key];
  const only = key.match(/^week \((.+) only\)$/);
  return only ? `Semana · solo ${only[1].replace(/^\w/, (c) => c.toUpperCase())}` : raw.trim();
};

const periodLabel = (raw) => ({ '24h': 'Últimas 24 h', '7d': 'Últimos 7 días' }[raw.toLowerCase()] || `Últimos ${raw}`);

const periodStats = (raw) => raw
  .replace(/(\d[\d,.]*)\s+requests?/i, '$1 peticiones')
  .replace(/(\d[\d,.]*)\s+sessions?/i, '$1 sesiones');

/** Convierte la salida de texto de `/usage` en datos; null si no lo es. */
export function parseUsageText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const limits = [];
  const periods = [];
  let intro = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const lim = line.match(LIMIT_RE);
    if (lim) {
      limits.push({ key: lim[1].trim().toLowerCase(), label: limitLabel(lim[1]), percent: Number(lim[2]), resets: lim[3]?.trim() || '' });
      continue;
    }
    const per = line.match(PERIOD_RE);
    if (per) {
      periods.push({ label: periodLabel(per[1]), stats: periodStats(per[2]), items: [] });
      continue;
    }
    if (periods.length && /^\s/.test(raw)) periods[periods.length - 1].items.push(line);
    else if (!limits.length && !intro) intro = line;
  }
  return limits.length ? { intro, limits, periods } : null;
}

/** Ventana vigente: si ya pasó su reinicio, el cupo guardado está vencido. */
export function liveWindow(w, now = Date.now()) {
  if (!w) return null;
  if (w.resetAt && w.resetAt * 1000 <= now) return { percent: 0, resetAt: null, expired: true };
  return w;
}
