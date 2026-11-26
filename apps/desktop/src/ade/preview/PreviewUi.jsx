import { StatusIcon } from '@lixbon/icons/status';
// PreviewUi.jsx — primitivas de la vista previa sobre las del producto (iconos, AgentChip).
// La forma distingue el estado y el color lo refuerza; Attention vive en su propio eje.
import {
  IconGitBranch, IconServer, IconTerminal, IconShield, IconChat, IconEye, IconX, IconCheck, IconFolder, IconSearch,
  IconPlus, IconChevronDown, IconChevronRight, IconChevronUp, IconChevronLeft, IconArrowUp, IconStop, IconWarn,
  IconCode, IconNodes, IconHistory, IconSplit, IconPencil, IconUser, IconChart, IconSliders, IconPullRequest,
  IconFileCode, IconFile, IconImage, IconPanel, IconBook, IconDatabase, IconKeyboard, IconArrowRight, IconClip,
} from '../../components/Icons';
import { AgentChip } from '../../orch/agent/AgentChip';
import { meta, stateLabel, hostOf, isRemote, RISK_LABEL } from './previewVocab';

const ICONS = {
  branch: IconGitBranch, server: IconServer, terminal: IconTerminal, shield: IconShield, chat: IconChat, eye: IconEye,
  x: IconX, check: IconCheck, folder: IconFolder, search: IconSearch, plus: IconPlus, down: IconChevronDown,
  right: IconChevronRight, up: IconChevronUp, left: IconChevronLeft, send: IconArrowUp, stop: IconStop, warn: IconWarn,
  code: IconCode, nodes: IconNodes, history: IconHistory, split: IconSplit, pencil: IconPencil, user: IconUser,
  chart: IconChart, sliders: IconSliders, pr: IconPullRequest, filecode: IconFileCode, file: IconFile, image: IconImage,
  panel: IconPanel, book: IconBook, db: IconDatabase, keyboard: IconKeyboard, arrow: IconArrowRight, clip: IconClip,
};

export function I({ n, size = 14, ...rest }) {
  const kind = { shield: 'permission', chat: 'question', eye: 'review', warn: 'attention', pr: 'review' }[n];
  if (kind) return <StatusIcon kind={kind} size={size} {...rest} />;
  const C = ICONS[n];
  return C ? <C size={size} {...rest} /> : null;
}

const STATUS_KIND = { thinking: 'working', tool: 'working', waiting: 'permission', queued: 'paused', offline: 'offline' };
export function Mark({ attempt, kind, tone, size = 14 }) {
  const m = attempt ? meta(attempt) : { mark: kind, tone };
  const state = attempt?.cause === 'answer' ? 'question' : attempt?.cause === 'network' ? 'network' : STATUS_KIND[m.mark] || m.mark;
  return <span className={`pvmk pv-tone-${m.tone}`} data-mark={m.mark} aria-hidden="true"><StatusIcon kind={state} size={size} /></span>;
}

export function StatePill({ attempt }) {
  return (
    <span className={`pv-pill pv-tone-${meta(attempt).tone}`} data-state={attempt.state}>
      <Mark attempt={attempt} size={12} />
      {stateLabel(attempt)}
    </span>
  );
}

/** Marcador de Attention: ámbar y relleno, distinto de cualquier estado de ejecución. */
export function AttnFlag({ n = 1, risk }) {
  const label = `${n} ${n === 1 ? 'espera' : 'esperan'} tu decisión`;
  return (
    <span className={`pv-attn${risk === 'high' ? ' is-high' : ''}`} title={label} aria-label={label}>
      <StatusIcon kind="attention" size={16} />{n > 1 && <span>{n}</span>}
    </span>
  );
}

export function Agent({ attempt, size = 12, detail = true }) {
  return <AgentChip provider={attempt.provider} model={detail ? attempt.model : null} effort={detail ? attempt.effort : null} size={size} />;
}

/** Ubicación real del Intento: rama, worktree y host. El host solo si es remoto o está desconectado (o se fuerza). */
export function Loc({ attempt, parts = ['branch'], forceHost = false }) {
  const h = hostOf(attempt.host);
  const showHost = parts.includes('host') && (forceHost || isRemote(attempt) || h.status === 'offline');
  return (
    <span className="pv-loc">
      {parts.includes('branch') && (
        <span className="pv-tag mono" title={attempt.worktree ? `Worktree ${attempt.worktree}` : 'Solo lectura: sin worktree'}>
          <I n="branch" size={11} />{attempt.branch || 'sin worktree'}
        </span>
      )}
      {parts.includes('worktree') && attempt.worktree && (
        <span className="pv-tag mono pv-tag--dim" title={attempt.worktree}><I n="folder" size={11} />…\{attempt.id}</span>
      )}
      {showHost && (
        <span className={`pv-tag${h.status === 'offline' ? ' pv-tag--off' : ''}`}><I n="server" size={11} />{h.name}{h.status === 'offline' ? ' · desconectado' : ''}</span>
      )}
    </span>
  );
}

export function RiskTag({ risk }) {
  if (!risk || risk === 'none') return null;
  return <span className={`pv-risk pv-risk--${risk}`}>riesgo {RISK_LABEL[risk]}</span>;
}

export function Meter({ pct }) {
  return <span className={`pv-meter${pct >= 70 ? ' is-hot' : ''}`} aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>;
}

/** Botón que solo existe para mover la simulación; nunca es parte del producto. */
export function SimBadge() {
  return <span className="pv-sim" title="Control de la vista previa: no es parte del producto">sim</span>;
}

/** Tabs con semántica de pestañas y el mismo aspecto que el switch del ADE real. */
export function Tabs({ value, onChange, options, label, idPrefix }) {
  const onKeyDown = (event) => {
    const index = options.findIndex((o) => o.id === value);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    onChange(options[next].id);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="ade-view-switch" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${o.id}` : undefined}
            aria-selected={selected}
            aria-label={o.label}
            tabIndex={selected ? 0 : -1}
            className={`ade-view-switch__tab${selected ? ' is-active' : ''}`}
            onClick={() => onChange(o.id)}
            title={o.title}
          >
            {o.icon && <I n={o.icon} size={12} />}
            <span className="pv-tab__label">{o.label}</span>
            {o.badge}
          </button>
        );
      })}
    </div>
  );
}
