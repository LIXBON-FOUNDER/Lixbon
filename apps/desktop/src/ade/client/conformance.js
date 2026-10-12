// conformance.js — batería de conformidad de un AdeClient.
//
// La misma comprobación valida hoy el MockAdeClient y validará cada paso hacia CoreAdeClient: mismos
// métodos, mismas formas, ids del vocabulario y todo campo declarado en fieldSources. Devuelve la lista de
// problemas (vacía = conforme); no lanza.
import { missingAdeMethods } from './contract';
import { CORE_INTENT_IDS } from './intents';
import { undeclaredFields } from './fieldSources';
import {
  ATTEMPT_STATES, TASK_DERIVED_STATES, ATTENTION_KINDS, ENTITY_KINDS, DURABLE_EVENT_TYPES, MESSAGE_KINDS,
  REVIEW_STATES, INTEGRATION_OUTCOMES, FAILURE_REASONS, POLICY_STATUSES, THREAD_SYNC_POLICIES,
} from '../vocab/vocabulario';

const ids = (lista) => lista.map((e) => (typeof e === 'string' ? e : e.id));
const EN = {
  attemptState: ids(ATTEMPT_STATES), derived: TASK_DERIVED_STATES, attention: ids(ATTENTION_KINDS), entity: ENTITY_KINDS,
  eventType: DURABLE_EVENT_TYPES, message: MESSAGE_KINDS, review: REVIEW_STATES, outcome: INTEGRATION_OUTCOMES,
  failure: FAILURE_REASONS, policy: POLICY_STATUSES, sync: THREAD_SYNC_POLICIES,
};

/** @returns {Promise<string[]>} problemas encontrados */
export async function checkAdeClientConformance(client) {
  const problemas = [];
  const falla = (m) => problemas.push(m);
  const faltan = missingAdeMethods(client);
  if (faltan.length) {
    falla(`faltan métodos: ${faltan.join(', ')}`);
    return problemas;
  }

  const campos = (entidad, obj, donde) => {
    const sinSlice = undeclaredFields(entidad, obj);
    if (sinSlice.length) falla(`${donde}: campos sin slice declarado en fieldSources: ${sinSlice.join(', ')}`);
  };
  const enVocab = (valor, lista, donde) => {
    if (valor !== null && valor !== undefined && !lista.includes(valor)) falla(`${donde}: «${valor}» no está en el vocabulario`);
  };

  try {
    const con = await client.getConnection();
    campos('ClientConnection', con, 'getConnection');
    if (!['mock', 'core'].includes(con.source)) falla('getConnection.source debe ser mock o core');

    const caps = await client.getCapabilities();
    for (const id of CORE_INTENT_IDS) {
      if (!caps[id]) falla(`getCapabilities: falta el intent ${id}`);
      else campos('Capability', caps[id], `capabilities.${id}`);
    }

    const proyectos = await client.listProjects({ includeArchived: true });
    proyectos.forEach((p) => campos('Project', p, `Project ${p.id}`));

    const tareas = await client.listTasks();
    for (const t of tareas) {
      campos('Task', t, `Task ${t.id}`);
      enVocab(t.derivedState, EN.derived, `Task ${t.id}.derivedState`);
    }

    const intentos = await client.listAttempts();
    for (const a of intentos) {
      campos('Attempt', a, `Attempt ${a.id}`);
      enVocab(a.state, EN.attemptState, `Attempt ${a.id}.state`);
      enVocab(a.failureReason, EN.failure, `Attempt ${a.id}.failureReason`);
      enVocab(a.policy?.status, EN.policy, `Attempt ${a.id}.policy.status`);
    }

    for (const t of tareas) {
      const hilos = await client.listThreads({ taskId: t.id });
      for (const h of hilos) {
        campos('Thread', h, `Thread ${h.id}`);
        enVocab(h.syncPolicy, EN.sync, `Thread ${h.id}.syncPolicy`);
        const completo = await client.getThread(h.id);
        completo.messages.forEach((m) => enVocab(m.kind, EN.message, `Thread ${h.id} mensaje ${m.id}`));
      }
    }

    for (const a of intentos) {
      (await client.listWorktrees({ attemptId: a.id })).forEach((w) => campos('Worktree', w, `Worktree ${w.id}`));
      (await client.listArtifacts({ attemptId: a.id })).forEach((x) => campos('Artifact', x, `Artifact ${x.id}`));
      const r = await client.getReview(a.id);
      campos('Review', r, `Review ${a.id}`);
      enVocab(r.state, EN.review, `Review ${a.id}.state`);
      const i = await client.getIntegration(a.id);
      campos('Integration', i, `Integration ${a.id}`);
      enVocab(i.outcome, EN.outcome, `Integration ${a.id}.outcome`);
    }

    for (const it of await client.listAttention()) {
      campos('AttentionItem', it, `Attention ${it.id}`);
      enVocab(it.kind, EN.attention, `Attention ${it.id}.kind`);
      enVocab(it.entity?.kind, EN.entity, `Attention ${it.id}.entity.kind`);
    }

    for (const e of await client.listActivity({ limit: 500 })) {
      campos('ActivityEntry', e, `Activity ${e.id}`);
      enVocab(e.type, EN.eventType, `Activity ${e.id}.type`);
      enVocab(e.entity?.kind, EN.entity, `Activity ${e.id}.entity.kind`);
    }

    (await client.listAgents()).forEach((g) => campos('AgentProvider', g, `Agent ${g.id}`));
    const unsub = client.subscribe(() => {});
    if (typeof unsub !== 'function') falla('subscribe debe devolver una función para darse de baja');
    else unsub();
  } catch (e) {
    falla(`excepción durante la batería: ${e?.code ?? ''} ${e?.message ?? e}`);
  }
  return problemas;
}
