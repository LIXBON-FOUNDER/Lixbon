import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AutonomyEditor } from './AutonomyEditor';
import { validatePolicyEffective, CATEGORIES, LEVELS } from './autonomyContract';
import { resetOutstandingQueries } from './coreQueryPolicy';

// LXO-210 · Autonomía: ver la policy efectiva con su origen, previsualizar y guardar un cambio, con el Core como única autoridad.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

// ── Un Core de mentira con las mismas reglas que docs/core/POLICY.md ────────────────────────────────────────────────────────────
const rank = (l) => LEVELS.indexOf(l);
const FLOOR = { start: 'confirm', review: 'confirm', integrate: 'confirm', cleanup: 'confirm', provider_permissions: 'confirm' };
const baselineOf = (category) => FLOOR[category] ?? 'allow';
const max = (list) => list.filter(Boolean).reduce((a, b) => (rank(b) > rank(a) ? b : a));

function categoriesOf(overrides, project, attempt) {
  return CATEGORIES.map((category) => {
    const at = (kind, id) => overrides.find((o) => o.scope.kind === kind && o.scope.id === id && o.category === category)?.level ?? null;
    const layers = { baseline: baselineOf(category), global: at('global', null), project: project ? at('project', project) : null, attempt: attempt ? at('attempt', attempt) : null };
    const top = max([layers.baseline, layers.global, layers.project, layers.attempt]);
    const floor = FLOOR[category] ?? null;
    const level = floor && rank(top) < rank(floor) ? floor : top;
    const source = floor && rank(top) < rank(floor) ? 'floor' : layers.attempt === top ? 'attempt' : layers.project === top ? 'project' : layers.global === top ? 'global' : 'baseline';
    const reason = { baseline: 'baseline_default', global: 'override_global', project: 'override_project', attempt: 'override_attempt', floor: 'safety_floor' }[source];
    return { category, level, source, reason, layers, floor, enforced: !['answer', 'provider_permissions'].includes(category) };
  });
}

function matrix() {
  const row = (f) => Object.fromEntries(CATEGORIES.map((c) => [c, f(c)]));
  return { desktop_person: row(baselineOf), cli_person: row((c) => (c === 'start' ? 'confirm' : 'deny')), mobile_person: row(() => 'deny'), automation: row(() => 'deny'), agent: row(() => 'deny'), core: row(() => 'allow') };
}

function makeCore({ revision = 0, overrides = [], actor = { class: 'desktop_person', can_edit: true }, fail = null } = {}) {
  const core = { revision, overrides: [...overrides], calls: [], queries: [], actor };
  const withChange = (scope, category, level) => {
    const rest = core.overrides.filter((o) => !(o.scope.kind === scope.kind && (o.scope.id ?? null) === (scope.id ?? null) && o.category === category));
    return level ? [...rest, { scope: { kind: scope.kind, id: scope.id ?? null }, category, level }] : rest;
  };
  invoke.mockImplementation(async (command, payload) => {
    if (command === 'orch_call') {
      core.calls.push(payload);
      if (fail) throw new Error(fail);
      const a = payload.args;
      if (a.expected_revision !== core.revision) throw new Error(`policy_stale: la policy cambió (revisión actual ${core.revision})`);
      core.overrides = withChange(a.scope, a.category, payload.cmd === 'policy_set' ? a.level : null);
      core.revision += 1;
      return { status: 'Changed', revision: core.revision };
    }
    const args = payload.args;
    core.queries.push(args);
    const project = args.project_id ?? null;
    const attempt = args.attempt_id ?? null;
    const body = {
      v: 1, revision: core.revision, actor: core.actor, scope: { project_id: project, attempt_id: attempt }, levels: [...LEVELS],
      categories: categoriesOf(core.overrides, project, attempt),
      overrides: core.overrides.map((o) => ({ ...o, set_by: 'user', set_at: 1, revision: 1 })),
      baseline_matrix: matrix(),
    };
    if (args.preview) {
      const { scope, category, level } = args.preview;
      const before = body.categories.find((c) => c.category === category);
      let invalid = null;
      if (level && FLOOR[category] && rank(level) < rank(FLOOR[category])) invalid = ['policy_below_floor', 'no baja del piso'];
      const parentLayers = scope.kind === 'project' ? [before.layers.baseline, before.layers.global] : scope.kind === 'attempt' ? [before.layers.baseline, before.layers.global, before.layers.project] : [];
      if (!invalid && level && parentLayers.length && rank(level) < rank(max(parentLayers))) invalid = ['policy_cannot_loosen', 'solo puede endurecer'];
      if (invalid) body.preview = { valid: false, code: invalid[0], message: invalid[1] };
      else {
        const after = categoriesOf(withChange(scope, category, level), project, attempt);
        const a = after.find((c) => c.category === category);
        body.preview = {
          valid: true, direction: !level ? 'reset' : rank(a.level) > rank(before.level) ? 'tighten' : rank(a.level) < rank(before.level) ? 'loosen' : 'same',
          needs_confirm: rank(a.level) < rank(before.level), before: before.level, after: a.level, categories: after,
        };
      }
    }
    return body;
  });
  return core;
}

