import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PREVIEW_QUERY_SPECS, MAX_PREVIEW_REQUEST_BYTES, PREVIEW_ERROR_CODES, PREVIEW_NOTES, validateContextPreview,
} from './contextPreviewContract';
import {
  ERROR_COPY, NOTE_COPY, REDACTED_MARK, describeAttachment, describeSections, describeTests, describeTruncation, formatBytes, sizeEstimate, splitRedacted, statusBadges,
} from './contextPreviewModel';
import { ADE_QUERY_NAMES } from './coreQueries';
import { CANONICAL_INVALID, CANONICAL_VALID, REJECTED, VARIANTS, validVariant } from './testFixtures/contextPreviewFixtures';

// LXO-136 · contrato y modelo de la vista previa contra las fixtures canónicas del Core y variantes que debe rechazar o distinguir.
const bad = (response) => expect(() => validateContextPreview(response)).toThrow(/ade_query_invalid_response: context_package_preview/);

describe('context_package_preview · contrato cliente', () => {
  it('acepta las dos respuestas canónicas del Core y cada variante local', () => {
    expect(validateContextPreview(CANONICAL_VALID)).toBe(CANONICAL_VALID);
    expect(validateContextPreview(CANONICAL_INVALID)).toBe(CANONICAL_INVALID);
    for (const make of Object.values(VARIANTS)) expect(() => validateContextPreview(make())).not.toThrow();
    for (const code of PREVIEW_ERROR_CODES) expect(() => validateContextPreview(REJECTED.porCodigo(code))).not.toThrow();
  });

  it('rechaza lo que no es del contrato, sin completarlo ni reinterpretarlo', () => {
    bad(null);
    bad([]);
    bad({ ...CANONICAL_VALID, v: 2 });
    bad({ ...CANONICAL_VALID, status: 'quizas' });
    bad(validVariant((r) => { r.verification.identity = 'sin_verificar'; }));
    bad(validVariant((r) => { r.verification.attachments = 'verified'; })); // los adjuntos no llegan: no se dan por verificados
    bad(validVariant((r) => { r.package_id = 'sha256:abc'; }));
    bad(validVariant((r) => { r.package.package_id = `sha256:${'0'.repeat(64)}`; })); // la identidad del documento no es la de la respuesta
    bad(validVariant((r) => { r.package.schema_version = 2; }));
    bad(validVariant((r) => { delete r.package.source.task_id; }));
    bad(validVariant((r) => { delete r.package.revision; }));
    bad(validVariant((r) => { r.package.decisions = 'una'; }));
    bad(validVariant((r) => { r.package.redactions = -1; }));
    bad(validVariant((r) => { r.package.attachments[0].kind = 'cinta'; }));
    bad(validVariant((r) => { r.package.truncated = [{ field: 'x', original: 3, unit: 'palabras' }]; }));
    bad(validVariant((r) => { r.summary.completeness = 'casi'; }));
    bad(validVariant((r) => { r.summary.notes = ['otra_cosa']; }));
    bad(validVariant((r) => { delete r.summary.counts.files; }));
  });

  it('un paquete inválido no trae contenido y su motivo es del contrato', () => {
    bad({ ...CANONICAL_INVALID, error: { code: 'raro', message: 'x' } });
    bad({ ...CANONICAL_INVALID, package: {} });
    bad({ ...CANONICAL_INVALID, summary: {} });
    bad({ ...CANONICAL_INVALID, package_id: CANONICAL_INVALID.declared_id });
    bad({ ...CANONICAL_INVALID, declared_id: 'no-es-un-hash' });
    bad({ ...CANONICAL_INVALID, serialized_bytes: -1 });
  });

  it('la query está en la tabla del ADE y la petición mide el tamaño en bytes', () => {
    expect(ADE_QUERY_NAMES).toContain('context_package_preview');
    const spec = CONTEXT_PREVIEW_QUERY_SPECS.context_package_preview;
    expect(spec.request({ package: '{"a":1}' })).toEqual({ package: '{"a":1}' });
    for (const raro of [undefined, {}, { package: '' }, { package: '   ' }, { package: 3 }]) expect(() => spec.request(raro)).toThrow(/ade_query_invalid_request/);
    // 40 000 caracteres de 3 bytes (120 KB en UTF-8) caben en caracteres, pero no en bytes.
    expect(() => spec.request({ package: '€'.repeat(50_000) })).toThrow(/pesa más/);
    expect(MAX_PREVIEW_REQUEST_BYTES).toBe(128 * 1024);
  });
});

