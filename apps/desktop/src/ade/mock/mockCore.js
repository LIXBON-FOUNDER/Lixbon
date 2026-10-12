// mockCore.js — «núcleo simulado»: las reglas que en producción son del Core, aquí en memoria.
//
// ATENCIÓN: nada de este archivo es del frontend real. Existe para que el mock se comporte de forma
// coherente tras una decisión (p. ej. aceptar una revisión convierte `review` en `integrate`). Cuando
// llegue el Core, estas reglas desaparecen y las sirve G / el corte Task/Attempt. Las pantallas NO lo importan.
//
// Reglas simuladas y su origen:
//  - Attention: los 4 kinds vigentes de src/orch/attention.js + los 2 reservados (G decide).
//  - Estado de revisión: orch/attention.js::reviewStatus (none / stale / accepted / rejected).
//  - Integración permitida: orch/canIntegrate.js.
//  - Estado derivado de la Task: modelo de runtime §4 (reservado hasta el corte Task/Attempt).
import { adeError } from '../client/contract';
import { INTENTS, RESERVED_INTENT_IDS, validateIntent } from '../client/intents';
import { isFinalState } from '../vocab/vocabulario';

const MIN = 60 * 1000;
const clonar = (o) => JSON.parse(JSON.stringify(o));
const mismoComando = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