const byId = (id) => screen.getByTestId(id);
const open = async (props = {}) => {
  render(<AutonomyEditor projectId="p1" attemptId="t-a1" {...props} />);
  fireEvent.click(byId('autonomy-open'));
  await flush();
};
const choose = async (category, value) => { fireEvent.change(byId(`autonomy-select-${category}`), { target: { value } }); await flush(); };
const sent = (core) => core.calls.map((c) => ({ cmd: c.cmd, ...c.args }));

describe('Autonomía · contrato', () => {
  const args = { project_id: 'p1' };
  const good = () => ({
    v: 1, revision: 0, actor: { class: 'desktop_person', can_edit: true }, scope: { project_id: 'p1', attempt_id: null }, levels: [...LEVELS],
    categories: categoriesOf([], 'p1', null), overrides: [], baseline_matrix: matrix(),
  });
  const bad = (r, what) => expect(() => validatePolicyEffective(r, args), what).toThrow(/ade_query_invalid_response: policy_effective/);

  it('acepta lo del Core y rechaza una policy que el Core no calculó', () => {
    expect(validatePolicyEffective(good(), args)).toBeTruthy();
    bad({ ...good(), v: 2 }, 'versión');
    bad({ ...good(), categories: good().categories.slice(1) }, 'faltan categorías');
    bad({ ...good(), actor: { class: 'cli_person', can_edit: true } }, 'se concede editar a quien no es Desktop');
    bad({ ...good(), scope: { project_id: 'otro', attempt_id: null } }, 'otro Project');
    bad({ ...good(), levels: ['allow', 'deny'] }, 'niveles');
    const lax = good();
    lax.categories[6] = { ...lax.categories[6], level: 'allow' }; // review por debajo de su piso
    bad(lax, 'nivel por debajo del piso');
    const wrongMax = good();
    wrongMax.categories[3] = { ...wrongMax.categories[3], level: 'deny', layers: { ...wrongMax.categories[3].layers, global: 'confirm' } };
    bad(wrongMax, 'el efectivo no es el más restrictivo de las capas');
    const fakeFloor = good();
    fakeFloor.categories[3] = { ...fakeFloor.categories[3], source: 'floor' };
    bad(fakeFloor, 'floor sin piso');
    bad({ ...good(), preview: { valid: true, direction: 'loosen', needs_confirm: false, before: 'deny', after: 'allow', categories: good().categories } }, 'una preview que calla que afloja');
    bad({ ...good(), preview: { valid: false, code: 'otra', message: 'x' } }, 'preview rechazada sin código policy_');
  });
});

