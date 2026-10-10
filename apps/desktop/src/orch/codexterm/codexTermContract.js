// codexTermContract.js — contrato PROPUESTO con el host para la pestaña de terminal de
// Codex (la TUI de Codex en un PTY). DESKTOP lo implementa en otra rama; todos los
// nombres (snake_case) viven aquí para renombrarlos en un solo sitio.
// El mock de ./mockCodexTerm.js solo se carga si import.meta.env.DEV y VITE_ORCH_MOCK === '1'.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const CODEX_TERM_COMMANDS = Object.freeze({
  policy: 'codex_term_policy',   // { cwd, model?, effort? } → { policy, argv, warnings }; no lanza nada
  open: 'codex_term_open',       // { cwd, model?, effort?, cols?, rows?, acknowledged } → { term_id, policy, argv, warnings }
  write: 'codex_term_write',     // { term_id, data }
  resize: 'codex_term_resize',   // { term_id, cols, rows } (mínimo 200 columnas)
  close: 'codex_term_close',     // { term_id }
  buffer: 'codex_term_buffer',   // { term_id } → { data, seq, cols, rows, alt_screen }  (pantalla renderizada por vt100; data empieza con \x1b[0m; seq = el último incluido)
  redraw: 'codex_term_redraw',   // { term_id }  respaldo: el host vuelve a pintar la pantalla
  list: 'codex_term_list',       // () → [{ term_id, cwd, policy, exited, code }]  (rehacer pestañas al arrancar/recargar)
});

export const CODEX_TERM_EVENTS = Object.freeze({
  output: 'codex-term-output',   // { term_id, seq, data }  (seq creciente por terminal; confirmado por DESKTOP)
  exit: 'codex-term-exit',       // { term_id, code }
});

/** Marca del error de open cuando hay avisos y no se confirmó. */
export const NEEDS_ACK = 'needs_ack';
export const isNeedsAck = (e) => String(e?.message ?? e ?? '').includes(NEEDS_ACK);

// Formato de `data`: el mismo que el PTY de los agentes del orquestador. Hoy ese PTY
// emite texto (AgentTerminal hace term.write(e.payload) y orch_term_write recibe la
// cadena de onData), así que aquí es texto tal cual. Si el host pasa a base64, se
// cambia SOLO en estas dos funciones.
export const TERM_DATA_ENCODING = 'text';
export function decodeTermData(data) {
  return typeof data === 'string' ? data : '';
}
export function encodeTermData(text) {
  return String(text ?? '');
}

/** Quita opcionales vacíos: el host recibe Option<String>. */
const opt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export function policyArgs({ cwd, model, effort }) {
  const a = { cwd };
  if (opt(model)) a.model = opt(model);
  if (opt(effort)) a.effort = opt(effort);
  return a;
}

const useMock = () => import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1';
// Rama eliminada en el build de producción (DEV es la constante false).
const mock = async () => (await import('./mockCodexTerm.js')).mockCodexTerm;

async function call(cmd, args) {
  if (useMock()) return (await mock()).invoke(cmd, args);
  return invoke(cmd, args);
}
async function on(event, handler) {
  if (useMock()) return (await mock()).listen(event, handler);
  return listen(event, handler);
}

// ── Repintado y orden ──────────────────────────────────────────────────────────
/** Tope del búfer de respaldo por pestaña (si el host no da codex_term_buffer). */
export const FALLBACK_BUFFER_CAP = 1024 * 1024;

/** Prefijo tras recortar: reinicia atributos para no heredar colores a medias. */
export const TRUNCATE_RESET = '\x1b[0m';

/**
 * Añade al búfer y, si pasa de `cap`, recorta por delante: corta en el primer \n después del
 * límite (así no quedan secuencias ANSI ni UTF-16/UTF-8 partidas) y antepone \x1b[0m.
 * Si no hay ningún \n en la parte que queda, se conserva desde el límite sin partir un par
 * sustituto.
 */
