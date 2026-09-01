// Icons.jsx — iconos SVG inline de trazo fino (estilo "7000 FREE UI ICONS").
// Todos heredan currentColor y tamaño por prop `size` (default 18).

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

export const IconPlus = (p) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);

export const IconSearch = (p) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);

export const IconRefresh = (p) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v4h-4" /></Svg>
);

export const IconPanel = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></Svg>
);

export const IconMenu = (p) => (
  <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
);

export const IconChat = (p) => (
  <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H4l1.7-3.4A8 8 0 1 1 21 12Z" /></Svg>
);

export const IconGrid = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </Svg>
);

export const IconDots = (p) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </Svg>
);

export const IconChevron = ({ open, ...p }) => (
  <Svg {...p} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconGear = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
  </Svg>
);

export const IconShare = (p) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
  </Svg>
);

export const IconSend = (p) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

export const IconClip = (p) => (
  <Svg {...p}>
    <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8L13.2 3.7a3.7 3.7 0 1 1 5.2 5.2L9.9 17.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </Svg>
);

export const IconGlobe = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a13.4 13.4 0 0 1 0 18M12 3a13.4 13.4 0 0 0 0 18" />
  </Svg>
);

export const IconPencil = (p) => (
  <Svg {...p}><path d="M17 3.5a2.1 2.1 0 0 1 3 3L8.5 18l-4 1 1-4L17 3.5Z" /></Svg>
);

export const IconTrash = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);

export const IconArrowDown = (p) => (
  <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>
);

export const IconLogout = (p) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>
);

export const IconX = (p) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);

export const IconDownload = (p) => (
  <Svg {...p}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></Svg>
);

export const IconCopy = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Svg>
);

export const IconTerminal = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></Svg>
);

export const IconBook = (p) => (
  <Svg {...p}>
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
    <path d="M4 19a2 2 0 0 1 2-2h13" />
  </Svg>
);

export const IconWindow = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></Svg>
);

export const IconPhone = (p) => (
  <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}><path d="M4 12l5 5L20 6" /></Svg>
);

export const IconBolt = (p) => (
  <Svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></Svg>
);

export const IconUser = (p) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
);

export const IconShield = (p) => (
  <Svg {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" /></Svg>
);

export const IconCard = (p) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></Svg>
);

export const IconChart = (p) => (
  <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>
);

export const IconSun = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p) => (
  <Svg {...p}><path d="M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9Z" /></Svg>
);

export const IconMic = (p) => (
  <Svg {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" />
  </Svg>
);

export const IconImage = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17M14 15l1.8-1.8a2 2 0 0 1 2.8 0L20 14.5" />
  </Svg>
);

export const IconFile = (p) => (
  <Svg {...p}>
    <path d="M14 2.5H7.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2.5V7h4.5" />
  </Svg>
);
