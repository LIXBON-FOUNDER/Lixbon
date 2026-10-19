// honeycomb.js — el panal de uso: cada hexágono son 200 mil tokens que un
// servicio (CLI, IDE, móvil, web) gastó un día, con el número del día dentro.
// El último de cada día va a medio llenar. Las celdas salen en espiral desde
// el centro, servicio a servicio (el CLI en el centro), así que el panal crece
// hacia fuera con el uso. La web tiene una copia en src/lib/honeycomb.js.

export const HEX_TOKENS = 200000;
export const SERVICES = ['cli', 'ide', 'mobile', 'web', 'other'];
export const SERVICE_LABEL = { cli: 'CLI', ide: 'IDE', mobile: 'Móvil', web: 'Web', other: 'Otros' };
// Con más celdas el panal deja de leerse; las que sobran se cuentan aparte.
export const MAX_CELLS = 1500;

const pad = (n) => String(n).padStart(2, '0');
const utcDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Celdas y totales de los últimos `days` días a partir de las filas
    {date, service, tokens} de /api/account/usage. */
export function serviceCells(rows, days, now = new Date()) {
  const since = utcDay(new Date(now.getTime() - (days - 1) * 86400000));
  const totals = Object.fromEntries(SERVICES.map((s) => [s, 0]));
  const byService = Object.fromEntries(SERVICES.map((s) => [s, []]));
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.date !== 'string' || r.date < since || typeof r.tokens !== 'number' || r.tokens <= 0) continue;
    const service = SERVICES.includes(r.service) ? r.service : 'other';
    totals[service] += r.tokens;
    byService[service].push(r);
  }
  const cells = [];
  for (const service of SERVICES) {
    for (const r of byService[service].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const day = String(parseInt(r.date.slice(8, 10), 10));
      for (let left = r.tokens; left > 0; left -= HEX_TOKENS) {
        cells.push({ service, date: r.date, day, fill: Math.min(1, left / HEX_TOKENS), tokens: Math.min(left, HEX_TOKENS) });
      }
    }
  }
  const total = SERVICES.reduce((a, s) => a + totals[s], 0);
  return { cells: cells.slice(0, MAX_CELLS), hidden: Math.max(0, cells.length - MAX_CELLS), totals, total, count: cells.length };
}

/** Coordenadas axiales en espiral: el centro y luego anillo a anillo. */
export function spiral(n) {
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const pts = n > 0 ? [[0, 0]] : [];
  for (let k = 1; pts.length < n; k++) {
    let q = dirs[4][0] * k;
    let r = dirs[4][1] * k;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < k; j++) {
        pts.push([q, r]);
        q += dirs[i][0];
        r += dirs[i][1];
      }
    }
  }
  return pts.slice(0, n);
}

/** Anillos que hacen falta para n celdas (1, 7, 19, 37…). */
export function ringsFor(n) {
  let k = 0;
  while (1 + 3 * k * (k + 1) < n) k++;
  return k;
}

/** Tamaño (radio) de la celda para que el panal quepa en `width`. */
export function cellSize(n, width, max = 16) {
  const across = 2 * ringsFor(n) + 1;
  return Math.max(3, Math.min(max, width / (across * Math.sqrt(3))));
}

function hexPoints(cx, cy, s) {
  const w = (Math.sqrt(3) * s) / 2;
  return [[cx, cy - s], [cx + w, cy - s / 2], [cx + w, cy + s / 2], [cx, cy + s], [cx - w, cy + s / 2], [cx - w, cy - s / 2]];
}

// Recorta un polígono convexo a lo que queda por debajo de y (relleno parcial
// desde abajo).
function clipBelow(points, y) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const aIn = a[1] >= y;
    const bIn = b[1] >= y;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (y - a[1]) / (b[1] - a[1]);
      out.push([a[0] + t * (b[0] - a[0]), y]);
    }
  }
  return out;
}

const toAttr = (pts) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** Posición de cada celda: polígono, relleno parcial y centro para el número. */
export function layout(cells, s, gap = 0.9) {
  const pts = spiral(cells.length);
  const w = Math.sqrt(3) * s;
  const xy = pts.map(([q, r]) => [w * (q + r / 2), 1.5 * s * r]);
  if (xy.length === 0) return { width: 0, height: 0, hexes: [] };
  const minX = Math.min(...xy.map((p) => p[0])) - w / 2;
  const minY = Math.min(...xy.map((p) => p[1])) - s;
  const width = Math.max(...xy.map((p) => p[0])) + w / 2 - minX;
  const height = Math.max(...xy.map((p) => p[1])) + s - minY;
  const inner = s * gap;
  const hexes = cells.map((cell, i) => {
    const cx = xy[i][0] - minX;
    const cy = xy[i][1] - minY;
    const hex = hexPoints(cx, cy, inner);
    const full = cell.fill >= 0.999;
    return {
      key: `${cell.service}${cell.date}${i}`,
      cell,
      cx,
      cy,
      full,
      points: toAttr(hex),
      partial: full ? '' : toAttr(clipBelow(hex, cy + inner - 2 * inner * cell.fill)),
    };
  });
  return { width, height, hexes };
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} mil`;
  return String(n);
}
