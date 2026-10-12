// helpers.js — utilidades SOLO para pruebas del ADE (no se importan desde código de producción).
import { createMockAdeClient } from '../client/MockAdeClient';
import { createFixtures } from '../mock/fixtures';

/** Instante fijo para que «hace 5 min» y las cuentas atrás sean deterministas. */
export const NOW = Date.parse('2026-10-12T10:00:00Z');
export const fixedNow = () => NOW;

export function makeClient(opts = {}) {
  return createMockAdeClient({ now: fixedNow, ...opts });
}

export const makeFixtures = () => createFixtures(NOW);
