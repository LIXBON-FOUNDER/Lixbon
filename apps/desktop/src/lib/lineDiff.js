// lineDiff.js — diff por líneas (Myers) agrupado en bloques. Se usa para
// revisar lo que cambió el agente: en el editor y en el panel de Cambios.

const splitLines = (text) => (text ? text.split('\n') : []);

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[max + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, max, d);
    }
  }
  return [];
}

function backtrack(trace, a, b, max, dEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? k + 1 : k - 1;
    const prevX = v[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', x - 1, y - 1]); x--; y--; }
    if (x === prevX) ops.push(['+', x, y - 1]);
    else ops.push(['-', x - 1, y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push(['=', x - 1, y - 1]); x--; y--; }
  return ops.reverse();
}

/**
 * Bloques de cambio entre `oldText` y `newText`.
 * Cada bloque: { oldStart, oldLines, newStart, newLines } con índices de
 * línea base 0 (newStart es la línea del texto nuevo donde empieza el bloque).
 */
export function diffHunks(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(pre, endA);
  const midB = b.slice(pre, endB);
  // Myers es O((n+m)·d): con miles de líneas distintas se degrada, y ahí un
  // único bloque "todo cambió" es igual de útil para revisar.
  const ops = midA.length * midB.length > 4e6
    ? [...midA.map((_, i) => ['-', i, 0]), ...midB.map((_, j) => ['+', midA.length, j])]
    : myers(midA, midB);

  const hunks = [];
  let cur = null;
  let ia = 0;
  let ib = 0;
  for (const [op] of ops) {
    if (op === '=') {
      if (cur) { hunks.push(cur); cur = null; }
      ia++; ib++;
      continue;
    }
    if (!cur) cur = { oldStart: pre + ia, oldLines: [], newStart: pre + ib, newLines: [] };
    if (op === '-') { cur.oldLines.push(midA[ia]); ia++; } else { cur.newLines.push(midB[ib]); ib++; }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

export function diffStats(hunks) {
  return hunks.reduce((s, h) => ({ added: s.added + h.newLines.length, removed: s.removed + h.oldLines.length }), { added: 0, removed: 0 });
}

/** Aplica un bloque sobre el texto viejo (aceptar ese bloque en la base). */
export function applyHunkToOld(oldText, hunk) {
  const a = splitLines(oldText);
  a.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
  return a.join('\n');
}

/** Deshace un bloque en el texto nuevo (rechazarlo). */
export function revertHunkInNew(newText, hunk) {
  const b = splitLines(newText);
  b.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines);
  return b.join('\n');
}
