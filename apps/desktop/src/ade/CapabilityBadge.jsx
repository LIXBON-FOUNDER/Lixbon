import './Capabilities.css';

/**
 * LXO-135 · Una capability de un proveedor como chip. Lo que distingue un estado de otro es el TEXTO y la FORMA (glifo y borde),
 * no solo el color: «no ofrecida», «no disponible ahora» y «bloqueada por el entorno» no se confunden entre sí ni con un fallo.
 * `info` sale de `describeCapability`/`resumeAvailability` (capabilityModel.js); este componente no decide nada.
 */
export function CapabilityBadge({ info, showLabel = true, compact = false }) {
  return (
    <span
      className={`cap cap--${info.tone}${compact ? ' cap--compact' : ''}`}
      data-state={info.state ?? info.kind}
      data-capability={info.capability ?? 'resume'}
      data-enabled={info.enabled ? 'true' : 'false'}
      title={info.reason}
    >
      <span className="cap__glyph" aria-hidden="true">{info.glyph}</span>
      {showLabel && <span className="cap__label">{info.label}</span>}
      {typeof info.stateLabel === 'string' && <span className="cap__state">{compact && info.stateShort ? info.stateShort : info.stateLabel}</span>}
    </span>
  );
}
