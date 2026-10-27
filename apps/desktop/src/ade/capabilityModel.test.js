import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_LABELS, STATE_GLYPHS, STATE_LABELS, STATE_SHORT, STATE_TONES, blockText, canDo, describeAll, describeCapability, describeEnvironment, providerOf, resumeAvailability,
} from './capabilityModel';
import { CAPABILITIES, CAPABILITY_STATES } from './providerCapabilitiesContract';
import { CANONICAL_SNAPSHOT, blocked, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-135 · las invariantes de la issue, comprobadas sobre el modelo y sobre el CÓDIGO de las superficies migradas.
const snapshot = liveWith(CANONICAL_SNAPSHOT.providers);

describe('capabilityModel · una acción solo se habilita si el Core la declara available', () => {
  it('para cada proveedor y capability de la fixture canónica, enabled ⇔ available (y nada más)', () => {
    let vistas = 0;
    for (const p of CANONICAL_SNAPSHOT.providers) {
      for (const capability of CAPABILITIES) {
        const declared = p.matrix.capabilities[capability].state;
        const info = describeCapability(p, capability);
        expect(info.state).toBe(declared);
        expect(info.enabled).toBe(declared === 'available');
        expect(canDo(snapshot, p.id, capability)).toBe(declared === 'available');
        vistas += 1;
      }
    }
    expect(vistas).toBe(3 * 6);
  });

  it('un proveedor que el Core no informa es «sin información» y NO habilita nada', () => {
    for (const capability of CAPABILITIES) {
      const info = describeCapability(providerOf(snapshot, 'proveedor-nuevo'), capability, 'proveedor-nuevo');
      expect(info).toMatchObject({ state: 'unknown', enabled: false });
      expect(canDo(snapshot, 'proveedor-nuevo', capability)).toBe(false);
    }
    expect(describeCapability(null, 'resume', 'x').reason).toMatch(/todavía no informa/);
    expect(canDo(null, 'x', 'start')).toBe(false);
    expect(canDo(undefined, undefined, 'start')).toBe(false);
  });

  it('el proveedor se busca por id EXACTO: un id parecido no sirve, ni por nombre ni por versión', () => {
    const snap = liveWith([provider('claude-local', { steer: 'unsupported' })]);
    expect(providerOf(snap, 'claude')).toBeNull();
    expect(canDo(snap, 'claude', 'start')).toBe(false);
    expect(canDo(snap, 'claude-local', 'start')).toBe(true);
    expect(canDo(snap, 'claude-local', 'steer')).toBe(false);
    // Mayúsculas, espacios y prefijos tampoco "se arreglan".
    for (const raro of ['Claude-local', ' claude-local', 'claude-loca', 'claude-local ']) expect(providerOf(snap, raro)).toBeNull();
  });

  it('un estado o una capability que el contrato no define se trata como desconocido y deshabilitado', () => {
    const raro = provider('p', { start: 'quizas' });
    expect(describeCapability(raro, 'start')).toMatchObject({ state: 'unknown', enabled: false });
    expect(describeCapability(provider('p'), 'teletransporte')).toMatchObject({ state: 'unknown', enabled: false });
    expect(describeCapability({ id: 'p', matrix: { capabilities: {} } }, 'start')).toMatchObject({ state: 'unknown', enabled: false });
  });

  it('describeAll devuelve las seis, en orden, con etiqueta y ayuda', () => {
    const all = describeAll(providerOf(snapshot, 'fake-completo'));
    expect(all.map((c) => c.capability)).toEqual(CAPABILITIES);
    for (const c of all) {
      expect(c.label).toBe(CAPABILITY_LABELS[c.capability]);
      expect(c.help.length).toBeGreaterThan(10);
    }
  });
});

describe('capabilityModel · los estados se distinguen y un bloqueo de entorno no es un fallo', () => {
  it('los cuatro estados tienen texto, glifo y tono propios (no dependen solo del color)', () => {
    for (const campo of [STATE_LABELS, STATE_GLYPHS, STATE_TONES]) {
      const valores = [...CAPABILITY_STATES, 'unknown'].map((s) => campo[s]);
      expect(new Set(valores).size).toBe(valores.length);
    }
    // El estado corto de las tablas tampoco se repite entre estados.
    const cortos = [...CAPABILITY_STATES, 'unknown'].map((s) => STATE_SHORT[s]);
    expect(new Set(cortos).size).toBe(cortos.length);
    // Ningún estado de capability usa el tono de peligro: ausente o bloqueado NO es un fallo.
    for (const s of [...CAPABILITY_STATES, 'unknown']) expect(STATE_TONES[s]).not.toBe('danger');
  });

  it('el motivo de cada estado explica por qué la acción no está', () => {
    const p = provider('x', { steer: 'unsupported', interrupt: { state: 'unavailable', reason: 'sin iniciar sesión' }, answer: { state: 'environment_blocked', block: 'cli_missing' } });
    expect(describeCapability(p, 'steer').reason).toMatch(/no la tiene/);
    expect(describeCapability(p, 'interrupt').reason).toMatch(/no está disponible ahora: sin iniciar sesión/);
    const bloqueada = describeCapability(p, 'answer');
    expect(bloqueada.reason).toMatch(/bloqueada por el entorno: no se encuentra la CLI del proveedor/);
    expect(bloqueada.reason).toMatch(/No es un intento fallido/);
    expect(bloqueada.enabled).toBe(false);
  });

  it('un bloqueo de entorno desconocido se nombra por su código, no se inventa', () => {
    expect(blockText('cli_missing')).toMatch(/CLI/);
    expect(blockText('windows_sandbox_setup')).toMatch(/sandbox de Windows/);
    expect(blockText('algo_nuevo')).toContain('algo_nuevo');
  });

  it('describeEnvironment: listo, bloqueado con sus textos, o sin información', () => {
    expect(describeEnvironment(providerOf(snapshot, 'fake-completo'))).toMatchObject({ state: 'ready', blocks: [] });
    const env = describeEnvironment(providerOf(snapshot, 'fake-bloqueado'));
    expect(env.state).toBe('blocked');
    expect(env.blocks).toEqual([{ code: 'cli_missing', text: expect.stringMatching(/CLI/) }]);
    expect(describeEnvironment(null).state).toBe('unknown');
  });
});

describe('capabilityModel · resume badge', () => {
  const conResume = provider('p');
  const session = (over = {}) => ({ id: 'ps-1', opened_by_attempt_id: 'a-1', binding: 'stream_json', bound: true, resumable: true, status: 'idle', ...over });

  it('Reanudable solo si el proveedor ofrece resume Y la sesión está en espera, vinculada y es reanudable', () => {
    expect(resumeAvailability(conResume, session())).toMatchObject({ kind: 'resumable', enabled: true });
    const otros = [
      [session({ status: 'open' }), 'in_use'],
      [session({ status: 'closed' }), 'closed'],
      [session({ resumable: false }), 'not_resumable'],
      [session({ bound: false }), 'not_bound'],
      [null, 'no_session'],
    ];
    for (const [s, kind] of otros) expect(resumeAvailability(conResume, s)).toMatchObject({ kind, enabled: false });
  });

  it('si el proveedor no ofrece resume, ninguna sesión lo hace reanudable (se dice por qué)', () => {
    const casos = [
      [provider('p', { resume: 'unsupported' }), 'unsupported'],
      [provider('p', { resume: { state: 'unavailable', reason: 'versión sin validar' } }), 'unavailable'],
      [blocked('p'), 'environment_blocked'],
      [null, 'unknown'],
    ];
    for (const [p, kind] of casos) {
      const r = resumeAvailability(p, session(), 'p');
      expect(r).toMatchObject({ kind, enabled: false });
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

// «No ramas por engine en componentes migrados»: se comprueba el CÓDIGO, no la intención.
describe('superficies migradas · ninguna rama por nombre de proveedor', () => {
  const FILES = [
    'capabilityModel.js', 'providerCapabilitiesContract.js', 'useProviderCapabilities.js',
    'CapabilityBadge.jsx', 'AttemptCapabilities.jsx', 'ProviderInspector.jsx',
  ];
  const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('el código no nombra ningún proveedor ni compara engine/provider con un literal', () => {
    for (const file of FILES) {
      const code = sinComentarios(readFileSync(resolve(process.cwd(), 'src/ade', file), 'utf8'));
      expect(code, file).not.toMatch(/\b(claude|codex|anthropic|openai|gpt|opus|sonnet|haiku|mimo|lixbon-cli)\b/i);
      expect(code, file).not.toMatch(/\bengine\s*[!=]==?\s*['"`]/);
      expect(code, file).not.toMatch(/(?<!typeof\s)\b(provider|providerId|id)\s*[!=]==?\s*['"`]/);
    }
  });
});
