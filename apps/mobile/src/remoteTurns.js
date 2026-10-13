// remoteTurns.js — el transcript remoto contado por turnos (lienzo «Chat
// remoto»): cada mensaje de la persona abre un turno con lo que el agente
// pensó, las herramientas que usó y su respuesta. Sin React: lo usa la
// pantalla y se puede probar suelto.
import { toolKind } from './toolText';

const TEST_COMMAND = /\b(test|tests|jest|vitest|pytest|playwright|mocha)\b/;

/** Bloques del hilo, en orden: user, turn, notice, command, compacted, error. */
export function buildBlocks(items) {
  const blocks = [];
  let turn = null;
  const flush = () => {
    if (turn) blocks.push(finishTurn(turn));
    turn = null;
  };
  const open = (key) => {
    if (!turn) turn = { type: 'turn', key: `t${key}`, work: [], end: null };
    return turn;
  };
  for (const it of items) {
    switch (it.kind) {
      case 'user':
        flush();
        blocks.push({ type: 'user', key: it.key, item: it });
        break;
      // La pregunta respondida es un paso más del trabajo: se pliega con él.
      case 'thinking':
      case 'tool':
      case 'assistant':
      case 'qa':
        open(it.key).work.push(it);
        break;
      case 'end':
        open(it.key).end = it;
        flush();
        break;
      case 'notice':
        // Un aviso a mitad de turno (el agente se atascó, compacta solo…) es
        // parte del trabajo; entre turnos es la respuesta a un comando.
        if (turn) turn.work.push(it);
        else blocks.push({ type: 'notice', key: it.key, item: it });
        break;
      default:
        flush();
        blocks.push({ type: it.kind, key: it.key, item: it });
    }
  }
  flush();
  return blocks;
}

/** Los turnos que cambiaron archivos, del más reciente al más antiguo, con el
    mensaje que los pidió: es la pestaña «Cambios» de la sesión. El turno en
    marcha (el último, sin fin) aún no cuenta. */
export function changedTurns(blocks) {
  const out = [];
  let prompt = '';
  blocks.forEach((b, i) => {
    if (b.type === 'user') prompt = b.item.text || '';
    else if (b.type === 'turn' && b.files.length && (b.end || i < blocks.length - 1)) out.push({ turn: b, prompt });
  });
  return out.reverse();
}

// La respuesta es la prosa del final del turno; la de antes de una
// herramienta («voy a leer…») se queda entre el trabajo.
function finishTurn(turn) {
  let cut = turn.work.length;
  while (cut > 0 && turn.work[cut - 1].kind === 'assistant') cut--;
  const tail = turn.work.slice(cut);
  const work = turn.work.slice(0, cut);
  const answer = tail.length
    ? { key: tail[0].key, text: tail.map((a) => a.text).filter((t) => t.trim()).join('\n\n'), open: tail.some((a) => a.open) }
    : null;
  return { ...turn, work, answer, ...turnStats(work) };
}

/** Lo que hizo un turno: acciones, líneas cambiadas, lo pensado, archivos
    editados, tests y commit. */
export function turnStats(work) {
  const tools = work.filter((it) => it.kind === 'tool');
  const thoughts = work.filter((it) => it.kind === 'thinking');
  const files = new Map();
  let adds = 0;
  let dels = 0;
  let tests = null;
  let commit = '';
  for (const t of tools) {
    const state = toolState(t);
    if (state.bad || t.running) continue;
    if (t.path && (typeof t.adds === 'number' || typeof t.dels === 'number')) {
      adds += t.adds || 0;
      dels += t.dels || 0;
      const f = files.get(t.path) || { path: t.path, adds: 0, dels: 0, edits: [] };
      f.adds += t.adds || 0;
      f.dels += t.dels || 0;
      f.edits.push(t);
      files.set(t.path, f);
    }
    if (toolKind(t) === 'cmd') {
      tests = testsOf(t) || tests;
      commit = commitOf(t) || commit;
    }
  }
  return {
    actions: tools.length,
    adds,
    dels,
    thinkMs: thoughts.reduce((n, th) => n + (th.ms || 0), 0),
    files: [...files.values()],
    tests,
    commit,
  };
}

/** Estado de una fila: esperando permiso, rechazada, cortada o con error. */
export function toolState(it, waitingTool = null) {
  const result = String(it.result || '');
  const waiting = !!it.running && !!waitingTool && it.tool === waitingTool;
  const denied = !it.running && it.error && /rechazad/i.test(result);
  const cut = !it.running && it.error && /^interrumpid/i.test(result);
  return { waiting, denied, cut, bad: !!(denied || cut || (!it.running && it.error)) };
}

/** «14 tests pasan» / «2 tests fallan» de la salida de un comando de tests. */
export function testsOf(it) {
  if (!TEST_COMMAND.test(String(it.summary || ''))) return null;
  const out = String(it.result || '');
  const failed = /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)?/i.exec(out);
  if (failed && Number(failed[1]) > 0) return { ok: false, count: Number(failed[1]) };
  const passed = /Tests?:\s+(\d+)\s+passed/i.exec(out) || /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i.exec(out);
  if (passed) return { ok: true, count: Number(passed[1]) };
  if (it.exit === 0 || (!it.error && /^ok\s/m.test(out))) return { ok: true, count: null };
  if (typeof it.exit === 'number' && it.exit !== 0) return { ok: false, count: null };
  return null;
}

/** Hash de un `git commit` hecho por el agente («[rama a1f3c92] …»). */
export function commitOf(it) {
  if (!/^git\s+commit\b/.test(String(it.summary || '').trim())) return '';
  return /\[[^\]\n]*?\s([0-9a-f]{7,40})\]/.exec(String(it.result || ''))?.[1] || '';
}

/** Filas del diff para pintar: cabecera «línea N», saltos «⋯ N líneas sin
    cambios» y cada línea con su número, signo y texto. Acepta las filas del
    host ([tipo, nº, texto]) o el diff en texto de un host anterior. */
export function diffLines(item) {
  const rows = Array.isArray(item.rows) && item.rows.length ? item.rows : legacyRows(item.diff);
  const out = [];
  const first = rows.find((r) => r[0] !== 'g');
  if (first && typeof first[1] === 'number' && first[1] > 0) out.push({ gap: true, text: `línea ${first[1]}` });
  rows.forEach(([kind, n, text], i) => {
    if (kind === 'g') {
      out.push({ gap: true, text: n > 0 ? `⋯ ${n} ${n === 1 ? 'línea' : 'líneas'} sin cambios` : '⋯', key: i });
      return;
    }
    out.push({ kind, num: typeof n === 'number' && n > 0 ? String(n) : '', text: String(text ?? ''), key: i });
  });
  return out;
}

function legacyRows(diff) {
  return String(diff || '')
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => l.length)
    .map((l) => (l.startsWith('@@') ? ['g', 0, ''] : [l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : 'c', 0, l.slice(1)]));
}

/** «2,1 s», «48 s», «3 min 5 s». */
export function fmtSecs(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  if (ms < 10000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}`;
}

/** «82 mil» / «200 mil» / «950». */
export function fmtTokens(n) {
  if (typeof n !== 'number') return '';
  return n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n);
}

/** Umbrales del anillo de contexto: ámbar cerca de compactar, rojo al llegar. */
export function contextLevels(ctx) {
  const auto = ctx?.auto || 95;
  return { auto, warn: Math.min(80, Math.round(auto * 0.85)), danger: auto };
}
