/**
 * Modelo de la vista previa de un ContextPackage (LXO-136): de la respuesta del Core a lo que la interfaz muestra. Puro y sin
 * dependencias de React ni de Tauri.
 *
 * REGLAS (las invariantes de la issue, comprobadas en `contextPreviewModel.test.js` y `ContextPreview.test.jsx`):
 * 1. La vista refleja EXACTAMENTE el paquete: lo que se lista sale de `response.package` sin recortar ni reordenar; aquí solo se
 *    formatea. Nada se completa: un campo ausente se dice «ausente», no se rellena.
 * 2. Lo redactado nunca se revela. `[redactado]` se marca como tal y no hay ninguna operación que lo muestre: el Core tampoco
 *    tiene el original.
 * 3. Un recorte se muestra EXPLÍCITO (campo, cuánto había y en qué unidad), no se deja que parezca el texto completo.
 * 4. La procedencia (`source`) es de solo lectura: ninguna función de este módulo la construye ni la modifica.
 * 5. Un paquete inválido no tiene contenido que mostrar: solo el motivo y, si es de identidad, los dos hashes.
 */

export const REDACTED_MARK = '[redactado]';

/** Copia de cada motivo de rechazo de `parse`. Un código que el contrato no define no llega aquí (el contrato lo rechaza). */
export const ERROR_COPY = Object.freeze({
  invalid_json: { title: 'No es un JSON válido', help: 'El archivo no se puede leer como JSON. Comprueba que es un paquete exportado y no un texto cortado.' },
  unsupported_version: { title: 'Versión del paquete no compatible', help: 'Es de una versión que esta versión de Lixbon no entiende. No se interpreta con las reglas de otra.' },
  missing_field: { title: 'Le falta un campo obligatorio', help: 'Un ContextPackage v1 tiene siempre su origen, su objetivo, sus decisiones y su evidencia.' },
  invalid_field: { title: 'Un campo no cumple el formato', help: 'Hay un campo con un formato, una ruta o un tamaño que el contrato no admite.' },
  id_mismatch: { title: 'El paquete se alteró', help: 'Su contenido no coincide con su identidad (el hash con el que se creó). No se debe usar para continuar un trabajo.' },
  too_large: { title: 'Pesa más de lo que admite', help: 'Un paquete v1 no pasa de 64 KiB sin contar los adjuntos.' },
  secret_detected: { title: 'Contiene algo con forma de credencial', help: 'Un paquete llega ya redactado. Este no: no se muestra y no se debe compartir.' },
  attachment_mismatch: { title: 'Los adjuntos no coinciden', help: 'Los adjuntos que declara no son los que llegan.' },
});

/** Lo que el Core avisa sobre un paquete válido. El tono acompaña; lo que distingue es el texto y el glifo. */
export const NOTE_COPY = Object.freeze({
  truncated: { label: 'Truncado', tone: 'warn', glyph: '✂', help: 'Algún campo se recortó al crear el paquete. Abajo dice cuál y cuánto había.' },
  redacted: { label: 'Redactado', tone: 'info', glyph: '▮', help: 'Algún valor se ocultó al crear el paquete. No hay forma de verlo desde aquí.' },
  revision_absent: { label: 'Sin repositorio', tone: 'warn', glyph: '∅', help: 'El Attempt no tenía repositorio: el paquete no trae evidencia de código verificable.' },
  attachment_omitted: { label: 'Adjunto omitido', tone: 'warn', glyph: '⊘', help: 'Un adjunto no viaja porque tenía algo con forma de credencial.' },
  attachment_not_scanned: { label: 'Adjunto sin escanear', tone: 'warn', glyph: '?', help: 'Un adjunto va comprimido (git bundle) y no se pudo buscar secretos en él.' },
});

