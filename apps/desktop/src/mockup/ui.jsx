// ui.jsx — primitivas compartidas por las 4 superficies. Misma marca de estado, mismo chip de ubicación, mismo marcador de Attention.
import {
  IconGitBranch, IconServer, IconTerminal, IconShield, IconChat, IconEye, IconX, IconCheck, IconFolder, IconSearch, IconPlus,
  IconChevronDown, IconChevronRight, IconDevice, IconSend, IconArrowUp, IconStop, IconWarn, IconRefresh, IconExternal,
  IconCode, IconCpu, IconNodes, IconHistory, IconSplit, IconPencil, IconTrash, IconClip, IconPlay, IconUser, IconChart,
  IconSliders, IconPullRequest, IconFileCode, IconFile, IconFolderOpen, IconDots, IconCopy, IconKeyboard, IconImage,
  IconArrowDown, IconPanel, IconList, IconArrowRight, IconChevronLeft, IconChevronUp, IconDatabase, IconBook, IconGear,
} from '../components/Icons';
import { meta, stateLabel, provider, agentShort, hostOf, isRemote } from './vocab';
import { CURRENT_HOST } from './data';

const ICONS = {
  branch: IconGitBranch, server: IconServer, terminal: IconTerminal, shield: IconShield, chat: IconChat, eye: IconEye, x: IconX,
  check: IconCheck, folder: IconFolder, search: IconSearch, plus: IconPlus, down: IconChevronDown, right: IconChevronRight,
  device: IconDevice, send: IconSend, up: IconArrowUp, stop: IconStop, warn: IconWarn, refresh: IconRefresh, external: IconExternal,
  code: IconCode, cpu: IconCpu, nodes: IconNodes, history: IconHistory, split: IconSplit, pencil: IconPencil, trash: IconTrash,
  clip: IconClip, play: IconPlay, user: IconUser, chart: IconChart, sliders: IconSliders, pr: IconPullRequest, filecode: IconFileCode,
  file: IconFile, folderopen: IconFolderOpen, dots: IconDots, copy: IconCopy, keyboard: IconKeyboard, image: IconImage,
  arrowdown: IconArrowDown, panel: IconPanel, list: IconList, arrow: IconArrowRight, left: IconChevronLeft, upchev: IconChevronUp,
  db: IconDatabase, book: IconBook, gear: IconGear,
};
export function I({ n, size = 14, ...rest }) {
  const C = ICONS[n];
  return C ? <C size={size} {...rest} /> : null;
}

/* ── Marca de estado: la FORMA distingue, el color refuerza ─────────────── */
const SHAPES = {
  working: (<><circle className="mk-track" cx="8" cy="8" r="6.2" /><circle className="mk-arc" cx="8" cy="8" r="6.2" /></>),
  thinking: (<><circle className="mk-dot mk-d1" cx="3.6" cy="8" r="1.5" /><circle className="mk-dot mk-d2" cx="8" cy="8" r="1.5" /><circle className="mk-dot mk-d3" cx="12.4" cy="8" r="1.5" /></>),
  tool: (<><rect className="mk-ring" x="1.8" y="2.8" width="12.4" height="10.4" rx="2.6" /><path className="mk-glyph" d="M4.6 6l2.2 2-2.2 2" /><path className="mk-glyph mk-blink" d="M8.4 10.4h3" /></>),
  waiting: (<><circle className="mk-ring" cx="8" cy="8" r="6.2" /><path className="mk-glyph" d="M8 4.6V8l2.2 1.4" /></>),
  queued: (<circle className="mk-ring mk-dash" cx="8" cy="8" r="6.2" />),
  review: (<><circle className="mk-fill mk-solid" cx="8" cy="8" r="6.4" /><path className="mk-glyph mk-inv" d="M4.2 8s1.5-2.6 3.8-2.6S11.8 8 11.8 8 10.3 10.6 8 10.6 4.2 8 4.2 8Z" /><circle className="mk-inv-fill" cx="8" cy="8" r="1.1" /></>),
  failed: (<><circle className="mk-fill" cx="8" cy="8" r="6.6" /><path className="mk-glyph" d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></>),
  done: (<><circle className="mk-fill" cx="8" cy="8" r="6.6" /><path className="mk-glyph" d="M4.9 8.2l2.1 2.1 4.2-4.5" /></>),
  paused: (<><circle className="mk-fill" cx="8" cy="8" r="6.6" /><path className="mk-glyph" d="M6.3 5.6v4.8M9.7 5.6v4.8" /></>),
  offline: (<><circle className="mk-ring" cx="8" cy="8" r="6.2" /><path className="mk-glyph" d="M3.8 12.2L12.2 3.8" /></>),
};

