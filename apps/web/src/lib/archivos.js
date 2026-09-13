// archivos.js — archivos que el modelo "escribe" en la respuesta.
//
// Convención: un bloque de código cuyo lenguaje es `file:nombre.ext`. El chat
// lo enseña como tarjeta y construye el archivo en el navegador al descargar:
// Word y Excel desde Markdown; el resto (csv, md, txt, json, código) tal cual.

const TIPOS = {
  docx: { label: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { label: 'Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { label: 'CSV', mime: 'text/csv' },
  md: { label: 'Markdown', mime: 'text/markdown' },
  txt: { label: 'Texto', mime: 'text/plain' },
  json: { label: 'JSON', mime: 'application/json' },
  html: { label: 'HTML', mime: 'text/html' },
};

export function parseFileLang(className) {
  const m = /language-file:(.+)$/.exec(className || '');
  if (!m) return null;
  const name = m[1].trim().replace(/[\\/:*?"<>|]/g, '_');
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { name, ext, ...(TIPOS[ext] || { label: ext.toUpperCase() || 'Archivo', mime: 'text/plain' }) };
}

export function extForLang(lang) {
  return ({
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', bash: 'sh', sh: 'sh',
    shell: 'sh', json: 'json', html: 'html', css: 'css', sql: 'sql', yaml: 'yml', yml: 'yml', markdown: 'md',
    md: 'md', csv: 'csv', java: 'java', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp', jsx: 'jsx', tsx: 'tsx',
  })[(lang || '').toLowerCase()] || 'txt';
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function descargarBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function construirArchivo(info, contenido) {
  if (info.ext === 'docx') return markdownADocx(contenido);
  if (info.ext === 'xlsx') return markdownAXlsx(contenido);
  return new Blob([contenido], { type: `${info.mime};charset=utf-8` });
}

// ── Markdown → Word ─────────────────────────────────────────────────────────

function esFilaTabla(linea) {
  return /^\s*\|.*\|\s*$/.test(linea);
}

function esSeparadorTabla(linea) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linea);
}

function celdas(linea) {
  return linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// Negrita, cursiva y código en línea → runs con formato.
function runs(texto, TextRun, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(texto))) {
    if (m.index > last) out.push(new TextRun({ text: texto.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else if (t.startsWith('`')) out.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas', ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), italics: true, ...base }));
    last = m.index + t.length;
  }
  if (last < texto.length) out.push(new TextRun({ text: texto.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: '', ...base })];
}

async function markdownADocx(md) {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = docx;
  const niveles = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const hijos = [];
  const lineas = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let enCodigo = false;
  let codigo = [];
  while (i < lineas.length) {
    const linea = lineas[i];
    if (linea.trim().startsWith('```')) {
      if (enCodigo) {
        hijos.push(new Paragraph({ children: [new TextRun({ text: codigo.join('\n'), font: 'Consolas', size: 18 })] }));
        codigo = [];
      }
      enCodigo = !enCodigo;
      i += 1;
      continue;
    }
    if (enCodigo) { codigo.push(linea); i += 1; continue; }
    if (esFilaTabla(linea) && i + 1 < lineas.length && esSeparadorTabla(lineas[i + 1])) {
      const cab = celdas(linea);
      const filas = [];
      i += 2;
      while (i < lineas.length && esFilaTabla(lineas[i])) { filas.push(celdas(lineas[i])); i += 1; }
      const fila = (cells, bold) => new TableRow({
        children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c, TextRun, bold ? { bold: true } : {}) })] })),
      });
      hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [fila(cab, true), ...filas.map((f) => fila(f, false))] }));
      hijos.push(new Paragraph({ text: '' }));
      continue;
    }
    const titulo = /^(#{1,4})\s+(.*)$/.exec(linea);
    if (titulo) {
      hijos.push(new Paragraph({ heading: niveles[titulo[1].length - 1], children: runs(titulo[2], TextRun) }));
    } else if (/^\s*[-*]\s+/.test(linea)) {
      hijos.push(new Paragraph({ bullet: { level: Math.min(2, Math.floor((linea.match(/^\s*/)[0].length) / 2)) }, children: runs(linea.replace(/^\s*[-*]\s+/, ''), TextRun) }));
    } else if (/^\s*\d+[.)]\s+/.test(linea)) {
      hijos.push(new Paragraph({ numbering: { reference: 'lista', level: 0 }, children: runs(linea.replace(/^\s*\d+[.)]\s+/, ''), TextRun) }));
    } else if (/^\s*>\s?/.test(linea)) {
      hijos.push(new Paragraph({ indent: { left: 720 }, children: runs(linea.replace(/^\s*>\s?/, ''), TextRun, { italics: true }) }));
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(linea)) {
      hijos.push(new Paragraph({ text: '', border: { bottom: { style: 'single', size: 6, color: '999999' } } }));
    } else if (linea.trim() === '') {
      hijos.push(new Paragraph({ text: '' }));
    } else {
      hijos.push(new Paragraph({ alignment: AlignmentType.LEFT, children: runs(linea, TextRun) }));
    }
    i += 1;
  }
  const doc = new Document({
    numbering: { config: [{ reference: 'lista', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }] },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: hijos }],
  });
  return Packer.toBlob(doc);
}

