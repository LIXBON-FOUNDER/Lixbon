// pulseModel.js — Workspace Pulse (LXO-218): el resumen compacto de salud de una fila del navegador.
//
// Pulse RESUME; el estado sigue siendo la señal primaria y la Attention conserva su marcador propio: ninguno de los dos
// entra aquí. Solo cabe lo que tiene dato:
//   · duración, archivos, pruebas, proveedor, origen y host;
//   · archivos y pruebas llevan su procedencia (`verified` | `agent_reported` | `unknown`) y NUNCA un dato sin respaldo:
//     lo desconocido se pinta «—», jamás 0 ni 100 %;
//   · no hay porcentajes ni «progreso»;
//   · un máximo de MAX_SEGMENTS señales por fila, elegidas por prioridad.
// Función pura: sin store, sin reloj, sin Core. El mismo Intento da siempre el mismo Pulse.
import { providerName } from '../../orch/agent/agentIdentity';
import { PROVENANCE_VIEW } from '../ProvenanceMark';
import { hostOf, isRemote, ORIGIN_LABEL } from './previewVocab';

/** Las cinco variantes del Pulse. No son estados nuevos: agrupan los estados del Intento solo para decidir qué señales caben. */
export const PULSE_VARIANTS = Object.freeze(['working', 'waiting', 'review', 'failed', 'final']);

const VARIANT_OF = Object.freeze({
  starting: 'working',
  working: 'working',
  queued: 'waiting',
  waiting: 'waiting',
  paused: 'waiting',
  offline: 'waiting',
  review_ready: 'review',
  failed: 'failed',
  completed: 'final',
});

export const MAX_SEGMENTS = 4;

/**
 * Caracteres que caben en la segunda línea de una fila del navegador (280 px, 11,5 px de letra), ESTADO incluido. Salió de medir la vista
 * previa en un Workspace denso: con todas las señales el 89 % de las filas recortaba y se perdían justo las pruebas (docs/ux/WORKSPACE_PULSE.md).
 * Pulse reparte lo que queda tras el estado por prioridad y lo que no cabe va al tooltip y al lector, no se recorta a medias.
 */
export const LINE_BUDGET = 36;
const SEPARATOR_COST = 3; // « · »

// Orden de aparición en la fila (el de la referencia North Star).
const ORDER = ['duration', 'files', 'tests', 'provider', 'origin', 'host'];
// Prioridad por variante cuando no caben todas (el primero se queda): cada variante responde a una pregunta distinta.
//   working → ¿cuánto lleva?   waiting → ¿cuánto lleva esperando?   review/final → ¿está comprobado?   failed → ¿qué se rompió?
const PRIORITY = Object.freeze({
  working: ['host', 'duration', 'tests', 'files', 'provider', 'origin'],
  waiting: ['host', 'duration', 'files', 'tests', 'provider', 'origin'],
  review: ['host', 'tests', 'files', 'duration', 'provider', 'origin'],
  failed: ['host', 'tests', 'duration', 'files', 'provider', 'origin'],
  final: ['host', 'tests', 'files', 'duration', 'provider', 'origin'],
});

// Sin trabajo en curso todavía no hay archivos ni pruebas que resumir (no es «0»: es que no toca).
const NO_WORK_YET = new Set(['starting', 'queued']);
// Un dato desconocido solo se enseña donde la pregunta «¿se comprobó?» importa; en curso se omite para no llenar de guiones.
const SHOWS_UNKNOWN = new Set(['review', 'failed', 'final']);

const KNOWN = new Set(['verified', 'agent_reported']);
const evidenceOf = (a, key) => (KNOWN.has(a.evidence?.[key]) ? a.evidence[key] : 'unknown');
const withProvenance = (what, evidence) => `${what}. ${PROVENANCE_VIEW[evidence].label}`;

/** «18 min», «1 h 12 min», «2 d 3 h». Sin dato o 0 → `null` (no se escribe «0 min»). */
export function durationText(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const total = Math.round(minutes);
  if (total < 1) return null;
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const hh = hours % 24;
  return hh ? `${days} d ${hh} h` : `${days} d`;
}

function durationLabel(variant, text) {
  if (variant === 'working') return `Lleva ${text}`;
  if (variant === 'waiting') return `${text} desde que empezó`;
  return `Duró ${text}`;
}

function validTests(tests) {
  return tests && Number.isInteger(tests.pass) && Number.isInteger(tests.total) && tests.total > 0 && tests.pass >= 0 && tests.pass <= tests.total;
}

