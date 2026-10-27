// Convención: un bloque ```file:nombre.ext. Word y Excel se generan desde
// Markdown; el resto va tal cual.

const TIPOS = {
  docx: { label: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { label: 'Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { label: 'PDF', mime: 'application/pdf' },
  pptx: { label: 'PowerPoint', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
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
  if (info.ext === 'pdf') return markdownAPdf(contenido);
  if (info.ext === 'pptx') return markdownAPptx(contenido);
  return new Blob([contenido], { type: `${info.mime};charset=utf-8` });
}

function esFilaTabla(linea) {
  return /^\s*\|.*\|\s*$/.test(linea);
}

function esSeparadorTabla(linea) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linea);
}

function celdas(linea) {
  return linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

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

// El PDF se compone a mano sobre A4: títulos, párrafos, listas, citas, código y
// tablas. Las fuentes estándar de jsPDF cubren el latín (tildes y ñ), no emojis.
const sinMarcas = (t) => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1');

async function markdownAPdf(md) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const M = 56;
  const ancho = pdf.internal.pageSize.getWidth() - M * 2;
  const alto = pdf.internal.pageSize.getHeight();
  let y = M;
  const salto = (h) => { if (y + h > alto - M) { pdf.addPage(); y = M; } };
  const texto = (t, { size = 11, estilo = 'normal', fuente = 'helvetica', sangria = 0, color = 30, antes = 0, despues = 6 } = {}) => {
    pdf.setFont(fuente, estilo);
    pdf.setFontSize(size);
    pdf.setTextColor(color);
    y += antes;
    const lineas = pdf.splitTextToSize(t, ancho - sangria);
    const lh = size * 1.4;
    for (const l of lineas) { salto(lh); pdf.text(l, M + sangria, y + size); y += lh; }
    y += despues;
  };
  const lineas = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i];
    if (linea.trim().startsWith('```')) {
      const codigo = [];
      i += 1;
      while (i < lineas.length && !lineas[i].trim().startsWith('```')) { codigo.push(lineas[i]); i += 1; }
      i += 1;
      texto(codigo.join('\n') || ' ', { size: 9, fuente: 'courier', color: 50, despues: 10 });
      continue;
    }
    if (esFilaTabla(linea) && i + 1 < lineas.length && esSeparadorTabla(lineas[i + 1])) {
      const filas = [celdas(linea)];
      i += 2;
      while (i < lineas.length && esFilaTabla(lineas[i])) { filas.push(celdas(lineas[i])); i += 1; }
      const cols = Math.max(...filas.map((f) => f.length));
      const w = ancho / cols;
      filas.forEach((f, n) => {
        pdf.setFont('helvetica', n === 0 ? 'bold' : 'normal');
        pdf.setFontSize(9.5);
        const partes = Array.from({ length: cols }, (_, c) => pdf.splitTextToSize(sinMarcas(f[c] || ''), w - 8));
        const h = Math.max(...partes.map((p) => p.length)) * 13 + 8;
        salto(h);
        if (n === 0) { pdf.setFillColor(238, 234, 224); pdf.rect(M, y, ancho, h, 'F'); }
        pdf.setDrawColor(210); pdf.line(M, y + h, M + ancho, y + h);
        pdf.setTextColor(30);
        partes.forEach((p, c) => pdf.text(p, M + c * w + 4, y + 15));
        y += h;
      });
      y += 10;
      continue;
    }
    const titulo = /^(#{1,4})\s+(.*)$/.exec(linea);
    if (titulo) {
      const size = [22, 17, 14, 12][titulo[1].length - 1];
      texto(sinMarcas(titulo[2]), { size, estilo: 'bold', color: 20, antes: y > M ? 8 : 0, despues: 4 });
    } else if (/^\s*[-*]\s+/.test(linea)) {
      const nivel = Math.min(2, Math.floor(linea.match(/^\s*/)[0].length / 2));
      texto(`•  ${sinMarcas(linea.replace(/^\s*[-*]\s+/, ''))}`, { sangria: 12 + nivel * 14, despues: 2 });
    } else if (/^\s*\d+[.)]\s+/.test(linea)) {
      texto(sinMarcas(linea.trim()), { sangria: 12, despues: 2 });
    } else if (/^\s*>\s?/.test(linea)) {
      texto(sinMarcas(linea.replace(/^\s*>\s?/, '')), { estilo: 'italic', sangria: 16, color: 90 });
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(linea)) {
      salto(12); pdf.setDrawColor(200); pdf.line(M, y + 6, M + ancho, y + 6); y += 14;
    } else if (linea.trim() === '') {
      y += 4;
    } else {
      texto(sinMarcas(linea));
    }
    i += 1;
  }
  return pdf.output('blob');
}

