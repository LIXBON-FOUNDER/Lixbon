import { CapabilityBadge } from './CapabilityBadge';
import { describeAll, describeEnvironment, providerOf, resumeAvailability } from './capabilityModel';
import { useProviderCapabilities } from './useProviderCapabilities';

/**
 * LXO-135 · Qué puede hacer el proveedor de ESTE Attempt, según lo que reporta el Core (no según su nombre). Se busca el proveedor
 * por su id exacto; si el Core no lo informa, se dice «sin información» y no se habilita nada. Solo lectura: no hay botones aquí.
 *
 * Un entorno bloqueado se explica como lo que es (algo que arreglar fuera de Lixbon) y se aclara que NO es un intento fallido.
 */
export function AttemptCapabilities({ providerId, session = null, active = true }) {
  const { snapshot, status, unsupported, probing } = useProviderCapabilities({ enabled: active && Boolean(providerId) });
  if (!providerId) return <p className="ade-missing">El intento no dice con qué proveedor corrió.</p>;
  if (unsupported) {
    return <p className="cap-note" role="status" data-testid="caps-unsupported">Este Core no informa de lo que ofrece cada proveedor: no se habilita ninguna acción.</p>;
  }
  if (!snapshot) {
    return status === 'error'
      ? <p className="cap-note cap-note--warn" role="status" data-testid="caps-error">No se pudo leer lo que ofrece {providerId}: no se habilita ninguna acción.</p>
      : <p className="cap-note" role="status" data-testid="caps-loading">Comprobando lo que ofrece {providerId}…</p>;
  }
  const provider = providerOf(snapshot, providerId);
  const env = describeEnvironment(provider);
  const caps = describeAll(provider, providerId);
  const resume = resumeAvailability(provider, session, providerId);
  return (
    <div className="cap-block" data-testid="attempt-capabilities" data-provider-known={provider ? 'true' : 'false'}>
      {!provider && (
        <p className="cap-note" role="status" data-testid="caps-provider-unknown">
          {probing ? 'El Core está comprobando los proveedores…' : `El Core no informa de «${providerId}»: no se sabe qué ofrece, y no se habilita ninguna acción.`}
        </p>
      )}
      {env.state === 'blocked' && (
        <div className="cap-note cap-note--info" role="status" data-testid="caps-env-blocked">
          <strong>{env.label}:</strong>{' '}
          {env.blocks.map((b) => b.text).join('; ')}. Es un problema del entorno, no un intento fallido: se arregla fuera de Lixbon y se vuelve a intentar.
        </div>
      )}
      <ul className="cap-list" aria-label={`Capacidades de ${providerId}`}>
        {/* «Reanudar sesión» no va aquí: lo dice la línea de abajo, que une lo que ofrece el proveedor con lo que es la sesión. */}
        {caps.filter((info) => info.capability !== 'resume').map((info) => (
          <li key={info.capability} className="cap-list__item" data-capability={info.capability}>
            <CapabilityBadge info={info} />
            {/* Con el entorno bloqueado, el aviso de arriba lo explica una sola vez: no se repite en cada capability. */}
            {!info.enabled && !(env.state === 'blocked' && info.state === 'environment_blocked') && <span className="cap-list__why">{info.reason}</span>}
          </li>
        ))}
      </ul>
      <p className="cap-resume" data-testid="caps-resume" data-kind={resume.kind}>
        <CapabilityBadge info={{ ...resume, capability: 'resume' }} />
        <span className="cap-list__why">{resume.reason}</span>
      </p>
    </div>
  );
}