function filesSegment(a, variant) {
  if (!a.worktree) return null; // Intento de solo lectura o sin worktree: no hay archivos que contar
  const evidence = evidenceOf(a, 'files');
  if (evidence === 'unknown' || !Number.isInteger(a.files) || a.files < 0) {
    if (!SHOWS_UNKNOWN.has(variant)) return null;
    return { key: 'files', text: 'archivos —', label: withProvenance('Archivos cambiados: sin dato', 'unknown'), evidence: 'unknown' };
  }
  if (a.files === 0) return null; // nada cambió: es el valor por defecto, no una señal
  const text = `${a.files} ${a.files === 1 ? 'archivo' : 'archivos'}`;
  return { key: 'files', text, label: withProvenance(`Archivos cambiados: ${a.files}`, evidence), evidence };
}

function testsSegment(a, variant) {
  const evidence = evidenceOf(a, 'tests');
  if (evidence === 'unknown' || !validTests(a.tests)) {
    if (!SHOWS_UNKNOWN.has(variant)) return null;
    return { key: 'tests', text: 'tests —', label: withProvenance('Pruebas: sin dato', 'unknown'), evidence: 'unknown' };
  }
  const { pass, total } = a.tests;
  const failing = total - pass;
  const what = failing > 0 ? `Pruebas: ${pass} de ${total} pasan, ${failing} fallan` : `Pruebas: ${pass} de ${total} pasan`;
  return { key: 'tests', text: `tests ${pass}/${total}`, label: withProvenance(what, evidence), evidence, alert: failing > 0 };
}

/**
 * Pulse de un Intento. `single`: la fila representa a la Task entera (un solo Intento), así que el proveedor no está ya en el título.
 * `budget`: caracteres libres en la línea tras el estado (ver LINE_BUDGET). Sin él solo manda el tope MAX_SEGMENTS.
 * Se añade por prioridad y se PARA en la primera señal que no cabe: nunca una señal menor salta a una mayor que se quedó fuera.
 * @returns {{variant: string|null, segments: Segment[], hidden: Segment[], label: string}}
 *   `segments` lo que se pinta (en el orden de la fila); `hidden` lo que tiene dato y no cabe; `label` ambos, para tooltip y lector.
 */
export function pulseOf(a, { single = true, budget = Infinity } = {}) {
  const variant = VARIANT_OF[a?.state] ?? null;
  if (!variant) return { variant: null, segments: [], hidden: [], label: '' };
  const all = [];

  const duration = durationText(a.minutes);
  if (duration) all.push({ key: 'duration', text: duration, label: durationLabel(variant, duration), evidence: null });

  if (!NO_WORK_YET.has(a.state)) {
    const files = filesSegment(a, variant);
    if (files) all.push(files);
    const tests = testsSegment(a, variant);
    if (tests) all.push(tests);
  }

  if (single) all.push({ key: 'provider', text: providerName(a.provider), label: `Proveedor ${providerName(a.provider)}`, evidence: null });
  if (a.origin && a.origin !== 'ADE') {
    const text = ORIGIN_LABEL[a.origin] || a.origin;
    all.push({ key: 'origin', text, label: `Empezó desde ${text}`, evidence: null });
  }
  if (isRemote(a) || a.state === 'offline') {
    const name = hostOf(a.host).name;
    all.push({ key: 'host', text: name, label: a.state === 'offline' ? `${name} está desconectado` : `Corre en ${name}`, evidence: null });
  }

  const rank = PRIORITY[variant];
  const byPriority = [...all].sort((x, y) => rank.indexOf(x.key) - rank.indexOf(y.key));
  const kept = new Set();
  let used = 0;
  for (const s of byPriority) {
    const cost = s.text.length + SEPARATOR_COST;
    if (kept.size >= MAX_SEGMENTS || used + cost > budget) break;
    kept.add(s.key);
    used += cost;
  }
  const inRowOrder = (x, y) => ORDER.indexOf(x.key) - ORDER.indexOf(y.key);
  const segments = all.filter((s) => kept.has(s.key)).sort(inRowOrder);
  const hidden = all.filter((s) => !kept.has(s.key)).sort(inRowOrder);
  return { variant, segments, hidden, label: [...segments, ...hidden].map((s) => s.label).join('. ') };
}

/** @typedef {{key: string, text: string, label: string, evidence: string|null, alert?: boolean}} Segment */
