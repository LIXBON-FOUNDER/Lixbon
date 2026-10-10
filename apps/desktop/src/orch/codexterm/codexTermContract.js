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
});

export const CODEX_TERM_EVENTS = Object.freeze({
  output: 'codex-term-output',   // { term_id, data }
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

/** Adaptador: lo único que usa la UI. */
export const codexTerm = {
  policy: (a) => call(CODEX_TERM_COMMANDS.policy, policyArgs(a)),
  open: ({ cols, rows, acknowledged, ...a }) => call(CODEX_TERM_COMMANDS.open, { ...policyArgs(a), cols, rows, acknowledged: acknowledged === true }),
  write: (term_id, text) => call(CODEX_TERM_COMMANDS.write, { term_id, data: encodeTermData(text) }),
  resize: (term_id, cols, rows) => call(CODEX_TERM_COMMANDS.resize, { term_id, cols, rows }),
  close: (term_id) => call(CODEX_TERM_COMMANDS.close, { term_id }),
  /** Solo entrega la salida de `term_id`: dos pestañas nunca se cruzan. */
  onOutput: (term_id, fn) => on(CODEX_TERM_EVENTS.output, (e) => { if (e?.payload?.term_id === term_id) fn(decodeTermData(e.payload.data)); }),
  onExit: (term_id, fn) => on(CODEX_TERM_EVENTS.exit, (e) => { if (e?.payload?.term_id === term_id) fn(e.payload.code ?? null); }),
};
