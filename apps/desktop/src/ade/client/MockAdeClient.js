// MockAdeClient.js — implementación SIMULADA de AdeClient.
//
// Los datos salen de mock/fixtures.js; las decisiones solo mutan la memoria de este cliente (mock/mockCore.js)
// y devuelven siempre `simulated: true`. Permite simular latencia, fallos y datos vacíos desde `client.sim`.
// No hace invoke, ni orch_call, ni fetch: nada de lo que hace sale del proceso.
import { adeError } from './contract';
import { createFixtures } from '../mock/fixtures';
import { createMockCore } from '../mock/mockCore';

const clonar = (o) => JSON.parse(JSON.stringify(o));
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const SCOPES_MOCK = {
  desktop: ['mock:lectura', 'mock:decisiones', 'mock:lanzar'],
  cli: ['mock:lectura', 'mock:decisiones', 'mock:lanzar'],
  mobile: ['mock:lectura', 'mock:decisiones'],
};
const ETIQUETA = { desktop: 'Desktop (simulado)', cli: 'CLI (simulado)', mobile: 'Móvil (simulado)' };

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] reloj (inyectable en pruebas)
 * @param {number} [opts.latencyMs] latencia artificial por llamada
 * @param {'desktop'|'cli'|'mobile'} [opts.clientKind] superficie que se simula (cambia las capacidades)
 * @param {object} [opts.fixtures] datos iniciales (por omisión, createFixtures(now()))
 */
