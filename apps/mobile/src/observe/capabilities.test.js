import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capabilitySummary } from './capabilities.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/core/fixtures/api/provider_capabilities.v1.json', import.meta.url)));

test('distingue unsupported, unavailable, blocked y available desde la matriz del Core', () => {
  const partial = fixture.providers.find((p) => p.id === 'fake-parcial');
  const rows = capabilitySummary({ capabilities: partial.matrix.capabilities });
  assert.equal(rows.find((r) => r.key === 'resume').stateLabel, 'No disponible ahora');
  assert.equal(rows.find((r) => r.key === 'steer').stateLabel, 'No soportado');
  const blocked = fixture.providers.find((p) => p.id === 'fake-bloqueado');
  assert.ok(capabilitySummary({ capabilities: blocked.matrix.capabilities }).every((r) => r.stateLabel === 'Bloqueado por el entorno'));
  assert.ok(capabilitySummary(null).every((r) => r.stateLabel === 'Sin información'));
});

test('reanudar requiere la sesión de ese intento y un perfil permitido', () => {
  const capabilities = { resume: { state: 'available' } };
  assert.match(capabilitySummary({ capabilities })[0].detail, /no tiene una sesión/);
  assert.equal(capabilitySummary({ capabilities })[0].stateLabel, 'No disponible ahora');
  assert.match(capabilitySummary({ capabilities, session: { bound: true, resumable: true } })[0].detail, /Sesión nativa disponible/);
  assert.match(capabilitySummary({ capabilities, profile_block: 'windows_sandbox_elevated' })[0].detail, /sandbox/);
  assert.equal(capabilitySummary({ capabilities, profile_block: 'windows_sandbox_elevated' })[0].stateLabel, 'Bloqueado por el entorno');
});
