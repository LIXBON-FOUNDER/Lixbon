import { describe, it, expect } from 'vitest';
import { pulseOf, durationText, MAX_SEGMENTS, PULSE_VARIANTS } from './pulseModel';

// Un Intento con worktree, en el equipo local, con datos de archivos y pruebas. Cada prueba cambia solo lo que prueba.
const attempt = (o = {}) => ({
  id: 'a1', taskId: 't1', provider: 'claude', host: 'desktop', origin: 'ADE', state: 'working', minutes: 18,
  worktree: '/wt/a1', files: 12, tests: { pass: 118, total: 141 }, evidence: { files: 'verified', tests: 'verified' }, ...o,
});
const keys = (p) => p.segments.map((s) => s.key);
const seg = (p, key) => p.segments.find((s) => s.key === key);

describe('Workspace Pulse · modelo', () => {
  it('reduce los estados del Intento a cinco variantes, sin inventar estados', () => {
    const variant = (state) => pulseOf(attempt({ state })).variant;
    expect(PULSE_VARIANTS).toEqual(['working', 'waiting', 'review', 'failed', 'final']);
    expect(['starting', 'working'].map(variant)).toEqual(['working', 'working']);
    expect(['waiting', 'queued', 'paused', 'offline'].map(variant)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(variant('review_ready')).toBe('review');
    expect(variant('failed')).toBe('failed');
    expect(variant('completed')).toBe('final');
  });

  it('un estado fuera del contrato no produce Pulse en vez de adivinar', () => {
    const none = { variant: null, segments: [], hidden: [], label: '' };
    expect(pulseOf(attempt({ state: 'inventado' }))).toEqual(none);
    expect(pulseOf(null)).toEqual(none);
  });

  it('compone la referencia North Star: duración · archivos · tests · proveedor', () => {
    const p = pulseOf(attempt());
    expect(p.segments.map((s) => s.text)).toEqual(['18 min', '12 archivos', 'tests 118/141', 'Claude Code']);
  });

  it('nunca pinta un dato sin respaldo: lo desconocido es «—», no 0 ni el número que traiga el objeto', () => {
    const p = pulseOf(attempt({ state: 'review_ready', evidence: {} }));
    expect(seg(p, 'files')).toMatchObject({ text: 'archivos —', evidence: 'unknown' });
    expect(seg(p, 'tests')).toMatchObject({ text: 'tests —', evidence: 'unknown' });
    expect(p.segments.map((s) => s.text).join(' ')).not.toMatch(/12|118|141|\b0\b/);
  });

  it('en curso omite lo desconocido en vez de llenar la fila de guiones', () => {
    const p = pulseOf(attempt({ state: 'working', evidence: {} }));
    expect(keys(p)).toEqual(['duration', 'provider']);
  });

  it('un total de pruebas 0 o incoherente es desconocido: nunca 0/0 ni 100 %', () => {
    for (const tests of [{ pass: 0, total: 0 }, { pass: 5, total: 3 }, { pass: -1, total: 4 }, { pass: 1.5, total: 4 }, null]) {
      const p = pulseOf(attempt({ state: 'review_ready', tests }));
      expect(seg(p, 'tests')).toMatchObject({ text: 'tests —', evidence: 'unknown' });
    }
  });

  it('lo que dice el agente se marca como tal y no se presenta como verificado', () => {
    const reported = seg(pulseOf(attempt({ evidence: { files: 'verified', tests: 'agent_reported' } })), 'tests');
    const verified = seg(pulseOf(attempt()), 'tests');
    expect(reported.evidence).toBe('agent_reported');
    expect(reported.label).toContain('Lo dice el agente');
    expect(verified.evidence).toBe('verified');
    expect(verified.label).toContain('Verificado por el Core');
    expect(verified.label).not.toContain('Lo dice el agente');
  });

  it('una procedencia fuera del contrato cuenta como desconocida', () => {
    const p = pulseOf(attempt({ state: 'completed', evidence: { files: 'confirmado', tests: true } }));
    expect(seg(p, 'files').evidence).toBe('unknown');
    expect(seg(p, 'tests').evidence).toBe('unknown');
  });

  it('las pruebas que fallan llevan el aviso en el texto accesible, no solo en el color', () => {
    const t = seg(pulseOf(attempt()), 'tests');
    expect(t.alert).toBe(true);
    expect(t.label).toContain('23 fallan');
    expect(seg(pulseOf(attempt({ tests: { pass: 141, total: 141 } })), 'tests').alert).toBeFalsy();
  });

  it('no hay porcentajes ni progreso en ninguna señal', () => {
    for (const state of ['working', 'waiting', 'review_ready', 'failed', 'completed']) {
      const p = pulseOf(attempt({ state }));
      expect(p.segments.map((s) => `${s.text} ${s.label}`).join(' ')).not.toMatch(/%|progreso/i);
    }
  });

  it('sin trabajo todavía (starting, queued) no resume archivos ni pruebas', () => {
    for (const state of ['starting', 'queued']) {
      expect(keys(pulseOf(attempt({ state })))).not.toContain('files');
      expect(keys(pulseOf(attempt({ state })))).not.toContain('tests');
    }
  });

  it('un Intento sin worktree (solo lectura) no cuenta archivos', () => {
    const p = pulseOf(attempt({ state: 'review_ready', worktree: null }));
    expect(keys(p)).not.toContain('files');
  });

  it('cero archivos verificados no es una señal; cero archivos desconocidos sí lo es', () => {
    expect(keys(pulseOf(attempt({ state: 'review_ready', files: 0 })))).not.toContain('files');
    expect(seg(pulseOf(attempt({ state: 'review_ready', files: 0, evidence: {} })), 'files').text).toBe('archivos —');
  });

  it('la duración sin dato o 0 se omite en vez de escribir «0 min»', () => {
    expect(keys(pulseOf(attempt({ minutes: 0 })))).not.toContain('duration');
    expect(keys(pulseOf(attempt({ minutes: undefined })))).not.toContain('duration');
    expect(durationText(NaN)).toBeNull();
    expect(durationText(0.2)).toBeNull();
  });

  it('formatea la duración sin redondeos absurdos', () => {
    expect(durationText(6)).toBe('6 min');
    expect(durationText(59.6)).toBe('1 h');
    expect(durationText(72)).toBe('1 h 12 min');
    expect(durationText(1440)).toBe('1 d');
    expect(durationText(26 * 60 + 5)).toBe('1 d 2 h');
  });

  it('en una fila hija el proveedor no se repite: ya es el título', () => {
    expect(keys(pulseOf(attempt(), { single: false }))).not.toContain('provider');
    expect(keys(pulseOf(attempt(), { single: true }))).toContain('provider');
  });

  it('origen y host solo aparecen cuando no son los de siempre', () => {
    expect(keys(pulseOf(attempt()))).not.toContain('origin');
    expect(keys(pulseOf(attempt()))).not.toContain('host');
    const far = pulseOf(attempt({ origin: 'CLI', host: 'macbook', tests: null }), { single: false });
    expect(seg(far, 'origin').text).toBe('CLI');
    expect(seg(far, 'host').text).toBe('MacBook');
    expect(seg(pulseOf(attempt({ state: 'offline', host: 'laptop' })), 'host').label).toContain('desconectado');
  });

  it(`nunca pasa de ${MAX_SEGMENTS} señales y, si sobran, se queda con las de más peso en el orden de la fila`, () => {
    const p = pulseOf(attempt({ origin: 'CLI', host: 'macbook' }));
    expect(p.segments.length).toBe(MAX_SEGMENTS);
    // Se descartan primero origen y proveedor; el host remoto y las pruebas se quedan.
    expect(keys(p)).toEqual(['duration', 'files', 'tests', 'host']);
  });

  describe('presupuesto de la línea', () => {
    it('reparte lo que cabe por la prioridad de cada variante: working pregunta «cuánto lleva», review «¿está comprobado?»', () => {
      const working = pulseOf(attempt({ state: 'working' }), { budget: 12 }); // solo cabe una señal corta
      expect(keys(working)).toEqual(['duration']);
      const review = pulseOf(attempt({ state: 'review_ready' }), { budget: 20 });
      expect(keys(review)).toEqual(['tests']);
      const failed = pulseOf(attempt({ state: 'failed' }), { budget: 30 });
      expect(keys(failed)).toEqual(['duration', 'tests']);
    });

    it('lo que no cabe no se pierde: queda en `hidden` y en la etiqueta completa', () => {
      const p = pulseOf(attempt({ state: 'working' }), { budget: 12 });
      expect(keys({ segments: p.hidden })).toEqual(['files', 'tests', 'provider']);
      expect(p.label).toContain('Lleva 18 min');
      expect(p.label).toContain('Pruebas: 118 de 141 pasan, 23 fallan');
      expect(p.label).toContain('Archivos cambiados: 12');
    });

    it('se para en la primera señal que no cabe: una menor nunca salta a una mayor que se quedó fuera', () => {
      // En review manda `tests` (16); no cabe en 15, así que tampoco entra `duration` (6 min = 9) aunque sí cupiera.
      const p = pulseOf(attempt({ state: 'review_ready', minutes: 6 }), { budget: 15 });
      expect(p.segments).toEqual([]);
      expect(p.hidden.length).toBeGreaterThan(0);
    });

    it('sin presupuesto solo manda el tope de señales y nada queda oculto por anchura', () => {
      const p = pulseOf(attempt());
      expect(p.hidden.map((s) => s.key)).toEqual([]);
    });

    it('un presupuesto agotado no inventa ni recorta texto: cada señal pintada cabe entera', () => {
      for (const state of ['working', 'waiting', 'review_ready', 'failed', 'completed']) {
        const budget = 22;
        const p = pulseOf(attempt({ state, origin: 'CLI', host: 'macbook' }), { budget });
        const used = p.segments.reduce((n, s) => n + s.text.length + 3, 0);
        expect(used).toBeLessThanOrEqual(budget);
      }
    });
  });

  it('es una función pura: el mismo Intento da el mismo Pulse y no se modifica', () => {
    const a = attempt();
    const copy = JSON.stringify(a);
    expect(pulseOf(a)).toEqual(pulseOf(a));
    expect(JSON.stringify(a)).toBe(copy);
  });

  it('el texto accesible une todas las señales con su procedencia', () => {
    const p = pulseOf(attempt({ state: 'review_ready', evidence: { files: 'verified', tests: 'agent_reported' } }));
    expect(p.label).toContain('Archivos cambiados: 12. Verificado por el Core');
    expect(p.label).toContain('Pruebas: 118 de 141 pasan, 23 fallan. Lo dice el agente');
  });
});