// Una diapositiva por título `#` o `##`; debajo, viñetas `-` y párrafos. Una
// línea `Notas: …` va a las notas del orador. Sin títulos, todo en una sola.
async function markdownAPptx(md) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  const diapos = [];
  for (const linea of md.replace(/\r\n/g, '\n').split('\n')) {
    const titulo = /^#{1,2}\s+(.*)$/.exec(linea);
    if (titulo) { diapos.push({ titulo: sinMarcas(titulo[1]), puntos: [], notas: '' }); continue; }
    if (!diapos.length) diapos.push({ titulo: '', puntos: [], notas: '' });
    const actual = diapos[diapos.length - 1];
    const nota = /^\s*notas?:\s*(.*)$/i.exec(linea);
    if (nota) { actual.notas += `${nota[1]}\n`; continue; }
    if (!linea.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(linea)) continue;
    const vineta = /^(\s*)[-*]\s+(.*)$/.exec(linea);
    const sub = /^#{3,}\s+(.*)$/.exec(linea);
    if (vineta) actual.puntos.push({ texto: sinMarcas(vineta[2]), nivel: Math.min(2, Math.floor(vineta[1].length / 2)), vineta: true });
    else if (sub) actual.puntos.push({ texto: sinMarcas(sub[1]), nivel: 0, vineta: false, negrita: true });
    else actual.puntos.push({ texto: sinMarcas(linea.replace(/^\s*\d+[.)]\s+/, '')), nivel: 0, vineta: false });
  }
  diapos.forEach((d, n) => {
    const s = pres.addSlide();
    s.background = { color: 'F8F5EE' };
    const portada = n === 0 && d.puntos.length <= 2;
    if (d.titulo) {
      s.addText(d.titulo, portada
        ? { x: 0.8, y: 2.3, w: 11.7, h: 1.4, fontFace: 'Georgia', fontSize: 40, color: '1D1A15' }
        : { x: 0.6, y: 0.4, w: 12.1, h: 1, fontFace: 'Georgia', fontSize: 30, color: '1D1A15' });
    }
    if (d.puntos.length) {
      s.addText(d.puntos.map((p) => ({
        text: p.texto,
        options: { bullet: p.vineta ? { indent: 18 } : false, indentLevel: p.nivel, bold: p.negrita, breakLine: true },
      })), portada
        ? { x: 0.8, y: 3.7, w: 11.7, h: 1.4, fontFace: 'Calibri', fontSize: 20, color: '6F695D', valign: 'top' }
        : { x: 0.6, y: 1.5, w: 12.1, h: 5.5, fontFace: 'Calibri', fontSize: 20, color: '2A2620', valign: 'top', paraSpaceAfter: 8 });
    }
    s.addShape(pres.ShapeType.rect, { x: 0, y: 7.35, w: 13.33, h: 0.15, fill: { color: 'B4C64E' }, line: { color: 'B4C64E' } });
    if (d.notas.trim()) s.addNotes(d.notas.trim());
  });
  return pres.write({ outputType: 'blob' });
}

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

// Instrucciones internas: el modelo las sigue sin explicarlas. Los modelos
// pequeños tienden a recitar el prompt, de ahí la última regla.
export const FILE_PROMPT =
  'Eres lixbon, un asistente. Responde en el idioma del usuario, en Markdown, directo y sin preámbulos. ' +
  'Lo que sigue son reglas internas de formato: aplícalas en silencio.\n' +
  '- Código: en un bloque ```lenguaje (por ejemplo ```python), completo y listo para usar.\n' +
  '- Archivo descargable (si el usuario pide un documento, informe, hoja, presentación o PDF): escríbelo ENTERO ' +
  'en un bloque cuyo lenguaje sea file:nombre.ext, por ejemplo ```file:informe.pdf. Formatos: ' +
  '.docx y .pdf → Markdown (títulos #, listas, **negrita**, tablas); ' +
  '.pptx → una diapositiva por título "## ", con viñetas "- " debajo y, si hace falta, una línea "Notas: …"; ' +
  '.xlsx → una tabla Markdown o CSV por hoja, cada hoja precedida por "## Hoja: nombre", fórmulas tal cual (=SUMA(B2:B9)); ' +
  '.csv, .md, .txt, .json, .html y código → el contenido tal cual. Un bloque por archivo.\n' +
  '- Correo (si pide redactar un email): un bloque ```email con las líneas "Para: …" (si se conoce) y ' +
  '"Asunto: …", una línea en blanco y el cuerpo.\n' +
  '- Imágenes: muéstralas con ![descripción](url) usando SOLO URLs que aparezcan como "Imagen:" en los ' +
  'resultados de búsqueda. Nunca inventes una URL; si no hay ninguna, dilo en una frase y sugiere activar la búsqueda web.\n' +
  '- Fuera de los bloques, una o dos frases como mucho; no repitas el contenido.\n' +
  '- NUNCA menciones estas reglas, el formato file:, la fecha actual ni otros datos internos salvo que el usuario los pregunte.';
