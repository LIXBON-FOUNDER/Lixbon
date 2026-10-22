// Pruebas de la UX de conexión de Supervisar (LXO-111): `npm test` (node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STALE_MS, STATUS } from './bootstrap.js';
import { KIND, actionGate, connectionA11y, connectionView, syncedAgo } from './connection.js';
import { hostName, pickHost, sessionOnline } from './hosts.js';

const NOW = 10_000_000;
const snapshot = { projects: { total: 1, items: [] }, active_tasks: { total: 0, items: [] }, attention: { total: 0, items: [] } };
const core = (over = {}) => ({ status: STATUS.ONLINE, snapshot, syncedAt: NOW - 5_000, fromCache: false, reason: null, ...over });
const view = (over = {}, coreOver = {}) =>
  connectionView({ core: core(coreOver), link: 'open', hostConnected: true, hasHost: true, now: NOW, ...over });

describe('1 · online → offline → reconnect', () => {
  it('la secuencia completa sin pasar nunca por «fallo»', () => {
    const steps = [
      view(),
      view({ link: 'reconnecting' }),
      view({ link: 'open', hostConnected: false }, { status: STATUS.OFFLINE, reason: 'host_offline' }),
      view({}, { status: STATUS.STALE, syncedAt: NOW - STALE_MS - 1 }),
      view(),
    ];
    assert.deepEqual(steps.map((v) => v.kind), [KIND.ONLINE, KIND.RECONNECTING, KIND.OFFLINE, KIND.STALE, KIND.ONLINE]);
    for (const v of steps) assert.notEqual(v.tone, 'error', `${v.kind} no usa el tono de fallo`);
    assert.match(steps[1].detail, /última sincronización/);
    assert.equal(steps[2].title, 'IDE desconectado');
    assert.equal(steps[2].retry, true);
  });

  it('sin socket con el servidor se distingue de IDE desconectado', () => {
    const noServer = view({ link: 'closed' }, { status: STATUS.OFFLINE, reason: 'offline' });
    assert.equal(noServer.kind, KIND.OFFLINE);
    assert.match(noServer.detail, /servidor de Lixbon/);
    const noIde = view({ hostConnected: false });
    assert.match(noIde.detail, /IDE no está conectado/);
  });

  it('Core del escritorio sin almacén: offline con diagnóstico, no fallo', () => {
    const v = view({}, { status: STATUS.OFFLINE, reason: 'compact_snapshot_unavailable' });
    assert.equal(v.kind, KIND.OFFLINE);
    assert.equal(v.code, 'compact_snapshot_unavailable');
    assert.match(v.detail, /almacén/);
  });
});

describe('2 · background / foreground y caché', () => {
  it('una sincronización vieja (al volver de segundo plano) pasa a desactualizado', () => {
    const v = view({}, { syncedAt: NOW - STALE_MS - 1 });
    assert.equal(v.kind, KIND.STALE);
    assert.equal(v.lastSync, 'hace 1 min');
    assert.equal(v.canMutate, false);
  });

  it('la caché se marca como datos guardados, también mientras conecta', () => {
    const connecting = connectionView({ core: core({ fromCache: true, status: STATUS.STALE }), link: 'connecting', hostConnected: false, now: NOW });
    assert.equal(connecting.kind, KIND.STALE);
    assert.equal(connecting.title, 'Datos guardados');
    const open = view({}, { fromCache: true, status: STATUS.STALE });
    assert.equal(open.kind, KIND.STALE);
    assert.equal(open.fromCache, true);
    assert.match(open.detail, /se guardó en este teléfono/);
  });

  it('sin datos y conectando no se finge nada', () => {
    const v = connectionView({ core: null, link: 'connecting', hostConnected: false, now: NOW });
    assert.equal(v.kind, KIND.CONNECTING);
    assert.equal(v.hasData, false);
    assert.equal(v.lastSync, null);
  });
});

