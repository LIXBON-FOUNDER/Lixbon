import { create } from 'zustand';
import { isNeverAutoCommand } from '../lib/agentProtocol';

const STORAGE = 'lx_project_commands';
const projectKey = (root) => String(root || '').replace(/[\\/]+$/, '');
const commandKey = (command) => String(command || '').trim();
const read = () => { try { return JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch { return {}; } };
export const useProjectCommands = create((set, get) => ({
  projects: read(),
  allow(root, command) {
    const key = projectKey(root), cmd = commandKey(command);
    if (!key || !cmd || isNeverAutoCommand(cmd)) return;
    const previous = get().projects[key];
    const list = Array.isArray(previous) ? previous : [];
    const projects = { ...get().projects, [key]: [...new Set([...list, cmd])] };
    try { localStorage.setItem(STORAGE, JSON.stringify(projects)); } catch { return; }
    set({ projects });
  },
  remove(root, command) {
    const key = projectKey(root);
    const list = get().projects[key];
    const projects = { ...get().projects, [key]: Array.isArray(list) ? list.filter((item) => item !== command) : [] };
    try { localStorage.setItem(STORAGE, JSON.stringify(projects)); } catch { return; }
    set({ projects });
  },
}));
export function projectCommands(root, projects = useProjectCommands.getState().projects) {
  const list = projects[projectKey(root)];
  return Array.isArray(list) ? list : [];
}
export const projectAllows = (root, command) => !isNeverAutoCommand(command) && projectCommands(root).includes(commandKey(command));
