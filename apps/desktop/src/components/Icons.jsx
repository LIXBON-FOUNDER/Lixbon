import { Icono } from "@lixbon/icons";
// Icons.jsx â€” iconos SVG inline de trazo fino (portado de apps/web).
// Todos heredan currentColor y tamaÃ±o por prop `size` (default 18).
// Al final: iconos exclusivos del IDE (Ã¡rbol de archivos, editor).

function Svg({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const LegacyIconPlus = (p) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);

const LegacyIconSearch = (p) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);

const LegacyIconList = (p) => (
  <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Svg>
);

const LegacyIconWarn = (p) => (
  <Svg {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></Svg>
);

const LegacyIconBook = (p) => (
  <Svg {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z" /><path d="M20 17v4H6.5A2.5 2.5 0 0 1 4 18.5" /></Svg>
);

const LegacyIconPanel = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></Svg>
);

const LegacyIconChat = (p) => (
  <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H4l1.7-3.4A8 8 0 1 1 21 12Z" /></Svg>
);

const LegacyIconDots = (p) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </Svg>
);

const LegacyIconChevron = ({ open, ...p }) => (
  <Svg {...p} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

const LegacyIconChevronRight = (p) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);

const LegacyIconGear = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
  </Svg>
);

const LegacyIconSend = (p) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

const LegacyIconStop = (p) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></Svg>
);

const LegacyIconClip = (p) => (
  <Svg {...p}>
    <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8L13.2 3.7a3.7 3.7 0 1 1 5.2 5.2L9.9 17.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </Svg>
);

const LegacyIconGlobe = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a13.4 13.4 0 0 1 0 18M12 3a13.4 13.4 0 0 0 0 18" />
  </Svg>
);

const LegacyIconPencil = (p) => (
  <Svg {...p}><path d="M17 3.5a2.1 2.1 0 0 1 3 3L8.5 18l-4 1 1-4L17 3.5Z" /></Svg>
);

const LegacyIconTrash = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);

const LegacyIconArchive = (p) => (
  <Svg {...p}>
    <path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" />
  </Svg>
);

const LegacyIconArrowDown = (p) => (
  <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>
);

const LegacyIconLogout = (p) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>
);

const LegacyIconX = (p) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);

const LegacyIconCopy = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Svg>
);

const LegacyIconCheck = (p) => (
  <Svg {...p}><path d="M4 12l5 5L20 6" /></Svg>
);

const LegacyIconUser = (p) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
);

// Cabeza de chibi: Gael y Leya (Ajustes â€º Mascota).
const LegacyIconMascota = (p) => (
  <Svg {...p}><circle cx="12" cy="10.5" r="6" /><path d="M6.3 9c1.3-1.4 3.2-2.2 5.7-2.2s4.4.8 5.7 2.2M9.6 11.2v.6M14.4 11.2v.6M7.5 20.5c1-1.5 2.6-2.3 4.5-2.3s3.5.8 4.5 2.3" /></Svg>
);

const LegacyIconChart = (p) => (
  <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>
);

const LegacyIconEye = (p) => (
  <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>
);

const LegacyIconEyeOff = (p) => (
  <Svg {...p}>
    <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.1M6.6 6.6C3.8 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1M3 3l18 18" />
  </Svg>
);

