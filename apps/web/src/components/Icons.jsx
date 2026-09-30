// Icons.jsx — la iconografía de lixbon, dibujada para la marca.
//
// Reglas del juego, para que un icono nuevo encaje con los demás:
//   · Rejilla de 24 con zona viva de 3 a 21; los contornos cerrados que
//     llenan la caja (ventanas, tarjetas, archivos) llevan radio 3–4, como
//     los 8px de la interfaz a escala.
//   · Trazo de 1.5 con puntas y uniones redondas. Todo en currentColor.
//   · Duotono: las formas principales llevan además un relleno del mismo
//     color al 14 % (<Tinta>). Da cuerpo sin añadir líneas y funciona igual
//     en claro que en oscuro.
// Tamaño por prop `size` (18 por defecto); el resto de props van al <svg>.

function Svg({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// El relleno suave del duotono: misma forma que el trazo, sin trazo.
const Tinta = ({ d }) => <path d={d} fill="currentColor" fillOpacity=".14" stroke="none" />;

// ── Navegación y acciones básicas ─────────────────────────────────────────

export const IconPlus = (p) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);

export const IconX = (p) => (
  <Svg {...p}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
);

export const IconMenu = (p) => (
  <Svg {...p}><path d="M4.5 7h15M4.5 12h15M4.5 17h15" /></Svg>
);

export const IconDots = (p) => (
  <Svg {...p} strokeWidth="2.4">
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" />
  </Svg>
);

export const IconChevron = ({ open, ...p }) => (
  <Svg {...p} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
);

export const IconCaret = (p) => (
  <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>
);

export const IconArrowLeft = (p) => (
  <Svg {...p}><path d="M19.5 12h-15M10 6.5 4.5 12l5.5 5.5" /></Svg>
);

export const IconArrowDown = (p) => (
  <Svg {...p}><path d="M12 4.5v15M6.5 14l5.5 5.5 5.5-5.5" /></Svg>
);

export const IconSend = (p) => (
  <Svg {...p} strokeWidth="1.8"><path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" /></Svg>
);

export const IconSearch = (p) => (
  <Svg {...p}>
    <Tinta d="M10.75 4.5a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z" />
    <circle cx="10.75" cy="10.75" r="6.25" />
    <path d="m15.5 15.5 4.5 4.5" />
  </Svg>
);

export const IconRefresh = (p) => (
  <Svg {...p}>
    <path d="M19.5 10.5A7.7 7.7 0 0 0 6 7L4.5 8.5M4.5 4.5v4h4" />
    <path d="M4.5 13.5A7.7 7.7 0 0 0 18 17l1.5-1.5M19.5 19.5v-4h-4" />
  </Svg>
);

export const IconExternal = (p) => (
  <Svg {...p}>
    <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
    <path d="M18 14v3.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10" />
  </Svg>
);

export const IconLink = (p) => (
  <Svg {...p}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.9.9" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.9-.9" />
  </Svg>
);

export const IconDownload = (p) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 15.5v2A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-2" />
  </Svg>
);

export const IconShare = (p) => (
  <Svg {...p}>
    <path d="M12 14V3.5M8 7.5l4-4 4 4" />
    <path d="M8.5 10.5H7A2.5 2.5 0 0 0 4.5 13v5A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-5a2.5 2.5 0 0 0-2.5-2.5h-1.5" />
  </Svg>
);

export const IconCopy = (p) => (
  <Svg {...p}>
    <Tinta d="M11.5 8.5h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z" />
    <rect x="8.5" y="8.5" width="12" height="12" rx="3" />
    <path d="M15.5 8.5v-2a3 3 0 0 0-3-3h-6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2" />
  </Svg>
);

export const IconPencil = (p) => (
  <Svg {...p}>
    <path d="M4 20l.9-4.2L15.6 5.1a2.2 2.2 0 0 1 3.1 0l.2.2a2.2 2.2 0 0 1 0 3.1L8.2 19.1 4 20Z" />
    <path d="M13.8 6.9l3.3 3.3" />
  </Svg>
);

