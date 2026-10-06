// docBlocks.js — los documentos adjuntos desde el móvil o la web llegan
// antepuestos al texto del mensaje (formato común con apps/web/src/lib/adjuntos.js
// y la app). Separarlos permite pintarlos como fichas y titular por la pregunta.
const DOC_HEADER = /^--- (?:Documento adjunto|Imagen adjunta): (.+?)(?: \(descrita por un modelo de visión\))? ---$/gm;
const DOC_SEPARATOR = '\n\n---\n\n';

export function splitDocs(content = '') {
  if (!content.startsWith('--- ')) return { docs: [], text: content };
  const cut = content.lastIndexOf(DOC_SEPARATOR);
  if (cut < 0) return { docs: [], text: content };
  const docs = [...content.slice(0, cut).matchAll(DOC_HEADER)].map((m) => m[1]);
  return docs.length ? { docs, text: content.slice(cut + DOC_SEPARATOR.length) } : { docs: [], text: content };
}

export const questionOf = (content = '') => splitDocs(content).text;