/* â”€â”€ Iconos del IDE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const LegacyIconFolder = (p) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Svg>
);

const LegacyIconFolderOpen = (p) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V11M3 19l2.5-8h16L19 19H3Z" /></Svg>
);

const LegacyIconFile = (p) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></Svg>
);

const LegacyIconFileCode = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2" />
  </Svg>
);

const LegacyIconFilePlus = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M12 12v6M9 15h6" />
  </Svg>
);

const LegacyIconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <path d="M12 10.5v5M9.5 13h5" />
  </Svg>
);

const LegacyIconRefresh = (p) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" /></Svg>
);

const LegacyIconChevronDown = (p) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);

const LegacyIconChevronUp = (p) => (
  <Svg {...p}><path d="m6 15 6-6 6 6" /></Svg>
);

const LegacyIconTerminal = (p) => (
  <Svg {...p}><path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="m7 9 3 3-3 3M13 15h4" /></Svg>
);

const LegacyIconPlay = (p) => (
  <Svg {...p}><path d="M7 5v14l12-7L7 5Z" fill="currentColor" stroke="none" /></Svg>
);

const LegacyIconHammer = (p) => (
  <Svg {...p}><path d="M14 6l4 4M10.5 9.5 3 17a2 2 0 0 0 3 3l7.5-7.5M12 8l4-4 4 4-4 4-4-4Z" /></Svg>
);

const LegacyIconGitBranch = (p) => (
  <Svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-4 4.5-7 4.5" /></Svg>
);

const LegacyIconGitCommit = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="3.5" /><path d="M3 12h5.5M15.5 12H21" /></Svg>
);

const LegacyIconArrowUp = (p) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

/* â”€â”€ Barra de tÃ­tulo (ventana sin decoraciones) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const LegacyIconWinMin = (p) => (
  <Svg {...p} strokeWidth="1.3"><path d="M5 12h14" /></Svg>
);

const LegacyIconWinMax = (p) => (
  <Svg {...p} strokeWidth="1.3"><rect x="6" y="6" width="12" height="12" rx="1" /></Svg>
);

const LegacyIconWinRestore = (p) => (
  <Svg {...p} strokeWidth="1.3">
    <rect x="5" y="8" width="11" height="11" rx="1" />
    <path d="M9 8V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3" />
  </Svg>
);

/* Panel con la franja derecha (toggle del chat, estilo VSCode) */
const LegacyIconPanelRight = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M14.5 4v16" /></Svg>
);

const LegacyIconDownload = (p) => (
  <Svg {...p}><path d="M12 3v12M7 11l5 5 5-5M4 21h16" /></Svg>
);

/* Pieza de puzzle (extensiones) */
const LegacyIconPuzzle = (p) => (
  <Svg {...p}>
    <path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 1 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4Z" />
  </Svg>
);

