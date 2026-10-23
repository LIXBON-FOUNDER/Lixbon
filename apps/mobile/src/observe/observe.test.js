// Pruebas del bootstrap observacional (LXO-107): `npm test` (node --test, sin Jest).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKOFF_MS, MAX_ATTEMPTS, POLL_MS, STALE_MS, STATUS, classify, createCoreBootstrap } from './bootstrap.js';
import { MAX_CACHE_CHARS, createSnapshotCache } from './cache.js';
import { RELAY_PROTOCOL, createCoreLink } from './link.js';
import { coreStatusLabel } from './status.js';

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Reloj falso: los temporizadores solo corren con `advance`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  let next = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
    get pending() {
      return timers.size;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

/** Un IDE + Core simulados: Tasks, Event Log con `seq` y snapshot coherente con su cursor. */
function fakeCore({ title = (i) => `Tarea ${i}`, projects = 1 } = {}) {
  const core = {
    seq: 0,
    tasks: [],
    events: [],
    calls: [],
    mode: 'ok', // ok | offline | unauthorized | old_ide | cursor_ahead | version2
    replayFrom: null, // al reconectar, repite eventos desde aquí
    addTask(project = 'p0') {
      const id = `t${core.tasks.length + 1}`;
      core.tasks.push({ id, project_id: project, title: title(core.tasks.length), status: 'running' });
      core.seq += 1;
      core.events.push({ seq: core.seq, kind: 'task.created', ts: core.seq, project_id: project, run_id: 'r1', entity: { kind: 'task', id } });
      return id;
    },
    snapshot() {
      return {
        snapshot_version: core.mode === 'version2' ? 2 : 1,
        generated_at: 1,
        core: { version: '2.2.0', health: 'ok', machine_id: 'm1' },
        cursor: { events: core.seq },
        projects: {
          total: projects,
          truncated: projects > 50,
          items: Array.from({ length: Math.min(projects, 50) }, (_, i) => ({ id: `p${i}`, name: title(i), status: 'active', active: 1, failed: 0, attention: 0 })),
        },
        active_tasks: { total: core.tasks.length, truncated: core.tasks.length > 50, items: core.tasks.slice(-50) },
        attention: { total: 0, by_category: {}, truncated: false, items: [] },
        unassigned: { active: 0, failed: 0, attention: 0 },
        limits: { projects: 50, active_tasks: 50, attention_items: 5, text_chars: 120 },
      };
    },
    async request(action, args) {
      core.calls.push(action);
      if (core.mode === 'offline') return { ok: false, transport: 'offline' };
      if (core.mode === 'unauthorized') return { ok: false, code: 'unauthorized' };
      if (core.mode === 'old_ide') return { ok: false, code: 'unsupported_action' };
      if (action === 'core_snapshot') return { ok: true, data: { snapshot: core.snapshot() } };
      if (core.mode === 'cursor_ahead' && args.cursor > core.seq) return { ok: false, code: 'cursor_ahead' };
      const from = core.replayFrom ?? args.cursor;
      core.replayFrom = null;
      const page = core.events.filter((e) => e.seq > from).slice(0, args.limit);
      const last = page.length ? page[page.length - 1].seq : core.seq;
      return { ok: true, data: { events: page, next_cursor: last, has_more: page.length === args.limit && last < core.seq, head_seq: core.seq } };
    },
  };
  return core;
}

function setup({ core = fakeCore(), storage = memoryStorage(), clock = fakeClock(), link = { transportOpen: true, hostConnected: true, capabilities: ['orch', 'core_snapshot'] } } = {}) {
  const logs = [];
  const states = [];
  const boot = createCoreBootstrap({
    hostKey: 'machine-1',
    request: (a, b) => core.request(a, b),
    cache: createSnapshotCache(storage),
    clock,
    now: clock.now,
    log: (code, fields) => logs.push({ code, fields }),
    onChange: (s) => states.push(s.status),
  });
  boot.setLink(link);
  return { boot, core, storage, clock, logs, states };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

describe('1 · arranque en frío', () => {
  it('connecting → online con la snapshot y su cursor', async () => {
    const { boot, core, states } = setup();
    core.addTask();
    assert.equal(boot.state.status, STATUS.CONNECTING);
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.ONLINE);
    assert.equal(boot.state.cursor, core.seq);
    assert.equal(boot.state.snapshot.active_tasks.items.length, 1);
    assert.equal(boot.state.fromCache, false);
    assert.ok(states.includes(STATUS.ONLINE));
  });

  it('guarda una caché no autoritativa sin secretos de sesión', async () => {
    const { boot, storage } = setup();
    await boot.start();
    await flush();
    const [[key, raw]] = [...storage.map.entries()];
    assert.match(key, /^lixbon\.observe\.cache\.v1:machine-1$/);
    const entry = JSON.parse(raw);
    assert.equal(entry.v, 1);
    assert.equal(entry.cursor, 0);
    assert.ok(!/token|secret|bearer/i.test(raw));
  });
});

describe('2 · caché vieja', () => {
  it('se pinta enseguida como stale y se sustituye por la snapshot real', async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    first.core.addTask();
    await first.boot.start();
    await flush();
    first.boot.stop();

    // Nueva apertura: el IDE aún no ha respondido.
    const core = fakeCore();
    core.addTask();
    core.addTask();
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = { ...core, request: async (a, b) => (await gate, core.request(a, b)) };
    const { boot } = setup({ core: slow, storage });
    await boot.start();
    assert.equal(boot.state.status, STATUS.STALE, 'la caché se ve, pero como desactualizada');
    assert.equal(boot.state.fromCache, true);
    assert.equal(boot.state.snapshot.active_tasks.items.length, 1);
    release();
    await flush();
    assert.equal(boot.state.status, STATUS.ONLINE);
    assert.equal(boot.state.fromCache, false);
    assert.equal(boot.state.snapshot.active_tasks.items.length, 2, 'la caché nunca es autoridad');
  });

  it('una caché de otra versión o de otro host se ignora', async () => {
    const storage = memoryStorage();
    storage.map.set('lixbon.observe.cache.v1:machine-1', JSON.stringify({ v: 1, hostKey: 'otro', savedAt: 1, cursor: 0, snapshot: { snapshot_version: 1 } }));
    const cache = createSnapshotCache(storage);
    assert.equal(await cache.load('machine-1'), null);
    storage.map.set('lixbon.observe.cache.v1:machine-1', JSON.stringify({ v: 1, hostKey: 'machine-1', savedAt: 1, cursor: 0, snapshot: { snapshot_version: 2 } }));
    assert.equal(await cache.load('machine-1'), null);
    storage.map.set('lixbon.observe.cache.v1:machine-1', '{roto');
    assert.equal(await cache.load('machine-1'), null);
  });

  it('una sincronización vieja pasa a stale', async () => {
    const { boot, clock, core } = setup();
    await boot.start();
    await flush();
    boot.setForeground(false);
    await clock.advance(STALE_MS + 1);
    core.mode = 'offline';
    boot.setForeground(true);
    assert.equal(boot.state.status, STATUS.STALE);
  });
});

