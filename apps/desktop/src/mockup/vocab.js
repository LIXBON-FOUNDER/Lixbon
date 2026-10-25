// vocab.js — UNA taxonomía de estado para ADE, IDE, Mobile y CLI.
// Dos ejes que nunca se mezclan:
//   1) ESTADO DE EJECUCIÓN (lo que hace el agente): queued · working{thinking|tool|writing} · waiting{cause} · review_ready · failed · completed · paused · offline
//   2) ATTENTION (lo que necesita de una persona): un item aparte, con su propio marcador.
// Un agente puede estar "working" sin Attention; puede estar "completed" y aun así tener Attention (conflicto).
import { PROVIDERS, HOSTS, CURRENT_HOST } from './data';

export const STATE_META = {
  queued: { mark: 'queued', tone: 'muted', label: 'Queued', cli: 'queued' },
  starting: { mark: 'queued', tone: 'info', label: 'Starting', cli: 'starting' },
  working: { mark: 'working', tone: 'info', label: 'Working', cli: 'working' },
  thinking: { mark: 'thinking', tone: 'info', label: 'Thinking', cli: 'working:thinking' },
  tool: { mark: 'tool', tone: 'info', label: 'Running tool', cli: 'working:tool' },
  waiting: { mark: 'waiting', tone: 'warn', label: 'Waiting', cli: 'waiting' },
  review_ready: { mark: 'review', tone: 'merged', label: 'Review ready', cli: 'review_ready' },
  failed: { mark: 'failed', tone: 'danger', label: 'Failed', cli: 'failed' },
  completed: { mark: 'done', tone: 'good', label: 'Completed', cli: 'completed' },
  paused: { mark: 'paused', tone: 'muted', label: 'Paused', cli: 'paused' },
  offline: { mark: 'offline', tone: 'faint', label: 'Offline', cli: 'offline' },
};

export const CAUSE_LABEL = { approval: 'approval', answer: 'answer', dependency: 'dependency', host: 'host', rate_limit: 'rate limit' };

/** Clave de meta efectiva: working se desdobla por fase. */
export function metaKey(a) {
  if (a.state === 'working') return a.phase === 'thinking' ? 'thinking' : a.phase === 'tool' ? 'tool' : 'working';
  return a.state;
}
export const meta = (a) => STATE_META[metaKey(a)] || STATE_META.queued;

/** "Waiting · approval" — Waiting SIEMPRE lleva causa. */
export function stateLabel(a) {
  if (a.state === 'waiting') return `Waiting · ${CAUSE_LABEL[a.cause] || 'unknown'}`;
  return meta(a).label;
}
export function cliState(a) {
  if (a.state === 'waiting') return `waiting:${a.cause}`;
  return meta(a).cli;
}

/** Un Attempt ocupado recibe follow-ups como Queue/Steer/Stop/Fork; uno ocioso, un "Send" normal. */
export const isBusy = (a) => ['working', 'waiting', 'starting', 'queued'].includes(a.state);
export const isActive = (a) => ['working', 'starting'].includes(a.state);

export const provider = (a) => PROVIDERS[a.provider];
export const agentName = (a) => `${PROVIDERS[a.provider].name}${a.model && a.provider !== 'local' ? ' ' + a.model : ''}`;
export const agentShort = (a) => {
  if (a.provider === 'local') return 'Local Model';
  const n = PROVIDERS[a.provider].name;
  return a.model.toLowerCase().startsWith(n.toLowerCase()) ? a.model : `${n} ${a.model}`;
};
export const hostOf = (id) => HOSTS.find((h) => h.id === id);
export const isRemote = (a) => a.host !== CURRENT_HOST;

export const KIND_META = {
  permission: { label: 'Permission', icon: 'shield' },
  question: { label: 'Question', icon: 'chat' },
  review: { label: 'Review ready', icon: 'eye' },
  failed: { label: 'Failed', icon: 'x' },
  conflict: { label: 'Conflict', icon: 'branch' },
  host: { label: 'Host offline', icon: 'server' },
  security: { label: 'Security risk', icon: 'shield' },
};

export const RISK_LABEL = { high: 'High', medium: 'Medium', low: 'Low', none: '—' };

export const MODES = {
  queue: { id: 'queue', label: 'Queue', sub: 'after current turn', keys: 'Enter', desc: 'Add an instruction for later. Delivered when the current turn ends.' },
  steer: { id: 'steer', label: 'Steer', sub: 'at next safe point', keys: 'Ctrl+Enter', desc: 'Adjust the running turn at the next safe boundary. Nothing is interrupted.' },
  stop: { id: 'stop', label: 'Stop & Send', sub: 'interrupt now', keys: 'Ctrl+Shift+Enter', desc: 'Stop the current turn, then send. Tools already run and files already written are NOT reverted.' },
  fork: { id: 'fork', label: 'Fork as Attempt', sub: 'in parallel', keys: '', desc: 'Keep this Attempt running and start a parallel one (own worktree) with this instruction.' },
};
