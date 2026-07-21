// Icon.js — iconos SVG de trazo fino, MISMOS paths que la web
// (apps/web/src/components/Icons.jsx, estilo "7000 FREE UI ICONS"):
// un solo lenguaje de icono en todo Lixbon. strokeWidth 1.6 como la web.
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const ICONS = {
  plus: { paths: ['M12 5v14M5 12h14'] },
  search: { paths: ['m20 20-3.5-3.5'], circles: [{ cx: 11, cy: 11, r: 7 }] },
  chat: { paths: ['M21 12a8 8 0 0 1-8 8H4l1.7-3.4A8 8 0 1 1 21 12Z'] },
  panel: { paths: ['M9.5 4v16'], rects: [{ x: 3, y: 4, width: 18, height: 16, rx: 3 }] },
  gear: {
    paths: [
      'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z',
    ],
    circles: [{ cx: 12, cy: 12, r: 3 }],
  },
  globe: {
    paths: ['M3 12h18M12 3a13.4 13.4 0 0 1 0 18M12 3a13.4 13.4 0 0 0 0 18'],
    circles: [{ cx: 12, cy: 12, r: 9 }],
  },
  pencil: { paths: ['M17 3.5a2.1 2.1 0 0 1 3 3L8.5 18l-4 1 1-4L17 3.5Z'] },
  trash: { paths: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'] },
  logout: { paths: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'] },
  x: { paths: ['M6 6l12 12M18 6 6 18'] },
  book: { paths: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z', 'M4 19a2 2 0 0 1 2-2h13'] },
  check: { paths: ['M4 12l5 5L20 6'] },
  user: { paths: ['M4 21a8 8 0 0 1 16 0'], circles: [{ cx: 12, cy: 8, r: 4 }] },
  chart: { paths: ['M4 20V10M10 20V4M16 20v-7M22 20H2'] },
  key: {
    paths: ['m21 2-2 2m-5.6 5.6L21 2m-4 4 2.5 2.5M13.4 9.6a5 5 0 1 1-7 7 5 5 0 0 1 7-7Z'],
  },
  external: { paths: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'] },
  mail: { paths: ['m22 6-10 7L2 6'], rects: [{ x: 2, y: 4, width: 20, height: 16, rx: 2 }] },
  warning: { paths: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z', 'M12 9v4', 'M12 17h.01'] },
  save: { paths: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z', 'M17 21v-8H7v8', 'M7 3v5h8'] },
  activity: { paths: ['M22 12h-4l-3 9L9 3l-3 9H2'] },
  clock: { paths: ['M12 7v5l3.5 2'], circles: [{ cx: 12, cy: 12, r: 9 }] },
  menu: { paths: ['M4 7h16M4 12h16M4 17h16'] },
  'arrow-left': { paths: ['M19 12H5M11 18l-6-6 6-6'] },
  'arrow-up': { paths: ['M12 19V5M6 11l6-6 6 6'] },
  'chevron-right': { paths: ['m9 18 6-6-6-6'] },
  'chevron-down': { paths: ['m6 9 6 6 6-6'] },
  stop: { rects: [{ x: 6, y: 6, width: 12, height: 12, rx: 2 }] },
};

export default function Icon({ name, size = 20, color = '#000', strokeWidth = 1.6 }) {
  const def = ICONS[name] || { paths: [] };
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {(def.rects || []).map((r, i) => (
        <Rect key={`r${i}`} {...r} {...common} />
      ))}
      {(def.circles || []).map((cir, i) => (
        <Circle key={`c${i}`} {...cir} {...common} />
      ))}
      {(def.paths || []).map((d, i) => (
        <Path key={`p${i}`} d={d} {...common} />
      ))}
    </Svg>
  );
}
