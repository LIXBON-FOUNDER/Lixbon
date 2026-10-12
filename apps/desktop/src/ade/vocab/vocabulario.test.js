// Vigila que el espejo del ADE no se desvíe de contracts/status-vocabulary.json (slice H).
// Mismo patrón que orch/vocabulary.test.js: el contrato se lee con readFileSync, no se importa en ejecución.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_STATUSES, ATTEMPT_STATES, ATTEMPT_STATE_LABELS, TASK_DERIVED_STATES, ATTENTION_KINDS, ENTITY_KINDS, MESSAGE_KINDS,
  FAILURE_REASONS, POLICY_STATUSES, REVIEW_DECISIONS, REVIEW_STATES, INTEGRATION_OUTCOMES, DURABLE_EVENT_TYPES, EPHEMERAL_EVENT_TYPES,
  VISUAL_GROUPS, attemptStateInfo, attentionPriority, attentionKindInfo, isFinalState, FAILURE_REASON_LABELS,
} from './vocabulario';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const contrato = JSON.parse(readFileSync(resolve(RAIZ, 'contracts', 'status-vocabulary.json'), 'utf8'));
const dominio = contrato.domain;
const presentacion = contrato.presentation;
const ids = (lista) => lista.map((e) => (typeof e === 'string' ? e : e.id));

describe('espejo del vocabulario canónico', () => {
  it('estados de Task: ids, finales y grupo visual', () => {
    expect(ids(TASK_STATUSES)).toEqual(dominio.task_status.items.map((i) => i.id));
    for (const e of dominio.task_status.items) {
      const mio = TASK_STATUSES.find((t) => t.id === e.id);
      expect(mio.final, e.id).toBe(e.final);
      expect(mio.group, e.id).toBe(presentacion.visual_group.of_task_status[e.id]);
    }
  });

  it('Attempt: pending_approval + los ids de la Task, con los mismos finales', () => {
    expect(ids(ATTEMPT_STATES)).toEqual(dominio.attempt_state.ids);
    expect(ATTEMPT_STATES.filter((a) => a.final).map((a) => a.id)).toEqual(dominio.attempt_state.final);
  });

  it('pending_approval es la única etiqueta que el ADE propone: se marca como propuesta', () => {
    expect(ATTEMPT_STATES.filter((a) => a.propuesta).map((a) => a.id)).toEqual(['pending_approval']);
    expect(attemptStateInfo('pending_approval').propuesta).toBe(true);
    expect(attemptStateInfo('running').propuesta).toBe(false);
  });

  it('las etiquetas de estado son las del Desktop en el contrato', () => {
    for (const [id, texto] of Object.entries(presentacion.desktop.task_status_label)) expect(ATTEMPT_STATE_LABELS[id], id).toBe(texto);
    expect(ids(ATTEMPT_STATES).sort()).toEqual(Object.keys(ATTEMPT_STATE_LABELS).sort());
  });

  it('grupos visuales: los seis del contrato', () => {
    expect([...VISUAL_GROUPS]).toEqual(presentacion.visual_group.groups);
  });

  it('estado derivado de la Task (reservado)', () => {
    expect([...TASK_DERIVED_STATES]).toEqual(dominio.task_derived_state.ids);
  });

  it('kinds de Attention: vigentes y reservados, en el orden del contrato (el orden es la prioridad)', () => {
    const vigentes = ATTENTION_KINDS.filter((k) => k.estado === 'vigente').map((k) => k.id);
    const reservados = ATTENTION_KINDS.filter((k) => k.estado === 'reservado').map((k) => k.id);
    expect(vigentes).toEqual(dominio.attention_kind.ids);
    expect(reservados).toEqual(dominio.attention_kind.reservados);
    expect(ids(ATTENTION_KINDS)).toEqual([...vigentes, ...reservados]);
  });

  it('entity_kind, mensajes, motivos de fallo, política, revisión e integración', () => {
    expect([...ENTITY_KINDS]).toEqual(dominio.entity_kind.ids);
    expect([...MESSAGE_KINDS]).toEqual(dominio.message_kind.ids);
    expect([...FAILURE_REASONS]).toEqual(dominio.failure_reason.ids);
    expect([...POLICY_STATUSES]).toEqual(dominio.policy_status.ids);
    expect([...REVIEW_DECISIONS]).toEqual(dominio.review_decision.ids);
    expect([...REVIEW_STATES]).toEqual(dominio.review_state.ids);
    expect([...INTEGRATION_OUTCOMES]).toEqual(dominio.integration_outcome.ids);
  });

  it('eventos: durables y efímeros son los del contrato, y no se solapan', () => {
    expect([...DURABLE_EVENT_TYPES]).toEqual(dominio.event.dominio_durable_reservado.ids);
    expect([...EPHEMERAL_EVENT_TYPES]).toEqual(dominio.event.efimeros_reservados.ids);
    expect(DURABLE_EVENT_TYPES.filter((t) => EPHEMERAL_EVENT_TYPES.includes(t))).toEqual([]);
  });

  it('todo prefijo de evento durable es un entity_kind', () => {
    for (const t of DURABLE_EVENT_TYPES) expect(ENTITY_KINDS, t).toContain(t.split('.')[0]);
  });

  it('los textos de los motivos de fallo cubren todos los ids del contrato', () => {
    for (const id of dominio.failure_reason.ids) expect(FAILURE_REASON_LABELS[id], id).toBeTruthy();
  });
});

describe('ayudas de presentación', () => {
  it('un estado desconocido no rompe: etiqueta = id, sin grupo', () => {
    const i = attemptStateInfo('estado_nuevo');
    expect(i).toMatchObject({ id: 'estado_nuevo', label: 'estado_nuevo', group: null, known: false });
  });

  it('isFinalState sigue al contrato', () => {
    for (const e of dominio.attempt_state.ids) expect(isFinalState(e), e).toBe(dominio.attempt_state.final.includes(e));
  });

  it('la prioridad es la posición: approve_in_terminal antes que failed antes que los reservados', () => {
    expect(attentionPriority('approve_in_terminal')).toBeLessThan(attentionPriority('integrate'));
    expect(attentionPriority('failed')).toBeLessThan(attentionPriority('pending_spawn'));
    expect(attentionPriority('kind_inventado')).toBe(ATTENTION_KINDS.length);
    expect(attentionKindInfo('review')).toMatchObject({ estado: 'vigente', known: true });
    expect(attentionKindInfo('pending_spawn').estado).toBe('reservado');
  });
});