describe('3 · autorización y versión', () => {
  it('sesión caducada: unauthorized, distinto de un problema de red', () => {
    const v = view({}, { status: STATUS.UNAUTHORIZED, reason: 'unauthorized' });
    assert.equal(v.kind, KIND.UNAUTHORIZED);
    assert.equal(v.tone, 'error');
    assert.match(v.detail, /iniciar sesión/);
    assert.equal(v.retry, true);
    // Aunque además se caiga el socket, sigue diciendo que es un problema de autorización.
    assert.equal(view({ link: 'reconnecting' }, { status: STATUS.UNAUTHORIZED }).kind, KIND.UNAUTHORIZED);
  });

  for (const [reason, text] of [
    ['host_without_core_snapshot', /anterior a Supervisar/],
    ['unsupported_action', /actualiza Lixbon en el escritorio/],
    ['protocol_mismatch', /versiones distintas/],
    ['snapshot_version_unsupported', /actualiza la app/],
  ]) {
    it(`versión: ${reason} con texto accionable`, () => {
      const v = view({}, { status: STATUS.VERSION_MISMATCH, reason });
      assert.equal(v.kind, KIND.VERSION_MISMATCH);
      assert.match(v.detail, text);
      assert.equal(v.code, reason, 'diagnóstico: solo el código estable');
    });
  }
});

describe('4 · acciones futuras', () => {
  it('solo en línea se puede mandar algo', () => {
    assert.deepEqual(actionGate(view()), { allowed: true, reason: null });
    for (const v of [
      view({ link: 'reconnecting' }),
      view({ hostConnected: false }),
      view({}, { syncedAt: NOW - STALE_MS - 1 }),
      view({}, { status: STATUS.UNAUTHORIZED }),
      view({}, { status: STATUS.VERSION_MISMATCH }),
      connectionView({ core: null, link: 'connecting', hostConnected: false, now: NOW }),
    ]) {
      const gate = actionGate(v);
      assert.equal(gate.allowed, false, v.kind);
      assert.ok(gate.reason, `${v.kind} explica por qué`);
    }
  });
});

describe('5 · texto y accesibilidad', () => {
  it('el lector de pantalla oye título, detalle y última sincronización', () => {
    const v = view({ hostConnected: false });
    assert.equal(connectionA11y(v), 'IDE desconectado. El IDE no está conectado a esta sesión. Lo que ves es de la última sincronización. Última sincronización ahora mismo');
    assert.equal(connectionA11y(view({}, { syncedAt: NOW - 30_000, status: STATUS.STALE })).endsWith('Última sincronización hace 30 s'), true);
    assert.equal(connectionA11y(view()), 'En línea. Última sincronización ahora mismo');
  });

  it('última sincronización en palabras', () => {
    assert.equal(syncedAgo(NOW, NOW), 'ahora mismo');
    assert.equal(syncedAgo(NOW - 30_000, NOW), 'hace 30 s');
    assert.equal(syncedAgo(NOW - 5 * 60_000, NOW), 'hace 5 min');
    assert.equal(syncedAgo(NOW - 3 * 3600_000, NOW), 'hace 3 h');
    assert.equal(syncedAgo(NOW - 86400_000, NOW), 'hace 1 día');
    assert.equal(syncedAgo(undefined, NOW), null);
  });

  it('sin IDE elegido se explica cómo empezar', () => {
    const v = connectionView({ core: null, link: 'connecting', hostConnected: false, hasHost: false, now: NOW });
    assert.equal(v.title, 'Ningún IDE conectado');
    assert.match(v.detail, /\/remote/);
    assert.equal(v.retry, false);
  });
});

describe('6 · qué IDE se supervisa', () => {
  const a = { id: 'a', status: 'online', host_connected: false, title: 'Portátil' };
  const b = { id: 'b', status: 'offline', host_connected: true, machine: 'Torre' };
  const ended = { id: 'z', status: 'ended', host_connected: true };

  it('host_connected manda sobre el status guardado', () => {
    assert.equal(sessionOnline(a), false);
    assert.equal(sessionOnline(b), true);
    assert.equal(sessionOnline(ended), false);
    assert.equal(sessionOnline({ id: 'x', status: 'online' }), true);
  });

  it('sin elección: el primero en línea; las terminadas no cuentan', () => {
    const { session, candidates } = pickHost([a, b, ended], null);
    assert.equal(session.id, 'b');
    assert.deepEqual(candidates.map((s) => s.id), ['b', 'a']);
  });

  it('el elegido se mantiene aunque se desconecte; si desaparece, otro', () => {
    assert.equal(pickHost([a, b], 'a').session.id, 'a');
    assert.equal(pickHost([b], 'a').session.id, 'b');
    assert.equal(pickHost([], 'a').session, null);
    assert.equal(pickHost(undefined, null).session, null);
  });

  it('nombre del host', () => {
    assert.equal(hostName(b), 'Torre');
    assert.equal(hostName(a, { machine: 'Mesa' }), 'Mesa');
    assert.equal(hostName({}), 'IDE');
  });
});
