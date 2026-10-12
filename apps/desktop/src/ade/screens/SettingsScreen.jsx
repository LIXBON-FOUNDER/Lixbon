// SettingsScreen.jsx — conexión, matriz de capacidades del cliente actual, catálogo de kinds y controles de simulación.
// La matriz es la forma honesta de ver qué ofrece cada capa HOY: disponible, simulado o no disponible (con su slice).
import { useAde } from '../state/AdeProvider';
import { ScreenFrame } from './detail/ScreenFrame';
import { Section } from '../components/small';
import { INTENT_IDS, INTENTS } from '../client/intents';
import { ATTENTION_KINDS, ATTENTION_TITLES } from '../vocab/vocabulario';
import { routes } from '../navigation/routes';

const DISPONIBILIDAD = { available: 'Disponible', simulated: 'Simulada', unavailable: 'No disponible' };

function CapabilityMatrix() {
  const { capabilities, host, capabilitiesLoaded } = useAde();
  const hostCaps = host.getCapabilities();
  return (
    <div className="ade-tablewrap">
      <table className="ade-table" data-testid="capability-matrix">
        <caption className="ade-sr">Capacidades del cliente actual</caption>
        <thead><tr><th>Acción</th><th>Dueño</th><th>Estado</th><th>Slice</th><th>Hoy</th></tr></thead>
        <tbody>
          {INTENT_IDS.map((id) => {
            const def = INTENTS[id];
            const cap = (def.owner === 'host' ? hostCaps : capabilities)[id];
            const estado = cap?.availability ?? 'unavailable';
            return (
              <tr key={id} data-intent={id} data-availability={estado}>
                <td><b>{def.label}</b><div className="mono ade-muted">{id}</div></td>
                <td>{def.owner === 'host' ? 'Cliente (host)' : 'Core'}</td>
                <td><span className={`ade-avail ade-avail--${estado}`}>{capabilitiesLoaded || def.owner === 'host' ? DISPONIBILIDAD[estado] : 'Cargando…'}</span></td>
                <td>{def.slice ?? '—'}</td>
                <td>{def.hoy}{def.nota ? ` · ${def.nota}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SimControls() {
  const { client } = useAde();
  const sim = client.sim;
  if (!sim) return <p className="ade-muted">Este cliente no es un mock: no hay controles de simulación.</p>;
  return (
    <div className="ade-toolbar" data-testid="sim-controls">
      <label className="ade-field ade-field--inline">
        <span>Latencia</span>
        <select className="field" defaultValue={String(sim.latencyMs)} onChange={(e) => sim.setLatency(Number(e.target.value))}>
          <option value="0">0 ms</option><option value="400">400 ms</option><option value="1500">1,5 s</option>
        </select>
      </label>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => { sim.failAlways('listAttention'); sim.refresh(); }}>Provocar errores en Atención</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => sim.useEmptyData()}>Datos vacíos</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => { sim.clearFailures(); sim.reset(); }}>Restablecer datos</button>
    </div>
  );
}

export function SettingsScreen() {
  const { connection, capabilitiesError } = useAde();
  return (
    <ScreenFrame route={routes.settings()} entities={{}} title="Ajustes" subtitle="Conexión, capacidades y simulación.">
      <Section title="Conexión" id="s-conn">
        {capabilitiesError ? <p role="alert">No se pudo leer la conexión: {capabilitiesError.message}</p> : connection ? (
          <dl className="ade-facts">
            <dt>Cliente</dt><dd>{connection.label}</dd>
            <dt>Fuente de datos</dt><dd>{connection.source === 'mock' ? 'Simulada (mock en memoria)' : 'Core'}</dd>
            <dt>Modo del Core</dt><dd>{connection.coreMode === 'daemon' ? 'Daemon' : 'En proceso con el Desktop'}</dd>
            <dt>Alcances</dt><dd className="mono">{connection.scopes.join(', ') || '—'}</dd>
          </dl>
        ) : <p className="ade-muted">Conectando…</p>}
      </Section>
      <Section title="Capacidades" id="s-caps"><CapabilityMatrix /></Section>
      <Section title="Kinds de Attention" id="s-kinds">
        <ul className="ade-plainlist" data-testid="attention-kinds">
          {ATTENTION_KINDS.map((k) => (
            <li key={k.id}><b>{ATTENTION_TITLES[k.id]}</b> <span className="mono ade-muted">{k.id}</span> <span className={`ade-tag ${k.estado === 'reservado' ? 'ade-tag--warn' : ''}`}>{k.estado}</span></li>
          ))}
        </ul>
        <p className="ade-muted">La prioridad es la posición en el vocabulario: no hay severidad definida (decisión pendiente de G).</p>
      </Section>
      <Section title="Simulación" id="s-sim"><SimControls /></Section>
    </ScreenFrame>
  );
}
