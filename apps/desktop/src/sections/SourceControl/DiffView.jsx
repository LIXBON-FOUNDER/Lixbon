// DiffView.jsx — patch unified de git (archivo o commit) con números de
// línea, en línea o lado a lado. Se usa en el modo Git y en la ventana
// flotante de diff.
import { useMemo } from 'react';
import { useAppStore } from '../../store/appStore';

function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git')) {
      file = { name: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), hunks: [], meta: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) { file = { name: '', hunks: [], meta: [] }; files.push(file); }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      oldNo = +m[1];
      newNo = +m[2];
      hunk = { head: line, ctx: m[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) { if (line.trim() && !/^(index |--- |\+\+\+ )/.test(line)) file.meta.push(line); continue; }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), n: newNo++ });
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1), o: oldNo++ });
    else hunk.lines.push({ kind: 'ctx', text: line.slice(1), o: oldNo++, n: newNo++ });
  }
  return files.filter((f) => f.hunks.length || f.meta.length);
}

/** Empareja borradas y añadidas consecutivas en filas izquierda/derecha. */
function splitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'ctx') { rows.push([lines[i], lines[i]]); i++; continue; }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] || null, adds[k] || null]);
  }
  return rows;
}

const Cell = ({ l, side }) => {
  if (!l) return <><span className="dv__no" /><span className="dv__code dv__code--empty" /></>;
  const kind = l.kind === 'ctx' ? 'ctx' : l.kind;
  return (
    <>
      <span className={`dv__no dv__no--${kind}`}>{side === 'old' ? l.o : l.n}</span>
      <span className={`dv__code dv__code--${kind}`}>{l.text || ' '}</span>
    </>
  );
};

export function DiffView({ mode = 'inline', patch }) {
  const diffData = useAppStore((s) => s.diffData);
  const text = patch ?? diffData?.patch ?? '';
  const files = useMemo(() => (text.trim() ? parsePatch(text) : []), [text]);

  if (!files.length) {
    const note = text.trim().startsWith('#') ? text.trim().replace(/^#\s*/, '') : 'Sin diferencias.';
    return <div className="changes__empty">{note}</div>;
  }

  return (
    <div className={`dv dv--${mode} mono`}>
      {files.map((f, fi) => (
        <section key={fi} className="dv__file">
          {files.length > 1 && f.name && <div className="dv__filename">{f.name}</div>}
          {f.meta.map((m, i) => <div key={i} className="dv__meta">{m}</div>)}
          {f.hunks.map((h, hi) => (
            <div key={hi} className="dv__hunk">
              <div className="dv__head">{(h.head.match(/^@@[^@]*@@/) || [h.head])[0]}<span>{h.ctx}</span></div>
              {mode === 'split'
                ? splitRows(h.lines).map(([a, b], i) => (
                  <div key={i} className="dv__row dv__row--split">
                    <Cell l={a && (a.kind === 'add' ? null : a)} side="old" />
                    <Cell l={b && (b.kind === 'del' ? null : b)} side="new" />
                  </div>
                ))
                : h.lines.map((l, i) => (
                  <div key={i} className={`dv__row dv__row--${l.kind}`}>
                    <span className="dv__no">{l.kind === 'add' ? '' : l.o}</span>
                    <span className="dv__no">{l.kind === 'del' ? '' : l.n}</span>
                    <span className={`dv__code dv__code--${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}</span>
                  </div>
                ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