describe('3 · cursor y Event Log', () => {
  it('sigue los eventos desde el cursor y pide otra snapshot si hay cambios', async () => {
    const { boot, core, clock } = setup();
    await boot.start();
    await flush();
    const t = core.addTask();
    await clock.advance(POLL_MS);
    assert.equal(boot.state.cursor, core.seq);
    assert.deepEqual(boot.state.events.map((e) => e.entity.id), [t]);
    assert.ok(boot.state.snapshot.active_tasks.items.some((x) => x.id === t), 'la snapshot nueva lo refleja');
    assert.deepEqual(core.calls, ['core_snapshot', 'core_events', 'core_snapshot']);
  });

  it('sin cambios no vuelve a pedir la snapshot', async () => {
    const { boot, core, clock } = setup();
    await boot.start();
    await flush();
    await clock.advance(POLL_MS * 3);
    assert.deepEqual(core.calls, ['core_snapshot', 'core_events', 'core_events', 'core_events']);
  });

  it('reconectar no duplica eventos aunque el relay los repita', async () => {
    const { boot, core, clock } = setup();
    await boot.start();
    await flush();
    core.addTask();
    core.addTask();
    await clock.advance(POLL_MS);
    const before = boot.state.events.map((e) => e.seq);
    boot.setLink({ transportOpen: false });
    assert.equal(boot.state.status, STATUS.OFFLINE);
    core.addTask();
    core.replayFrom = 0; // el host vuelve a mandar todo desde el principio
    boot.setLink({ transportOpen: true });
    await flush();
    const seqs = boot.state.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...before, core.seq], 'cada evento una vez, en orden');
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(boot.state.status, STATUS.ONLINE);
  });

  it('un cursor que no es de este Core descarta la caché y vuelve a la snapshot', async () => {
    const storage = memoryStorage();
    storage.map.set('lixbon.observe.cache.v1:machine-1', JSON.stringify({ v: 1, hostKey: 'machine-1', savedAt: 1, cursor: 999, snapshot: fakeCore().snapshot() }));
    const core = fakeCore();
    core.mode = 'cursor_ahead';
    const { boot, logs } = setup({ core, storage });
    await boot.start();
    await flush();
    // La primera vuelta ya pide snapshot (la caché nunca se sigue como autoridad); el cursor nuevo es 0.
    assert.equal(boot.state.cursor, 0);
    assert.equal(boot.state.status, STATUS.ONLINE);
    // Si el Core se reinicia con una base nueva, el cursor guardado supera head_seq.
    const { boot: b2, core: c2, clock: k2 } = setup({ core: fakeCore(), storage: memoryStorage() });
    c2.addTask();
    c2.addTask();
    await b2.start();
    await flush();
    c2.seq = 0;
    c2.events = [];
    c2.tasks = [];
    c2.mode = 'cursor_ahead';
    await k2.advance(POLL_MS);
    assert.equal(b2.state.cursor, 0, 'cursor reiniciado desde la snapshot nueva');
    assert.equal(b2.state.snapshot.active_tasks.items.length, 0);
    assert.ok(!logs.some((l) => l.code === 'core_bootstrap_unauthorized'));
  });
});

