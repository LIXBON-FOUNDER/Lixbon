// SOLO PARA PRUEBAS. No se importa desde código de producción.
//
// Respuestas de `context_package_preview` (LXO-136): las dos canónicas del Core tal cual (docs/core/fixtures/api/: un paquete
// completo con cambios sin commit y un paquete alterado) más VARIANTES LOCALES sintéticas (`testOnly: true`) derivadas del
// canónico para los estados que la fixture no cubre: parcial, truncado, redactado, adjunto omitido y paquete en el tope de tamaño.
import valid from '../../../../../docs/core/fixtures/api/context_package_preview.v1.json';
import invalid from '../../../../../docs/core/fixtures/api/context_package_preview_invalid.v1.json';

export const CANONICAL_VALID = Object.freeze(valid);
export const CANONICAL_INVALID = Object.freeze(invalid);

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Una copia editable del paquete válido canónico, con su resumen. `edit(response)` la modifica. */
export function validVariant(edit) {
  const r = clone(valid);
  edit?.(r);
  return r;
}

const recount = (r) => {
  const p = r.package;
  const att = p.attachments ?? [];
  r.summary.counts = {
    ...r.summary.counts,
    decisions: p.decisions.length,
    constraints: p.constraints.length,
    files: p.revision ? (p.revision.files ?? []).length : 0,
    untracked: p.uncommitted ? (p.uncommitted.untracked ?? []).length : 0,
    artifacts: (p.artifacts ?? []).length,
    attachments: att.length,
    attachments_omitted: att.filter((a) => a.omitted).length,
    attachments_not_scanned: att.filter((a) => !a.omitted && !a.scanned).length,
    redactions: p.redactions,
    truncated_fields: (p.truncated ?? []).length,
  };
};

export const VARIANTS = Object.freeze({
  /** Sin repositorio: parcial. */
  sinRepositorio: () => validVariant((r) => {
    r.package.revision = null;
    r.package.revision_absent_reason = 'el Attempt no tiene repositorio';
    delete r.package.uncommitted;
    r.summary.completeness = 'partial';
    r.summary.notes = ['revision_absent', 'attachment_not_scanned'];
    recount(r);
  }),
  /** Un campo recortado, dicho explícitamente. */
  truncado: () => validVariant((r) => {
    r.package.truncated = [{ field: 'objective', original: 6000, unit: 'chars' }];
    r.summary.completeness = 'partial';
    r.summary.notes = ['truncated', 'attachment_not_scanned'];
    recount(r);
  }),
  /** Valores redactados: el paquete llega ya con `[redactado]`. */
  redactado: () => validVariant((r) => {
    r.package.objective = 'Entrar con el token [redactado] y revisar la cuota.';
    r.package.decisions = ['La contraseña [redactado] no se guarda.', 'Claude se consulta con `claude -p /usage`.'];
    r.package.redactions = 2;
    r.summary.notes = ['redacted', 'attachment_not_scanned'];
    recount(r);
  }),
  /** Un adjunto no viaja porque tenía un secreto: parcial. */
  adjuntoOmitido: () => validVariant((r) => {
    r.package.attachments[1] = { ...r.package.attachments[1], omitted: 'secret_detected', scanned: true };
    r.summary.completeness = 'partial';
    r.summary.notes = ['attachment_omitted', 'attachment_not_scanned'];
    recount(r);
  }),
  /** En el tope de tamaño del contrato: 500 archivos y 100 sin seguimiento. */
  enElTope: () => validVariant((r) => {
    r.package.revision.files = Array.from({ length: 500 }, (_, i) => ({ path: `src/modulo${i}/archivo.rs`, added: i, deleted: 1 }));
    r.package.uncommitted.untracked = Array.from({ length: 100 }, (_, i) => ({ path: `nuevo/${i}.md`, sha256: 'a'.repeat(64), bytes: 10 + i }));
    recount(r);
    r.summary.serialized_bytes = 61_000;
  }),
});

export const REJECTED = Object.freeze({
  /** Un rechazo de cada motivo del contrato. */
  porCodigo: (code, message = `${code}: motivo de prueba`) => ({ v: 1, status: 'invalid', error: { code, message }, serialized_bytes: 120 }),
});