describe('Autonomía · vista', () => {
  it('no consulta nada hasta que se abre y entonces dice la policy con el origen de cada nivel', async () => {
    const core = makeCore({ overrides: [{ scope: { kind: 'global', id: null }, category: 'steer', level: 'confirm' }] });
    render(<AutonomyEditor projectId="p1" />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(byId('autonomy-open'));
    await flush();
    expect(byId('autonomy-actor').textContent).toContain('una persona en Desktop');
    expect(screen.getAllByRole('row')).toHaveLength(11);
    expect(byId('autonomy-level-steer').textContent).toContain('Pedir confirmación');
    expect(byId('autonomy-source-steer').textContent).toBe('Global');
    expect(byId('autonomy-level-queue').textContent).toContain('Permitir');
    expect(byId('autonomy-source-queue').textContent).toBe('Base del actor');
    expect(byId('autonomy-level-integrate').textContent).toContain('mínimo: Pedir confirmación');
    expect(byId('autonomy-source-integrate').textContent).toBe('Base del actor');
    expect(core.queries).toHaveLength(1);
  });

  it('lo que todavía no se aplica en ningún comando lo dice en vez de aparentar una protección', async () => {
    makeCore();
    await open();
    expect(byId('autonomy-unenforced-answer')).toBeTruthy();
    expect(byId('autonomy-unenforced-provider_permissions')).toBeTruthy();
    expect(screen.queryByTestId('autonomy-unenforced-steer')).toBeNull();
  });

  it('heredado y sobrescrito no se confunden: cambia con el ámbito y «volver a heredar» solo aparece donde hay override', async () => {
    makeCore({ overrides: [{ scope: { kind: 'global', id: null }, category: 'steer', level: 'confirm' }] });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    expect(byId('autonomy-tag-steer').textContent).toBe('Sobrescrito');
    expect(byId('autonomy-tag-queue').textContent).toBe('Heredado');
    expect(byId('autonomy-reset-steer')).toBeTruthy();
    expect(screen.queryByTestId('autonomy-reset-queue')).toBeNull();
    fireEvent.click(byId('autonomy-scope-project'));
    await flush();
    expect(byId('autonomy-tag-steer').textContent).toBe('Heredado');
    expect(screen.queryByTestId('autonomy-reset-steer')).toBeNull();
    expect(byId('autonomy-source-steer').textContent).toBe('Global');
  });

  it('endurecer: previsualiza el efecto con el Core, guarda con la revisión leída, vuelve a leer y avisa que queda en Activity', async () => {
    const core = makeCore({ revision: 4 });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    await choose('steer', 'deny');
    expect(byId('autonomy-tag-steer').textContent).toBe('Sin guardar');
    expect(byId('autonomy-effect').textContent).toContain('Permitir → Denegar');
    expect(byId('autonomy-direction').textContent).toBe('Reduce la autonomía.');
    expect(screen.queryByTestId('autonomy-ack')).toBeNull();
    expect(core.calls).toHaveLength(0); // previsualizar no escribe
    const reads = core.queries.length;
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(sent(core)).toEqual([{ cmd: 'policy_set', scope: { kind: 'global' }, category: 'steer', level: 'deny', expected_revision: 4 }]);
    expect(byId('autonomy-notice').textContent).toBe('Guardado (revisión 5). Queda en Activity.');
    expect(core.queries.length).toBeGreaterThan(reads); // se recarga del Core
    expect(byId('autonomy-level-steer').textContent).toContain('Denegar');
    expect(byId('autonomy-tag-steer').textContent).toBe('Sobrescrito');
    expect(screen.queryByTestId('autonomy-pending')).toBeNull();
  });

  it('dar MÁS autonomía es explícito: avisa, exige confirmar aparte y el Core recibe confirm: true solo entonces', async () => {
    const core = makeCore({ revision: 2, overrides: [{ scope: { kind: 'global', id: null }, category: 'steer', level: 'deny' }] });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    fireEvent.click(byId('autonomy-reset-steer'));
    await flush();
    expect(byId('autonomy-direction').getAttribute('data-direction')).toBe('reset');
    expect(byId('autonomy-effect').textContent).toContain('Denegar → Permitir');
    const ack = byId('autonomy-ack');
    expect(byId('autonomy-save').disabled).toBe(true);
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(core.calls).toHaveLength(0);
    fireEvent.click(ack);
    expect(byId('autonomy-save').disabled).toBe(false);
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(sent(core)).toEqual([{ cmd: 'policy_reset', scope: { kind: 'global' }, category: 'steer', expected_revision: 2, confirm: true }]);
    expect(byId('autonomy-level-steer').textContent).toContain('Permitir');
  });

  it('aflojar con un nivel explícito también es más autonomía y se marca igual', async () => {
    makeCore({ overrides: [{ scope: { kind: 'global', id: null }, category: 'queue', level: 'deny' }] });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    await choose('queue', 'confirm');
    expect(byId('autonomy-direction').getAttribute('data-direction')).toBe('loosen');
    expect(byId('autonomy-direction').textContent).toBe('DA MÁS AUTONOMÍA.');
    expect(byId('autonomy-ack')).toBeTruthy();
  });

  it('las opciones que el Core rechazaría salen desactivadas con su motivo: el piso y «un ámbito más cercano solo endurece»', async () => {
    makeCore({ overrides: [{ scope: { kind: 'global', id: null }, category: 'queue', level: 'confirm' }] });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    const integrate = within(byId('autonomy-select-integrate'));
    expect(integrate.getByRole('option', { name: /Permitir — Nunca baja de «Pedir confirmación»/ }).disabled).toBe(true);
    expect(integrate.getByRole('option', { name: 'Pedir confirmación' }).disabled).toBe(false);
    fireEvent.click(byId('autonomy-scope-project'));
    await flush();
    const queue = within(byId('autonomy-select-queue'));
    expect(queue.getByRole('option', { name: /Permitir — Un ámbito más cercano solo puede endurecer/ }).disabled).toBe(true);
    expect(queue.getByRole('option', { name: 'Denegar' }).disabled).toBe(false);
    expect(queue.getByRole('option', { name: 'Heredar (sin override)' }).disabled).toBe(false);
  });

  it('si el Core rechaza el cambio en la previsualización, lo dice y no deja guardar', async () => {
    const core = makeCore({ overrides: [{ scope: { kind: 'global', id: null }, category: 'queue', level: 'confirm' }] });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-project'));
    await flush();
    // Aunque la interfaz desactive la opción, si llegara hasta el Core manda el Core.
    const select = byId('autonomy-select-queue');
    select.querySelector('option[value="allow"]').disabled = false;
    await choose('queue', 'allow');
    expect(byId('autonomy-invalid').getAttribute('data-code')).toBe('policy_cannot_loosen');
    expect(byId('autonomy-invalid').textContent).toContain('solo puede endurecer');
    expect(byId('autonomy-save').disabled).toBe(true);
    expect(core.calls).toHaveLength(0);
  });

  it('una policy que cambió mientras se editaba (stale) no se pisa: avisa, recarga y descarta el borrador', async () => {
    const core = makeCore({ revision: 1 });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    await choose('steer', 'deny');
    core.revision = 3; // alguien más la cambió entre medias
    const reads = core.queries.length;
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(byId('autonomy-error').textContent).toContain('La policy cambió mientras editabas');
    expect(core.overrides).toEqual([]);
    expect(core.queries.length).toBeGreaterThan(reads);
    expect(screen.queryByTestId('autonomy-pending')).toBeNull();
    expect(byId('autonomy-tag-steer').textContent).toBe('Heredado');
  });

  it('sin permiso para editar solo se lee: nada se puede elegir y no se manda ninguna orden', async () => {
    const core = makeCore({ actor: { class: 'cli_person', can_edit: false } });
    await open({ attemptId: null });
    expect(byId('autonomy-readonly').textContent).toContain('Solo una persona en Desktop');
    for (const category of CATEGORIES) expect(byId(`autonomy-select-${category}`).disabled).toBe(true);
    expect(screen.queryByTestId('autonomy-reset-steer')).toBeNull();
    expect(core.calls).toHaveLength(0);
  });

  it('si el Core rechaza al que no puede editar, lo dice en lenguaje llano y conserva el detalle técnico', async () => {
    makeCore({ fail: 'policy_forbidden: solo una Person autenticada de Desktop puede cambiar la policy' });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    await choose('steer', 'deny');
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(byId('autonomy-error').textContent).toContain('Solo una persona en Desktop puede cambiar la policy.');
    expect(byId('autonomy-error').textContent).toContain('policy_forbidden');
  });

  it('no guarda la policy en el cliente: lo que se ve sale siempre del Core', async () => {
    const before = window.localStorage.length;
    const core = makeCore({ revision: 0 });
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    await choose('steer', 'deny');
    fireEvent.click(byId('autonomy-save'));
    await flush();
    expect(window.localStorage.length).toBe(before);
    cleanup();
    core.overrides = []; // el Core vuelve atrás: la interfaz no recuerda nada por su cuenta
    await open({ attemptId: null });
    expect(byId('autonomy-level-steer').textContent).toContain('Permitir');
  });

  it('teclado y lectores de pantalla: tabla con título y cabeceras, cada selector con nombre, avisos con rol', async () => {
    makeCore();
    await open({ attemptId: null });
    fireEvent.click(byId('autonomy-scope-global'));
    await flush();
    expect(screen.getByRole('table', { name: /Nivel efectivo de cada acción/ })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Acción', 'Nivel efectivo', 'Origen', 'Global']);
    expect(screen.getByRole('group', { name: 'Ámbito del cambio' })).toBeTruthy();
    for (const c of CATEGORIES) expect(byId(`autonomy-select-${c}`).labels[0].textContent).toMatch(/nivel en Global/);
    expect(screen.getByRole('combobox', { name: 'Corregir el turno en curso: nivel en Global' })).toBeTruthy();
    await choose('steer', 'deny');
    expect(screen.getByRole('group', { name: 'Cambio pendiente' })).toBeTruthy();
  });
});