export function Mark({ attempt, kind, tone, size = 14 }) {
  const m = attempt ? meta(attempt) : { mark: kind, tone };
  return (
    <span className={`mk mk-tone-${m.tone}`} style={{ width: size, height: size }} data-mark={m.mark} aria-hidden="true">
      <svg key={m.mark} viewBox="0 0 16 16" width={size} height={size}>{SHAPES[m.mark] || SHAPES.queued}</svg>
    </span>
  );
}

export function StatePill({ attempt, size = 12 }) {
  const m = meta(attempt);
  return (
    <span className={`pill mk-tone-${m.tone}`} data-state={attempt.state}>
      <Mark attempt={attempt} size={size} />
      {stateLabel(attempt)}
    </span>
  );
}

/** Attention vive en su propio eje: un marcador ámbar relleno, distinto de cualquier estado de ejecución. */
export function AttnFlag({ n = 1, risk }) {
  return (
    <span className={`attn-flag ${risk === 'high' ? 'is-high' : ''}`} title={`${n} need${n === 1 ? 's' : ''} your attention`} aria-label={`${n} need your attention`}>
      <b>!</b>{n > 1 && <span>{n}</span>}
    </span>
  );
}

export function ProvMark({ id, size = 16 }) {
  const p = { claude: 'C', codex: 'X', gpt: 'G', local: 'L' }[id] || '?';
  return <span className={`prov prov-${id}`} style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">{p}</span>;
}

export function Agent({ attempt, label = true, size = 16 }) {
  return (
    <span className="agent">
      <ProvMark id={attempt.provider} size={size} />
      {label && <span className="agent__n">{agentShort(attempt)}</span>}
    </span>
  );
}

/** Ubicación: SIEMPRE branch/worktree/host reales del Attempt, nunca inferidos. */
export function Loc({ attempt, parts = ['branch', 'host'], compact = false, forceHost = false }) {
  const h = hostOf(attempt.host);
  const showHost = parts.includes('host') && (forceHost || isRemote(attempt) || attempt.state === 'offline' || parts.includes('hostAlways'));
  return (
    <span className={`loc ${compact ? 'is-compact' : ''}`}>
      {parts.includes('branch') && (
        <span className="chip chip--mono" title={attempt.worktree ? `Worktree ${attempt.worktree}` : 'Read-only / plan — no worktree'}>
          <I n="branch" size={11} />{attempt.branch || 'plan · no worktree'}
        </span>
      )}
      {parts.includes('worktree') && attempt.worktree && <span className="chip chip--mono chip--dim" title={attempt.worktree}><I n="folder" size={11} />…\{attempt.id}</span>}
      {showHost && <span className={`chip chip--host ${h.status === 'offline' ? 'is-off' : ''}`}><I n="server" size={11} />{h.name}{h.status === 'offline' ? ' · offline' : ''}</span>}
    </span>
  );
}

export const Kbd = ({ children }) => <kbd className="kbd">{children}</kbd>;

export function RiskTag({ risk }) {
  if (!risk || risk === 'none') return null;
  return <span className={`risk risk--${risk}`}>{risk}</span>;
}

export function Seg({ value, onChange, options, size }) {
  return (
    <div className={`seg ${size ? 'seg--' + size : ''}`} role="tablist">
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} className={value === o.id ? 'is-on' : ''} onClick={() => onChange(o.id)}>
          {o.icon && <I n={o.icon} size={12} />}{o.label}{o.count != null && <i>{o.count}</i>}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, aside, children, className = '' }) {
  return (
    <section className={`sec ${className}`}>
      <header className="sec__h"><h3>{title}</h3>{aside && <div className="sec__a">{aside}</div>}</header>
      {children}
    </section>
  );
}

export const Meter = ({ pct, tone }) => (
  <span className={`meter ${tone ? 'meter--' + tone : pct > 80 ? 'meter--warn' : ''}`}><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
);

export const money = (n) => `$${n.toFixed(2)}`;
export { stateLabel, meta, provider, agentShort, hostOf, CURRENT_HOST };
