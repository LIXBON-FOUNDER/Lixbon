// usageStore.js — cupo de sesión y semana (/api/account/usage) para los
// indicadores pequeños (lista de agentes, barra de estado). Ajustes → Uso
// pide su propia copia con la serie diaria.
import { create } from 'zustand';
import { api } from '../lib/api';

const STALE_MS = 60 * 1000;

export const useUsageStore = create((set, get) => ({
  buckets: null,
  plan: null,
  loadedAt: 0,
  load: async (force = false) => {
    if (!force && Date.now() - get().loadedAt < STALE_MS) return;
    set({ loadedAt: Date.now() });
    try {
      const res = await api.get('/api/account/usage');
      set({ buckets: res.buckets || null, plan: res.plan || null });
    } catch { /* sin datos: los indicadores se ocultan */ }
  },
}));

export function resetLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'se reinicia en breve';
  if (mins < 60 * 20) return `se reinicia a las ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
  return `se reinicia el ${d.toLocaleDateString('es', { weekday: 'long', day: 'numeric' })}`;
}
