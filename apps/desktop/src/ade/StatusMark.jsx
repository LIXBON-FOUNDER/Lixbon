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

const SHAPES = {
  working: (<><circle className="ade-mark__track" cx="8" cy="8" r="6.2" /><path className="ade-mark__arc" d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" /></>),
  waiting: (<><circle className="ade-mark__ring" cx="8" cy="8" r="6.2" /><path className="ade-mark__glyph" d="M8 4.6V8l2.2 1.4" /></>),
  terminal: (<><rect className="ade-mark__ring" x="1.8" y="2.8" width="12.4" height="10.4" rx="2.6" /><path className="ade-mark__glyph" d="M4.6 6l2.2 2-2.2 2M8.4 10.4h3" /></>),
  queued: (<circle className="ade-mark__ring ade-mark__dash" cx="8" cy="8" r="6.2" />),
  review: (<><circle className="ade-mark__fill" cx="8" cy="8" r="6.6" /><path className="ade-mark__glyph ade-mark__inv" d="M4.2 8s1.5-2.6 3.8-2.6S11.8 8 11.8 8 10.3 10.6 8 10.6 4.2 8 4.2 8Z" /></>),
  done: (<><circle className="ade-mark__fill" cx="8" cy="8" r="6.6" /><path className="ade-mark__glyph ade-mark__inv" d="M4.9 8.2l2.1 2.1 4.2-4.5" /></>),
  failed: (<><circle className="ade-mark__fill" cx="8" cy="8" r="6.6" /><path className="ade-mark__glyph ade-mark__inv" d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></>),
  stopped: (<><circle className="ade-mark__ring" cx="8" cy="8" r="6.2" /><rect className="ade-mark__fill" x="5.4" y="5.4" width="5.2" height="5.2" rx="1" /></>),
  offline: (<><circle className="ade-mark__ring" cx="8" cy="8" r="6.2" /><path className="ade-mark__glyph" d="M3.8 12.2L12.2 3.8" /></>),
  unknown: (<circle className="ade-mark__fill" cx="8" cy="8" r="2.2" />),
};

export function StatusMark({ info, size = 12 }) {
  const shape = statusShape(info);
  return (
    <span className="ade-mark" data-shape={shape} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 16 16" width={size} height={size}>{SHAPES[shape]}</svg>
    </span>
  );
}

/** Marcador de Attention: ámbar, relleno y «!»; distinto de cualquier marca de estado. Solo acompaña al texto «Attention N». */
export function AttentionMark({ size = 12 }) {
  return (
    <span className="ade-attn-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size} height={size}>
        <path className="ade-attn-mark__shape" d="M8 1.4l6.8 12.2H1.2L8 1.4Z" />
        <path className="ade-attn-mark__bang" d="M8 6v3.4M8 11.2v.1" />
      </svg>
    </span>
  );
}
