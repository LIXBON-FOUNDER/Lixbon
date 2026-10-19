// IdeIcons.jsx — iconos del marco del IDE (modos, paneles, ajustes, equipo).
// Rejilla de 24, trazo de 1,7 y extremos redondos. Los tres de panel tienen
// contorno y versión rellena: así se ve de un vistazo si el panel está abierto.

function Svg({ size = 16, children, strokeWidth = 1.7, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Modos ────────────────────────────────────────────────────────────────

export const IconModeAgent = (p) => (
  <Svg {...p}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V17h-.5A2.5 2.5 0 0 1 4 14.5z" />
    <path d="M12 7.6l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
  </Svg>
);

export const IconModeEditor = (p) => (
  <Svg {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.6 5.5l-3.2 13" /></Svg>
);

export const IconModeDesign = (p) => (
  <Svg {...p}>
    <rect x="3" y="3.5" width="18" height="7" rx="1.8" />
    <rect x="3" y="14" width="9" height="6.5" rx="1.8" />
    <rect x="16" y="14" width="5" height="6.5" rx="1.8" />
  </Svg>
);

export const IconModeGit = (p) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.2" /><circle cx="6" cy="18.5" r="2.2" /><circle cx="18" cy="8" r="2.2" />
    <path d="M6 7.7v8.6M18 10.2c0 4.2-5.6 3.4-10.6 6.4" />
  </Svg>
);

export const IconModeOrch = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2.2" /><circle cx="5.5" cy="18.5" r="2.2" /><circle cx="18.5" cy="18.5" r="2.2" />
    <path d="M12 7.2v4.3M12 11.5H5.5v4.8M12 11.5h6.5v4.8" />
  </Svg>
);

// ── Paneles: izquierdo, inferior y derecho ───────────────────────────────

const FRAME = <rect x="3" y="4.5" width="18" height="15" rx="3" />;

export const IconPanelLeft = ({ filled, ...p }) => (
  <Svg {...p}>
    {FRAME}<path d="M9.5 4.5v15" />
    {filled && <path d="M6 4.5h3.5v15H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z" fill="currentColor" fillOpacity=".5" stroke="none" />}
  </Svg>
);

export const IconPanelBottom = ({ filled, ...p }) => (
  <Svg {...p}>
    {FRAME}<path d="M3 14.5h18" />
    {filled && <path d="M3 14.5h18v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="currentColor" fillOpacity=".5" stroke="none" />}
  </Svg>
);

export const IconPanelRight = ({ filled, ...p }) => (
  <Svg {...p}>
    {FRAME}<path d="M14.5 4.5v15" />
    {filled && <path d="M14.5 4.5H18a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-3.5z" fill="currentColor" fillOpacity=".5" stroke="none" />}
  </Svg>
);

// ── Barra superior ───────────────────────────────────────────────────────

export const IconGear = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M10.3 3.5h3.4l.5 2.1 1.5.9 2-.8 1.7 2.9-1.6 1.5v1.8l1.6 1.5-1.7 2.9-2-.8-1.5.9-.5 2.1h-3.4l-.5-2.1-1.5-.9-2 .8-1.7-2.9 1.6-1.5v-1.8L4.6 8.6l1.7-2.9 2 .8 1.5-.9z" />
  </Svg>
);

export const IconTeamPeople = (p) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="3.2" /><circle cx="16.5" cy="10" r="2.6" />
    <path d="M3.5 19c.5-3 2.8-4.7 5.5-4.7s5 1.7 5.5 4.7M15.5 14.6c2.2-.2 4.2 1.1 5 4" />
  </Svg>
);

export const IconFolderBar = (p) => (
  <Svg {...p}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconMinimize = (p) => <Svg strokeWidth={1.4} {...p}><path d="M7 12h10" /></Svg>;
export const IconMaximize = (p) => <Svg strokeWidth={1.4} {...p}><rect x="7" y="7" width="10" height="10" rx="1.6" /></Svg>;
export const IconRestore = (p) => (
  <Svg strokeWidth={1.4} {...p}>
    <rect x="6.5" y="9" width="8.5" height="8.5" rx="1.5" /><path d="M9 9V8a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 18 8v6a1.5 1.5 0 0 1-1.5 1.5H15" />
  </Svg>
);
export const IconClose = (p) => <Svg strokeWidth={1.4} {...p}><path d="M7 7l10 10M17 7 7 17" /></Svg>;
