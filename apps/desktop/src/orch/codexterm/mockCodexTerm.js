// mockCodexTerm.js — SOLO desarrollo (DEV && VITE_ORCH_MOCK==='1') y pruebas.
// Imita el contrato propuesto: política sin lanzar, needs_ack, eco de lo escrito y salida.
import { WARN_ELEVATED_RW } from '../providers/mockListProviders.js';
import { CODEX_TERM_COMMANDS as C, CODEX_TERM_EVENTS as E, NEEDS_ACK } from './codexTermContract';

export const MOCK_CODEX_TERM_WARNINGS = [
  'Codex corre con workspace-write: puede modificar archivos dentro de la carpeta.',
  'Con on-request, Codex pide aprobación en esta terminal antes de salir del sandbox.',
];

function policyOf({ cwd, model, effort }, elevated = false) {
  const argv = ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--cd', cwd];
  if (model) argv.push('-m', model);
  if (effort) argv.push('-c', `model_reasoning_effort=${effort}`);
  // Misma forma que build() en codex_term.rs (cd76e40).
  const policy = { provider: 'codex', profile: 'terminal', cli_version: '0.162.1', model: model || 'el que defina config.toml', effort: effort || null, interactive: true, status: 'unverified' };
  // e3572e5: con [windows] sandbox = "elevated", el mismo aviso que Delegar (pide ack).
  const warnings = [...MOCK_CODEX_TERM_WARNINGS, ...(elevated ? [WARN_ELEVATED_RW] : [])];
  return { policy, argv, warnings };
}

export function createMockCodexTerm(opts = {}) {
  const elevated = opts.windowsSandbox === 'elevated';
  const handlers = new Map();
  const terms = new Map();
  let n = 0;
  const out = new Map(); // term_id → { data, seq }
  const emitRaw = (event, payload) => (handlers.get(event) || []).forEach((h) => h({ payload }));
  // La salida lleva seq monótono y queda en el búfer del host simulado.
  const emit = (event, payload) => {
    if (event === E.exit) { const t = terms.get(payload.term_id); if (t) { t.open = false; t.code = payload.code; } }
    if (event === E.output) {
      const b = out.get(payload.term_id) || { data: '', seq: 0 };
      const seq = payload.seq ?? b.seq + 1;
      out.set(payload.term_id, { data: b.data + payload.data, seq });
      return emitRaw(event, { ...payload, seq });
    }
    return emitRaw(event, payload);
  };
  return {
    emit,
    emitRaw,
    terms,
    out,
    listen: async (event, h) => {
      handlers.set(event, [...(handlers.get(event) || []), h]);
      return () => handlers.set(event, (handlers.get(event) || []).filter((x) => x !== h));
    },
    invoke: async (cmd, a = {}) => {
      switch (cmd) {
        case C.policy: return policyOf(a, elevated);
        case C.open: {
          const p = policyOf(a, elevated);
          if (p.warnings.length && a.acknowledged !== true) throw new Error(`${NEEDS_ACK}: confirma los avisos antes de abrir Codex`);
          const term_id = `codex-mock-${++n}`;
          terms.set(term_id, { open: true, cols: a.cols, rows: a.rows, cwd: a.cwd, model: a.model ?? null, effort: a.effort ?? null, argv: p.argv, policy: p.policy, code: null });
          setTimeout(() => emit(E.output, { term_id, data: `\x1b[90m[mock] ${p.argv.join(' ')}\x1b[0m\r\n> ` }), 0);
          return { term_id, ...p };
        }
        case C.write: {
          const t = terms.get(a.term_id);
          if (!t?.open) throw new Error('terminal cerrada');
          emit(E.output, { term_id: a.term_id, data: a.data === '\r' ? '\r\n> ' : a.data });
          return null;
        }
        case C.resize: { const t = terms.get(a.term_id); if (t) Object.assign(t, { cols: Math.max(200, a.cols), rows: a.rows }); return null; }
        case C.close: {
          const t = terms.get(a.term_id);
          if (t?.open) { t.open = false; t.code = 0; emit(E.exit, { term_id: a.term_id, code: 0 }); }
          terms.delete(a.term_id); // cerrada por la persona: ya no sale en la lista
          return null;
        }
        case C.list:
          return [...terms.entries()].map(([term_id, t]) => ({ term_id, cwd: t.cwd, model: t.model, effort: t.effort, policy: t.policy, argv: t.argv, exited: !t.open, code: t.code }));
        case C.buffer: {
          const b = out.get(a.term_id);
          if (!b) throw new Error('terminal desconocida');
          const t = terms.get(a.term_id) || {};
          // vt100 del host simulado: la "pantalla" es todo lo emitido, precedido de \x1b[0m.
          return { data: `\x1b[0m${b.data}`, seq: b.seq, cols: t.cols || 200, rows: t.rows || 40, alt_screen: false };
        }
        case C.redraw: {
          const b = out.get(a.term_id);
          if (!b) throw new Error('terminal desconocida');
          emit(E.output, { term_id: a.term_id, data: '\x1b[2J\x1b[H[mock] redibujado\r\n' });
          return null;
        }
        default: throw new Error(`mock: comando desconocido ${cmd}`);
      }
    },
  };
}

export const mockCodexTerm = createMockCodexTerm();
