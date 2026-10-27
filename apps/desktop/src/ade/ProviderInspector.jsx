import { Fragment, useId } from 'react';
import { CapabilityBadge } from './CapabilityBadge';
import { CAPABILITY_LABELS, STATE_GLYPHS, STATE_LABELS, STATE_TONES, describeAll, describeEnvironment } from './capabilityModel';
import { CAPABILITIES } from './providerCapabilitiesContract';
import { useProviderCapabilities } from './useProviderCapabilities';

/**
 * LXO-135 · Inspector de proveedores (solo lectura): una fila por proveedor que el Core conoce y una columna por capability.
 * Lo que se pinta es la matriz del Core tal cual. Un proveedor nuevo aparece solo con que el Core lo registre: aquí no hay
 * ninguna lista de nombres. Se actualiza solo (la lectura se repite) y, si el Core no responde, conserva la última foto y lo dice.
 */
export function ProviderInspector({ active = true }) {
  const uid = useId();
  const { snapshot, status, unsupported, probing, retry } = useProviderCapabilities({ enabled: active });
  const headingId = `${uid}-h`;
  let body;
  if (unsupported) {
    body = <p className="cap-note" role="status" data-testid="inspector-unsupported">Este Core no informa de lo que ofrece cada proveedor.</p>;
  } else if (!snapshot) {
    body = status === 'error'
      ? <p className="cap-note cap-note--warn" role="alert" data-testid="inspector-error">No se pudo leer lo que ofrece cada proveedor. <button type="button" className="lk" onClick={retry}>Reintentar</button></p>
      : <p className="cap-note" role="status" data-testid="inspector-loading">Comprobando los proveedores…</p>;
  } else if (snapshot.providers.length === 0) {
    body = <p className="cap-note" role="status" data-testid="inspector-empty">{probing ? 'El Core está comprobando los proveedores…' : 'El Core no tiene proveedores registrados.'}</p>;
  } else {
    body = (
      <>
        {status === 'stale' && <p className="cap-note cap-note--warn" role="status" data-testid="inspector-stale">El Core no respondió: se muestra la última información conocida.</p>}
        <div className="cap-table-wrap">
          <table className="cap-table" data-testid="provider-inspector-table">
            <caption className="cap-sr">Qué ofrece cada proveedor</caption>
            <thead>
              <tr>
                <th scope="col">Proveedor</th>
                {CAPABILITIES.map((c) => <th key={c} scope="col">{CAPABILITY_LABELS[c]}</th>)}
              </tr>
            </thead>
            <tbody>
              {snapshot.providers.map((provider) => {
                const env = describeEnvironment(provider);
                return (
                  <Fragment key={provider.id}>
                  <tr data-provider={provider.id} data-env={env.state}>
                    <th scope="row">
                      <span className="mono">{provider.id}</span>
                      <span className="cap-table__meta">
                        {provider.cli_version ? `v${provider.cli_version}` : 'versión desconocida'}
                        {provider.transport ? ` · ${provider.transport}` : ''}
                      </span>
                    </th>
                    {describeAll(provider).map((info) => (
                      <td key={info.capability} data-capability={info.capability} data-state={info.state}>
                        <CapabilityBadge info={info} showLabel={false} compact />
                      </td>
                    ))}
                  </tr>
                  {env.state === 'blocked' && (
                    <tr className="cap-table__envrow" data-env-of={provider.id}>
                      <td colSpan={CAPABILITIES.length + 1} data-testid={`env-${provider.id}`}>
                        <strong>{provider.id} · {env.label}:</strong> {env.blocks.map((b) => b.text).join('; ')}. No es un intento fallido.
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="cap-legend" aria-label="Leyenda de estados" data-testid="provider-inspector-legend">
          {['available', 'unsupported', 'unavailable', 'environment_blocked'].map((state) => (
            <li key={state} className={`cap-legend__item cap-legend__item--${STATE_TONES[state]}`}>
              <span aria-hidden="true">{STATE_GLYPHS[state]}</span> {STATE_LABELS[state]}
            </li>
          ))}
        </ul>
        <p className="cap-note">Un entorno bloqueado no es un intento fallido. Una capability «no ofrecida» no es un error: el proveedor no la tiene.</p>
      </>
    );
  }
  return (
    <section className="cap-inspector" aria-labelledby={headingId} data-testid="provider-inspector">
      <h3 className="cap-inspector__h" id={headingId}>Proveedores y capacidades</h3>
      {body}
    </section>
  );
}
