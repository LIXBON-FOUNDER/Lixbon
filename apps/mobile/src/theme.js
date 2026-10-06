// theme.js — tokens del sistema del IDE (apps/desktop/src/styles/base.css):
// seis peldaños de relleno en vez de bordes, radio de 7px, acento reservado
// para el estado, Hanken Grotesk + JetBrains Mono. Los nombres heredados
// (bg, bgSecondary, borderSoft…) se mantienen porque todas las pantallas los usan.

export const RADIUS = 7;
export const RADIUS_PILL = 7;
export const RADIUS_BOX = 10;

// En Android los TTF sueltos no responden a fontWeight: cada peso es una familia.
export const FONTS = {
  brand: 'BrunoAceSC',
  ui: 'Hanken',
  uiMedium: 'Hanken-Medium',
  uiSemiBold: 'Hanken-SemiBold',
  uiBold: 'Hanken-Bold',
  mono: 'JetBrainsMono',
  monoMedium: 'JetBrainsMono-Medium',
};

export const ACCENTS = [
  { id: 'lima', label: 'Lima', dark: ['#C6D66E', '#D4E37E', '198,214,110'], light: ['#7E9430', '#6A7D28', '126,148,48'] },
  { id: 'menta', label: 'Menta', dark: ['#7FD6B4', '#97E3C6', '127,214,180'], light: ['#2F8F6B', '#257556', '47,143,107'] },
  { id: 'cielo', label: 'Cielo', dark: ['#8EC5FF', '#A9D3FF', '142,197,255'], light: ['#2F6FB0', '#255B91', '47,111,176'] },
  { id: 'lavanda', label: 'Lavanda', dark: ['#B9A6FF', '#CBBDFF', '185,166,255'], light: ['#6A55C8', '#5643A8', '106,85,200'] },
  { id: 'coral', label: 'Coral', dark: ['#F4A08C', '#F7B6A6', '244,160,140'], light: ['#C0573F', '#A04632', '192,87,63'] },
  { id: 'ambar', label: 'Ámbar', dark: ['#EBC06A', '#F1CF88', '235,192,106'], light: ['#A8791F', '#8A6318', '168,121,31'] },
  { id: 'hueso', label: 'Hueso', dark: ['#E4E0D2', '#F2EFE4', '228,224,210'], light: ['#4A4A44', '#33332F', '74,74,68'] },
];

const DARK_BASE = {
  dark: true,
  surface0: '#070707',
  surface1: '#111111',
  surface2: '#161616',
  surface3: '#1C1C1C',
  surface4: '#222222',
  surface5: '#2A2A2A',
  surface6: '#333330',
  ink: '#F2F2EE',
  inkBody: '#DCDCD6',
  ink70: '#B5B5AF',
  inkSoft: '#9A9A94',
  inkMuted: '#85857F',
  inkLabel: '#6A6A65',
  inkFaint: '#5E5E59',
  inkRgb: '242,242,238',
  primary: '#F2F2EE',
  onPrimary: '#0B0B0B',
  onAccent: '#0B0B0B',
  codeBg: '#0B0B0B',
  scrim: 'rgba(4,4,4,0.62)',
  danger: '#F08C7C',
  dangerStrong: '#D9584A',
  dangerSoft: 'rgba(240,140,124,0.12)',
  good: '#86D694',
  warn: '#E8C872',
  warnSoft: 'rgba(232,200,114,0.14)',
  info: '#8EC5FF',
};

const LIGHT_BASE = {
  dark: false,
  surface0: '#F3F2EC',
  surface1: '#FBFAF6',
  surface2: '#FFFFFF',
  surface3: '#EDEBE3',
  surface4: '#E5E3DA',
  surface5: '#DBD9CF',
  surface6: '#D0CEC3',
  ink: '#191917',
  inkBody: '#2E2E2B',
  ink70: '#45453F',
  inkSoft: '#5B5B55',
  inkMuted: '#7E7E77',
  inkLabel: '#8A8A82',
  inkFaint: '#A3A39B',
  inkRgb: '25,25,23',
  primary: '#191917',
  onPrimary: '#F5F4EE',
  onAccent: '#F5F4EE',
  codeBg: '#EDEBE3',
  scrim: 'rgba(0,0,0,0.4)',
  danger: '#B8462F',
  dangerStrong: '#B8462F',
  dangerSoft: 'rgba(184,70,47,0.12)',
  good: '#4F8A3A',
  warn: '#A8842A',
  warnSoft: 'rgba(168,132,42,0.14)',
  info: '#2F6FB0',
};

export function buildTheme(mode, accentId) {
  const base = mode === 'light' ? LIGHT_BASE : DARK_BASE;
  const accent = ACCENTS.find((a) => a.id === accentId) || ACCENTS[0];
  const [a, aDeep, aRgb] = base.dark ? accent.dark : accent.light;
  return {
    ...base,
    accent: a,
    accentDeep: aDeep,
    accentRgb: aRgb,
    accentSoft: `rgba(${aRgb},0.14)`,
    bg: base.surface0,
    bgSidebar: base.surface1,
    bgSecondary: base.surface2,
    bgInput: base.surface3,
    border: base.surface5,
    // Sin líneas: lo que aún dibuja un borde queda como un velo casi invisible.
    borderSoft: `rgba(${base.inkRgb},0.06)`,
    pressed: `rgba(${base.inkRgb},0.06)`,
    track: base.surface4,
    ok: base.good,
  };
}

export const DARK = buildTheme('dark', 'lima');
export const LIGHT = buildTheme('light', 'lima');
