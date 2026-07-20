// theme.js — tokens de diseño de Lixbon (espejo de apps/web/src/styles/base.css
// y docs/DISENO_WEB.md): mismas paletas claro/oscuro y mismas fuentes.

export const RADIUS_PILL = 999;
export const RADIUS_BOX = 22;

// Cada peso de Bricolage es una familia propia: en Android los TTF sueltos no
// responden a fontWeight, así que el peso se elige por nombre de familia.
export const FONTS = {
  brand: 'BrunoAceSC',
  ui: 'Bricolage',
  uiMedium: 'Bricolage-Medium',
  uiSemiBold: 'Bricolage-SemiBold',
  uiBold: 'Bricolage-Bold',
};

export const LIGHT = {
  bg: '#FFFFFF',
  bgSidebar: '#FFFFFF',
  bgSecondary: '#F2F1E3',
  bgInput: '#F2F1E3',
  ink: '#171717',
  inkSoft: 'rgba(23,23,23,0.62)',
  inkMuted: 'rgba(23,23,23,0.45)',
  border: 'rgba(23,23,23,0.9)',
  borderSoft: 'rgba(23,23,23,0.16)',
  accent: '#D9E64A',
  accentDeep: '#6C7A46',
  accentSoft: 'rgba(217,230,74,0.16)',
  onAccent: '#171717',
  primary: '#171717',
  onPrimary: '#FFFFFF',
  codeBg: '#171717',
  codeInk: '#F6F7ED',
  scrim: 'rgba(23,23,23,0.42)',
  danger: '#C0392B',
  dangerSoft: 'rgba(192,57,43,0.10)',
  ok: '#4A7C1A',
  // Derivados de --ink-rgb (base.css): hover de icon-btn y pista de cuotas.
  pressed: 'rgba(23,23,23,0.07)',
  track: 'rgba(23,23,23,0.08)',
};

export const DARK = {
  bg: '#1A1913',
  bgSidebar: '#141309',
  bgSecondary: '#211F17',
  bgInput: '#201E16',
  ink: '#F3F0E2',
  inkSoft: '#C3BCA6',
  inkMuted: '#8E876F',
  border: '#33301F',
  borderSoft: '#2A2820',
  accent: '#A9B86E',
  accentDeep: '#6C7A46',
  accentSoft: 'rgba(169,184,110,0.10)',
  onAccent: '#1A1913',
  primary: '#F0EBD9',
  onPrimary: '#1A1913',
  codeBg: '#141309',
  codeInk: '#C3BCA6',
  scrim: 'rgba(0,0,0,0.6)',
  danger: '#E0685A',
  dangerSoft: 'rgba(224,104,90,0.14)',
  ok: '#A9B86E',
  pressed: 'rgba(243,240,226,0.07)',
  track: 'rgba(243,240,226,0.08)',
};
