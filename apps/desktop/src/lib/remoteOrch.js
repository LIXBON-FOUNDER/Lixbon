// remoteOrch.js — el orquestador de agentes visto y manejado desde /remote
// (web y móvil). El IDE es el host: publica un snapshot compacto del
// orquestador cada vez que cambia (evento `orch`, que el gateway no persiste
// ni mete en el replay) y atiende las acciones que llegan del controller
// (`orch` + action). Cada acción se valida aquí: el controller no manda nada
// que el IDE no sepa hacer ya desde su propia interfaz.
import { invoke } from '@tauri-apps/api/core';
import { useOrchStore, prepareOrchestrate } from '../store/orchStore';
import { useAppStore } from '../store/appStore';

const RUNS = 12;
const MESSAGES = 150;
const TERM_CHARS = 16_000;
const DIFF_CHARS = 120_000;
const DEBOUNCE_MS = 400;

let emitFn = null;
let unsub = null;
let timer = null;
let lastJson = '';

const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const base = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
// eslint-disable-next-line no-control-regex -- quita los códigos ANSI de la terminal
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\r(?!\n)/g;

/** Lo que viaja: sin rutas absolutas ni el texto completo de cada mensaje. */
export function compactSnapshot(snap) {
  if (!snap) return null;
  const runs = Object.values(snap.runs || {}).sort((a, b) => b.created - a.created).slice(0, RUNS);
  const ids = new Set(runs.map((r) => r.id));
  const tasks = Object.values(snap.tasks || {}).filter((t) => ids.has(t.run)).map((t) => ({
    id: t.id, run: t.run, parent: t.parent || null, depth: t.depth || 0,
    title: cut(t.title, 200), agent: t.agent, model: t.model || null, effort: t.effort || null, role: t.role || null,
    status: t.status, created: t.created, updated: t.updated,
    phases: (t.phases || []).slice(-15).map((p) => ({ name: cut(p.name, 120), done: !!p.done, at: p.at, note: cut(p.note, 300) })),
    spec: cut(t.spec, 2000), summary: cut(t.summary, 2000), files: (t.files || []).slice(0, 30),
    branch: t.branch || null, merged: !!t.merged, pr_url: t.pr_url || null,
    report: t.report ? base(t.report) : null, repo: base(t.repo),
  }));
  const messages = (snap.messages || []).filter((m) => ids.has(m.run)).slice(-MESSAGES).map((m) => ({
    id: m.id, run: m.run, from: m.from, to: m.to, kind: m.kind, body: cut(m.body, 800), reply_to: m.reply_to ?? null, at: m.at,
  }));
  const s = snap.settings || {};
  return {
    enabled: !!s.enabled,
    lxo_exists: !!snap.lxo_exists,
    workspace: base(useAppStore.getState().workspaceRoot),
    settings: { notify_phases: !!s.notify_phases, notify_done: !!s.notify_done, notify_questions: !!s.notify_questions },
    roles: (snap.roles || []).map((r) => ({ id: r.id, label: r.label, purpose: r.purpose, model: r.model, effort: r.effort || '', read_only: !!r.read_only })),
    runs: runs.map((r) => ({ id: r.id, objective: cut(r.objective, 400), created: r.created, repo: base(snap.tasks?.[r.root]?.repo) })),
    tasks,
    messages,
    live: (snap.live || []).filter((id) => tasks.some((t) => t.id === id)),
  };
}

function publish(force = false) {
  if (!emitFn) return;
  const compact = compactSnapshot(useOrchStore.getState().snap);
  if (!compact) return;
  const json = JSON.stringify(compact);
  if (!force && json === lastJson) return;
  lastJson = json;
  emitFn('orch', compact);
}

export function startOrchBridge(emit) {
  emitFn = emit;
  lastJson = '';
  const st = useOrchStore.getState();
  st.init();
  if (st.snap) publish(true); else st.refresh().then(() => publish(true));
  unsub = useOrchStore.subscribe((s, prev) => {
    if (s.snap === prev.snap) return;
    clearTimeout(timer);
    timer = setTimeout(() => publish(), DEBOUNCE_MS);
  });
}

export function stopOrchBridge() {
  if (unsub) { unsub(); unsub = null; }
  clearTimeout(timer);
  emitFn = null;
  lastJson = '';
}

