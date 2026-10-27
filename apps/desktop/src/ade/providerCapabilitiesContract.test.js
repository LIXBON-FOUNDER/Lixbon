import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, CAPABILITY_STATES, PROVIDER_CAPABILITIES_QUERY_SPECS, validateProviderCapabilities, validateRegistrySnapshot,
} from './providerCapabilitiesContract';
import { ADE_QUERY_NAMES } from './coreQueries';
import { CANONICAL_SNAPSHOT, PROBING, blocked, live, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-135 · el contrato cliente de `provider_capabilities` contra la fixture canónica del Core y variantes que debe rechazar.
const clone = (v) => JSON.parse(JSON.stringify(v));
const reject = (response) => expect(() => validateProviderCapabilities(response)).toThrow(/ade_query_invalid_response: provider_capabilities/);

describe('provider_capabilities · contrato cliente', () => {
  it('acepta la fixture canónica del Core (snapshot) y la lectura viva construida sobre ella', () => {
    expect(validateRegistrySnapshot(CANONICAL_SNAPSHOT)).toBe(CANONICAL_SNAPSHOT);
    const response = live();
    expect(validateProviderCapabilities(response)).toBe(response);
    // Los tres proveedores canónicos cubren completo, parcial y bloqueado por el entorno.
    expect(response.providers.map((p) => p.id)).toEqual(['fake-bloqueado', 'fake-completo', 'fake-parcial']);
  });

  it('acepta el primer sondeo: sin proveedores, sin hora y refrescando', () => {
    expect(validateProviderCapabilities(PROBING)).toBe(PROBING);
  });

  it('la matriz trae SIEMPRE las seis capabilities y el vocabulario es cerrado', () => {
    expect(CAPABILITIES).toEqual(['start', 'events', 'answer', 'interrupt', 'steer', 'resume']);
    expect(CAPABILITY_STATES).toEqual(['available', 'unsupported', 'unavailable', 'environment_blocked']);
    for (const p of live().providers) expect(Object.keys(p.matrix.capabilities).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('rechaza lo que no es del contrato, sin completarlo ni reinterpretarlo', () => {
    reject(null);
    reject([]);
    reject({ ...live(), version: 2 });
    reject({ ...live(), generation: -1 });
    reject({ ...live(), generation: 1.5 });
    reject({ ...live(), providers: 'no' });
    reject({ ...live(), status: 'listo' });
    reject({ ...live(), refreshing: 'si' });
    reject({ ...live(), checked_at_ms: -3 });
    reject({ ...live(), checked_at_ms: undefined });

    const sinCapability = live();
    delete sinCapability.providers[1].matrix.capabilities.steer;
    reject(sinCapability); // una capability que falta NO es «no soportada»: es una respuesta inválida

    const estadoNuevo = live();
    estadoNuevo.providers[1].matrix.capabilities.steer = { state: 'quizas' };
    reject(estadoNuevo);

    const sinMotivo = live();
    sinMotivo.providers[1].matrix.capabilities.resume = { state: 'unavailable' };
    reject(sinMotivo);

    const sinBloqueo = live();
    sinBloqueo.providers[0].matrix.capabilities.start = { state: 'environment_blocked' };
    reject(sinBloqueo);

    const entornoSinBloqueos = live();
    entornoSinBloqueos.providers[0].environment = { state: 'blocked' };
    reject(entornoSinBloqueos);

    const otroEntorno = live();
    otroEntorno.providers[1].environment = { state: 'quemado' };
    reject(otroEntorno);

    const matrizNueva = live();
    matrizNueva.providers[1].matrix.version = 2;
    reject(matrizNueva);

    reject(liveWith([provider('a'), provider('a')]));
    reject(liveWith([{ ...provider('a'), id: '' }]));
  });

  it('una capability extra que el cliente no conoce no tumba la lectura (no se muestra, tampoco se usa)', () => {
    const extra = clone(live());
    extra.providers[1].matrix.capabilities.teletransporte = { state: 'available' };
    expect(() => validateProviderCapabilities(extra)).not.toThrow();
  });

  it('un proveedor bloqueado y uno con motivo se aceptan', () => {
    expect(() => validateProviderCapabilities(liveWith([blocked('x'), provider('y', { resume: { state: 'unavailable', reason: 'sin login' } })]))).not.toThrow();
  });

  it('la query está en la tabla del ADE y la petición solo lleva refresh cuando se pide', () => {
    expect(ADE_QUERY_NAMES).toContain('provider_capabilities');
    const spec = PROVIDER_CAPABILITIES_QUERY_SPECS.provider_capabilities;
    expect(spec.request({})).toEqual({});
    expect(spec.request(undefined)).toEqual({});
    expect(spec.request({ refresh: 'si' })).toEqual({});
    expect(spec.request({ refresh: true })).toEqual({ refresh: true });
  });
});