export function appendCapped(buf, text, cap = FALLBACK_BUFFER_CAP) {
  const out = (buf || '') + (text || '');
  if (out.length <= cap) return out;
  const from = out.length - cap;
  const nl = out.indexOf('\n', from);
  if (nl >= 0) return TRUNCATE_RESET + out.slice(nl + 1);
  let i = from;
  const c = out.charCodeAt(i);
  if (c >= 0xdc00 && c <= 0xdfff) i += 1; // no empezar en la mitad baja de un par
  return TRUNCATE_RESET + out.slice(i);
}

/** Entrada de codex_term_list normalizada; null si no trae term_id. */
export function normalizeListItem(x) {
  if (!x || typeof x.term_id !== 'string' || !x.term_id) return null;
  return { term_id: x.term_id, cwd: typeof x.cwd === 'string' ? x.cwd : '', policy: x.policy ?? null, exited: x.exited === true, code: x.code ?? null };
}

/** seq válido (entero ≥ 0) o null si no viene. */
export const seqOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * ¿Se pinta un evento con `seq` si lo ya pintado llega hasta `floor`? Sin seq en el
 * evento o sin suelo conocido no se puede deduplicar: se acepta.
 */
export const acceptSeq = (seq, floor) => (seqOf(seq) === null || seqOf(floor) === null ? true : seq > floor);

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** Respuesta de codex_term_buffer → { data, seq, cols, rows, alt_screen } o null si no sirve. */
export function normalizeBuffer(res) {
  if (!res || typeof res !== 'object' || typeof res.data !== 'string') return null;
  return { data: decodeTermData(res.data), seq: seqOf(res.seq), cols: posInt(res.cols), rows: posInt(res.rows), alt_screen: res.alt_screen === true };
}

/** Adaptador: lo único que usa la UI. */
export const codexTerm = {
  policy: (a) => call(CODEX_TERM_COMMANDS.policy, policyArgs(a)),
  open: ({ cols, rows, acknowledged, ...a }) => call(CODEX_TERM_COMMANDS.open, { ...policyArgs(a), cols, rows, acknowledged: acknowledged === true }),
  write: (term_id, text) => call(CODEX_TERM_COMMANDS.write, { term_id, data: encodeTermData(text) }),
  resize: (term_id, cols, rows) => call(CODEX_TERM_COMMANDS.resize, { term_id, cols, rows }),
  close: (term_id) => call(CODEX_TERM_COMMANDS.close, { term_id }),
  /** Respaldo: pide al host que vuelva a pintar la pantalla (llega como salida normal). */
  redraw: (term_id) => call(CODEX_TERM_COMMANDS.redraw, { term_id }),
  /** Terminales que el host tiene abiertas (o ya terminadas); [] si falla. */
  list: async () => { try { const l = await call(CODEX_TERM_COMMANDS.list, {}); return (Array.isArray(l) ? l : []).map(normalizeListItem).filter(Boolean); } catch { return []; } },
  /** null si el host no lo tiene o falla: entonces se repinta con el búfer de respaldo. */
  buffer: async (term_id) => { try { return normalizeBuffer(await call(CODEX_TERM_COMMANDS.buffer, { term_id })); } catch { return null; } },
  /** Toda la salida (la reparte el store por term_id). */
  onAnyOutput: (fn) => on(CODEX_TERM_EVENTS.output, (e) => { const p = e?.payload; if (p?.term_id) fn(p.term_id, decodeTermData(p.data), seqOf(p.seq)); }),
  onAnyExit: (fn) => on(CODEX_TERM_EVENTS.exit, (e) => { const p = e?.payload; if (p?.term_id) fn(p.term_id, p.code ?? null); }),
  /** Solo entrega la salida de `term_id`: dos pestañas nunca se cruzan. */
  onOutput: (term_id, fn) => on(CODEX_TERM_EVENTS.output, (e) => { if (e?.payload?.term_id === term_id) fn(decodeTermData(e.payload.data)); }),
  onExit: (term_id, fn) => on(CODEX_TERM_EVENTS.exit, (e) => { if (e?.payload?.term_id === term_id) fn(e.payload.code ?? null); }),
};
