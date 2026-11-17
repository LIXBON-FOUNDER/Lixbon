import assert from 'node:assert/strict';
import test from 'node:test';
import { usageCard } from './usage.js';

const support = { windows: 'available', tokens: 'available', plan: 'available', credits: 'available', cost: 'available' };
const provider = { provider: 'nuevo', status: 'fresh', support, snapshot: {
  observed_at_ms: 10000, account: 'a12bc34d', provenance: 'provider_query',
  windows: [{ id: 'primary', used_percent: null }],
  models: [{ model: 'm1', input_tokens: null, output_tokens: 0, cost_usd: null }],
} };

test('las métricas desconocidas se distinguen de un cero informado', () => {
  const card = usageCard(provider, { now: 10010 });
  assert.equal(card.windows[0].value, 'Uso sin dato');
  assert.match(card.models[0].tokens, /sin dato entrada · 0 salida/);
  assert.equal(card.models[0].cost, 'sin dato');
  const zero = structuredClone(provider);
  zero.snapshot.windows[0].used_percent = 0;
  zero.snapshot.models[0].cost_usd = 0;
  assert.equal(usageCard(zero).windows[0].value, '0 % usado');
  assert.equal(usageCard(zero).models[0].cost, '0 USD');
});

test('un fallo conserva lo conocido, se marca antiguo y explica la acción', () => {
  const card = usageCard({ ...provider, status: 'stale', error: 'rate_limited' });
  assert.equal(card.status, 'Dato antiguo');
  assert.match(card.error, /Espera/);
  assert.equal(card.models.length, 1);
  assert.equal(usageCard(provider, { now: 400000 }).status, 'Dato antiguo');
});

test('unsupported, unknown y auth error se muestran sin inventar cuotas ni cuentas', () => {
  const unsupported = { provider: 'simple', status: 'unsupported', support: Object.fromEntries(Object.keys(support).map((key) => [key, 'unsupported'])) };
  assert.equal(usageCard(unsupported).status, 'No informa de su uso');
  assert.ok(usageCard(unsupported).metrics.every((metric) => metric.text === 'no soportado'));
  const unknown = usageCard({ provider: 'otro', status: 'unknown', support, error: 'auth_required' });
  assert.equal(unknown.status, 'Sin datos de uso');
  assert.match(unknown.error, /Inicia sesión/);
  assert.equal(unknown.account, null);
});