export const IconTrash = (p) => (
  <Svg {...p}>
    <Tinta d="M6.5 7h11l-.8 11.2a2 2 0 0 1-2 1.8H9.3a2 2 0 0 1-2-1.8L6.5 7Z" />
    <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10.25 11v5M13.75 11v5" />
  </Svg>
);

export const IconLogout = (p) => (
  <Svg {...p}>
    <path d="M14 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h7" />
    <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
  </Svg>
);

export const IconStop = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2.5" />
  </svg>
);

export const IconPlay = (p) => (
  <Svg {...p}>
    <Tinta d="M7.5 5.8v12.4a1 1 0 0 0 1.5.9l10-6.2a1 1 0 0 0 0-1.8L9 4.9a1 1 0 0 0-1.5.9Z" />
    <path d="M7.5 5.8v12.4a1 1 0 0 0 1.5.9l10-6.2a1 1 0 0 0 0-1.8L9 4.9a1 1 0 0 0-1.5.9Z" />
  </Svg>
);

export const IconHistory = (p) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7M4 4.5v4.2h4.2" />
    <path d="M12 8v4.2l2.8 1.8" />
  </Svg>
);

// ── Productos y secciones ────────────────────────────────────────────────

// Burbuja de conversación: un óvalo limpio con la cola abajo a la izquierda.
export const IconChat = (p) => {
  const d = 'M12 4.5c4.7 0 8.5 3 8.5 6.75S16.7 18 12 18c-.9 0-1.8-.1-2.6-.3L5 19.5l1.3-3.4c-1.7-1.2-2.8-3-2.8-4.85C3.5 7.5 7.3 4.5 12 4.5Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="M8.5 11.25h.01M12 11.25h.01M15.5 11.25h.01" strokeWidth="2" />
    </Svg>
  );
};

export const IconGrid = (p) => (
  <Svg {...p}>
    <Tinta d="M16 3.5h1a3.5 3.5 0 0 1 3.5 3.5v1A2.5 2.5 0 0 1 18 10.5h-2A2.5 2.5 0 0 1 13.5 8V6A2.5 2.5 0 0 1 16 3.5Z" />
    <rect x="3.5" y="3.5" width="7" height="7" rx="2.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2.5" />
  </Svg>
);

export const IconPanel = (p) => (
  <Svg {...p}>
    <Tinta d="M9.5 4.5h-2a4 4 0 0 0-4 4v7a4 4 0 0 0 4 4h2Z" />
    <rect x="3.5" y="4.5" width="17" height="15" rx="4" />
    <path d="M9.5 4.5v15" />
  </Svg>
);

export const IconHome = (p) => {
  const d = 'M4 10.2 12 4l8 6.2V18a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18v-7.8Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="M9.5 20.5v-5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5" />
    </Svg>
  );
};

export const IconBook = (p) => (
  <Svg {...p}>
    <Tinta d="M12 6.5c-1.8-1.4-4.3-2-8-2v13c3.7 0 6.2.6 8 2Z" />
    <path d="M12 6.5c-1.8-1.4-4.3-2-8-2v13c3.7 0 6.2.6 8 2 1.8-1.4 4.3-2 8-2v-13c-3.7 0-6.2.6-8 2Z" />
    <path d="M12 6.5v13" />
  </Svg>
);

export const IconTerminal = (p) => (
  <Svg {...p}>
    <Tinta d="M7 4.5h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-7a4 4 0 0 1 4-4Z" />
    <rect x="3" y="4.5" width="18" height="15" rx="4" />
    <path d="m7.5 10 2.5 2.5L7.5 15M12.5 15h4" />
  </Svg>
);