export function createMockAdeClient({ now = Date.now, latencyMs = 0, clientKind = 'desktop', fixtures } = {}) {
  const semilla = fixtures ?? createFixtures(now());
  const oyentes = new Set();
  let core;
  let desconectar = () => {};

  const sim = {
    latencyMs,
    calls: [],
    siguienteFallo: new Map(), // método -> error[] (se consume uno por llamada)
    siempreFalla: new Map(), // método -> error
  };

  function montar(datos) {
    desconectar();
    core = createMockCore(datos, { now, clientKind });
    desconectar = core.suscribir((aviso) => oyentes.forEach((f) => f(aviso)));
  }
  montar(semilla);

  const espera = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  async function llamar(metodo, fn) {
    sim.calls.push(metodo);
    await espera(sim.latencyMs);
    const cola = sim.siguienteFallo.get(metodo);
    if (cola?.length) throw cola.shift();
    if (sim.siempreFalla.has(metodo)) throw sim.siempreFalla.get(metodo);
    return clonar(fn());
  }

  const noExiste = (cosa, id) => adeError('not_found', `No existe ${cosa} ${id}.`, { simulated: true });
  const buscar = (lista, id, cosa) => {
    const e = lista.find((x) => x.id === id);
    if (!e) throw noExiste(cosa, id);
    return e;
  };

  const client = {
    source: 'mock',

    getConnection: () => llamar('getConnection', () => ({
      clientKind, label: ETIQUETA[clientKind] || clientKind, scopes: SCOPES_MOCK[clientKind] || [], source: 'mock', coreMode: 'in_process',
    })),
    getCapabilities: () => llamar('getCapabilities', () => core.capacidades()),

    listProjects: ({ includeArchived = false } = {}) => llamar('listProjects', () => core.s.projects.filter((p) => includeArchived || p.state === 'active')),
    getProject: (id) => llamar('getProject', () => buscar(core.s.projects, id, 'el proyecto')),

    listTasks: ({ projectId } = {}) => llamar('listTasks', () => core.s.tasks.filter((t) => !projectId || t.projectId === projectId)),
    getTask: (id) => llamar('getTask', () => buscar(core.s.tasks, id, 'la tarea')),

    listAttempts: ({ taskId, projectId } = {}) => llamar('listAttempts', () => core.s.attempts
      .filter((a) => (!taskId || a.taskId === taskId) && (!projectId || a.projectId === projectId))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.ordinal - b.ordinal)),
    getAttempt: (id) => llamar('getAttempt', () => buscar(core.s.attempts, id, 'el intento')),

    listThreads: ({ taskId }) => llamar('listThreads', () => core.s.threads.filter((t) => t.taskId === taskId).map(({ messages, ...t }) => ({
      ...t, messageCount: messages.length, lastMessageAt: messages.length ? Math.max(...messages.map((m) => m.at)) : null,
    }))),
    getThread: (id) => llamar('getThread', () => {
      const t = buscar(core.s.threads, id, 'el hilo');
      const { messages, ...resto } = t;
      const ordenados = [...messages].sort((a, b) => a.at - b.at);
      return { ...resto, messageCount: messages.length, lastMessageAt: ordenados.at(-1)?.at ?? null, messages: ordenados };
    }),

    listWorktrees: ({ attemptId }) => llamar('listWorktrees', () => core.s.worktrees.filter((w) => w.attemptId === attemptId)),
    listArtifacts: ({ attemptId }) => llamar('listArtifacts', () => core.s.artifacts.filter((a) => a.attemptId === attemptId)),

    getReview: (attemptId) => llamar('getReview', () => {
      const a = buscar(core.s.attempts, attemptId, 'el intento');
      const raw = core.s.reviews[a.id];
      return {
        attemptId: a.id, state: core.estadoRevision(a.id), decision: raw?.decision ?? null, headCommit: raw?.headCommit ?? null,
        currentHeadCommit: core.worktreeDe(a.id)?.headCommit ?? null, at: raw?.at ?? null, by: raw?.by ?? null,
        diffStat: raw?.diffStat ?? core.s.diffStats[a.id] ?? null,
      };
    }),
    getIntegration: (attemptId) => llamar('getIntegration', () => {
      const a = buscar(core.s.attempts, attemptId, 'el intento');
      const raw = core.s.integrations[a.id];
      return { attemptId: a.id, outcome: raw?.outcome ?? null, into: raw?.into ?? core.proyecto(a.projectId)?.defaultBranch ?? null, resultCommit: raw?.resultCommit ?? null, at: raw?.at ?? null, eligibility: core.elegibilidad(a) };
    }),

    listAttention: ({ projectId, attemptId } = {}) => llamar('listAttention', () => core.calcularAttention()
      .filter((i) => (!projectId || i.projectId === projectId) && (!attemptId || i.attemptId === attemptId))),
    listActivity: ({ projectId, taskId, attemptId, limit = 50 } = {}) => llamar('listActivity', () => core.s.activity
      .filter((e) => (!projectId || e.projectId === projectId) && (!taskId || e.taskId === taskId) && (!attemptId || e.attemptId === attemptId))
      .slice(0, limit)),
    listAgents: () => llamar('listAgents', () => core.s.agents),

    resolveLocation: (ref = {}) => llamar('resolveLocation', () => {
      const candidatos = [ref.worktreePath, ref.path].filter(Boolean).map(norm);
      for (const w of core.s.worktrees) {
        const raiz = norm(w.path);
        if (candidatos.some((c) => c === raiz || c.startsWith(`${raiz}/`)) || (ref.branch && w.branch === ref.branch)) {
          const a = core.intento(w.attemptId);
          return { projectId: a.projectId, taskId: a.taskId, attemptId: a.id, worktreeId: w.id };
        }
      }
      for (const p of core.s.projects) {
        if (p.locations.some((l) => candidatos.some((c) => c === norm(l.path) || c.startsWith(`${norm(l.path)}/`)))) {
          return { projectId: p.id, taskId: null, attemptId: null, worktreeId: null };
        }
      }
      return null;
    }),

    dispatch: (intent) => llamar('dispatch', () => {
      const efectos = core.ejecutar(intent);
      return { ok: true, simulated: true, intent: intent.type, effects: efectos, message: `Simulado: ${intent.type}. Solo cambió la memoria del mock.` };
    }),

    subscribe(listener) {
      oyentes.add(listener);
      return () => oyentes.delete(listener);
    },

    /** Controles de simulación: solo existen en el mock. */
    sim: {
      get calls() { return sim.calls; },
      get latencyMs() { return sim.latencyMs; },
      setLatency(ms) { sim.latencyMs = Math.max(0, Number(ms) || 0); },
      failNext(metodo, error) {
        const lista = sim.siguienteFallo.get(metodo) || [];
        lista.push(error ?? adeError('unavailable', `Fallo simulado en ${metodo}.`, { simulated: true }));
        sim.siguienteFallo.set(metodo, lista);
      },
      failAlways(metodo, error) { sim.siempreFalla.set(metodo, error ?? adeError('unavailable', `Fallo simulado en ${metodo}.`, { simulated: true })); },
      clearFailures() { sim.siguienteFallo.clear(); sim.siempreFalla.clear(); },
      /** Pide a la interfaz que vuelva a preguntar (útil tras failNext). */
      refresh() { oyentes.forEach((f) => f({ type: 'changed', entities: [], seq: null })); },
      /** Sustituye los datos por un espacio sin proyectos (catálogo de agentes se conserva). */
      useEmptyData() {
        const base = createFixtures(now());
        montar({ ...base, discardedTaskIds: [], projects: [], tasks: [], attempts: [], threads: [], worktrees: [], artifacts: [], reviews: {}, diffStats: {}, integrations: {}, activity: [] });
        oyentes.forEach((f) => f({ type: 'changed', entities: [], seq: null }));
      },
      reset() {
        montar(createFixtures(now()));
        oyentes.forEach((f) => f({ type: 'changed', entities: [], seq: null }));
      },
    },
  };
  return client;
}
