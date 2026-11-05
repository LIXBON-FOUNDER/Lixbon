// WorkspacePulse.jsx — pinta el Pulse (pulseModel.js) dentro de la segunda línea de una fila del navegador.
// Texto plano, sin controles ni regiones en vivo: la fila es un botón y un cambio de fondo no anuncia ni mueve nada.
// Lo visible va en `aria-hidden` y cada señal trae su texto completo (con procedencia) para lector de pantalla.
import { Fragment } from 'react';

export function WorkspacePulse({ pulse }) {
  if (!pulse || !(pulse.segments.length || pulse.hidden.length)) return null;
  return (
    <span className="pv-pulse2" data-testid="pulse" data-variant={pulse.variant}>
      {pulse.segments.map((s) => (
        <Fragment key={s.key}>
          <span className="pv-sep" aria-hidden="true">·</span>
          <span
            className={`pv-pulse2__seg${s.evidence ? ` pv-pulse2__seg--${s.evidence}` : ''}${s.alert ? ' is-alert' : ''}`}
            data-pulse={s.key}
            data-evidence={s.evidence ?? undefined}
            title={s.label}
          >
            <span aria-hidden="true">{s.text}</span>
            <span className="pv-sr">{`, ${s.label}`}</span>
          </span>
        </Fragment>
      ))}
      {/* Lo que tiene dato y no cabe en la línea no se recorta a medias: el lector lo oye y el tooltip de la fila lo enseña. */}
      {pulse.hidden.length > 0 && <span className="pv-sr" data-pulse-hidden>{`, ${pulse.hidden.map((s) => s.label).join('. ')}`}</span>}
    </span>
  );
}