export function createMockCore(fixtures, { now = Date.now, clientKind = 'desktop' } = {}) {
  const s = clonar(fixtures);
  s.personState = {};
  s.attentionSince = {};
  let seq = s.activity.reduce((m, e) => Math.max(m, e.seq), 0);
  let contador = 0;
  const oyentes = new Set();

  const proyecto = (id) => s.projects.find((p) => p.id === id);
  const tarea = (id) => s.tasks.find((t) => t.id === id);
  const intento = (id) => s.attempts.find((a) => a.id === id);
  const worktreeDe = (attemptId) => s.worktrees.find((w) => w.attemptId === attemptId) || null;
  const agenteLabel = (a) => s.agents.find((g) => g.id === a.agent.provider)?.label || a.agent.provider;

  // ── Reglas simuladas ────────────────────────────────────────────────────────

  function estadoRevision(attemptId) {
    const raw = s.reviews[attemptId];
    if (!raw) return 'none';
    const head = worktreeDe(attemptId)?.headCommit;
    if (!head || raw.headCommit !== head) return 'stale';
    return raw.decision;
  }

  function elegibilidad(a) {
    const wt = worktreeDe(a.id);
    if (s.integrations[a.id]?.outcome === 'merged') return { allowed: false, reason: 'already_merged' };
    if (a.state !== 'done') return { allowed: false, reason: 'attempt_not_done' };
    if (!wt?.branch) return { allowed: false, reason: 'no_branch' };
    if (estadoRevision(a.id) !== 'accepted') return { allowed: false, reason: 'review_required' };
    return { allowed: true, reason: null };
  }

  function estadoDerivado(t) {
    if (s.discardedTaskIds.includes(t.id)) return 'discarded';
    const lista = t.attemptIds.map(intento).filter(Boolean);
    if (lista.some((a) => s.integrations[a.id]?.outcome === 'merged')) return 'integrated';
    if (lista.some((a) => !isFinalState(a.state))) return 'in_progress';
    if (lista.some((a) => a.state === 'done')) return 'in_review';
    return lista.length ? 'in_progress' : 'open';
  }

  function recalcularTareas() {
    for (const t of s.tasks) t.derivedState = estadoDerivado(t);
  }

  function reglasAttention(a) {
    const t = tarea(a.taskId);
    if (!t || s.discardedTaskIds.includes(t.id)) return null;
    if (a.state === 'awaiting_terminal_approval') return { kind: 'approve_in_terminal', reason: null };
    if (a.state === 'failed') return { kind: 'failed', reason: a.failureReason };
    if (a.state === 'pending_approval') return { kind: 'pending_spawn', reason: null, dueAt: a.approvalDeadline };
    if (a.pendingQuestion) return { kind: 'unanswered_question', reason: null };
    if (a.state === 'done' && worktreeDe(a.id)?.branch && s.integrations[a.id]?.outcome !== 'merged') {
      const r = estadoRevision(a.id);
      if (r === 'accepted') return { kind: 'integrate', reason: null };
      if (r === 'rejected') return null;
      return { kind: 'review', reason: r };
    }
    return null;
  }

  function calcularAttention() {
    const t0 = now();
    const items = [];
    for (const a of s.attempts) {
      const r = reglasAttention(a);
      if (!r) continue;
      const id = `attn:${r.kind}:${a.id}`; // clave regla+entidad: sin duplicados
      s.attentionSince[id] ??= a.updatedAt ?? t0;
      items.push({
        id, kind: r.kind, reason: r.reason, entity: { kind: 'attempt', id: a.id },
        projectId: a.projectId, taskId: a.taskId, attemptId: a.id,
        subject: tarea(a.taskId).title,
        createdAt: s.attentionSince[id], dueAt: r.dueAt ?? null,
        person: s.personState[id] || { seen: false, snoozedUntil: null },
      });
    }
    return items;
  }

  // ── Eventos y cambios ───────────────────────────────────────────────────────

  function notificar(entities) {
    const aviso = { type: 'changed', entities: clonar(entities), seq };
    for (const f of [...oyentes]) f(aviso);
  }

  function registrar(type, entity, a, actor, data = {}) {
    seq += 1;
    s.activity.unshift({
      seq, id: `ev_${seq}`, ts: now(), type, entity, projectId: a.projectId, taskId: a.taskId ?? null, attemptId: a.id ?? null,
      actor: actor || { kind: 'human', id: 'usuario', label: 'Tú', client: clientKind }, data,
    });
  }

  const persona = () => ({ kind: 'human', id: 'usuario', label: 'Tú', client: clientKind });

  function tocar(a) {
    a.updatedAt = now();
    const t = tarea(a.taskId);
    if (t) t.updatedAt = a.updatedAt;
  }

  // ── Decisiones ──────────────────────────────────────────────────────────────

  function necesitaIntento(id) {
    const a = intento(id);
    if (!a) throw adeError('not_found', `No existe el intento ${id}.`, { simulated: true });
    return a;
  }

  const manejadores = {
    approve_spawn(i) {
      const a = necesitaIntento(i.attemptId);
      if (a.state !== 'pending_approval') throw adeError('stale', 'El lanzamiento ya no está pendiente.', { simulated: true });
      if (!mismoComando(i.confirmedCommand, a.policy.command)) {
        throw adeError('invalid', 'El comando confirmado no coincide con el que resolvió el Core.', { simulated: true });
      }
      if (clientKind === 'mobile' && a.policy.elevated) {
        throw adeError('forbidden', 'El móvil no puede aprobar lanzamientos con política elevada.', { slice: 'F', simulated: true });
      }
      a.state = 'starting';
      a.approvalDeadline = null;
      a.startedAt = now();
      const id = `wt_${a.id.slice(4)}`;
      a.worktreeId = id;
      s.worktrees.push({
        id, attemptId: a.id, path: `%LOCALAPPDATA%/Lixbon/worktrees/${a.projectId}/${a.id}`, branch: `lxo/${a.id}`,
        baseCommit: '0'.repeat(40), headCommit: '0'.repeat(40), dirty: false, exists: true,
      });
      tocar(a);
      registrar('attempt.approved', { kind: 'attempt', id: a.id }, a, persona());
      return [{ kind: 'attempt', id: a.id }, { kind: 'worktree', id }];
    },

    reject_spawn(i) {
      const a = necesitaIntento(i.attemptId);
      if (a.state !== 'pending_approval') throw adeError('stale', 'El lanzamiento ya no está pendiente.', { simulated: true });
      a.state = 'stopped';
      a.endedAt = now();
      a.approvalDeadline = null;
      tocar(a);
      registrar('attempt.rejected', { kind: 'attempt', id: a.id }, a, persona());
      return [{ kind: 'attempt', id: a.id }];
    },

    answer_question(i) {
      const a = necesitaIntento(i.attemptId);
      if (!a.pendingQuestion) throw adeError('stale', 'No hay ninguna pregunta pendiente.', { simulated: true });
      const texto = String(i.text).trim();
      if (!texto) throw adeError('invalid', 'La respuesta está vacía.', { simulated: true });
      const th = s.threads.find((x) => x.attemptIds.includes(a.id));
      if (th) {
        th.messages.push({
          id: `m_${++contador}`, kind: 'reply', at: now(), attemptId: a.id, replyTo: a.pendingQuestion.id,
          author: { kind: 'human', label: 'Tú' }, text: texto,
        });
      }
      a.pendingQuestion = null;
      a.state = 'running';
      a.phase = 'Retomando';
      a.note = 'Recibió tu respuesta';
      tocar(a);
      registrar('agent.answered', { kind: 'attempt', id: a.id }, a, persona());
      return [{ kind: 'attempt', id: a.id }, ...(th ? [{ kind: 'thread', id: th.id }] : [])];
    },

    review_attempt(i) {
      const a = necesitaIntento(i.attemptId);
      if (a.state !== 'done') throw adeError('invalid', 'Solo se revisa un intento terminado.', { simulated: true });
      if (i.decision !== 'accepted' && i.decision !== 'rejected') throw adeError('invalid', 'La decisión debe ser accepted o rejected.', { simulated: true });
      const head = worktreeDe(a.id)?.headCommit;
      if (!head || i.headCommit !== head) {
        throw adeError('stale', 'La rama cambió: revisa el diff actual antes de decidir.', { simulated: true });
      }
      s.reviews[a.id] = {
        decision: i.decision, headCommit: head, at: now(), by: { kind: 'human', client: clientKind },
        diffStat: s.reviews[a.id]?.diffStat || s.diffStats[a.id] || null,
      };
      tocar(a);
      registrar('review.completed', { kind: 'review', id: a.id }, a, persona(), { decision: i.decision });
      return [{ kind: 'review', id: a.id }, { kind: 'attempt', id: a.id }];
    },

    integrate_attempt(i) {
      const a = necesitaIntento(i.attemptId);
      if (i.confirm !== true) throw adeError('invalid', 'Falta la confirmación explícita.', { simulated: true });
      const el = elegibilidad(a);
      if (!el.allowed) throw adeError('forbidden', `No se puede integrar: ${el.reason}.`, { simulated: true });
      if (i.headCommit !== worktreeDe(a.id).headCommit) throw adeError('stale', 'La rama cambió desde que la viste.', { simulated: true });
      s.integrations[a.id] = {
        outcome: 'merged', into: proyecto(a.projectId)?.defaultBranch || 'main', resultCommit: 'f'.repeat(40), at: now(),
      };
      tocar(a);
      registrar('integration.completed', { kind: 'integration', id: a.id }, a, persona(), { outcome: 'merged' });
      return [{ kind: 'integration', id: a.id }, { kind: 'attempt', id: a.id }, { kind: 'task', id: a.taskId }];
    },

    launch_task(i) {
      const p = proyecto(i.projectId);
      if (!p) throw adeError('not_found', `No existe el proyecto ${i.projectId}.`, { simulated: true });
      if (p.state !== 'active') throw adeError('forbidden', 'El proyecto está archivado.', { slice: 'D', simulated: true });
      const prov = s.agents.find((g) => g.id === i.agent?.provider);
      if (!prov?.available) throw adeError('invalid', 'El proveedor no está disponible.', { simulated: true });
      contador += 1;
      const tid = `tsk_nueva_${contador}`;
      const aid = `att_nueva_${contador}`;
      const hid = `th_nueva_${contador}`;
      const t0 = now();
      s.tasks.unshift({
        id: tid, projectId: p.id, title: String(i.title), objective: String(i.objective || i.title), derivedState: 'in_progress',
        attemptIds: [aid], threadIds: [hid], createdAt: t0, updatedAt: t0,
      });
      s.attempts.push({
        id: aid, taskId: tid, projectId: p.id, ordinal: 1, state: 'pending_approval',
        agent: { provider: prov.id, model: i.agent.model ?? prov.models[0]?.id ?? null, effort: i.agent.effort ?? null, role: i.agent.role ?? 'implementador' },
        startedAt: t0, updatedAt: t0, endedAt: null, phase: null, note: null, summary: null, failureReason: null,
        approvalDeadline: t0 + 10 * MIN,
        policy: { status: prov.policyStatus, command: [prov.id, '--permission-mode', 'plan'], warnings: [], elevated: false },
        pendingQuestion: null, worktreeId: null, contextPackageId: null,
      });
      s.threads.push({ id: hid, taskId: tid, title: String(i.title), syncPolicy: 'metadata-only', attemptIds: [aid], messages: [] });
      registrar('task.created', { kind: 'task', id: tid }, { projectId: p.id, taskId: tid }, persona());
      registrar('attempt.requested', { kind: 'attempt', id: aid }, { projectId: p.id, taskId: tid, id: aid }, persona());
      return [{ kind: 'task', id: tid }, { kind: 'attempt', id: aid }, { kind: 'project', id: p.id }];
    },

    stop_attempt(i) {
      const a = necesitaIntento(i.attemptId);
      if (isFinalState(a.state)) throw adeError('stale', 'El intento ya terminó.', { simulated: true });
      a.state = 'stopped';
      a.endedAt = now();
      a.pendingQuestion = null;
      tocar(a);
      registrar('attempt.stopped', { kind: 'attempt', id: a.id }, a, persona());
      return [{ kind: 'attempt', id: a.id }];
    },

    mark_attention_seen(i) {
      s.personState[i.attentionId] = { seen: true, snoozedUntil: s.personState[i.attentionId]?.snoozedUntil ?? null };
      return [{ kind: 'attention', id: i.attentionId }];
    },

    snooze_attention(i) {
      s.personState[i.attentionId] = { seen: true, snoozedUntil: now() + (Number(i.forMs) || 60 * MIN) };
      return [{ kind: 'attention', id: i.attentionId }];
    },
  };

  /** Ejecuta una decisión. Lanza AdeError; si todo va bien devuelve las entidades afectadas. */
  function ejecutar(intent) {
    const def = INTENTS[intent?.type];
    if (def?.owner === 'host') throw adeError('invalid', `${intent.type} es una capacidad del cliente (AdeHost), no una decisión del Core.`, { simulated: true });
    const invalido = validateIntent(intent);
    if (invalido) throw adeError('invalid', invalido, { simulated: true });
    if (RESERVED_INTENT_IDS.includes(intent.type)) {
      throw adeError('unavailable', `${def.label} no está disponible: requiere ${def.slice}.`, { slice: def.slice, simulated: true });
    }
    const alcance = capacidades()[intent.type];
    if (alcance.availability === 'unavailable') throw adeError('forbidden', alcance.reason, { slice: alcance.slice, simulated: true });
    const efectos = manejadores[intent.type](intent);
    recalcularTareas();
    notificar(efectos);
    return efectos;
  }

  // ── Capacidades ─────────────────────────────────────────────────────────────

  function capacidades() {
    const salida = {};
    for (const [id, def] of Object.entries(INTENTS)) {
      if (def.owner !== 'core') continue;
      if (def.reserved) {
        salida[id] = { intent: id, availability: 'unavailable', slice: def.slice, reason: `Requiere ${def.slice}.${def.nota ? ` ${def.nota}` : ''}`, requiresConfirmation: false };
      } else if (clientKind === 'mobile' && (id === 'integrate_attempt' || id === 'launch_task')) {
        salida[id] = { intent: id, availability: 'unavailable', slice: 'F', reason: 'Fuera del alcance aprobado del móvil (decisión pendiente en F).', requiresConfirmation: Boolean(def.requiresConfirmation) };
      } else {
        salida[id] = { intent: id, availability: 'simulated', slice: def.slice, reason: 'Acción simulada: solo cambia el estado del mock en memoria.', requiresConfirmation: Boolean(def.requiresConfirmation) };
      }
    }
    return salida;
  }

  recalcularTareas();

  return {
    s, ejecutar, capacidades, calcularAttention, estadoRevision, elegibilidad, worktreeDe, proyecto, tarea, intento, agenteLabel,
    suscribir(f) { oyentes.add(f); return () => oyentes.delete(f); },
    clientKind,
  };
}