describe('contextPreviewModel · la vista refleja el paquete y no reinterpreta nada', () => {
  it('completo, parcial, truncado, redactado e inválido tienen avisos propios y distintos', () => {
    const ids = (r) => statusBadges(r).map((b) => b.id);
    expect(ids(CANONICAL_VALID)).toEqual(['complete', 'attachment_not_scanned']);
    expect(ids(VARIANTS.sinRepositorio())).toEqual(['partial', 'revision_absent', 'attachment_not_scanned']);
    expect(ids(VARIANTS.truncado())).toEqual(['partial', 'truncated', 'attachment_not_scanned']);
    expect(ids(VARIANTS.redactado())).toEqual(['complete', 'redacted', 'attachment_not_scanned']);
    expect(ids(VARIANTS.adjuntoOmitido())).toEqual(['partial', 'attachment_omitted', 'attachment_not_scanned']);
    expect(ids(CANONICAL_INVALID)).toEqual(['invalid']);
    // Redactado NO hace parcial al paquete; parcial viene del Core, no se deduce aquí.
    expect(statusBadges(VARIANTS.redactado())[0].id).toBe('complete');
    // Cada aviso tiene texto y glifo propios (no depende del color) y ninguno se repite.
    const todos = [...PREVIEW_NOTES.map((n) => NOTE_COPY[n]), ...['complete', 'partial', 'invalid'].map((id) => statusBadges(id === 'invalid' ? CANONICAL_INVALID : { status: 'valid', summary: { completeness: id, notes: [] } })[0])];
    for (const campo of ['label', 'glyph']) expect(new Set(todos.map((t) => t[campo])).size).toBe(todos.length);
  });

  it('cada motivo de rechazo del contrato tiene su copia, con título y explicación', () => {
    for (const code of PREVIEW_ERROR_CODES) {
      expect(ERROR_COPY[code].title.length).toBeGreaterThan(5);
      expect(ERROR_COPY[code].help.length).toBeGreaterThan(15);
    }
    expect(ERROR_COPY.id_mismatch.help).toMatch(/alter|hash/i);
  });

  it('lo redactado se marca y nunca se revela: el modelo no tiene ninguna operación que lo muestre', () => {
    expect(splitRedacted('Entrar con [redactado] y [redactado] otra vez')).toEqual([
      { text: 'Entrar con ', redacted: false }, { text: REDACTED_MARK, redacted: true }, { text: ' y ', redacted: false },
      { text: REDACTED_MARK, redacted: true }, { text: ' otra vez', redacted: false },
    ]);
    expect(splitRedacted('sin nada')).toEqual([{ text: 'sin nada', redacted: false }]);
    expect(splitRedacted('')).toEqual([]);
    expect(splitRedacted(null)).toEqual([]);
    // El texto de vuelta es exactamente el de entrada: no se transforma ni se completa.
    const t = 'a [redactado] b';
    expect(splitRedacted(t).map((p) => p.text).join('')).toBe(t);
  });

  it('un recorte se dice explícito: qué campo, cuánto había y en qué unidad', () => {
    expect(describeTruncation({ field: 'objective', original: 6000, unit: 'chars' }).text).toBe('«objective» se recortó: tenía 6000 caracteres.');
    expect(describeTruncation({ field: 'decisions', original: 40, unit: 'items' }).text).toBe('«decisions» se recortó: tenía 40 elementos.');
  });

  it('cada adjunto dice si viaja, si se escaneó o por qué se omitió, sin tocar su contenido', () => {
    const [bundle, patch] = CANONICAL_VALID.package.attachments;
    expect(describeAttachment(bundle)).toMatchObject({ state: 'unscanned', kind: 'git bundle', size: '4 KiB' });
    expect(describeAttachment(patch)).toMatchObject({ state: 'included' });
    const omitido = describeAttachment({ ...patch, omitted: 'secret_detected' });
    expect(omitido.state).toBe('omitted');
    expect(omitido.detail).toMatch(/credencial y no viaja/);
    expect(describeAttachment({ ...patch, omitted: 'otro' }).detail).toContain('«otro»');
  });

  it('las secciones dicen incluido / ausente / omitido y no rellenan lo que falta', () => {
    const estado = (r, id) => describeSections(r.package, r.summary).find((s) => s.id === id).state;
    expect(estado(CANONICAL_VALID, 'revision')).toBe('included');
    expect(estado(CANONICAL_VALID, 'uncommitted')).toBe('included');
    expect(estado(CANONICAL_VALID, 'attachments')).toBe('included');
    const sin = VARIANTS.sinRepositorio();
    expect(estado(sin, 'revision')).toBe('absent');
    expect(describeSections(sin.package, sin.summary).find((s) => s.id === 'revision').detail).toBe('el Attempt no tiene repositorio');
    expect(estado(sin, 'uncommitted')).toBe('absent');
    expect(estado(VARIANTS.adjuntoOmitido(), 'attachments')).toBe('omitted');
    const sinHilo = validVariant((r) => { delete r.package.thread_summary; });
    expect(estado(sinHilo, 'thread_summary')).toBe('absent');
  });

  it('el tamaño y los tokens son una estimación honesta, y un dato ausente es «sin dato», no cero', () => {
    const s = sizeEstimate(CANONICAL_VALID.summary);
    expect(s).toMatchObject({ packageBytes: 2105, package: '2.1 KiB', attachmentsBytes: 4196, approxTokens: 527 });
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB');
    expect(formatBytes(-1)).toBe('—');
    expect(describeTests({ command: 'cargo test' })).toEqual({ command: 'cargo test', passed: 'sin dato', failed: 'sin dato', ignored: 'sin dato' });
    expect(describeTests({ command: 'x', passed: 0, failed: 0 }).passed).toBe('0');
  });
});