describe('4 · offline, backoff y foreground', () => {
  it('offline no es un fallo: conserva los datos y reintenta con backoff acotado', async () => {
    const { boot, core, clock } = setup();
    core.addTask();
    await boot.start();
    await flush();
    core.mode = 'offline';
    await clock.advance(POLL_MS);
    assert.equal(boot.state.status, STATUS.STALE, 'con el IDE alcanzable y datos: desactualizado, no vacío');
    assert.equal(boot.state.snapshot.active_tasks.items.length, 1);
    const callsAtFirstFailure = core.calls.length;
    for (const ms of BACKOFF_MS) await clock.advance(ms);
    assert.equal(core.calls.length - callsAtFirstFailure, MAX_ATTEMPTS - 1, 'no reintenta más allá del tope');
    await clock.advance(10 * 60_000);
    assert.equal(core.calls.length - callsAtFirstFailure, MAX_ATTEMPTS - 1);
    assert.equal(clock.pending, 0, 'sin temporizadores colgando');
    // Al volver la conexión se reanuda desde el cursor.
    core.mode = 'ok';
    boot.setLink({ transportOpen: false });
    boot.setLink({ transportOpen: true });
    await flush();
    assert.equal(boot.state.status, STATUS.ONLINE);
    assert.equal(boot.state.attempts, 0);
  });

  it('sin socket o sin IDE conectado está offline y no pide nada', async () => {
    const core = fakeCore();
    const { boot } = setup({ core, link: { transportOpen: true, hostConnected: false, capabilities: ['core_snapshot'] } });
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.OFFLINE);
    assert.deepEqual(core.calls, []);
    boot.setLink({ hostConnected: true });
    await flush();
    assert.equal(boot.state.status, STATUS.ONLINE);
  });

  it('en segundo plano no sondea; al volver se refresca', async () => {
    const { boot, core, clock } = setup();
    await boot.start();
    await flush();
    boot.setForeground(false);
    const calls = core.calls.length;
    await clock.advance(STALE_MS * 5);
    assert.equal(core.calls.length, calls, 'sin peticiones en segundo plano');
    assert.equal(clock.pending, 0);
    core.addTask();
    boot.setForeground(true);
    await flush();
    assert.ok(core.calls.length > calls);
    assert.equal(boot.state.status, STATUS.ONLINE);
    assert.equal(boot.state.snapshot.active_tasks.items.length, 1);
  });
});

