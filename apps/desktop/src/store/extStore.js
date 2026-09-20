// extStore.js — extensiones del AGENTE (ya no de VSCode/Open VSX: ese
// marketplace no tiene editor al que aplicarse desde que lixbon dejó de
// serlo). Catálogo fijo, estado local: son capacidades de UI todavía sin
// backend real detrás.
import { create } from 'zustand';

const INSTALLED_KEY = 'lixbon_agent_extensions';

const CATALOG = [
  { id: 'linter', name: 'Linter', desc: 'Revisa estilo mientras el agente escribe código', installed: true, enabled: true },
  { id: 'remote-terminal', name: 'Terminal remota', desc: 'Ejecuta comandos del agente en un servidor', installed: true, enabled: true },
  { id: 'build-history', name: 'Historial de builds', desc: 'Cronología de despliegues del proyecto', installed: false, enabled: false },
];

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(INSTALLED_KEY));
    if (!Array.isArray(saved)) return CATALOG;
    return CATALOG.map((base) => {
      const found = saved.find((s) => s.id === base.id);
      return found ? { ...base, installed: !!found.installed, enabled: !!found.enabled } : base;
    });
  } catch {
    return CATALOG;
  }
}

function persist(list) {
  localStorage.setItem(INSTALLED_KEY, JSON.stringify(list.map(({ id, installed, enabled }) => ({ id, installed, enabled }))));
}

export const useExtStore = create((set, get) => ({
  extensions: readState(),

  toggle: (id) => {
    const extensions = get().extensions.map((e) => (e.id === id && e.installed ? { ...e, enabled: !e.enabled } : e));
    persist(extensions);
    set({ extensions });
  },

  install: (id) => {
    const extensions = get().extensions.map((e) => (e.id === id ? { ...e, installed: true, enabled: true } : e));
    persist(extensions);
    set({ extensions });
  },

  uninstall: (id) => {
    const extensions = get().extensions.map((e) => (e.id === id ? { ...e, installed: false, enabled: false } : e));
    persist(extensions);
    set({ extensions });
  },
}));