describe('superficies de la vista previa · el código no edita la procedencia ni ofrece revelar lo redactado', () => {
  const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const leer = (f) => sinComentarios(readFileSync(resolve(process.cwd(), 'src/ade', f), 'utf8'));

  it('ningún campo de entrada toca `source` y no hay operación de «revelar»', () => {
    const jsx = leer('ContextPreview.jsx');
    const model = leer('contextPreviewModel.js');
    // Solo hay dos entradas (el archivo y el texto del paquete) y ninguna escribe `source`.
    expect((jsx.match(/<input\b/g) ?? []).length).toBe(1);
    expect((jsx.match(/<textarea\b/g) ?? []).length).toBe(1);
    // Ninguna asignación a `source` ni a un campo suyo, ni un estado propio para él.
    expect(jsx).not.toMatch(/\bsource(\.[A-Za-z_]+|\[[^\]]+\])*\s*=(?!=)/);
    expect(jsx).not.toMatch(/\bsetSource\b|\bonSourceChange\b/);
    for (const code of [jsx, model]) expect(code).not.toMatch(/\b(reveal|unredact|mostrarSecreto|showSecret|desredactar)\b/i);
    // El único sitio donde aparece el marcador es el modelo que lo separa y el componente que lo marca.
    expect(jsx).not.toMatch(/onClick=\{[^}]*redact/i);
  });
});