describe('5 · token inválido y versión', () => {
  it('token inválido: unauthorized, sin reintentos solos; retry() lo reanuda', async () => {
    const core = fakeCore();
    core.mode = 'unauthorized';
    const { boot, clock } = setup({ core });
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.UNAUTHORIZED);
    await clock.advance(10 * 60_000);
    assert.equal(core.calls.length, 1);
    boot.setLink({ transportOpen: false });
    boot.setLink({ transportOpen: true });
    boot.setForeground(false);
    boot.setForeground(true);
    await flush();
    assert.equal(core.calls.length, 1, 'ni reconectar ni volver a primer plano lo reintentan');
    core.mode = 'ok';
    boot.retry();
    await flush();
    assert.equal(boot.state.status, STATUS.ONLINE);
  });

  for (const code of ['compact_snapshot_auth_required', 'forbidden']) {
    it(`${code} del Core también es unauthorized`, () => assert.equal(classify({ ok: false, code }), 'unauthorized'));
  }

  it('IDE sin la capability: version_mismatch sin pedir nada', async () => {
    const core = fakeCore();
    const { boot } = setup({ core, link: { transportOpen: true, hostConnected: true, capabilities: ['orch'] } });
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.VERSION_MISMATCH);
    assert.equal(boot.state.reason, 'host_without_core_snapshot');
    assert.deepEqual(core.calls, []);
  });

  it('IDE o gateway anterior (acción no soportada): version_mismatch', async () => {
    const core = fakeCore();
    core.mode = 'old_ide';
    const { boot } = setup({ core });
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.VERSION_MISMATCH);
  });

  it('snapshot de una versión que no conoce: version_mismatch', async () => {
    const core = fakeCore();
    core.mode = 'version2';
    const { boot } = setup({ core });
    await boot.start();
    await flush();
    assert.equal(boot.state.status, STATUS.VERSION_MISMATCH);
    assert.equal(boot.state.reason, 'snapshot_version_unsupported');
  });
});

describe('6 · datos sensibles y snapshot grande', () => {
  it('los logs llevan códigos y contadores, nunca contenido', async () => {
    const core = fakeCore({ title: (i) => `SENTINEL-TITLE-${i}` });
    core.addTask();
    const { boot, logs, clock } = setup({ core });
    await boot.start();
    await flush();
    core.mode = 'offline';
    await clock.advance(POLL_MS);
    const text = JSON.stringify(logs);
    assert.ok(logs.length > 0);
    assert.ok(!text.includes('SENTINEL'), text);
    assert.ok(!text.includes('machine-1'));
  });

  it('bootstrap con la snapshot más grande que permite el Core', async () => {
    // Peor caso de LXO-94: 50 Projects y 50 Tasks con textos de 120 caracteres de 4 bytes (~67 KB).
    const big = (i) => `${String(i).padStart(4, '0')}${'🦀'.repeat(115)}`;
    const core = fakeCore({ title: big, projects: 150 });
    for (let i = 0; i < 150; i++) core.addTask(`p${i % 50}`);
    const storage = memoryStorage();
    const { boot } = setup({ core, storage });
    const size = Buffer.byteLength(JSON.stringify(core.snapshot()), "utf8");
    const t0 = performance.now();
    await boot.start();
    await flush();
    const ms = performance.now() - t0;
    assert.equal(boot.state.status, STATUS.ONLINE);
    assert.equal(boot.state.snapshot.projects.truncated, true);
    assert.equal(boot.state.snapshot.active_tasks.items.length, 50);
    const [[, raw]] = [...storage.map.entries()];
    assert.ok(raw.length <= MAX_CACHE_CHARS, `caché de ${raw.length} caracteres`);
    assert.ok(ms < 500, `bootstrap en ${ms.toFixed(1)} ms`);
    console.log(`observe · snapshot grande: ${size} bytes, bootstrap ${ms.toFixed(1)} ms`);
  });

  it('una snapshot que no cabe en el tope de la caché no se guarda', async () => {
    const storage = memoryStorage();
    const cache = createSnapshotCache(storage);
    const huge = { snapshot_version: 1, filler: 'x'.repeat(MAX_CACHE_CHARS) };
    assert.equal(await cache.save('h', { snapshot: huge, cursor: 0, savedAt: 1 }), false);
    assert.equal(storage.map.size, 0);
  });
});

// ── Enlace por rid ────────────────────────────────────────────────────────────

