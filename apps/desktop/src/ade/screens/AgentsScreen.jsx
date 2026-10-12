// AgentsScreen.jsx — proveedores, modelos y esfuerzos disponibles, y cuántos intentos vivos tiene cada uno.
// Configurar roles y políticas sigue en Ajustes → Orquestador del IDE (vigente); aquí solo se ve.
import { useAdeQuery } from '../state/useAdeQuery';
import { ScreenFrame } from './detail/ScreenFrame';
import { EmptyState, QueryBoundary } from '../components/states';
import { ProviderMark } from '../../orch/agent/ProviderMark';
import { activeAttemptsByProvider } from '../domain-view/projects';
import { routes } from '../navigation/routes';
import { POLICY_STATUS_LABELS } from '../vocab/vocabulario';

export function AgentsScreen() {
  const q = useAdeQuery(async (c) => {
    const [agents, attempts] = await Promise.all([c.listAgents(), c.listAttempts()]);
    return { agents, vivos: activeAttemptsByProvider(attempts) };
  }, []);
  return (
    <ScreenFrame route={routes.agents()} entities={{}} title="Agentes y proveedores" subtitle="Quién puede ejecutar trabajo y con qué modelos.">
      <QueryBoundary query={q} isEmpty={(d) => d.agents.length === 0} empty={<EmptyState title="Sin proveedores configurados">Configura un proveedor en Ajustes → Orquestador.</EmptyState>}>
        {({ agents, vivos }) => (
          <div className="ade-agentgrid">
            {agents.map((g) => (
              <article key={g.id} className={`ade-agentcard ${g.available ? '' : 'is-off'}`} data-testid={`agent-${g.id}`}>
                <header className="ade-agentcard__head">
                  <ProviderMark provider={g.id} size={18} />
                  <h3>{g.label}</h3>
                  <span className={`ade-tag ${g.available ? '' : 'ade-tag--warn'}`}>{g.available ? 'Disponible' : 'No disponible'}</span>
                </header>
                <dl className="ade-facts">
                  <dt>Política</dt><dd>{POLICY_STATUS_LABELS[g.policyStatus] || g.policyStatus}</dd>
                  <dt>Intentos vivos</dt><dd>{vivos[g.id] || 0}</dd>
                  <dt>Modelos</dt><dd>{g.models.length ? g.models.map((m) => m.label).join(', ') : '—'}</dd>
                  <dt>Esfuerzos</dt><dd>{g.efforts.length ? g.efforts.join(', ') : '—'}</dd>
                  <dt>Roles</dt><dd>{g.roles.length ? g.roles.join(', ') : '—'}</dd>
                </dl>
              </article>
            ))}
          </div>
        )}
      </QueryBoundary>
    </ScreenFrame>
  );
}