/* â”€â”€ Tema claro/oscuro â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const LegacyIconSun = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </Svg>
);

const LegacyIconMoon = (p) => (
  <Svg {...p}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" /></Svg>
);

/* â”€â”€ Colapsar panel lateral â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const LegacyIconChevronLeft = (p) => (
  <Svg {...p}><path d="M14 6l-6 6 6 6" /></Svg>
);

const LegacyIconArrowRight = (p) => (
  <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
);

const LegacyIconExternal = (p) => (
  <Svg {...p}><path d="M14 5h5v5M19 5l-8 8M8 5H5v14h14v-3" /></Svg>
);

const LegacyIconHistory = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></Svg>
);

// â”€â”€ Workbench â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LegacyIconLayoutLeft = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Svg>
);

const LegacyIconLayoutBottom = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 15h18" /></Svg>
);

const LegacyIconLayoutRight = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Svg>
);

const LegacyIconSplit = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></Svg>
);

const LegacyIconExpand = (p) => (
  <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>
);

const LegacyIconRotate = (p) => (
  <Svg {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8" /><path d="M20 3v5h-5" /></Svg>
);

const LegacyIconCursor = (p) => (
  <Svg {...p}><path d="M5 3l14 7-6 2-2 6z" /></Svg>
);

const LegacyIconSliders = (p) => (
  <Svg {...p}>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" />
  </Svg>
);

const LegacyIconExtensions = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><path d="M16.75 13.5v6.5M13.5 16.75H20" />
  </Svg>
);

const LegacyIconPullRequest = (p) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" />
    <path d="M6 8v8M18 16V9a2 2 0 0 0-2-2h-4M14 5l-2 2 2 2" />
  </Svg>
);

const LegacyIconAt = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></Svg>
);

const LegacyIconImage = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></Svg>
);

const LegacyIconDevice = (p) => (
  <Svg {...p}><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M11 18h2" /></Svg>
);

const LegacyIconCode = (p) => (
  <Svg {...p}><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></Svg>
);

/* â”€â”€ Ajustes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const LegacyIconShield = (p) => (
  <Svg {...p}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Svg>
);

const LegacyIconCpu = (p) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Svg>
);

const LegacyIconNodes = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" />
    <path d="M12 7.5V12M12 12l-5.3 4.9M12 12l5.3 4.9" />
  </Svg>
);

const LegacyIconKeyboard = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6.5 14h.01M17.5 14h.01M9.5 14h5" />
  </Svg>
);

const LegacyIconDatabase = (p) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
    <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
  </Svg>
);

const LegacyIconServer = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="7" rx="1.5" /><rect x="3.5" y="13" width="17" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
);

// El IDE consume el catÃ¡logo compartido; otras ventanas conservan su presentaciÃ³n.
export const IconPlus = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="nuevo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPlus size={size} filled={filled} {...props} />;
export const IconSearch = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="buscar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconSearch size={size} filled={filled} {...props} />;
export const IconList = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="lista" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconList size={size} filled={filled} {...props} />;
export const IconWarn = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="alerta" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconWarn size={size} filled={filled} {...props} />;
export const IconBook = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="libro" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconBook size={size} filled={filled} {...props} />;
export const IconPanel = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="panel" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPanel size={size} filled={filled} {...props} />;
export const IconChat = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="chat" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChat size={size} filled={filled} {...props} />;
export const IconDots = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="opciones" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconDots size={size} filled={filled} {...props} />;
export const IconChevron = ({ open, size = 18, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre={open ? "abajo" : "siguiente"} size={size} {...props} /> : <LegacyIconChevron open={open} size={size} {...props} />;
export const IconChevronRight = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="siguiente" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChevronRight size={size} filled={filled} {...props} />;
export const IconGear = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="ajustes" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconGear size={size} filled={filled} {...props} />;
export const IconSend = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="enviar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconSend size={size} filled={filled} {...props} />;
export const IconStop = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="detener" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconStop size={size} filled={filled} {...props} />;
export const IconClip = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="clip" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconClip size={size} filled={filled} {...props} />;
export const IconGlobe = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="globo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconGlobe size={size} filled={filled} {...props} />;
export const IconPencil = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="editar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPencil size={size} filled={filled} {...props} />;
export const IconTrash = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="borrar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconTrash size={size} filled={filled} {...props} />;
export const IconArchive = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="archivar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconArchive size={size} filled={filled} {...props} />;
export const IconArrowDown = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="flecha-abajo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconArrowDown size={size} filled={filled} {...props} />;
export const IconLogout = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="salir" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconLogout size={size} filled={filled} {...props} />;
export const IconX = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="cerrar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconX size={size} filled={filled} {...props} />;
export const IconCopy = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="copiar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconCopy size={size} filled={filled} {...props} />;
export const IconCheck = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="hecho" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconCheck size={size} filled={filled} {...props} />;
export const IconUser = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="usuario" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconUser size={size} filled={filled} {...props} />;
export const IconMascota = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="mascota" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconMascota size={size} filled={filled} {...props} />;
export const IconChart = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="grafica" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChart size={size} filled={filled} {...props} />;
export const IconEye = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="ojo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconEye size={size} filled={filled} {...props} />;
export const IconEyeOff = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="ojo-off" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconEyeOff size={size} filled={filled} {...props} />;
export const IconFolder = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="carpeta" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFolder size={size} filled={filled} {...props} />;
export const IconFolderOpen = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="carpeta-abierta" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFolderOpen size={size} filled={filled} {...props} />;
export const IconFile = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="archivo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFile size={size} filled={filled} {...props} />;
export const IconFileCode = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="archivo-codigo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFileCode size={size} filled={filled} {...props} />;
export const IconFilePlus = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="archivo-nuevo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFilePlus size={size} filled={filled} {...props} />;
export const IconFolderPlus = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="carpeta-nueva" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconFolderPlus size={size} filled={filled} {...props} />;
export const IconRefresh = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="refrescar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconRefresh size={size} filled={filled} {...props} />;
export const IconChevronDown = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="abajo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChevronDown size={size} filled={filled} {...props} />;
export const IconChevronUp = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="arriba" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChevronUp size={size} filled={filled} {...props} />;
export const IconTerminal = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="terminal" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconTerminal size={size} filled={filled} {...props} />;
export const IconPlay = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="reproducir" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPlay size={size} filled={filled} {...props} />;
export const IconHammer = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="construir" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconHammer size={size} filled={filled} {...props} />;
export const IconGitBranch = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="git" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconGitBranch size={size} filled={filled} {...props} />;
export const IconGitCommit = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="commit" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconGitCommit size={size} filled={filled} {...props} />;
export const IconArrowUp = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="flecha-arriba" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconArrowUp size={size} filled={filled} {...props} />;
export const IconWinMin = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="minimizar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconWinMin size={size} filled={filled} {...props} />;
export const IconWinMax = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="maximizar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconWinMax size={size} filled={filled} {...props} />;
export const IconWinRestore = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="restaurar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconWinRestore size={size} filled={filled} {...props} />;
export const IconPanelRight = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="panel-der" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPanelRight size={size} filled={filled} {...props} />;
export const IconDownload = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="descargar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconDownload size={size} filled={filled} {...props} />;
export const IconPuzzle = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="apps" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPuzzle size={size} filled={filled} {...props} />;
export const IconSun = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="claro" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconSun size={size} filled={filled} {...props} />;
export const IconMoon = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="oscuro" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconMoon size={size} filled={filled} {...props} />;
export const IconChevronLeft = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="anterior" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconChevronLeft size={size} filled={filled} {...props} />;
export const IconArrowRight = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="siguiente" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconArrowRight size={size} filled={filled} {...props} />;
export const IconExternal = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="externo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconExternal size={size} filled={filled} {...props} />;
export const IconHistory = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="historial" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconHistory size={size} filled={filled} {...props} />;
export const IconLayoutLeft = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="panel" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconLayoutLeft size={size} filled={filled} {...props} />;
export const IconLayoutBottom = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="panel-inf" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconLayoutBottom size={size} filled={filled} {...props} />;
export const IconLayoutRight = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="panel-der" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconLayoutRight size={size} filled={filled} {...props} />;
export const IconSplit = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="dividir" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconSplit size={size} filled={filled} {...props} />;
export const IconExpand = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="expandir" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconExpand size={size} filled={filled} {...props} />;
export const IconRotate = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="girar" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconRotate size={size} filled={filled} {...props} />;
export const IconCursor = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="cursor" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconCursor size={size} filled={filled} {...props} />;
export const IconSliders = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="deslizadores" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconSliders size={size} filled={filled} {...props} />;
export const IconExtensions = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="apps" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconExtensions size={size} filled={filled} {...props} />;
export const IconPullRequest = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="pull-request" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconPullRequest size={size} filled={filled} {...props} />;
export const IconAt = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="mencion" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconAt size={size} filled={filled} {...props} />;
export const IconImage = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="imagen" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconImage size={size} filled={filled} {...props} />;
export const IconDevice = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="remoto" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconDevice size={size} filled={filled} {...props} />;
export const IconCode = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="codigo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconCode size={size} filled={filled} {...props} />;
export const IconShield = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="escudo" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconShield size={size} filled={filled} {...props} />;
export const IconCpu = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="cpu" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconCpu size={size} filled={filled} {...props} />;
export const IconNodes = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="nodos" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconNodes size={size} filled={filled} {...props} />;
export const IconKeyboard = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="teclado" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconKeyboard size={size} filled={filled} {...props} />;
export const IconDatabase = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="base-datos" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconDatabase size={size} filled={filled} {...props} />;
export const IconServer = ({ size = 18, filled, ...props }) => typeof document !== "undefined" && document.documentElement.dataset.ui === "ide" ? <Icono nombre="servidor" size={size} relleno={Boolean(filled)} {...props} /> : <LegacyIconServer size={size} filled={filled} {...props} />;