export const republishOrch = () => publish(true);

const str = (v, n = 200) => (typeof v === 'string' && v.length <= n ? v : null);
const known = (task) => !!useOrchStore.getState().snap?.tasks?.[task];

/** Una acción que llega del controller. Las respuestas a peticiones puntuales
    (diff, terminal, agentes) van como eventos efímeros; los errores, como
    `orch_error` para que el controller los enseñe. */
export async function handleOrchAction(action, args = {}) {
  const fail = (message) => emitFn?.('orch_error', { action, message: String(message) });
  const orch = useOrchStore.getState();
  try {
    switch (action) {
      case 'refresh':
        await orch.refresh();
        publish(true);
        return;
      case 'enable': {
        await orch.saveSettings({ enabled: !!args.on });
        await orch.refresh();
        publish(true);
        return;
      }
      case 'settings': {
        const patch = {};
        for (const k of ['notify_phases', 'notify_done', 'notify_questions']) if (typeof args[k] === 'boolean') patch[k] = args[k];
        if (args.role && str(args.role, 40)) {
          const roles = { ...orch.snap?.settings?.roles };
          const cur = roles[args.role] || {};
          const role = (orch.snap?.roles || []).find((r) => r.id === args.role);
          if (!role) return fail('Ese rol no existe.');
          roles[args.role] = {
            model: str(args.model, 120) ?? cur.model ?? role.model,
            effort: str(args.effort, 20) ?? cur.effort ?? role.effort ?? '',
          };
          patch.roles = roles;
        }
        if (!Object.keys(patch).length) return;
        await orch.saveSettings(patch);
        await orch.refresh();
        publish(true);
        return;
      }
      case 'stop':
        if (!known(args.task)) return fail('Esa tarea ya no existe.');
        await invoke('orch_call', { cmd: 'stop', args: { task: args.task } });
        return;
      case 'remove_run':
        if (!str(args.run, 80)) return fail('Run no válido.');
        await invoke('orch_call', { cmd: 'remove_run', args: { run: args.run } });
        return;
      case 'diff': {
        if (!known(args.task)) return fail('Esa tarea ya no existe.');
        const d = await invoke('orch_call', { cmd: 'diff', args: { task: args.task } });
        const diff = d?.diff || '';
        emitFn?.('orch_diff', { task: args.task, stat: d?.stat || '', diff: diff.slice(0, DIFF_CHARS), truncated: diff.length > DIFF_CHARS });
        return;
      }
      case 'term': {
        if (!known(args.task)) return fail('Esa tarea ya no existe.');
        const raw = await invoke('orch_term_buffer', { task: args.task }).catch(() => '');
        const text = String(raw || '').replace(ANSI, '').replace(/\n{3,}/g, '\n\n');
        emitFn?.('orch_term', {
          task: args.task,
          text: text.slice(-TERM_CHARS),
          live: (useOrchStore.getState().snap?.live || []).includes(args.task),
        });
        return;
      }
      case 'agents': {
        const res = await invoke('orch_call', { cmd: 'agents', args: { refresh: !!args.refresh } });
        emitFn?.('orch_agents', {
          agents: (res?.agents || []).map((a) => ({
            id: a.id, label: a.label, strengths: a.strengths,
            models: (a.models || []).slice(0, 60).map((m) => m.id), efforts: a.efforts || [],
          })),
        });
        return;
      }
      default:
        fail('Acción no soportada.');
    }
  } catch (e) {
    fail(e?.message || e);
  }
}

/** `/orquestar <objetivo>` mandado desde el remoto. Devuelve el texto de un
    aviso si no se puede orquestar, o null si el mensaje puede seguir su camino. */
export async function prepareRemoteOrchestrate(objective) {
  if (!objective?.trim()) return 'Escribe el objetivo: /orquestar <objetivo>.';
  const st = useOrchStore.getState();
  if (!st.snap) await st.refresh();
  if (!useOrchStore.getState().snap?.settings?.enabled) {
    return 'El orquestador está desactivado en el IDE. Actívalo en la pestaña Orquestar y vuelve a enviarlo.';
  }
  if (!useAppStore.getState().workspaceRoot) return 'El IDE no tiene abierta la carpeta del repositorio.';
  const ok = await prepareOrchestrate();
  return ok ? null : 'El IDE no pudo preparar el orquestador.';
}
