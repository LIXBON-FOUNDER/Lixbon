// Icon.js — set propio de iconos de trazo (24×24, estilo Feather): un solo
// lenguaje de línea en toda la app en lugar de los glyphs de Material.
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const PATHS = {
  chat: ['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'],
  history: ['M12 6v6l4 2'],
  chart: ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'],
  search: ['M21 21l-4.35-4.35'],
  globe: ['M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  'arrow-up': ['M12 19V5', 'M5 12l7-7 7 7'],
  edit: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  check: ['M20 6L9 17l-4-4'],
  key: ['M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  book: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
  warning: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  mail: ['M22 6l-10 7L2 6'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  pencil: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'],
};

// Elementos extra (círculos/rects) que completan algunos iconos.
const EXTRAS = {
  history: [{ el: 'circle', cx: 12, cy: 12, r: 9 }],
  user: [{ el: 'circle', cx: 12, cy: 7, r: 4 }],
  search: [{ el: 'circle', cx: 11, cy: 11, r: 8 }],
  globe: [{ el: 'circle', cx: 12, cy: 12, r: 10 }],
  stop: [{ el: 'rect', x: 6, y: 6, width: 12, height: 12, rx: 2 }],
  mail: [{ el: 'rect', x: 2, y: 4, width: 20, height: 16, rx: 2 }],
};

export default function Icon({ name, size = 20, color = '#000', strokeWidth = 1.8 }) {
  const paths = PATHS[name] || [];
  const extras = EXTRAS[name] || [];
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {extras.map((e, i) =>
        e.el === 'circle' ? (
          <Circle key={`e${i}`} cx={e.cx} cy={e.cy} r={e.r} {...common} />
        ) : (
          <Rect key={`e${i}`} x={e.x} y={e.y} width={e.width} height={e.height} rx={e.rx} {...common} />
        ),
      )}
      {paths.map((d, i) => (
        <Path key={i} d={d} {...common} />
      ))}
    </Svg>
  );
}
