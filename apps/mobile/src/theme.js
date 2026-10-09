// theme.js — sistema visual de la app (lienzo de diseño "Sistema visual"):
// cinco escalones de relleno en vez de bordes, radio 6 en controles y 8 en
// tarjetas y hojas, acento solo para estado. Geist + Geist Mono, con Source
// Serif 4 para los titulares. Los nombres heredados (bg, bgSecondary,
// borderSoft…) se mantienen porque todas las pantallas los usan.

export const RADIUS = 8;
export const RADIUS_SM = 6;
export const RADIUS_PILL = 6;
export const RADIUS_BOX = 8;

export const MOTION = { sheet: 560, drawer: 600, fade: 480 };

// En Android los TTF sueltos no responden a fontWeight: cada peso es una familia.
export const FONTS = {
  brand: 'Fraunces-LightItalic',
  serif: 'SourceSerif4',
  ui: 'Geist',
  uiMedium: 'Geist-Medium',
  uiSemiBold: 'Geist-SemiBold',
  uiBold: 'Geist-SemiBold',
  mono: 'GeistMono',
  monoMedium: 'GeistMono-Medium',
};

export const ACCENTS = [
  { id: 'lima', label: 'Lima', dark: ['#B4C64E', '#C4D468', '180,198,78'], light: ['#7E9430', '#6A7D28', '126,148,48'] },
  { id: 'menta', label: 'Menta', dark: ['#7FD6B4', '#97E3C6', '127,214,180'], light: ['#2F8F6B', '#257556', '47,143,107'] },
  { id: 'cielo', label: 'Cielo', dark: ['#8EC5FF', '#A9D3FF', '142,197,255'], light: ['#2F6FB0', '#255B91', '47,111,176'] },
  { id: 'lavanda', label: 'Lavanda', dark: ['#B9A6FF', '#CBBDFF', '185,166,255'], light: ['#6A55C8', '#5643A8', '106,85,200'] },
  { id: 'coral', label: 'Coral', dark: ['#F4A08C', '#F7B6A6', '244,160,140'], light: ['#C0573F', '#A04632', '192,87,63'] },
  { id: 'ambar', label: 'Ámbar', dark: ['#EBC06A', '#F1CF88', '235,192,106'], light: ['#A8791F', '#8A6318', '168,121,31'] },
  { id: 'hueso', label: 'Hueso', dark: ['#E4E0D2', '#F2EFE4', '228,224,210'], light: ['#4A4A44', '#33332F', '74,74,68'] },
];

const DARK_BASE = {
  dark: true,
  surface0: '#0E0E0E',
  surface1: '#131313',
  surface2: '#181818',
  surface3: '#1C1C1C',
  surface4: '#232323',
  surface5: '#2A2A2A',
  surface6: '#333330',
  sheet: '#161616',
  raised: '#262626',
  onRaised: '#F2F2F0',
  ink: '#F2F2F0',
  inkBody: '#D6D6D3',
  ink70: '#B0B0AD',
  inkSoft: '#B0B0AD',
  inkMuted: '#8A8A86',
  inkLabel: '#8A8A86',
  inkFaint: '#5E5E5C',
  inkRgb: '242,242,240',
  primary: '#F2F2F0',
  onPrimary: '#0E0E0E',
  onAccent: '#0E0E0E',
  codeBg: '#131313',
  scrim: 'rgba(4,4,4,0.66)',
  danger: '#F08C7C',
  dangerStrong: '#F08C7C',
  dangerSoft: 'rgba(240,140,124,0.14)',
  good: '#86D694',
  warn: '#E8C872',
  warnSoft: 'rgba(232,200,114,0.12)',
  info: '#8EC5FF',
};

const LIGHT_BASE = {
  dark: false,
  surface0: '#F6F5F1',
  surface1: '#EFEEE9',
  surface2: '#FFFFFF',
  surface3: '#EAE9E3',
  surface4: '#E2E1DA',
  surface5: '#D9D8D0',
  surface6: '#CFCEC5',
  sheet: '#FFFFFF',
  raised: '#232321',
  onRaised: '#F6F5F1',
  ink: '#191917',
  inkBody: '#2E2E2B',
  ink70: '#4E4E49',
  inkSoft: '#4E4E49',
  inkMuted: '#76766F',
  inkLabel: '#76766F',
  inkFaint: '#A3A39B',
  inkRgb: '25,25,23',
  primary: '#191917',
  onPrimary: '#F6F5F1',
  onAccent: '#F6F5F1',
  codeBg: '#EFEEE9',
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
    track: base.surface5,
    ok: base.good,
  };
}

export const DARK = buildTheme('dark', 'lima');
export const LIGHT = buildTheme('light', 'lima');