export const IconCode = (p) => (
  <Svg {...p}><path d="m15.5 17.5 5.5-5.5-5.5-5.5M8.5 6.5 3 12l5.5 5.5M13.5 5l-3 14" /></Svg>
);

export const IconWindow = (p) => (
  <Svg {...p}>
    <Tinta d="M7 4.5h10a4 4 0 0 1 4 4V9H3v-.5a4 4 0 0 1 4-4Z" />
    <rect x="3" y="4.5" width="18" height="15" rx="4" />
    <path d="M3 9h18" />
    <path d="M6.5 6.75h.01M9 6.75h.01" strokeWidth="1.8" />
  </Svg>
);

export const IconPhone = (p) => (
  <Svg {...p}>
    <Tinta d="M9.5 2.5h5a3.5 3.5 0 0 1 3.5 3.5v12a3.5 3.5 0 0 1-3.5 3.5h-5A3.5 3.5 0 0 1 6 18V6a3.5 3.5 0 0 1 3.5-3.5Z" />
    <rect x="6" y="2.5" width="12" height="19" rx="3.5" />
    <path d="M10.5 18.5h3" />
  </Svg>
);

export const IconLayers = (p) => (
  <Svg {...p}>
    <Tinta d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
    <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
  </Svg>
);

// Rellenas, no de trazo: el lanzador de aplicaciones.
export const IconApps = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...p}>
    {[5.5, 12, 18.5].map((cy) => [5.5, 12, 18.5].map((cx) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.7" />
    )))}
  </svg>
);

export const IconGear = (p) => (
  <Svg {...p}>
    <Tinta d="M12 7.25a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Z" />
    <path d="M10.4 5.08l.39-2.3h2.42l.39 2.3a7.1 7.1 0 0 1 2.16.9l1.9-1.36 1.72 1.72-1.36 1.9a7.1 7.1 0 0 1 .9 2.16l2.3.39v2.42l-2.3.39a7.1 7.1 0 0 1-.9 2.16l1.36 1.9-1.72 1.72-1.9-1.36a7.1 7.1 0 0 1-2.16.9l-.39 2.3h-2.42l-.39-2.3a7.1 7.1 0 0 1-2.16-.9l-1.9 1.36-1.72-1.72 1.36-1.9a7.1 7.1 0 0 1-.9-2.16l-2.3-.39v-2.42l2.3-.39a7.1 7.1 0 0 1 .9-2.16L4.62 6.34l1.72-1.72 1.9 1.36a7.1 7.1 0 0 1 2.16-.9Z" />
    <circle cx="12" cy="12" r="2.75" />
  </Svg>
);

// ── Contenido y adjuntos ─────────────────────────────────────────────────

export const IconClip = (p) => (
  <Svg {...p}>
    <path d="M19.5 11.5 12.4 18.6a4.5 4.5 0 0 1-6.4-6.4l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.3 7.3a1.5 1.5 0 0 1-2.1-2.1l6.6-6.6" />
  </Svg>
);

export const IconFile = (p) => {
  const d = 'M13.5 3.5H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9l-5.5-5.5Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="M13.5 3.5V7a2 2 0 0 0 2 2H19M8.5 13h7M8.5 16.5h4" />
    </Svg>
  );
};

export const IconImage = (p) => (
  <Svg {...p}>
    <Tinta d="M7.5 4.5h9a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4v-7a4 4 0 0 1 4-4Z" />
    <rect x="3.5" y="4.5" width="17" height="15" rx="4" />
    <circle cx="9" cy="9.5" r="1.5" />
    <path d="m3.8 16.5 4-4a2 2 0 0 1 2.8 0l5.9 5.9M14 16l1.8-1.8a2 2 0 0 1 2.8 0l1.6 1.6" />
  </Svg>
);

export const IconCamera = (p) => {
  const d = 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.5-2h4.4l1.5 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-9Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  );
};

export const IconMic = (p) => (
  <Svg {...p}>
    <Tinta d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Svg>
);

