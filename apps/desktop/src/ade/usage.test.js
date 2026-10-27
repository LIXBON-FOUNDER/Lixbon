import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_KINDS, USAGE_QUERY_SPECS, USAGE_STATUSES, validateUsageReport, validateUsageResponse } from './usageContract';
import {
  ERROR_COPY, STATUS_INFO, ageText, describeProvider, filterOptions, filterReport, formatCost, formatDuration, formatTokens, percentOf, resetText, supportList, windowLabel,
} from './usageModel';
import { ADE_QUERY_NAMES } from './coreQueries';
import { CANONICAL_REPORT, LOADING, NOW, PROVIDERS, live, report } from './testFixtures/usageFixtures';

// LXO-206 · contrato y modelo de la vista de Usage contra el informe canónico del Core y variantes que debe rechazar o distinguir.
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (r) => expect(() => validateUsageResponse(r)).toThrow(/ade_query_invalid_response: usage_report/);

describe('usage_report · contrato cliente', () => {
  it('acepta el informe canónico del Core, su respuesta viva, el primer sondeo y cada variante', () => {
    expect(validateUsageReport(CANONICAL_REPORT)).toBe(CANONICAL_REPORT);
    const r = live();
    expect(validateUsageResponse(r)).toBe(r);
    expect(validateUsageResponse(LOADING)).toBe(LOADING);
    for (const make of Object.values(PROVIDERS)) expect(() => validateUsageReport(report([make()]))).not.toThrow();
    // La fixture cubre los cuatro tipos de proveedor que el contrato distingue.
    expect(CANONICAL_REPORT.providers.map((p) => p.status)).toEqual(['fresh', 'fresh', 'unknown', 'unsupported']);
  });

  it('el vocabulario del contrato es cerrado y completo', () => {
    expect(USAGE_STATUSES).toEqual(['fresh', 'stale', 'unknown', 'unsupported', 'environment_blocked']);
    expect(ERROR_KINDS).toEqual(['auth_required', 'rate_limited', 'provider_unavailable', 'unsupported', 'environment_blocked', 'internal']);
    for (const s of USAGE_STATUSES) expect(STATUS_INFO[s].label.length).toBeGreaterThan(3);
    for (const k of ERROR_KINDS) expect(ERROR_COPY[k].length).toBeGreaterThan(10);
  });

  it('rechaza lo que no es del contrato, sin completarlo ni reinterpretarlo', () => {
    bad(null);
    bad({ ...live(), v: 2 });
    bad({ ...live(), status: 'casi' });
    bad({ ...live(), refreshing: 'si' });
    bad({ ...LOADING, report: CANONICAL_REPORT }); // «cargando» no trae informe
    bad({ ...live(), report: null });
    bad(live(report([PROVIDERS.alLimite()], { version: 2 })));
    bad(live(report([PROVIDERS.alLimite()], { generated_at_ms: -1 })));
    const mut = (fn) => { const r = clone(live()); fn(r.report); bad(r); };
    mut((r) => { r.providers[0].status = 'brillante'; });
    mut((r) => { delete r.providers[0].support.fields.cost; }); // lo que no se ofrece se declara `unsupported`, no se omite
    mut((r) => { r.providers[0].support.fields.cost = { state: 'quizas' }; });
    mut((r) => { r.providers[0].snapshot.windows[0].used_percent = 150; });
    mut((r) => { r.providers[0].snapshot.windows[0].used_percent = -1; });
    mut((r) => { r.providers[0].snapshot.provenance = 'adivinado'; });
    mut((r) => { r.providers[0].snapshot.provider = 'otro-distinto'; });
    mut((r) => { r.providers[0].snapshot.models[0].cost_usd = -3; });
    mut((r) => { r.providers[2].error.kind = 'explotó'; });
    mut((r) => { r.providers.push(clone(r.providers[0])); }); // un proveedor repetido
    mut((r) => { delete r.providers[0].snapshot; }); // fresh sin snapshot
    mut((r) => { r.providers[3].snapshot = clone(r.providers[0].snapshot); r.providers[3].snapshot.provider = 'minimo'; }); // unsupported con snapshot
    mut((r) => { r.providers[2].snapshot = clone(r.providers[0].snapshot); r.providers[2].snapshot.provider = 'otro'; }); // unknown con snapshot
  });

  it('la query está en la tabla del ADE y la petición solo lleva refresh cuando se pide', () => {
    expect(ADE_QUERY_NAMES).toContain('usage_report');
    const spec = USAGE_QUERY_SPECS.usage_report;
    expect(spec.request({})).toEqual({});
    expect(spec.request(undefined)).toEqual({});
    expect(spec.request({ refresh: 'si' })).toEqual({});
    expect(spec.request({ refresh: true })).toEqual({ refresh: true });
  });
});

