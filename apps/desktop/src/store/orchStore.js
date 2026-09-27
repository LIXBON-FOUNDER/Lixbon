// orchStore.js — estado del orquestador de agentes. La verdad vive en Rust
// (src-tauri/src/orch): aquí solo se refleja su snapshot y se lanzan acciones.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from './toastStore';

export const AGENT_LABELS = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini', lixbon: 'Lixbon', externo: 'Externo',
};

export const STATUS_LABELS = {
  starting: 'Arrancando', running: 'Trabajando', waiting: 'Esperando respuesta', done: 'Terminada', failed: 'Fallida', stopped: 'Detenida', exited: 'Cerrada',
};

export const isFinal = (status) => ['done', 'failed', 'stopped', 'exited'].includes(status);

let listening = false;
let refreshTimer = null;

export const useOrchStore = create((set, get) => ({
  snap: null,
  agents: [],
  selected: null,
  busy: null,

  init: () => {
    if (listening) return;
    listening = true;
    get().refresh();
    listen('orch:changed', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => get().refresh(), 60);
    });
  },
  refresh: async () => {
    try { set({ snap: await invoke('orch_snapshot') }); } catch { /* sin backend (vite solo) */ }
  },
  loadAgents: async () => {
    try { set({ agents: await invoke('orch_agents') }); } catch { set({ agents: [] }); }
  },
  select: (selected) => set({ selected }),

  saveSettings: async (patch) => {
    const settings = { ...get().snap?.settings, ...patch };
    try {
      set({ snap: await invoke('orch_settings_set', { settings }) });
    } catch (e) {
      toast(`No se pudo guardar: ${e}`, { tone: 'error' });
    }
  },

  installSkill: async (ids) => {
    try {
      const done = await invoke('orch_skill_install', { ids });
      toast(done.length ? `Skill instalada en ${done.length} agente${done.length === 1 ? '' : 's'}` : 'Nada que instalar');
    } catch (e) {
      toast(`No se pudo instalar: ${e}`, { tone: 'error' });
    }
    get().loadAgents();
  },
  uninstallSkill: async (ids) => {
    try { await invoke('orch_skill_uninstall', { ids }); } catch (e) { toast(`No se pudo quitar: ${e}`, { tone: 'error' }); }
    get().loadAgents();
  },

  newRun: async (objective, agent, cwd) => {
    try {
      const res = await invoke('orch_new_run', { objective, agent, cwd });
      set({ selected: res.task });
      return res;
    } catch (e) {
      toast(String(e), { tone: 'error' });
      return null;
    }
  },

  /** Acción sobre una tarea desde la interfaz (merge, pr, stop, reply…). */
  call: async (cmd, args = {}, okText = null) => {
    set({ busy: `${cmd}:${args.task || args.question || args.run || ''}` });
    try {
      const res = await invoke('orch_call', { cmd, args });
      if (okText) toast(typeof okText === 'function' ? okText(res) : okText);
      return res;
    } catch (e) {
      toast(String(e), { tone: 'error', ms: 8000 });
      return null;
    } finally {
      set({ busy: null });
    }
  },
}));

/** Tareas ordenadas como árbol (padre, luego sus hijas) para un run. */
export function taskTree(tasks, run) {
  const list = Object.values(tasks || {}).filter((t) => t.run === run);
  const byParent = new Map();
  for (const t of list) {
    const k = t.parent || '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(t);
  }
  const out = [];
  const walk = (parent) => {
    for (const t of (byParent.get(parent) || []).sort((a, b) => a.created - b.created)) {
      out.push(t);
      walk(t.id);
    }
  };
  walk('');
  return out;
}

/** Sección del system prompt del agente de Lixbon: con el orquestador activo
    puede coordinar a otros agentes como cualquier otro, a través de `lxo`. */
export function orchPromptSection() {
  const snap = useOrchStore.getState().snap;
  if (!snap?.settings?.enabled || !snap.lxo_exists) return '';
  const lxo = `"${snap.lxo}"`;
  return `\n\n## Orquestador de agentes (Lixbon)\nPuedes repartir trabajo grande entre varios agentes (Claude Code, Codex, OpenCode…), cada uno en su rama y worktree, con la CLI ${lxo}. Úsalo solo si el usuario lo pide o si la tarea tiene partes independientes que merezcan agentes en paralelo. Antes de nada ejecuta con run_command: ${lxo} guide coordinator, y sigue esa guía (usa siempre ${lxo} en lugar de lxo).`;
}

/** `/orquestar <objetivo>` desde el chat: run nuevo en el repo activo con el
    coordinador por defecto, y se abre el modo Orquestar para seguirlo. */
export async function orchestrateFromChat(objective) {
  const st = useOrchStore.getState();
  if (!st.snap) await st.refresh();
  const { useWorkbenchStore } = await import('./workbenchStore');
  const { useAppStore } = await import('./appStore');
  const settings = useOrchStore.getState().snap?.settings;
  if (!settings?.enabled) {
    toast('Activa antes el orquestador en Ajustes → Orquestador.');
    useWorkbenchStore.getState().openSettings('orch');
    return;
  }
  const root = useAppStore.getState().workspaceRoot;
  if (!root) { toast('Abre la carpeta del repositorio con el que quieres orquestar.'); return; }
  const res = await st.newRun(objective, settings.default_agent, root);
  if (res) {
    toast(`Coordinador lanzado (${AGENT_LABELS[settings.default_agent] || settings.default_agent}) en ${root.split(/[\/]/).pop()}`);
    useWorkbenchStore.getState().setMode('orch');
  }
}
