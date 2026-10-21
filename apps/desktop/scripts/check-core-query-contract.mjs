/**
 * Comprobación SIN dependencias de la política de espera y del contrato de `resource_inventory`
 * (LXO-101).
 *
 * Por qué existe: `coreQueryPolicy.js` y `coreInventoryContract.js` no dependen de React ni de
 * Tauri a propósito, así que su lógica se puede ejecutar con el Node que ya está en la máquina,
 * sin `npm install`. La suite de Vitest sigue siendo la referencia (`useCoreQuery.test.js` y
 * `coreQueries.test.js`); este script es la comprobación de que esa lógica hace lo que dice,
 * ejecutable en un worktree sin `node_modules`.
 *
 * Uso: `node scripts/check-core-query-contract.mjs` (desde `apps/desktop`).
 */
import assert from 'node:assert/strict';
import {
  classifyCoreError,
  createQueryReader,
  ensureRequest,
  outstandingCount,
  outstandingLimit,
  resetOutstandingQueries,
  RESOURCE_INVENTORY_ABANDON_MS,
  slotFor,
  statusForFailure,
  subscribeFreeSlots,
  timeoutFor,
} from '../src/ade/coreQueryPolicy.js';
import { validateResourceInventory } from '../src/ade/coreInventoryContract.js';

