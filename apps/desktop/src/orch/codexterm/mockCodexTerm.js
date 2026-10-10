// mockCodexTerm.js — SOLO desarrollo (DEV && VITE_ORCH_MOCK==='1') y pruebas.
// Imita el contrato propuesto: política sin lanzar, needs_ack, eco de lo escrito y salida.
import { CODEX_TERM_COMMANDS as C, CODEX_TERM_EVENTS as E, NEEDS_ACK } from './codexTermContract';

export const MOCK_CODEX_TERM_WARNINGS = [
  'Codex corre con workspace-write: puede modificar archivos dentro de la carpeta.',
  'Con on-request, Codex pide aprobación en esta terminal antes de salir del sandbox.',
];

function policyOf({ cwd, model, effort }) {
  const argv = ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--cd', cwd];
  if (model) argv.push('--model', model);
  if (effort) argv.push('-c', `model_reasoning_effort=${effort}`);
  return { policy: 'workspace-write · on-request', argv, warnings: [...MOCK_CODEX_TERM_WARNINGS] };
}

export function createMockCodexTerm() {
  const handlers = new Map();
  const terms = new Map();
  let n = 0;
  const emit = (event, payload) => (handlers.get(event) || []).forEach((h) => h({ payload }));
  return {
    emit,
    terms,
    listen: async (event, h) => {
      handlers.set(event, [...(handlers.get(event) || []), h]);
      return () => handlers.set(event, (handlers.get(event) || []).filter((x) => x !== h));
    },
    invoke: async (cmd, a = {}) => {
      switch (cmd) {
        case C.policy: return policyOf(a);
        case C.open: {
          const p = policyOf(a);
          if (p.warnings.length && a.acknowledged !== true) throw new Error(`${NEEDS_ACK}: confirma los avisos antes de abrir Codex`);
          const term_id = `codex-mock-${++n}`;
          terms.set(term_id, { open: true, cols: a.cols, rows: a.rows });
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
          if (t?.open) { t.open = false; emit(E.exit, { term_id: a.term_id, code: 0 }); }
          return null;
        }
        default: throw new Error(`mock: comando desconocido ${cmd}`);
      }
    },
  };
}

export const mockCodexTerm = createMockCodexTerm();
