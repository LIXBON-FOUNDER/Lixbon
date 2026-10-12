// integrationText.js — textos de la elegibilidad de integración (presentación).
// La regla (¿se puede integrar?) es del Core; hoy vive en orch/canIntegrate.js y pasará al Core con G.
// Los ids `already_merged` y `review_required` son los «resultados no registrados» del vocabulario;
// `attempt_not_done` y `no_branch` son del mock y se confirmarán con el Core.
export const ELIGIBILITY_TEXT = Object.freeze({
  already_merged: 'Ya está integrada.',
  review_required: 'Falta una revisión aceptada sobre el commit actual.',
  attempt_not_done: 'El intento todavía no ha terminado.',
  no_branch: 'El intento no tiene rama que integrar.',
});

export const eligibilityText = (reason) => ELIGIBILITY_TEXT[reason] || (reason ? `No se puede integrar (${reason}).` : '');