/** Los avisos con una forma estable. Se arman a partir de la respuesta; no se infiere nada que el Core no diga. */
export function statusBadges(response) {
  if (response.status === 'invalid') {
    return [{ id: 'invalid', label: 'Inválido', tone: 'danger', glyph: '✕', help: ERROR_COPY[response.error.code]?.help ?? '' }];
  }
  const partial = response.summary.completeness === 'partial';
  const base = partial
    ? { id: 'partial', label: 'Parcial', tone: 'warn', glyph: '◐', help: 'Falta algo que quien reciba el paquete necesitaría: mira los avisos.' }
    : { id: 'complete', label: 'Completo', tone: 'good', glyph: '●', help: 'No falta nada que el paquete deba traer.' };
  return [base, ...response.summary.notes.map((n) => ({ id: n, ...NOTE_COPY[n] }))];
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.0', '')} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.0', '')} MiB`;
}

/**
 * Cuánto pesa lo que viajaría. Los tokens son una ESTIMACIÓN gruesa (4 bytes por token): sirve para comparar paquetes, no para
 * facturar. Los adjuntos no entran en el mensaje con que arranca el siguiente Attempt: se cuentan aparte.
 */
export function sizeEstimate(summary) {
  return {
    packageBytes: summary.serialized_bytes,
    package: formatBytes(summary.serialized_bytes),
    attachmentsBytes: summary.counts.attachments_bytes,
    attachments: formatBytes(summary.counts.attachments_bytes),
    approxTokens: Math.ceil(summary.serialized_bytes / 4),
  };
}

/** `[redactado]` separado del resto del texto, para marcarlo sin ofrecer nunca mostrar lo que había. */
export function splitRedacted(text) {
  if (typeof text !== 'string' || text === '') return [];
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    const i = rest.indexOf(REDACTED_MARK);
    if (i === -1) { parts.push({ text: rest, redacted: false }); break; }
    if (i > 0) parts.push({ text: rest.slice(0, i), redacted: false });
    parts.push({ text: REDACTED_MARK, redacted: true });
    rest = rest.slice(i + REDACTED_MARK.length);
  }
  return parts;
}

const OMITTED_COPY = Object.freeze({ secret_detected: 'tenía algo con forma de credencial y no viaja' });

/** Cada adjunto, con lo que dice el paquete de él. Nada de su contenido: solo lo declarado. */
export function describeAttachment(a) {
  const omitted = typeof a.omitted === 'string';
  let state;
  let detail;
  if (omitted) {
    state = 'omitted';
    detail = `Omitido: ${OMITTED_COPY[a.omitted] ?? `motivo «${a.omitted}»`}.`;
  } else if (!a.scanned) {
    state = 'unscanned';
    detail = 'Viaja, pero no se pudo buscar secretos en él (va comprimido).';
  } else {
    state = 'included';
    detail = 'Viaja y se buscó secretos en su contenido: no se encontró ninguno.';
  }
  const KIND = { git_bundle: 'git bundle', patch: 'parche', file: 'archivo' };
  return { id: a.id, kind: KIND[a.kind] ?? a.kind, bytes: a.bytes, size: formatBytes(a.bytes), sha256: a.sha256, state, detail };
}

/** Un recorte, dicho sin adornos: qué campo, cuánto había y en qué unidad. */
export function describeTruncation(t) {
  const unit = t.unit === 'items' ? 'elementos' : 'caracteres';
  return { field: t.field, original: t.original, text: `«${t.field}» se recortó: tenía ${t.original} ${unit}.` };
}

/**
 * Qué secciones trae el paquete y cuáles no. `included` / `absent` / `omitted`: un campo opcional que el paquete no trae es
 * «ausente» (no se rellena), y un adjunto que no viaja es «omitido».
 */
export function describeSections(pkg, summary) {
  const rev = pkg.revision;
  const unc = pkg.uncommitted;
  const hasUnc = Boolean(unc && (unc.staged_patch || unc.unstaged_patch || (unc.untracked ?? []).length > 0));
  const att = pkg.attachments ?? [];
  const omitted = att.filter((a) => typeof a.omitted === 'string').length;
  const sec = (id, label, state, detail = '') => ({ id, label, state, detail });
  return [
    sec('objective', 'Objetivo', pkg.objective ? 'included' : 'absent'),
    sec('decisions', 'Decisiones', pkg.decisions.length ? 'included' : 'absent', `${pkg.decisions.length}`),
    sec('constraints', 'Restricciones', pkg.constraints.length ? 'included' : 'absent', `${pkg.constraints.length}`),
    sec('thread_summary', 'Resumen del hilo', pkg.thread_summary ? 'included' : 'absent'),
    sec('revision', 'Revisión de código', rev ? 'included' : 'absent', rev ? `${(rev.files ?? []).length} archivos` : (pkg.revision_absent_reason ?? '')),
    sec('uncommitted', 'Cambios sin commit', hasUnc ? 'included' : 'absent'),
    sec('test_results', 'Resultado de pruebas', pkg.test_results ? 'included' : 'absent'),
    sec('artifacts', 'Artefactos', (pkg.artifacts ?? []).length ? 'included' : 'absent', `${(pkg.artifacts ?? []).length}`),
    sec('attachments', 'Adjuntos', att.length === 0 ? 'absent' : omitted > 0 ? 'omitted' : 'included', att.length ? `${att.length - omitted} de ${att.length} viajan` : ''),
  ].map((s) => ({ ...s, counts: summary.counts }));
}

/** Resumen de las pruebas para una frase. Un número ausente es «sin dato», nunca cero. */
export function describeTests(t) {
  const n = (v) => (v === undefined || v === null ? 'sin dato' : String(v));
  return { command: t.command, passed: n(t.passed), failed: n(t.failed), ignored: n(t.ignored) };
}
