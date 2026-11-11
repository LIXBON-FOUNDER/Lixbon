import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PR_URL_MAX_LEN, sanitizeOrchSnapshot, sanitizePrUrl } from './remotePrUrl';

// Los vectores son los del Core, los de lxo y los de web y mobile: una sola fuente (LXO-243).
const vectors = JSON.parse(readFileSync(new URL('../../../../docs/core/fixtures/pr_url_allowlist.v1.json', import.meta.url), 'utf8'));

describe('sanitizePrUrl: la allowlist del cliente es la del Core', () => {
  it('conserva y limpia lo que el fixture dice', () => {
    expect(PR_URL_MAX_LEN).toBe(vectors.max_len);
    expect(vectors.keep.length).toBeGreaterThanOrEqual(8);
    for (const { raw, clean } of vectors.keep) expect(sanitizePrUrl(raw), JSON.stringify(raw)).toBe(clean);
  });

  it('rechaza lo que el fixture dice', () => {
    expect(vectors.reject.length).toBeGreaterThanOrEqual(25);
    for (const raw of vectors.reject) expect(sanitizePrUrl(raw), JSON.stringify(raw)).toBeNull();
    for (const g of vectors.reject_generated) expect(sanitizePrUrl(g.prefix + g.fill.repeat(g.count)), g.why).toBeNull();
  });

  it('los casos de la aceptación de LXO-243, uno a uno', () => {
    expect(sanitizePrUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizePrUrl('https://bot:SENTINEL@github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(sanitizePrUrl('https://github.com/o/../pull/1')).toBeNull();
    expect(sanitizePrUrl('https://github.com:99999999/o/r/pull/1')).toBeNull();
    expect(sanitizePrUrl(`https://github.com/${'a'.repeat(300)}`)).toBeNull();
  });

  it('lo que no es un texto se descarta', () => {
    for (const raw of [null, undefined, 7, {}, [], true]) expect(sanitizePrUrl(raw)).toBeNull();
  });
});

describe('sanitizeOrchSnapshot', () => {
  it('sanea la pr_url de cada Task sin mutar la entrada', () => {
    const sucia = 'https://bot:SENTINEL@github.com/o/r/pull/1?token=SENTINEL';
    const entrada = { runs: [], tasks: [{ id: 't1', pr_url: sucia }, { id: 't2', pr_url: 'javascript:alert(1)' }, { id: 't3' }] };
    const copia = JSON.parse(JSON.stringify(entrada));
    const salida = sanitizeOrchSnapshot(entrada);
    expect(entrada).toEqual(copia);
    expect(salida.tasks[0].pr_url).toBe('https://github.com/o/r/pull/1');
    expect(salida.tasks[1].pr_url).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(salida.tasks[2], 'pr_url')).toBe(false);
    expect(JSON.stringify(salida)).not.toContain('SENTINEL');
  });

  it('una snapshot sin la forma que se puede sanear no se acepta a medias', () => {
    for (const x of [null, undefined, 'x', 3, [], { runs: [] }, { tasks: [] }, { runs: null, tasks: [] }, { runs: [], tasks: { 0: { id: 'x' } } }, { runs: [], tasks: ['no soy una task'] }]) {
      expect(sanitizeOrchSnapshot(x)).toBeNull();
    }
  });
});
