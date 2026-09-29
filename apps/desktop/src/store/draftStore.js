// draftStore.js — lo que hay escrito en la caja del chat, por sesión. Vive fuera
// del componente porque la caja se desmonta al cambiar de sección y hay dos
// (panel del editor y modo Agente) que deben ver el mismo borrador.
import { create } from 'zustand';
import { useSessionsStore } from './chatStore';

export const EMPTY_DRAFT = { text: '', images: [], mentions: [] };

export const useDraftStore = create((set) => ({
  drafts: {},
  patch: (field, value) => set((s) => {
    const key = useSessionsStore.getState().activeKey;
    const cur = s.drafts[key] || EMPTY_DRAFT;
    const next = typeof value === 'function' ? value(cur[field]) : value;
    return next === cur[field] ? s : { drafts: { ...s.drafts, [key]: { ...cur, [field]: next } } };
  }),
}));

const setter = (field) => (value) => useDraftStore.getState().patch(field, value);
export const setDraftText = setter('text');
export const setDraftImages = setter('images');
export const setDraftMentions = setter('mentions');