export const IconGlobe = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
    <path d="M3.5 12h17" />
  </Svg>
);

export const IconPointer = (p) => (
  <Svg {...p}>
    <Tinta d="M5.5 4.5 18.5 10l-5.6 1.9-1.9 5.6L5.5 4.5Z" />
    <path d="M5.5 4.5 18.5 10l-5.6 1.9-1.9 5.6L5.5 4.5Z" />
    <path d="m13 12 5.5 5.5" />
  </Svg>
);

// ── Cuenta, pagos y estado ───────────────────────────────────────────────

export const IconUser = (p) => (
  <Svg {...p}>
    <Tinta d="M12 4.75a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5Z" />
    <circle cx="12" cy="8.5" r="3.75" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </Svg>
);

export const IconUsers = (p) => (
  <Svg {...p}>
    <Tinta d="M9 5.25a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z" />
    <circle cx="9" cy="8.5" r="3.25" />
    <path d="M3.5 19.5c.6-3 2.8-5 5.5-5s4.9 2 5.5 5" />
    <path d="M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17 14.7c2 .6 3.1 2.3 3.5 4.8" />
  </Svg>
);

export const IconShield = (p) => {
  const d = 'M12 3.5 19 6v5.5c0 4.4-2.9 7.7-7 9-4.1-1.3-7-4.6-7-9V6l7-2.5Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
};

export const IconCard = (p) => (
  <Svg {...p}>
    <Tinta d="M3 10h18V9a3.5 3.5 0 0 0-3.5-3.5h-11A3.5 3.5 0 0 0 3 9Z" />
    <rect x="3" y="5.5" width="18" height="13" rx="3.5" />
    <path d="M3 10h18M7 15h3" />
  </Svg>
);

export const IconBag = (p) => {
  const d = 'M5 8.5h14l-.9 9.6a2.5 2.5 0 0 1-2.5 2.4H8.4a2.5 2.5 0 0 1-2.5-2.4L5 8.5Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" />
    </Svg>
  );
};

export const IconBolt = (p) => {
  const d = 'M13.5 3 5 13.5h6.5L10.5 21 19 10.5h-6.5L13.5 3Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
    </Svg>
  );
};

export const IconChart = (p) => (
  <Svg {...p} strokeWidth="1.8">
    <path d="M5 19.5v-5M10 19.5v-14M15 19.5v-9M20 19.5v-3" />
  </Svg>
);

export const IconTrend = (p) => (
  <Svg {...p}>
    <path d="M3.5 17 9 11.5l3.5 3.5 7.5-7.5" />
    <path d="M15 7.5h5v5" />
  </Svg>
);

export const IconNodes = (p) => (
  <Svg {...p}>
    <Tinta d="M12 15.75a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z" />
    <circle cx="6" cy="6.5" r="2.25" />
    <circle cx="18" cy="6.5" r="2.25" />
    <circle cx="12" cy="18" r="2.25" />
    <path d="M8.25 6.5h7.5M7.1 8.5l3.8 7.5M16.9 8.5l-3.8 7.5" />
  </Svg>
);

export const IconAlert = (p) => {
  const d = 'M10.3 4.6 3.1 17a2 2 0 0 0 1.7 3h14.4a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
      <path d="M12 9.5v3.5" />
      <path d="M12 16.5h.01" strokeWidth="2" />
    </Svg>
  );
};

// ── Tema ─────────────────────────────────────────────────────────────────

export const IconSun = (p) => (
  <Svg {...p}>
    <Tinta d="M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5Z" />
    <circle cx="12" cy="12" r="3.75" />
    <path d="M12 3v1.5M12 19.5V21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M3 12h1.5M19.5 12H21M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1" />
  </Svg>
);

export const IconMoon = (p) => {
  const d = 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z';
  return (
    <Svg {...p}>
      <Tinta d={d} />
      <path d={d} />
    </Svg>
  );
};
