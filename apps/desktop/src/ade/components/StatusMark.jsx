// StatusMark.jsx — marca y píldora de estado, indexadas por el GRUPO VISUAL del vocabulario canónico.
// Distingue por forma y no solo por color: `waiting` (aro con manecillas) y `needs_person` (relleno con
// exclamación y pulso) son ambos ámbar y no deben confundirse.
import { attemptStateInfo } from '../vocab/vocabulario';

const FORMAS = {
  active: (
    <>
      <circle className="ade-sm__track" cx="8" cy="8" r="6.2" />
      <circle className="ade-sm__arc" cx="8" cy="8" r="6.2" />
    </>
  ),
  waiting: (
    <>
      <circle className="ade-sm__ring" cx="8" cy="8" r="6.2" />
      <path className="ade-sm__glyph" d="M8 4.6V8l2.2 1.4" />
    </>
  ),
  needs_person: (
    <>
      <circle className="ade-sm__ping" cx="8" cy="8" r="4" />
      <circle className="ade-sm__fill ade-sm__fill--solid" cx="8" cy="8" r="6.4" />
      <path className="ade-sm__glyph ade-sm__glyph--inv" d="M8 4.8v3.9M8 11.1v.1" />
    </>
  ),
  ok: (
    <>
      <circle className="ade-sm__fill" cx="8" cy="8" r="6.6" />
      <path className="ade-sm__glyph" d="M4.9 8.2l2.1 2.1 4.2-4.5" />
    </>
  ),
  error: (
    <>
      <circle className="ade-sm__fill" cx="8" cy="8" r="6.6" />
      <path className="ade-sm__glyph" d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  halted: (
    <>
      <circle className="ade-sm__fill" cx="8" cy="8" r="6.6" />
      <rect className="ade-sm__stop" x="5.6" y="5.6" width="4.8" height="4.8" rx="1" />
    </>
  ),
  desconocido: <circle className="ade-sm__ring ade-sm__ring--dash" cx="8" cy="8" r="6.2" />,
};

/** @param {{state?: string, group?: string, size?: number}} props `state` es un id de Attempt/Task; `group` fuerza el grupo. */
export function StatusMark({ state, group, size = 14 }) {
  const info = attemptStateInfo(state);
  const g = group || info.group || 'desconocido';
  return (
    <span className={`ade-sm ade-tone-${g}`} style={{ width: size, height: size }} data-group={g} data-state={state} role="img" aria-label={info.label}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">{FORMAS[g] || FORMAS.desconocido}</svg>
    </span>
  );
}

/** Marca + etiqueta en español. `propuesta` avisa de que la etiqueta aún no es canónica. */
export function StatusPill({ state, size = 12 }) {
  const info = attemptStateInfo(state);
  return (
    <span className={`ade-pill ade-tone-${info.group || 'desconocido'}`} data-state={state} title={info.propuesta ? `${info.label} (etiqueta propuesta, no canónica aún)` : info.label}>
      <StatusMark state={state} size={size} />
      <span>{info.label}</span>
    </span>
  );
}