describe('usageModel · desconocido no es cero y la frescura se ve', () => {
  it('un porcentaje que el proveedor no dio es «sin dato», no 0; un 0 real sí se muestra', () => {
    expect(percentOf({ id: 'five_hour' })).toEqual({ known: false, value: null, high: false, label: 'sin dato' });
    expect(percentOf({ id: 'x', used_percent: 0 })).toMatchObject({ known: true, value: 0, label: '0 % usado' });
    expect(percentOf({ id: 'x', used_percent: 12.34 }).label).toBe('12.3 % usado');
    expect(percentOf({ id: 'x', used_percent: 90 }).high).toBe(true);
    expect(percentOf({ id: 'x', used_percent: 89.9 }).high).toBe(false);
  });

  it('tokens y coste ausentes son «sin dato»; un cero que sí llegó es 0', () => {
    expect(formatTokens(undefined)).toBe('sin dato');
    expect(formatTokens(null)).toBe('sin dato');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(12_345)).toBe('12.345');
    expect(formatTokens(4200)).toBe('4.200'); // también los de cuatro cifras: la columna se lee igual
    expect(formatCost(undefined)).toBe('sin dato');
    expect(formatCost(0)).toBe('0.000 USD');
    expect(formatCost(0.0123)).toBe('0.012 USD');
    expect(formatCost(3.5)).toBe('3.50 USD');
  });

  it('la hora de reinicio se dice relativa, o «desconocida»; nunca se inventa', () => {
    expect(resetText({ id: 'x' }, NOW)).toEqual({ known: false, text: 'hora de reinicio desconocida', iso: null });
    expect(resetText({ id: 'x', resets_at: NOW / 1000 + 600 }, NOW).text).toBe('se reinicia en 10 min');
    expect(resetText({ id: 'x', resets_at: NOW / 1000 + 5400 }, NOW).text).toBe('se reinicia en 1 h 30 min');
    expect(resetText({ id: 'x', resets_at: NOW / 1000 + 86400 * 2 + 3600 }, NOW).text).toBe('se reinicia en 2 d 1 h');
    expect(resetText({ id: 'x', resets_at: NOW / 1000 - 5 }, NOW).text).toBe('ya debería haberse reiniciado');
    expect(resetText({ id: 'x', resets_at: NOW / 1000 + 600 }, NOW).iso).toMatch(/^20\d\d-/);
  });

  it('la edad del dato es sobre cuándo se observó, no sobre cuándo se pintó', () => {
    expect(ageText(NOW - 10_000, NOW)).toBe('hace unos segundos');
    expect(ageText(NOW - 120_000, NOW)).toBe('hace 2 min');
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('hace 3 h');
    expect(ageText(NOW - 2 * 86_400_000, NOW)).toBe('hace 2 d');
    expect(ageText(NOW + 5000, NOW)).toBe('hace unos segundos'); // un reloj adelantado no da edades negativas
  });

  it('cada estado tiene su explicación, su frescura y, si falló, el motivo; ninguno usa el tono de peligro', () => {
    const d = (p) => describeProvider(p, NOW);
    expect(d(PROVIDERS.antiguoPorFallo())).toMatchObject({ status: 'stale', tone: 'warn' });
    expect(d(PROVIDERS.antiguoPorFallo()).headline).toBe('No se pudo actualizar: El proveedor pide iniciar sesión. Se muestra el último dato.');
    expect(d(PROVIDERS.antiguoPorFallo()).freshness.age).toBe('hace 1 h');
    expect(d(PROVIDERS.sinDatos()).headline).toBe('Sin datos de uso: El proveedor limita las consultas de uso: se reintentará más tarde.');
    expect(d(PROVIDERS.sinDatos()).freshness).toBeNull();
    expect(d({ provider: 'x', status: 'unsupported', support: PROVIDERS.sinDatos().support }).headline).toMatch(/No es un fallo/);
    expect(d(PROVIDERS.bloqueado()).headline).toMatch(/No es un fallo del proveedor/);
    expect(d(PROVIDERS.alLimite()).freshness).toMatchObject({ source: 'consulta al proveedor', provenance: 'provider_query' });
    expect(d(PROVIDERS.sinPorcentaje()).freshness.source).toBe('lo último que dijo durante una ejecución');
    for (const s of USAGE_STATUSES) expect(STATUS_INFO[s].tone).not.toBe('danger');
    // Cada estado se distingue por texto y glifo.
    for (const campo of ['label', 'glyph']) expect(new Set(USAGE_STATUSES.map((s) => STATUS_INFO[s][campo])).size).toBe(USAGE_STATUSES.length);
  });

  it('las ventanas se nombran con lo que el Core normaliza y un id raro se muestra tal cual', () => {
    expect(windowLabel({ id: 'five_hour', minutes: 300 })).toBe('Ventana de 5 horas');
    expect(windowLabel({ id: 'seven_day' })).toBe('Semana');
    expect(windowLabel({ id: 'seven_day_sonnet' })).toBe('Semana · sonnet');
    expect(windowLabel({ id: 'primary', minutes: 300 })).toBe('Ventana principal (5 h)');
    expect(windowLabel({ id: 'secondary', minutes: 10080 })).toBe('Ventana secundaria (7 d)');
    // Los ids REALES de Codex llevan el espacio de nombres del proveedor (visto con codex 0.164.0).
    expect(windowLabel({ id: 'codex.primary', minutes: 300 })).toBe('Ventana principal (5 h)');
    expect(windowLabel({ id: 'codex.secondary', minutes: 10080 })).toBe('Ventana secundaria (7 d)');
    expect(windowLabel({ id: 'algo_nuevo' })).toBe('algo_nuevo');
    expect(windowLabel({ id: 'x.algo_nuevo', minutes: 60 })).toBe('x.algo_nuevo');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(0)).toBeNull();
  });

  it('qué informa cada proveedor, campo por campo', () => {
    const p = CANONICAL_REPORT.providers[1]; // claude: solo ventanas
    const por = Object.fromEntries(supportList(p).map((f) => [f.field, f.state]));
    expect(por).toEqual({ windows: 'available', tokens: 'unsupported', credits: 'unsupported', plan: 'unsupported', cost: 'unsupported' });
  });
});

