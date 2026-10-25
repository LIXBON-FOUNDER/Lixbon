// previewVocab.js — una taxonomía de estado para la vista previa, en la lengua del producto.
// Dos ejes que nunca se mezclan:
//   1) Estado de ejecución (lo que hace el agente): forma + color, con texto siempre.
//   2) Attention (lo que necesita de una persona): un elemento aparte con su propio marcador.
// Los tonos son los de adeLabels (active · waiting · done · failed · neutral) más `review` y `faint`.
import { providerName } from '../../orch/agent/agentIdentity';
import { HOSTS, CURRENT_HOST, PROVIDERS, POLICIES } from './previewData';

export const STATE_META = {
  queued: { mark: 'queued', tone: 'neutral', label: 'En cola' },
  starting: { mark: 'queued', tone: 'active', label: 'Iniciando' },
  working: { mark: 'working', tone: 'active', label: 'En ejecución' },
  thinking: { mark: 'thinking', tone: 'active', label: 'Pensando' },
  tool: { mark: 'tool', tone: 'active', label: 'Ejecutando una orden' },
  waiting: { mark: 'waiting', tone: 'waiting', label: 'Esperando' },
  review_ready: { mark: 'review', tone: 'review', label: 'Listo para revisar' },
  failed: { mark: 'failed', tone: 'failed', label: 'Falló' },
  completed: { mark: 'done', tone: 'done', label: 'Terminado' },
  paused: { mark: 'paused', tone: 'neutral', label: 'En pausa' },
  offline: { mark: 'offline', tone: 'faint', label: 'Host desconectado' },
};

export const CAUSE_LABEL = { approval: 'aprobación', answer: 'respuesta', dependency: 'dependencia', host: 'host', rate_limit: 'límite de uso' };

/** Clave efectiva: `working` se desdobla por fase. */
export function metaKey(a) {
  if (a.state === 'working') return a.phase === 'thinking' ? 'thinking' : a.phase === 'tool' ? 'tool' : 'working';
  return a.state;
}
export const meta = (a) => STATE_META[metaKey(a)] || STATE_META.queued;

/** «Esperando · aprobación»: Esperando siempre lleva causa. */
export function stateLabel(a) {
  if (a.state === 'waiting') return `Esperando · ${CAUSE_LABEL[a.cause] || 'causa desconocida'}`;
  return meta(a).label;
}

/** Un Intento ocupado recibe instrucciones como Cola / Corregir / Detener; uno ocioso, un envío normal. */
export const isBusy = (a) => ['working', 'waiting', 'starting', 'queued'].includes(a.state);
export const isActive = (a) => ['working', 'starting'].includes(a.state);

export const canSteer = (a) => Boolean(PROVIDERS[a.provider]?.steer);
export const agentName = (a) => providerName(a.provider);
export const hostOf = (id) => HOSTS.find((h) => h.id === id) || { id, name: id, status: 'offline' };
export const isRemote = (a) => a.host !== CURRENT_HOST;
export const policyName = (id) => POLICIES[id] || id;
export const attemptName = (a) => `Intento ${a.label}`;

export const KIND_META = {
  permission: { label: 'Permiso', icon: 'shield', tone: 'waiting' },
  question: { label: 'Pregunta', icon: 'chat', tone: 'waiting' },
  review: { label: 'Listo para revisar', icon: 'eye', tone: 'review' },
  failed: { label: 'Falló', icon: 'x', tone: 'failed' },
  conflict: { label: 'Conflicto', icon: 'branch', tone: 'failed' },
  host: { label: 'Host desconectado', icon: 'server', tone: 'faint' },
};

export const RISK_LABEL = { high: 'alto', medium: 'medio', low: 'bajo' };

export const MODES = {
  queue: { id: 'queue', label: 'En cola', sub: 'tras el turno actual', keys: 'Enter', desc: 'Añade una instrucción para después. Se entrega cuando acaba el turno actual.' },
  steer: { id: 'steer', label: 'Corregir', sub: 'en el próximo punto seguro', keys: 'Ctrl Enter', desc: 'Ajusta el turno en marcha en el próximo punto seguro. No se interrumpe nada.' },
  stop: { id: 'stop', label: 'Detener y enviar', sub: 'interrumpe ahora', keys: 'Ctrl Shift Enter', desc: 'Detiene el turno y luego envía. Las órdenes ya ejecutadas y los archivos ya escritos NO se deshacen.' },
  fork: { id: 'fork', label: 'Nuevo Intento en paralelo', sub: 'en paralelo', keys: '', desc: 'Este Intento sigue y arranca otro en paralelo, con su propio worktree, con esta instrucción.' },
};

export const ORIGIN_LABEL = { ADE: 'ADE', IDE: 'Editor', CLI: 'CLI', 'Móvil': 'Móvil' };

export const money = (n) => `$${n.toFixed(2)}`;
export const kTokens = (n) => `${Math.round(n / 1000)}k`;
