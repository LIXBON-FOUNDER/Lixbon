import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_NOTES, contextSize, portabilityText } from './contextSummary.js';

test('un paquete alterado o ausente no se ofrece para transferir', () => {
  assert.match(portabilityText({ status: 'invalid' }), /rechazó/);
  assert.match(portabilityText({ status: 'absent' }), /no hay/);
  assert.match(portabilityText({ status: 'valid', portability: 'partial' }), /parcial/);
  assert.match(portabilityText({ status: 'valid', portability: 'attachments_not_verified' }), /deben comprobarse/);
});

test('redacción, recortes y tamaño de adjuntos se muestran explícitos', () => {
  assert.match(CONTEXT_NOTES.redacted, /ocultaron/);
  assert.match(CONTEXT_NOTES.truncated, /recortados/);
  assert.equal(contextSize(0), '0 B');
  assert.equal(contextSize(null), 'Sin dato');
  assert.equal(contextSize(3 * 1024 * 1024), '3.0 MiB');
});