describe('usageModel · filtros sobre el informe, sin sumar ni transformar', () => {
  const r = report([PROVIDERS.conModelos('uno', 'aaaabbbb'), PROVIDERS.conModelos('dos', 'ccccdddd'), PROVIDERS.sinDatos()]);

  it('las opciones salen del propio informe', () => {
    expect(filterOptions(r)).toEqual({ providers: ['uno', 'dos', 'otro'], accounts: ['aaaabbbb', 'ccccdddd'], models: ['modelo-a', 'modelo-b', 'modelo-c'] });
  });

  it('proveedor, cuenta y modelo filtran; sin filtro es el mismo informe', () => {
    expect(filterReport(r).providers).toHaveLength(3);
    expect(filterReport(r, { provider: 'dos' }).providers.map((p) => p.provider)).toEqual(['dos']);
    expect(filterReport(r, { account: 'aaaabbbb' }).providers.map((p) => p.provider)).toEqual(['uno']);
    const porModelo = filterReport(r, { model: 'modelo-a' });
    expect(porModelo.providers.map((p) => p.provider)).toEqual(['uno', 'dos']);
    expect(porModelo.providers[0].snapshot.models.map((m) => m.model)).toEqual(['modelo-a']);
    expect(filterReport(r, { provider: 'uno', account: 'ccccdddd' }).providers).toEqual([]);
    // Es una vista: el informe original no cambia.
    expect(r.providers[0].snapshot.models).toHaveLength(3);
  });

  it('no existe ningún total: el modelo no suma nada entre proveedores', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ade/usageModel.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/\.reduce\(|\btotal\b|\bsum\b|suma/i);
  });
});