const checks = [];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    checks.push(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    checks.push(`  FAIL ${name}\n         ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    checks.push(`  FAIL ${name}\n         ${error.message}`);
  }
}

/** Deja que las cadenas de promesas se resuelvan. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Reloj falso: el tiempo no pasa solo, así que las comprobaciones son deterministas. */
function fakeClock() {
  const realNow = Date.now;
  let now = 0;
  let seq = 0;
  const timers = new Map();
  Date.now = () => now;
  const api = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms, every: null });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms, every: ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (!due.length) break;
      const [id, timer] = due[0];
      now = timer.at;
      if (timer.every) timer.at = now + timer.every;
      else timers.delete(id);
      timer.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  return { api, advance, restore: () => { Date.now = realNow; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** DTO de `resource_inventory` tal como lo da el Core (docs/core/RESOURCES.md). */
function inventario({ probe = true, projectId = null } = {}) {
  const dto = {
    v: 1,
    machine: 'machine-1',
    filters: { project_id: projectId, probe },
    repos: [
      { project_id: 'project-1', machine: 'machine-1', path: '/home/ana/app', scan: 'ok' },
      { project_id: 'project-2', machine: 'machine-1', path: '/home/ana/roto', scan: 'unavailable', reason: 'not_a_repository' },
      { project_id: 'project-3', machine: 'otro-equipo', path: '/srv/remoto', scan: 'other_machine', reason: 'other_machine' },
    ],
    worktrees: [
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', path: '/home/ana/app.lixbon-wt/wt-c' },
        state: 'tracked',
        origin: 'task',
        physical: 'present',
        git: { registered: true, branch: 'lx/r/c', detached: false, locked: false, prunable: false },
        owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
        dirty: 'clean',
        merged: 'unmerged',
        into: 'main',
        needs_review: true,
      },
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', path: '/srv/otro' },
        state: 'external',
        origin: 'external',
        physical: 'present',
        git: { registered: true, branch: 'ext/x', detached: false, locked: false, prunable: false },
        owner: null,
        dirty: 'dirty',
        merged: 'unknown',
        into: 'main',
        needs_review: false,
      },
    ],
    preserved_branches: [
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', branch: 'lx/r/g' },
        branch_exists: true,
        owner: { task_id: 't-4', run_id: 'r-1', status: 'stopped' },
        merged: 'unmerged',
        into: 'main',
        needs_review: true,
      },
    ],
    warnings: {
      branches_to_review: 2,
      worktrees_by_state: {
        tracked: 1,
        missing_on_disk: 0,
        not_registered: 0,
        orphan_candidate: 0,
        external: 1,
        unknown: 0,
      },
    },
  };

  if (projectId !== null) {
    dto.repos = dto.repos.filter((repo) => repo.project_id === projectId);
    dto.worktrees = dto.worktrees.filter((worktree) => worktree.target.project_id === projectId);
    dto.preserved_branches = dto.preserved_branches.filter((branch) => branch.target.project_id === projectId);
  }
  return recontarInventario(dto);
}

function recontarInventario(dto) {
  const states = ['tracked', 'missing_on_disk', 'not_registered', 'orphan_candidate', 'external', 'unknown'];
  const allReviewable = [...dto.worktrees, ...dto.preserved_branches];
  return {
    ...dto,
    warnings: {
      ...dto.warnings,
      branches_to_review: dto.filters.probe ? allReviewable.filter((entry) => entry.needs_review === true).length : null,
      worktrees_by_state: Object.fromEntries(states.map((state) => [
        state,
        dto.worktrees.filter((worktree) => worktree.state === state).length,
      ])),
    },
  };
}

function conWorktrees(dto, worktrees) {
  return recontarInventario({ ...dto, worktrees });
}

function conRamasConservadas(dto, preserved_branches) {
  return recontarInventario({ ...dto, preserved_branches });
}

function inventarioSinSondeo(projectId = null) {
  const out = inventario({ probe: false, projectId });
  out.worktrees = out.worktrees.map((worktree) => ({ ...worktree, dirty: 'skipped', merged: 'skipped', needs_review: null }));
  out.preserved_branches = out.preserved_branches.map((branch) => ({ ...branch, merged: 'skipped', needs_review: null }));
  out.warnings = { ...out.warnings, branches_to_review: null };
  return out;
}

const rejects = (dto, args) => {
  try {
    validateResourceInventory(dto, args);
    return false;
  } catch (error) {
    assert.match(error.message, /^ade_query_invalid_response/);
    return true;
  }
};

// ---------------------------------------------------------------- política de espera (P1)

check('el umbral de resource_inventory es de 30 s y el genérico de 10 s', () => {
  assert.equal(timeoutFor('resource_inventory'), 30_000);
  assert.equal(timeoutFor('projects_overview'), 10_000);
});

check('un plazo agotado NO se clasifica como desconexión', () => {
  assert.equal(classifyCoreError(new Error('ade_query_timeout: el Core no respondió a tiempo')), 'timeout');
  assert.equal(classifyCoreError(new Error('projects_overview timeout')), 'timeout');
});

check('solo hay evidencia de transporte roto cuando el mensaje la da', () => {
  assert.equal(classifyCoreError(new Error('disconnected: Core IPC closed')), 'disconnected');
  assert.equal(classifyCoreError(new Error('connection refused')), 'disconnected');
  assert.equal(classifyCoreError(new Error('resource_inventory_unavailable: almacén no disponible')), 'degraded');
  assert.equal(classifyCoreError(new Error('resource_inventory_read_failed')), 'error');
});

check('el estado según la evidencia: stale con foto, error sin ella', () => {
  assert.equal(statusForFailure('timeout', true), 'stale');
  assert.equal(statusForFailure('timeout', false), 'error');
  assert.equal(statusForFailure('disconnected', false), 'disconnected');
  assert.equal(statusForFailure('degraded', false), 'degraded');
  assert.equal(statusForFailure('error', true), 'stale');
});

check('resource_inventory admite una sola petición outstanding; las demás, varias', () => {
  assert.equal(outstandingLimit('resource_inventory'), 1);
  assert.ok(outstandingLimit('projects_overview') > 1);
});

await checkAsync('una misma clave reutiliza la petición viva: una sola llamada al Core', async () => {
  resetOutstandingQueries();
  const late = deferred();
  let launches = 0;
  const first = ensureRequest('resource_inventory', 'k1', () => { launches += 1; return late.promise; });
  const second = ensureRequest('resource_inventory', 'k1', () => { launches += 1; return late.promise; });
  assert.equal(first, second);
  assert.equal(launches, 1);
  assert.equal(outstandingCount('resource_inventory'), 1);
  late.resolve({});
  await first.settled;
});

await checkAsync('con un escaneo en marcha no se abre otro: la lectura se aplaza', async () => {
  resetOutstandingQueries();
  const late = deferred();
  let launches = 0;
  const first = ensureRequest('resource_inventory', 'k1', () => { launches += 1; return late.promise; });
  const blocked = ensureRequest('resource_inventory', 'k2', () => { launches += 1; return late.promise; });
  assert.equal(blocked, null, 'con el límite de 1 no debe abrirse un segundo escaneo');
  assert.equal(launches, 1);

  // Cuando la primera se resuelve, el hueco queda libre y lo aplazado puede salir.
  let freed = 0;
  const unsubscribe = subscribeFreeSlots((query) => { if (query === 'resource_inventory') freed += 1; });
  late.resolve({});
  await first.settled;
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();
  assert.equal(freed, 1, 'hay que avisar de que se liberó un hueco');
  assert.equal(outstandingCount('resource_inventory'), 0);

  const next = ensureRequest('resource_inventory', 'k2', () => { launches += 1; return late.promise; });
  assert.ok(next, 'con el hueco libre la lectura aplazada sale');
  assert.equal(launches, 2);
  late.resolve({});
  await next.settled;
});

await checkAsync('el fallo de la petición llega como resultado, no como excepción', async () => {
  resetOutstandingQueries();
  const late = deferred();
  const entry = ensureRequest('resource_inventory', 'k1', () => late.promise);
  late.reject(new Error('resource_inventory_read_failed'));
  const outcome = await entry.settled;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.message, 'resource_inventory_read_failed');
});

await checkAsync('el umbral pertenece a la petición: quien se engancha después hereda el plazo', async () => {
  resetOutstandingQueries();
  const late = deferred();
  const started = Date.now();
  const entry = ensureRequest('resource_inventory', 'k1', () => late.promise);
  assert.equal(entry.deadline, started + 30_000);
  const again = ensureRequest('resource_inventory', 'k1', () => late.promise);
  assert.equal(again.deadline, entry.deadline);
  late.resolve({});
  await entry.settled;
});

// -------------------------------------------- lector con umbral visual, extremo a extremo (P1)

await checkAsync('una lectura más lenta que el umbral no abre un segundo escaneo y se recupera', async () => {
  const clock = fakeClock();
  let reader = null;
  try {
    resetOutstandingQueries();
    const late = deferred();
    let launches = 0;
    const events = [];
    reader = createQueryReader({
      query: 'resource_inventory',
      requestKey: 'resource_inventory:{"project_id":null,"probe":true}',
      launch: () => { launches += 1; return late.promise; },
      pollMs: 1_000,
      timers: clock.api,
      onStart: () => events.push('start'),
      onThreshold: () => events.push('threshold'),
      onOutcome: (outcome) => events.push(outcome.ok ? 'ok' : 'error'),
    });
    reader.start();
    assert.equal(launches, 1);

    await clock.advance(30_000);
    assert.equal(launches, 1, 'vencer el umbral no abre otro escaneo');
    assert.ok(events.includes('threshold'), 'al vencer el umbral se avisa');

    await clock.advance(20_000);
    assert.equal(launches, 1, 'el poll no abre otro escaneo mientras la petición sigue viva');

    late.resolve({ repos: [] });
    await flush();
    assert.ok(events.includes('ok'), 'la respuesta tardía se aplica');
    assert.equal(launches, 1, 'la recuperación no duplica el escaneo');
  } finally {
    if (reader) reader.stop();
    clock.restore();
  }
});

await checkAsync('el poll, el reintento y el cambio de argumentos no solapan escaneos', async () => {
  const clock = fakeClock();
  const readers = [];
  try {
    resetOutstandingQueries();
    const late = deferred();
    let launches = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const launch = () => {
      launches += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return late.promise.finally(() => { concurrent -= 1; });
    };
    const keyA = 'resource_inventory:{"project_id":null,"probe":true}';
    const keyB = 'resource_inventory:{"project_id":"project-2","probe":true}';
    const options = { query: 'resource_inventory', launch, pollMs: 1_000, timers: clock.api };

    const readerA = createQueryReader({ ...options, requestKey: keyA });
    readers.push(readerA);
    readerA.start();
    await clock.advance(5_000);
    assert.equal(launches, 1);

    // Un reintento rehace el lector con la MISMA clave: se engancha a la petición viva.
    readerA.stop();
    const readerRetry = createQueryReader({ ...options, requestKey: keyA });
    readers.push(readerRetry);
    readerRetry.start();
    await clock.advance(5_000);
    assert.equal(launches, 1, 'el reintento no abre otro escaneo');

    // Un cambio de argumentos: la lectura nueva se APLAZA hasta que se libere el hueco.
    readerRetry.stop();
    const readerB = createQueryReader({ ...options, requestKey: keyB });
    readers.push(readerB);
    readerB.start();
    await clock.advance(5_000);
    assert.equal(launches, 1, 'el cambio de argumentos no solapa el escaneo');

    // Cuando la primera se resuelve, la lectura aplazada sale: secuencial, nunca solapada.
    late.resolve({ repos: [] });
    await flush();
    assert.equal(launches, 2, 'la lectura aplazada sale cuando se libera el hueco');
    assert.equal(maxConcurrent, 1, 'nunca hay dos escaneos a la vez');

    // Y el sondeo sigue: una lectura nueva cada vez, nunca solapada con la anterior.
    await clock.advance(1_000);
    assert.equal(maxConcurrent, 1, 'el sondeo tampoco solapa escaneos');
  } finally {
    for (const reader of readers) reader.stop();
    clock.restore();
  }
});

await checkAsync('un fallo tardío libera el hueco y la foto conocida no se inventa', async () => {
  const clock = fakeClock();
  let reader = null;
  try {
    resetOutstandingQueries();
    const late = deferred();
    let launches = 0;
    const outcomes = [];
    reader = createQueryReader({
      query: 'resource_inventory',
      requestKey: 'resource_inventory:{"project_id":null,"probe":true}',
      launch: () => { launches += 1; return late.promise; },
      pollMs: 1_000,
      timers: clock.api,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    reader.start();
    await clock.advance(31_000);
    assert.equal(launches, 1);

    late.reject(new Error('resource_inventory_read_failed'));
    await flush();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(outcomes[0].error.message, 'resource_inventory_read_failed');
    assert.equal(outstandingCount('resource_inventory'), 0, 'el hueco queda libre tras el fallo');

    // El siguiente poll vuelve a preguntar al Core: se puede recuperar de un fallo.
    await clock.advance(1_000);
    assert.equal(launches, 2);
  } finally {
    if (reader) reader.stop();
    clock.restore();
  }
});

await checkAsync('el hueco de resource_inventory es por Project: un escaneo lento no aplaza a otro Project', async () => {
  const clock = fakeClock();
  const readers = [];
  try {
    resetOutstandingQueries();
    const slow = deferred();
    const launched = [];
    const make = (projectId, launch) => {
      const reader = createQueryReader({
        query: 'resource_inventory',
        requestKey: `resource_inventory:{"project_id":"${projectId}","probe":true}`,
        slot: slotFor('resource_inventory', projectId),
        launch: () => { launched.push(projectId); return launch(); },
        pollMs: 1_000,
        timers: clock.api,
      });
      readers.push(reader);
      reader.start();
      return reader;
    };
    make('project-1', () => slow.promise);
    make('project-2', () => Promise.resolve({}));
    await clock.advance(10);
    assert.deepEqual(launched.slice(0, 2), ['project-1', 'project-2'], 'project-2 sale sin esperar a project-1');
    assert.equal(outstandingCount(slotFor('resource_inventory', 'project-1')), 1);
    assert.equal(slotFor('resource_inventory', null), 'resource_inventory', 'sin Project el hueco es el global');
    slow.resolve({});
    await flush();
  } finally {
    for (const reader of readers) reader.stop();
    clock.restore();
  }
});

await checkAsync('una petición colgada se abandona, libera el hueco y el sondeo vuelve a preguntar', async () => {
  const clock = fakeClock();
  let reader = null;
  try {
    resetOutstandingQueries();
    let launches = 0;
    const outcomes = [];
    reader = createQueryReader({
      query: 'resource_inventory',
      requestKey: 'resource_inventory:{"project_id":"project-1","probe":true}',
      slot: slotFor('resource_inventory', 'project-1'),
      launch: () => { launches += 1; return new Promise(() => {}); },
      pollMs: 1_000,
      timers: clock.api,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    reader.start();
    await clock.advance(RESOURCE_INVENTORY_ABANDON_MS - 1);
    assert.equal(launches, 1, 'antes del abandono no se abre otro escaneo');
    assert.equal(outcomes.length, 0);
    await clock.advance(1);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(classifyCoreError(outcomes[0].error), 'timeout', 'el abandono es un plazo, no una desconexión');
    // El hueco quedó libre: el sondeo del mismo instante ya pudo volver a preguntar (una sola petición viva).
    assert.ok(outstandingCount(slotFor('resource_inventory', 'project-1')) <= 1, 'nunca dos escaneos vivos del mismo Project');
    await clock.advance(1_000);
    assert.equal(launches, 2, 'el sondeo vuelve a preguntar tras el abandono');
  } finally {
    if (reader) reader.stop();
    clock.restore();
  }
});

check('el eco de filtros sin project_id se rechaza', () => {
  const dto = inventario();
  const { project_id: _omitido, ...sinProject } = dto.filters;
  assert.throws(() => validateResourceInventory({ ...dto, filters: sinProject }, { project_id: null, probe: true }), /ade_query_invalid_response/);
});

// ------------------------------------------------------- contrato de resource_inventory (P2)
check('un inventario del Core tal cual se acepta', () => {
  const dto = inventario();
  assert.equal(validateResourceInventory(dto, { project_id: null, probe: true }), dto);
});

check('sin sondeo el inventario se acepta tal cual', () => {
  const dto = inventarioSinSondeo();
  assert.equal(validateResourceInventory(dto, { project_id: null, probe: false }), dto);
});

check('con sondeo, branches_to_review tiene que ser un número', () => {
  const dto = inventario();
  dto.warnings.branches_to_review = null;
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'null con sondeo no vale');
  dto.warnings.branches_to_review = '2';
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'un texto no vale');
  dto.warnings.branches_to_review = 2;
  assert.ok(!rejects(dto, { project_id: null, probe: true }));
});

check('sin sondeo, branches_to_review tiene que ser null', () => {
  const dto = inventarioSinSondeo();
  dto.warnings.branches_to_review = 0;
  assert.ok(rejects(dto, { project_id: null, probe: false }), 'un número sin sondeo no vale');
  dto.warnings.branches_to_review = null;
  assert.ok(!rejects(dto, { project_id: null, probe: false }));
});

check('el aviso tiene que cuadrar con las propias entradas', () => {
  const dto = inventario();
  dto.warnings.branches_to_review = 5;
  assert.ok(rejects(dto, { project_id: null, probe: true }));
});

check('«falta» lo afirma el disco, no el cliente', () => {
  const base = inventario();
  const tracked = base.worktrees[0];
  const missingPhysical = conWorktrees(base, [{ ...tracked, physical: 'missing', dirty: 'skipped' }]);
  assert.ok(rejects(missingPhysical, { project_id: null, probe: true }), 'physical=missing con state=tracked');

  const otraDireccion = conWorktrees(base, [{
    ...tracked,
    state: 'missing_on_disk',
  }]);
  assert.ok(rejects(otraDireccion, { project_id: null, probe: true }), 'state=missing_on_disk con physical=present');

  const missingNotPrunable = conWorktrees(base, [{
    ...tracked,
    state: 'missing_on_disk',
    physical: 'missing',
    dirty: 'skipped',
    git: { ...tracked.git, prunable: false },
  }]);
  assert.ok(!rejects(missingNotPrunable, { project_id: null, probe: true }), 'registered missing en disco puede conservar prunable=false como dato informativo');
  const missingPrunable = conWorktrees(base, [{
    ...tracked,
    state: 'missing_on_disk',
    physical: 'missing',
    dirty: 'skipped',
    git: { ...tracked.git, prunable: true },
  }]);
  assert.ok(!rejects(missingPrunable, { project_id: null, probe: true }), 'prunable true también se conserva como dato informativo');

  const missingUnownedNotPrunable = conWorktrees(base, [{
    ...base.worktrees[1],
    state: 'missing_on_disk',
    physical: 'missing',
    dirty: 'skipped',
    git: { ...base.worktrees[1].git, prunable: false },
  }]);
  assert.ok(!rejects(missingUnownedNotPrunable, { project_id: null, probe: true }), 'worktree listado sin owner puede faltar aunque Git no emita prunable');
});

check('el estado tiene que cuadrar con lo que dijo git', () => {
  const dto = inventario();
  dto.worktrees[0].git = { ...dto.worktrees[0].git, registered: false };
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'tracked sin registro en git');
  const baseUnknown = inventario();
  const otro = conWorktrees(baseUnknown, [{ ...baseUnknown.worktrees[0], state: 'unknown' }]);
  assert.ok(rejects(otro, { project_id: null, probe: true }), 'unknown+present con registered=true y origin=task');
});

check('registered=false y registered=null no pueden contradecir el estado o el scan', () => {
  const base = inventario();
  const tracked = base.worktrees[0];
  const trackedWithoutRegistration = conWorktrees(base, [{
    ...tracked,
    git: { registered: false, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped',
    merged: 'unknown',
    needs_review: false,
  }, base.worktrees[1]]);
  assert.ok(rejects(trackedWithoutRegistration, { project_id: null, probe: true }), 'tracked exige registered=true aunque false no traiga otros hechos Git');

  const scannedWithoutRegistration = conWorktrees(base, [{
    ...tracked,
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped',
    merged: 'unknown',
    needs_review: false,
  }, base.worktrees[1]]);
  assert.ok(rejects(scannedWithoutRegistration, { project_id: null, probe: true }), 'scan ok no permite registered=null aunque unknown y owner sean coherentes');
});

check('dirty solo se evalúa con carpeta presente y registro git confirmado', () => {
  const base = inventario();
  const tracked = base.worktrees[0];
  const unknownDisk = conWorktrees(base, [{
    ...tracked,
    state: 'unknown', physical: 'unknown', dirty: 'dirty',
  }]);
  assert.ok(rejects(unknownDisk, { project_id: null, probe: true }), 'unknown físico no permite dirty evaluado');

  const unregistered = conWorktrees(base, [{
    ...tracked,
    state: 'not_registered',
    git: { registered: false, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'clean',
  }]);
  assert.ok(rejects(unregistered, { project_id: null, probe: true }), 'git.registered=false no permite dirty evaluado');

  const skippedWhenProbeable = conWorktrees(base, [{ ...tracked, dirty: 'skipped' }]);
  assert.ok(rejects(skippedWhenProbeable, { project_id: null, probe: true }), 'con carpeta presente y registrada probe=true no permite skipped');
});

check('unknown acepta disco no comprobable con y sin Task, pero conserva la propiedad', () => {
  const base = inventario();
  const taskUnknown = { ...base.worktrees[0], state: 'unknown', physical: 'unknown', dirty: 'skipped' };
  const externalUnknown = { ...base.worktrees[1], state: 'unknown', physical: 'unknown', dirty: 'skipped' };
  const orphanUnknown = {
    ...base.worktrees[1],
    target: { ...base.worktrees[1].target, path: '/home/ana/app.lixbon-wt/orphan' },
    state: 'unknown', origin: 'lixbon_dir', physical: 'unknown', dirty: 'skipped',
  };
  const unknownDisk = conWorktrees(base, [taskUnknown, externalUnknown, orphanUnknown]);
  assert.ok(!rejects(unknownDisk, { project_id: null, probe: true }), 'unknown con physical=unknown acepta Task, external y lixbon_dir con dueños correctos');

  const ownerlessTask = conWorktrees(base, [{ ...taskUnknown, owner: null }]);
  assert.ok(rejects(ownerlessTask, { project_id: null, probe: true }), 'una Task conocida no puede perder su owner');

  const unlistedExternal = conWorktrees(base, [{
    ...externalUnknown,
    git: { ...externalUnknown.git, registered: null },
  }]);
  assert.ok(rejects(unlistedExternal, { project_id: null, probe: true }), 'un candidato sin dueño debe estar listado por git');
  const unregisteredExternal = conWorktrees(base, [{
    ...externalUnknown,
    git: { ...externalUnknown.git, registered: false },
  }]);
  assert.ok(rejects(unregisteredExternal, { project_id: null, probe: true }), 'un candidato unknown no puede tener registered=false');

  const gitUnavailable = conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [],
  }, [{
    ...base.worktrees[0],
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped', merged: 'unknown', needs_review: false,
  }]);
  assert.ok(!rejects(gitUnavailable, { project_id: null, probe: true }), 'carpeta presente y git sin respuesta permite unknown con Task');
});

check('un worktree externo nunca lleva dueño', () => {
  const dto = inventario();
  dto.worktrees[1].owner = { task_id: 't-9', run_id: 'r-1', status: 'done' };
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'externo con dueño');
});

check('el origen tiene que cuadrar con el estado', () => {
  const dto = inventario();
  const orphanExternal = conWorktrees(dto, [{ ...dto.worktrees[1], state: 'orphan_candidate' }]);
  assert.ok(rejects(orphanExternal, { project_id: null, probe: true }), 'orphan_candidate con origen external');
  const tracked = conWorktrees(inventario(), [{ ...dto.worktrees[0], origin: 'lixbon_dir', needs_review: false }]);
  assert.ok(rejects(tracked, { project_id: null, probe: true }), 'tracked sin Task que lo declare');
});

check('otra máquina sale como other_machine y sin worktrees', () => {
  assert.ok(!rejects(inventario(), { project_id: null, probe: true }), 'other_machine con machine y Project string se acepta');
  const dto = inventario();
  dto.repos[2].reason = 'git_failed';
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'other_machine con otro motivo');
  const escaneado = inventario();
  escaneado.repos[0].machine = 'otro-equipo';
  assert.ok(rejects(escaneado, { project_id: null, probe: true }), 'otra máquina escaneada');
  const otherWithoutMachine = inventario();
  otherWithoutMachine.repos[2].machine = null;
  assert.ok(rejects(otherWithoutMachine, { project_id: null, probe: true }), 'other_machine requiere su machine id');
  const otherWithoutProject = inventario();
  otherWithoutProject.repos[2].project_id = null;
  assert.ok(rejects(otherWithoutProject, { project_id: null, probe: true }), 'other_machine conserva project_id string de la ubicación');
  const conWorktree = inventario();
  conWorktree.worktrees[0].target = { ...conWorktree.worktrees[0].target, machine: 'otro-equipo' };
  assert.ok(rejects(conWorktree, { project_id: null, probe: true }), 'worktree de otra máquina');

  const targetOther = inventario();
  targetOther.machine = null;
  targetOther.worktrees[0].target = {
    ...targetOther.worktrees[0].target,
    machine: 'otro-equipo', project_id: 'project-3', repo: '/srv/remoto',
  };
  assert.ok(rejects(targetOther, { project_id: null, probe: true }), 'target no puede apuntar a repo other_machine');

  const branchOther = inventario();
  branchOther.machine = null;
  branchOther.preserved_branches[0].target = {
    ...branchOther.preserved_branches[0].target,
    machine: 'otro-equipo', project_id: 'project-3', repo: '/srv/remoto',
  };
  assert.ok(rejects(branchOther, { project_id: null, probe: true }), 'rama tampoco puede apuntar a repo other_machine');
});

check('machine null del Core debe coincidir exactamente con repo y target local', () => {
  const withoutMachine = inventario();
  withoutMachine.machine = null;
  withoutMachine.repos = withoutMachine.repos.map((repo) => repo.scan === 'other_machine'
    ? repo
    : { ...repo, machine: null });
  withoutMachine.worktrees = withoutMachine.worktrees.map((worktree) => ({
    ...worktree,
    target: { ...worktree.target, machine: null },
  }));
  withoutMachine.preserved_branches = withoutMachine.preserved_branches.map((branch) => ({
    ...branch,
    target: { ...branch.target, machine: null },
  }));
  assert.ok(!rejects(withoutMachine, { project_id: null, probe: true }), 'repo y targets locales null son válidos cuando machine del Core es null');

  const repoMachineWildcard = {
    ...withoutMachine,
    repos: withoutMachine.repos.map((repo) => repo.scan === 'other_machine' ? repo : { ...repo, machine: 'machine-1' }),
    worktrees: withoutMachine.worktrees.map((worktree) => ({
      ...worktree,
      target: { ...worktree.target, machine: 'machine-1' },
    })),
    preserved_branches: withoutMachine.preserved_branches.map((branch) => ({
      ...branch,
      target: { ...branch.target, machine: 'machine-1' },
    })),
  };
  assert.ok(rejects(repoMachineWildcard, { project_id: null, probe: true }), 'repo y targets no pueden usar machine no nula como comodín si Core informa null');
});

check('scan del repo determina registro git y existencia de ramas nullable', () => {
  const base = inventario();
  const unavailableWithFacts = conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [],
  }, base.worktrees);
  assert.ok(rejects(unavailableWithFacts, { project_id: null, probe: true }), 'scan unavailable no permite hechos de registro Git');

  const scannedWithoutRegistration = conWorktrees(base, [{
    ...base.worktrees[0],
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped', merged: 'unknown', needs_review: false,
  }]);
  assert.ok(rejects(scannedWithoutRegistration, { project_id: null, probe: true }), 'scan ok no permite registered null');

  const registeredWithoutGitFacts = conWorktrees(base, [{
    ...base.worktrees[0],
    git: { ...base.worktrees[0].git, detached: null, locked: null, prunable: null },
  }]);
  assert.ok(rejects(registeredWithoutGitFacts, { project_id: null, probe: true }), 'registered=true requiere los hechos emitidos por git');

  const unavailableBranch = conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [{ ...base.preserved_branches[0], branch_exists: true }],
  }, []);
  assert.ok(rejects(unavailableBranch, { project_id: null, probe: true }), 'scan unavailable no permite branch_exists no nulo');
});

check('scan unavailable puede dejar merged desconocido o usar el valor merged de Task', () => {
  const base = inventario();
  const makeUnavailable = (overrides) => conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [],
  }, [{
    ...base.worktrees[0],
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped',
    merged: 'unknown',
    needs_review: false,
    ...overrides,
  }]);

  assert.ok(!rejects(makeUnavailable({ merged: 'unknown' }), { project_id: null, probe: true }), 'scan unavailable permite merged unknown');
  assert.ok(!rejects(makeUnavailable({ merged: 'merged' }), { project_id: null, probe: true }), 'la Task puede aportar merged aunque Git no escanee');
});

check('scan unavailable no puede producir merged unmerged', () => {
  const base = inventario();
  const unavailableUnmerged = conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [],
  }, [{
    ...base.worktrees[0],
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped',
    merged: 'unmerged',
    needs_review: false,
  }]);
  assert.ok(rejects(unavailableUnmerged, { project_id: null, probe: true }), 'sin escaneo no puede verificarse unmerged');
});

check('scan unavailable no puede producir merged unmerged en ramas conservadas', () => {
  const base = inventario();
  const unavailableRepos = [
    { ...base.repos[0], scan: 'unavailable', reason: 'git_failed' },
    ...base.repos.slice(1),
  ];
  const preservedUnmerged = conRamasConservadas({
    ...base,
    repos: unavailableRepos,
    worktrees: [],
  }, [{
    ...base.preserved_branches[0],
    branch_exists: null,
    merged: 'unmerged',
    needs_review: false,
  }]);
  assert.ok(rejects(preservedUnmerged, { project_id: null, probe: true }), 'branch_exists=null no legitima merged=unmerged si scan no está disponible');

  const preservedUnknown = conRamasConservadas({
    ...base,
    repos: unavailableRepos,
    worktrees: [],
  }, [{
    ...base.preserved_branches[0],
    branch_exists: null,
    merged: 'unknown',
    needs_review: false,
  }]);
  assert.ok(!rejects(preservedUnknown, { project_id: null, probe: true }), 'con scan unavailable, merged=unknown y needs_review=false sí cuadran');
});

check('scan unavailable no puede producir needs_review true', () => {
  const base = inventario();
  const unavailableNeedsReview = conWorktrees({
    ...base,
    repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
    preserved_branches: [],
  }, [{
    ...base.worktrees[0],
    state: 'unknown',
    git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    dirty: 'skipped',
    merged: 'unmerged',
    needs_review: true,
  }]);
  assert.ok(rejects(unavailableNeedsReview, { project_id: null, probe: true }), 'sin escaneo Core no marca revisión');
});

check('cada repo coincide exactamente con la máquina conocida por Core', () => {
  const dto = inventario();
  dto.repos[0].machine = null;
  assert.ok(rejects(dto, { project_id: null, probe: true }), 'repo con machine null contradice machine de Core');
});

check('mismatch de machine solo en repo o solo en target se rechaza', () => {
  const base = inventario();
  const repoOnlyMismatch = {
    ...base,
    repos: base.repos.map((repo, index) => index === 1 ? { ...repo, machine: null } : repo),
  };
  assert.ok(rejects(repoOnlyMismatch, { project_id: null, probe: true }), 'repo sin targets tampoco puede contradecir machine de Core');

  const worktreeTargetOnlyMismatch = conWorktrees(base, [
    { ...base.worktrees[0], target: { ...base.worktrees[0].target, machine: null } },
    base.worktrees[1],
  ]);
  assert.ok(rejects(worktreeTargetOnlyMismatch, { project_id: null, probe: true }), 'target de worktree no puede contradecir machine de repo/Core');

  const branchTargetOnlyMismatch = conRamasConservadas(base, [{
    ...base.preserved_branches[0],
    target: { ...base.preserved_branches[0].target, machine: null },
  }]);
  assert.ok(rejects(branchTargetOnlyMismatch, { project_id: null, probe: true }), 'target de rama conservada no puede contradecir machine de repo/Core');
});

check('una rama que git da por inexistente no se puede pedir revisar', () => {
  const dto = inventario();
  dto.preserved_branches[0].branch_exists = false;
  assert.ok(rejects(dto, { project_id: null, probe: true }));
});

check('needs_review respeta los campos visibles sin inferir existencia en worktrees', () => {
  const base = inventario();
  const task = base.worktrees[0];
  const preserved = base.preserved_branches[0];

  // El DTO de worktrees no expone branch_exists; git.branch no permite inferir ese resultado.
  const uncertainWorktreeBranch = conWorktrees(base, [{
    ...task,
    git: { ...task.git, branch: null },
    needs_review: false,
  }, base.worktrees[1]]);
  assert.ok(!rejects(uncertainWorktreeBranch, { project_id: null, probe: true }), 'unmerged sin existencia confirmada aún puede ser false');

  const activeTask = conWorktrees(base, [
    { ...task, owner: { ...task.owner, status: 'running' }, needs_review: false },
    base.worktrees[1],
  ]);
  assert.ok(!rejects(activeTask, { project_id: null, probe: true }), 'una Task activa no se marca para revisión');

  for (const invalid of [
    { ...task, merged: 'unknown' },
    { ...task, merged: 'merged' },
    { ...task, owner: { ...task.owner, status: 'running' } },
  ]) {
    assert.ok(rejects(conWorktrees(base, [invalid, base.worktrees[1]]), { project_id: null, probe: true }), 'needs_review true requiere merged unmerged y owner final');
  }

  assert.ok(rejects(conWorktrees(base, [task, { ...base.worktrees[1], needs_review: true }]), { project_id: null, probe: true }), 'un worktree externo nunca cuenta para revisión');
  assert.ok(rejects(conWorktrees(base, [{ ...task, merged: 'skipped' }, base.worktrees[1]]), { project_id: null, probe: true }), 'probe=true nunca produce merged skipped');

  const unknownExistence = conRamasConservadas(base, [{ ...preserved, branch_exists: null, needs_review: false }]);
  assert.ok(!rejects(unknownExistence, { project_id: null, probe: true }), 'existencia null no se convierte en revisión');
  assert.ok(rejects(conRamasConservadas(base, [{ ...preserved, branch_exists: null }]), { project_id: null, probe: true }), 'existencia null no permite needs_review true');
  assert.ok(rejects(conRamasConservadas(base, [{ ...preserved, branch_exists: false, merged: 'unmerged', needs_review: false }]), { project_id: null, probe: true }), 'rama inexistente no puede ser unmerged');
  assert.ok(!rejects(conRamasConservadas(base, [{ ...preserved, branch_exists: false, merged: 'unknown', needs_review: false }]), { project_id: null, probe: true }));
  assert.ok(rejects(conRamasConservadas(base, [{ ...preserved, needs_review: false }]), { project_id: null, probe: true }), 'rama existente y unmerged exige needs_review true');
  assert.ok(rejects(conRamasConservadas(base, [{ ...preserved, owner: null }]), { project_id: null, probe: true }), 'una rama conservada de una Task conserva su owner');
  assert.ok(rejects(conRamasConservadas(base, [{ ...preserved, merged: 'skipped', needs_review: false }]), { project_id: null, probe: true }), 'probe=true nunca produce merged skipped');

  const withoutProbe = inventarioSinSondeo();
  assert.ok(!rejects(withoutProbe, { project_id: null, probe: false }), 'probe=false mantiene skipped y needs_review null');
});

check('needs_review incoherente se rechaza cambiando solo el veredicto', () => {
  const base = inventario();
  const externalMarkedForReview = conWorktrees(base, [
    base.worktrees[0],
    { ...base.worktrees[1], needs_review: true },
  ]);
  assert.ok(rejects(externalMarkedForReview, { project_id: null, probe: true }), 'un worktree external conserva needs_review=false');

  const preservedNotMarked = conRamasConservadas(base, [{
    ...base.preserved_branches[0],
    needs_review: false,
  }]);
  assert.ok(rejects(preservedNotMarked, { project_id: null, probe: true }), 'una rama existente y unmerged exige needs_review=true');
});

check('origin=task requiere owner y origin=lixbon_dir requiere owner=null', () => {
  const base = inventario();
  const taskWithoutOwner = conWorktrees(base, [
    { ...base.worktrees[0], owner: null, needs_review: false },
    base.worktrees[1],
  ]);
  assert.ok(rejects(taskWithoutOwner, { project_id: null, probe: true }), 'origin=task requiere owner');

  const lixbonDirWithOwner = conWorktrees(base, [
    base.worktrees[0],
    {
      ...base.worktrees[1],
      state: 'orphan_candidate',
      origin: 'lixbon_dir',
      owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
    },
  ]);
  assert.ok(rejects(lixbonDirWithOwner, { project_id: null, probe: true }), 'origin=lixbon_dir requiere owner=null');
});

check('el eco de los filtros tiene que ser el de la petición', () => {
  const dto = inventario({ projectId: 'project-9' });
  assert.ok(rejects(dto, { project_id: 'project-1', probe: true }));
});

check('project_id limita repos y targets pero null sigue válido sin filtro', () => {
  const scoped = inventario({ projectId: 'project-1' });
  assert.ok(!rejects(scoped, { project_id: 'project-1', probe: true }), 'el DTO del Project pedido se acepta');

  const otherRepo = { ...scoped, repos: [...scoped.repos, inventario().repos[1]] };
  assert.ok(rejects(otherRepo, { project_id: 'project-1', probe: true }), 'repo de otro Project se rechaza');
  const otherWorktree = conWorktrees(scoped, [{
    ...scoped.worktrees[0],
    target: { ...scoped.worktrees[0].target, project_id: 'project-2' },
  }, scoped.worktrees[1]]);
  assert.ok(rejects(otherWorktree, { project_id: 'project-1', probe: true }), 'target de worktree de otro Project se rechaza');
  const otherBranch = conRamasConservadas(scoped, [{
    ...scoped.preserved_branches[0],
    target: { ...scoped.preserved_branches[0].target, project_id: 'project-2' },
  }]);
  assert.ok(rejects(otherBranch, { project_id: 'project-1', probe: true }), 'target de rama conservada de otro Project se rechaza');

  const nullRepo = { project_id: null, machine: 'machine-1', path: '/tmp/unassigned', scan: 'ok' };
  const nullWorktree = {
    ...inventario().worktrees[1],
    target: { ...inventario().worktrees[1].target, project_id: null, repo: '/tmp/unassigned', path: '/tmp/unassigned/wt' },
  };
  const nullBranch = {
    ...scoped.preserved_branches[0],
    target: { ...scoped.preserved_branches[0].target, project_id: null, repo: '/tmp/unassigned' },
  };
  const unfiltered = recontarInventario({
    ...inventario(),
    repos: [...inventario().repos, nullRepo],
    worktrees: [...inventario().worktrees, nullWorktree],
    preserved_branches: [...inventario().preserved_branches, nullBranch],
  });
  assert.ok(!rejects(unfiltered, { project_id: null, probe: true }), 'repo, worktree externo y rama con project_id null se aceptan sin filtro');

  assert.ok(rejects({ ...scoped, repos: [...scoped.repos, nullRepo] }, { project_id: 'project-1', probe: true }), 'repo null se rechaza bajo filtro');
  assert.ok(rejects(conWorktrees(scoped, [...scoped.worktrees, nullWorktree]), { project_id: 'project-1', probe: true }), 'target null se rechaza bajo filtro');
  assert.ok(rejects(conRamasConservadas(scoped, [nullBranch]), { project_id: 'project-1', probe: true }), 'target de rama null se rechaza bajo filtro');
});

check('cada target debe corresponder al repo con la misma ruta, máquina y Project', () => {
  const base = inventario();
  const unavailable = base.repos[1];

  const unrelatedWorktreeRepo = conWorktrees(base, [{
    ...base.worktrees[0],
    target: { ...base.worktrees[0].target, repo: unavailable.path },
  }, base.worktrees[1]]);
  assert.ok(rejects(unrelatedWorktreeRepo, { project_id: null, probe: true }), 'un repo unavailable de otro Project no legitima la ruta');

  const mismatchedWorktreeProject = conWorktrees(base, [{
    ...base.worktrees[0],
    target: { ...base.worktrees[0].target, project_id: 'project-2' },
  }, base.worktrees[1]]);
  assert.ok(rejects(mismatchedWorktreeProject, { project_id: null, probe: true }), 'el Project del target debe coincidir con repos');

  const mismatchedWorktreeMachine = conWorktrees(base, [{
    ...base.worktrees[0],
    target: { ...base.worktrees[0].target, machine: null },
  }, base.worktrees[1]]);
  assert.ok(rejects(mismatchedWorktreeMachine, { project_id: null, probe: true }), 'la máquina del target debe coincidir con repos');

  const unrelatedBranchRepo = conRamasConservadas(base, [{
    ...base.preserved_branches[0],
    target: { ...base.preserved_branches[0].target, repo: unavailable.path },
  }]);
  assert.ok(rejects(unrelatedBranchRepo, { project_id: null, probe: true }), 'un repo unavailable de otro Project no legitima una rama conservada');

  const mismatchedBranchProject = conRamasConservadas(base, [{
    ...base.preserved_branches[0],
    target: { ...base.preserved_branches[0].target, project_id: 'project-2' },
  }]);
  assert.ok(rejects(mismatchedBranchProject, { project_id: null, probe: true }), 'el Project de la rama debe coincidir con repos');

  const mismatchedBranchMachine = conRamasConservadas(base, [{
    ...base.preserved_branches[0],
    target: { ...base.preserved_branches[0].target, machine: null },
  }]);
  assert.ok(rejects(mismatchedBranchMachine, { project_id: null, probe: true }), 'la máquina de la rama debe coincidir con repos');
});

resetOutstandingQueries();
console.log(checks.join('\n'));
console.log(failures === 0 ? `\nOK: ${checks.length} comprobaciones sin dependencias.` : `\nFALLOS: ${failures} de ${checks.length}.`);
process.exit(failures === 0 ? 0 : 1);