describe('7 · enlace con el IDE por rid', () => {
  const okAck = async () => ({ ok: true });

  it('empareja la respuesta por rid e ignora las ajenas', async () => {
    const sent = [];
    const link = createCoreLink({ send: async (c) => (sent.push(c), { ok: true }), newRid: () => 'c1' });
    const p = link.request('core_snapshot', {});
    await flush();
    assert.deepEqual(sent, [{ type: 'orch', action: 'core_snapshot', args: { rid: 'c1' } }]);
    assert.equal(link.handleEvent({ type: 'orch_core_snapshot', rid: 'otro', ok: true, protocol: RELAY_PROTOCOL }), true, 'no es transcript');
    assert.equal(link.pendingCount, 1);
    link.handleEvent({ type: 'orch_core_snapshot', rid: 'c1', ok: true, protocol: RELAY_PROTOCOL, snapshot: { snapshot_version: 1 } });
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.data.snapshot.snapshot_version, 1);
    assert.equal(link.handleEvent({ type: 'assistant_done' }), false);
  });

  it('una respuesta a otra acción con el mismo rid no la resuelve', async () => {
    const link = createCoreLink({ send: okAck, newRid: () => 'c1' });
    const p = link.request('core_events', { cursor: 0 });
    await flush();
    link.handleEvent({ type: 'orch_core_snapshot', rid: 'c1', ok: true, protocol: 1 });
    assert.equal(link.pendingCount, 1);
    link.handleEvent({ type: 'orch_core_events', rid: 'c1', ok: false, code: 'cursor_ahead', protocol: 1 });
    assert.deepEqual(await p, { ok: false, code: 'cursor_ahead' });
  });

  for (const [ack, expected] of [
    [{ ok: false, status: 409 }, { ok: false, transport: 'host_offline' }],
    [{ ok: false, status: 401 }, { ok: false, code: 'unauthorized' }],
    [{ ok: false, status: 422 }, { ok: false, code: 'unsupported_action' }],
    [{ ok: false, detail: 'Sin conexión con el servidor' }, { ok: false, transport: 'offline' }],
  ]) {
    it(`acuse ${JSON.stringify(ack)} → ${JSON.stringify(expected)}`, async () => {
      const link = createCoreLink({ send: async () => ack });
      assert.deepEqual(await link.request('core_snapshot', {}), expected);
      assert.equal(link.pendingCount, 0);
    });
  }

  it('sin respuesta del IDE: timeout', async () => {
    const clock = fakeClock();
    const link = createCoreLink({ send: okAck, clock, timeoutMs: 1000 });
    const p = link.request('core_snapshot', {});
    await clock.advance(1000);
    assert.deepEqual(await p, { ok: false, transport: 'timeout' });
  });

  it('IDE anterior: orch_error de la acción resuelve como no soportada', async () => {
    const link = createCoreLink({ send: okAck });
    const p = link.request('core_snapshot', {});
    await flush();
    assert.equal(link.handleEvent({ type: 'orch_error', action: 'core_snapshot', message: 'Acción no soportada.' }), true);
    assert.deepEqual(await p, { ok: false, code: 'unsupported_action' });
    assert.equal(link.handleEvent({ type: 'orch_error', action: 'diff', message: 'x' }), false, 'otros errores siguen a la vista');
  });

  it('otro protocolo de relé: protocol_mismatch', async () => {
    const link = createCoreLink({ send: okAck, newRid: () => 'c9' });
    const p = link.request('core_snapshot', {});
    await flush();
    link.handleEvent({ type: 'orch_core_snapshot', rid: 'c9', ok: true, protocol: 2 });
    assert.deepEqual(await p, { ok: false, code: 'protocol_mismatch' });
  });

  it('cerrar resuelve lo pendiente', async () => {
    const link = createCoreLink({ send: okAck });
    const p = link.request('core_snapshot', {});
    link.close();
    assert.deepEqual(await p, { ok: false, transport: 'closed' });
    assert.deepEqual(await link.request('core_snapshot', {}), { ok: false, transport: 'closed' });
  });
});

describe('8 · indicador de conexión', () => {
  const snap = (over = {}) => ({ ...fakeCore({ title: () => 'SENTINEL-TITLE' }).snapshot(), ...over });

  it('cada estado tiene su texto y solo los que se atascan ofrecen reintentar', () => {
    const base = { snapshot: snap(), syncedAt: 1_000, events: [] };
    const label = (status) => coreStatusLabel({ ...base, status }, 1_000 + 5 * 60_000);
    assert.equal(coreStatusLabel(null), null);
    assert.equal(label(STATUS.CONNECTING).retry, false);
    assert.match(label(STATUS.ONLINE).text, /en línea · 1 proyecto · 0 tareas activas/);
    assert.match(label(STATUS.STALE).text, /desactualizado \(hace 5 min\)/);
    for (const st of [STATUS.OFFLINE, STATUS.UNAUTHORIZED, STATUS.VERSION_MISMATCH]) assert.equal(label(st).retry, true, st);
    assert.equal(label(STATUS.VERSION_MISMATCH).tone, 'error');
    assert.match(coreStatusLabel({ status: STATUS.OFFLINE, snapshot: null }).text, /sin conexión con el IDE/);
  });

  it('solo cuenta, nunca enseña títulos', () => {
    const text = coreStatusLabel({ status: STATUS.ONLINE, snapshot: snap(), syncedAt: 1 }).text;
    assert.ok(!text.includes('SENTINEL'));
  });
});
