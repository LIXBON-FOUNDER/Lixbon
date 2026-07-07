// Icons.jsx — iconos SVG inline de trazo fino (portado de apps/web).
// Todos heredan currentColor y tamaño por prop `size` (default 18).
// Al final: iconos exclusivos del IDE (árbol de archivos, editor).

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

export const IconPanel = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></Svg>
);

export const IconChat = (p) => (
  <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H4l1.7-3.4A8 8 0 1 1 21 12Z" /></Svg>
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

export const IconChevronRight = (p) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);

export const IconGear = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
  </Svg>
);

export const IconSend = (p) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

export const IconStop = (p) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></Svg>
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

export const IconCopy = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}><path d="M4 12l5 5L20 6" /></Svg>
);

export const IconUser = (p) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
);

export const IconChart = (p) => (
  <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>
);

export const IconEye = (p) => (
  <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>
);

export const IconEyeOff = (p) => (
  <Svg {...p}>
    <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.1M6.6 6.6C3.8 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1M3 3l18 18" />
  </Svg>
);

/* ── Iconos del IDE ──────────────────────────────────────────────────── */

export const IconFolder = (p) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Svg>
);

export const IconFolderOpen = (p) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V11M3 19l2.5-8h16L19 19H3Z" /></Svg>
);

export const IconFile = (p) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></Svg>
);

export const IconFileCode = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2" />
  </Svg>
);

export const IconFilePlus = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M12 12v6M9 15h6" />
  </Svg>
);

export const IconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <path d="M12 10.5v5M9.5 13h5" />
  </Svg>
);

export const IconRefresh = (p) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" /></Svg>
);

export const IconChevronDown = (p) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);

export const IconTerminal = (p) => (
  <Svg {...p}><path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="m7 9 3 3-3 3M13 15h4" /></Svg>
);

export const IconPlay = (p) => (
  <Svg {...p}><path d="M7 5v14l12-7L7 5Z" fill="currentColor" stroke="none" /></Svg>
);

export const IconHammer = (p) => (
  <Svg {...p}><path d="M14 6l4 4M10.5 9.5 3 17a2 2 0 0 0 3 3l7.5-7.5M12 8l4-4 4 4-4 4-4-4Z" /></Svg>
);

export const IconGitBranch = (p) => (
  <Svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-4 4.5-7 4.5" /></Svg>
);

export const IconGitCommit = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="3.5" /><path d="M3 12h5.5M15.5 12H21" /></Svg>
);

export const IconArrowUp = (p) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);
