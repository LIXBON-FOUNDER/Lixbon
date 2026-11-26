import { create } from 'zustand';
export const REASONING_LABELS = { auto: 'Auto', off: 'Apagado', on: 'Encendido', low: 'Bajo', medium: 'Medio', high: 'Alto' };
export function reasoningLevels(info) {
  if (info?.reasoning === 'toggle') return ['auto', 'off', 'on'];
  if (info?.reasoning !== 'levels') return [];
  return /gpt-oss/i.test(info.real || info.id || '') ? ['auto', 'low', 'medium', 'high'] : ['auto', 'off', 'low', 'medium', 'high'];
}
let saved = {};
try { saved = JSON.parse(localStorage.getItem('lx_model_reasoning') || '{}'); } catch { /* preferencias ausentes */ }
export const useModelReasoning = create((set) => ({ values: saved, setValue: (key, value) => set((state) => {
  const values = { ...state.values, [key]: value };
  try { localStorage.setItem('lx_model_reasoning', JSON.stringify(values)); } catch { /* almacenamiento lleno */ }
  return { values };
}) }));
export function modelThink(session, model, info) {
  const value = useModelReasoning.getState().values[`${session || 'new'}:${model}`];
  return reasoningLevels(info).includes(value) ? ({ off: false, on: true, low: 'low', medium: 'medium', high: 'high' })[value] : undefined;
}
