import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissSheet, sheetDrag } from './motion.js';
test('gestos de hoja: distancia lenta y velocidad en px/ms', () => {
  assert.equal(dismissSheet(120, 0.1), true);
  assert.equal(dismissSheet(119, 0.1), false);
  assert.equal(dismissSheet(60, 0.1), false);
  assert.equal(dismissSheet(60, 0.41), true);
  assert.equal(dismissSheet(60, 0.4), false);
  assert.equal(dismissSheet(-30, -1), false);
});
test('arrastre hacia arriba tiene fricción; hacia abajo sigue el dedo', () => {
  assert.equal(sheetDrag(60), 60);
  assert.equal(sheetDrag(-60), -12);
});