// ── Markdown/CSV → Excel ────────────────────────────────────────────────────

function valorCelda(texto) {
  const t = texto.trim();
  if (t === '') return null;
  // Sin `t` y un valor cacheado SheetJS no escribe la fórmula; Excel recalcula al abrir.
  if (t.startsWith('=')) return { t: 'n', f: t.slice(1), v: 0 };
  if (/^-?\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return t;
}

function parseCsvLinea(linea, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < linea.length; i += 1) {
    const ch = linea[i];
    if (q) {
      if (ch === '"' && linea[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function filasDeBloque(texto) {
  const lineas = texto.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lineas.length) return [];
  if (lineas.every(esFilaTabla)) {
    return lineas.filter((l) => !esSeparadorTabla(l)).map(celdas);
  }
  const sep = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ';' : ',';
  return lineas.map((l) => parseCsvLinea(l, sep));
}

async function markdownAXlsx(md) {
  const XLSX = await import('xlsx');
  const libro = XLSX.utils.book_new();
  // Hojas separadas por `## Hoja: nombre` (o cualquier título `##`); sin
  // títulos, todo va a una hoja.
  const partes = md.replace(/\r\n/g, '\n').split(/^##\s+(?:Hoja:\s*)?(.+)$/m);
  const hojas = [];
  if (partes[0].trim()) hojas.push(['Hoja1', partes[0]]);
  for (let i = 1; i < partes.length; i += 2) hojas.push([partes[i].trim().slice(0, 31) || `Hoja${hojas.length + 1}`, partes[i + 1] || '']);
  if (!hojas.length) hojas.push(['Hoja1', md]);
  const usados = new Set();
  for (const [nombreBase, texto] of hojas) {
    let nombre = nombreBase.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Hoja';
    while (usados.has(nombre)) nombre = `${nombre.slice(0, 28)}_${usados.size}`;
    usados.add(nombre);
    const filas = filasDeBloque(texto).map((f) => f.map(valorCelda));
    const hoja = XLSX.utils.aoa_to_sheet(filas.length ? filas : [[]]);
    const anchos = [];
    filas.forEach((f) => f.forEach((v, c) => { anchos[c] = Math.min(60, Math.max(anchos[c] || 8, String(v?.f ? `=${v.f}` : v ?? '').length + 2)); }));
    hoja['!cols'] = anchos.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(libro, hoja, nombre);
  }
  const out = XLSX.write(libro, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: TIPOS.xlsx.mime });
}

// ── Instrucción para el modelo ──────────────────────────────────────────────

export const FILE_PROMPT =
  'Cuando el usuario pida un documento, hoja de cálculo o archivo descargable, escríbelo ENTERO dentro de un ' +
  'bloque de código cuyo lenguaje sea file:nombre.ext (por ejemplo ```file:informe.docx). La interfaz lo convierte ' +
  'en archivo real. Formatos: .docx → contenido en Markdown (títulos #, listas, **negrita**, tablas); ' +
  '.xlsx → una tabla Markdown o CSV por hoja, cada hoja precedida por "## Hoja: nombre", fórmulas tal cual ' +
  '(=SUMA(B2:B9)); .csv, .md, .txt, .json y código → el contenido tal cual. Un bloque por archivo. Fuera del ' +
  'bloque, una o dos frases de contexto como mucho; no repitas el contenido.';
