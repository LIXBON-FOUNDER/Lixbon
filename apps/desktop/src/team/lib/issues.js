// issues.js — lo que saben todas las pantallas de issues: prioridades, tipos de
// estado, fechas y cuentas del ciclo. Sin React: se prueba y se reusa solo.

export const PRIORIDADES = [
  { valor: 4, nombre: 'Urgente', rombos: 3, color: 'var(--danger)' },
  { valor: 3, nombre: 'Alta', rombos: 3, color: 'var(--ink-body)' },
  { valor: 2, nombre: 'Media', rombos: 2, color: 'var(--ink-body)' },
  { valor: 1, nombre: 'Baja', rombos: 1, color: 'var(--ink-body)' },
  { valor: 0, nombre: 'Sin prioridad', rombos: 0, color: 'var(--ink-35)' },
];
export const prioridadDe = (valor) => PRIORIDADES.find((p) => p.valor === valor) || PRIORIDADES[4];

export const TIPOS = {
  backlog: { nombre: 'Sin empezar', abierto: true },
  pendiente: { nombre: 'Sin empezar', abierto: true },
  en_curso: { nombre: 'Empezado', abierto: true },
  revision: { nombre: 'Empezado', abierto: true },
  hecho: { nombre: 'Cerrado', abierto: false },
  cancelado: { nombre: 'Cerrado', abierto: false },
};
export const GRUPOS_ESTADO = [
  { nombre: 'Sin empezar', tipos: ['backlog', 'pendiente'] },
  { nombre: 'Empezado', tipos: ['en_curso', 'revision'] },
  { nombre: 'Cerrado', tipos: ['hecho', 'cancelado'] },
];
export const esCerrado = (estado) => estado?.tipo === 'hecho' || estado?.tipo === 'cancelado';

export const ROLES_AGENTE = {
  explorador: { nombre: 'Explorador', modelo: 'Haiku' },
  implementador: { nombre: 'Implementador', modelo: 'Sonnet' },
  revisor: { nombre: 'Revisor', modelo: 'Opus' },
  escalado: { nombre: 'Escalado', modelo: 'Opus' },
};

export const ESCALAS = {
  ninguna: [],
  fib: [1, 2, 3, 5, 8],
  tallas: [1, 3, 5],
};
export const nombreEstimacion = (escala, n) => {
  if (n == null) return '';
  if (escala === 'tallas') return { 1: 'S', 3: 'M', 5: 'L' }[n] || `${n}`;
  return n === 1 ? '1 pt' : `${n} pts`;
};

export const COLORES = ['#C6D66E', '#8EC5FF', '#E8C872', '#C3B4FF', '#86D694', '#F08C7C', '#B5B5AF', '#85857F'];

export const ESTADOS_INICIATIVA = {
  planificado: { nombre: 'Planificado', color: 'var(--ink-soft)' },
  en_camino: { nombre: 'En camino', color: 'var(--good)' },
  en_riesgo: { nombre: 'En riesgo', color: 'var(--warn)' },
  hecho: { nombre: 'Hecho', color: 'var(--accent)' },
};

// ── Fechas ────────────────────────────────────────────────────────────────

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const diaDe = (iso) => {
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(a, m - 1, d);
};
export const isoDe = (fecha) =>
  `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
export const sumarDias = (iso, n) => {
  const d = diaDe(iso);
  d.setDate(d.getDate() + n);
  return isoDe(d);
};
export const diasEntre = (a, b) => Math.round((diaDe(b) - diaDe(a)) / 86400000);
export const fechaCorta = (iso) => {
  if (!iso) return '';
  const d = diaDe(iso);
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
};

/** «Hoy», «Mañana», «3 días tarde» o «14 oct», con su tono. */
export function vencimiento(iso, cerrada = false) {
  if (!iso) return null;
  if (cerrada) return { texto: fechaCorta(iso), tono: 'normal' };
  const n = diasEntre(hoyISO(), iso);
  if (n < 0) return { texto: n === -1 ? '1 día tarde' : `${-n} días tarde`, tono: 'tarde' };
  if (n === 0) return { texto: 'Hoy', tono: 'pronto' };
  if (n === 1) return { texto: 'Mañana', tono: 'pronto' };
  return { texto: fechaCorta(iso), tono: 'normal' };
}

export function haceRato(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d} días`;
  return fechaCorta(iso.slice(0, 10));
}

// ── Ciclos ────────────────────────────────────────────────────────────────

export const cicloDeHoy = (ciclos = []) => {
  const hoy = hoyISO();
  return ciclos.find((c) => c.empieza <= hoy && hoy <= c.termina) || null;
};

/** Avance de un conjunto de issues: por estado y por puntos. */
export function avance(issues, estadosPorId) {
  const cuenta = { total: issues.length, cerradas: 0, porTipo: {}, puntos: 0, puntosHechos: 0 };
  for (const i of issues) {
    const e = estadosPorId[i.estado_id];
    const tipo = e?.tipo || 'pendiente';
    cuenta.porTipo[tipo] = (cuenta.porTipo[tipo] || 0) + 1;
    const cerrada = tipo === 'hecho' || tipo === 'cancelado';
    if (cerrada) cuenta.cerradas += 1;
    cuenta.puntos += i.estimacion || 0;
    if (tipo === 'hecho') cuenta.puntosHechos += i.estimacion || 0;
  }
  cuenta.pct = cuenta.total ? Math.round((cuenta.cerradas / cuenta.total) * 100) : 0;
  return cuenta;
}

/** Serie diaria de alcance y cerradas de un ciclo, hasta hoy. Se reconstruye
 *  con las fechas de creación y cierre: una aproximación honesta sin
 *  guardar instantáneas. */
export function serieDelCiclo(ciclo, issues) {
  if (!ciclo) return [];
  const dias = diasEntre(ciclo.empieza, ciclo.termina) + 1;
  const hoy = hoyISO();
  const serie = [];
  for (let n = 0; n < dias; n += 1) {
    const dia = sumarDias(ciclo.empieza, n);
    if (dia > hoy) break;
    const fin = `${dia}T23:59:59`;
    const alcance = issues.filter((i) => i.creado_en.slice(0, 10) <= dia || i.creado_en.slice(0, 10) < ciclo.empieza).length;
    const cerradas = issues.filter((i) => i.cerrado_en && i.cerrado_en <= fin).length;
    serie.push({ dia, alcance, cerradas });
  }
  return serie;
}

// ── Orden ─────────────────────────────────────────────────────────────────

/** El `orden` que deja una tarjeta entre dos vecinas (índice fraccional). */
export function ordenEntre(antes, despues) {
  if (antes == null && despues == null) return 0;
  if (antes == null) return despues - 1;
  if (despues == null) return antes + 1;
  return (antes + despues) / 2;
}

export const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export const CLAVE_ISSUE = /\b([A-Z][A-Z0-9]{0,4})-(\d+)\b/g;
