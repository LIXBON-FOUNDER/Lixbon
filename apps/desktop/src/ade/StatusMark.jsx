import { StatusIcon } from '@lixbon/icons/status';
import './StatusMark.css';

/**
 * Marca de estado por FORMA además del color (D3 de la maqueta): quien no distingue colores sigue distinguiendo un círculo
 * que trabaja de uno que espera, uno que acabó bien y uno que falló. Es solo un refuerzo visual: el estado ya va escrito al
 * lado, por eso la marca es `aria-hidden`. Attention es otro eje y tiene su propia marca (`AttentionMark`, ámbar y con «!»).
 */
const SHAPE_BY_STATUS = Object.freeze({
  starting: 'working', running: 'working', in_progress: 'working',
  waiting: 'waiting',
  awaiting_terminal_approval: 'terminal',
  pending_approval: 'queued', not_started: 'queued', open: 'queued',
  in_review: 'review',
  done: 'done', integrated: 'done',
  failed: 'failed',
  stopped: 'stopped', discarded: 'stopped',
  exited: 'offline',
});
const SHAPE_BY_TONE = Object.freeze({ active: 'working', waiting: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' });

/** Forma de un `{raw, tone, known}` de `adeLabels`; un valor que no se reconoce es un punto neutro, nunca un estado inventado. */
export function statusShape(info) {
  if (!info || info.known === false) return 'unknown';
  return SHAPE_BY_STATUS[info.raw] ?? SHAPE_BY_TONE[info.tone] ?? 'unknown';
}

const KIND = { working: 'working', waiting: 'question', terminal: 'permission', queued: 'paused', review: 'review', done: 'done', failed: 'failed', stopped: 'paused', offline: 'offline' };
export function StatusMark({ info, size = 16 }) {
  const shape = statusShape(info);
  const kind = info?.raw === 'pending_approval' ? 'permission' : KIND[shape];
  return <span className="ade-mark" data-shape={shape} aria-hidden="true">{kind ? <StatusIcon kind={kind} size={size} /> : <svg viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="2" fill="currentColor" /></svg>}</span>;
}
export function AttentionMark({ size = 16 }) {
  return <span className="ade-attn-mark" aria-hidden="true"><StatusIcon kind="attention" size={size} /></span>;
}
