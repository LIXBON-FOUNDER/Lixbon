import { ProviderMark } from './ProviderMark';
import { providerName, modelDetail } from './agentIdentity';
import './agent.css';

/** Quién es el agente: proveedor, modelo y esfuerzo. Mismo aspecto en chats, pestañas de Codex y tareas hijas. */
export function AgentChip({ provider, model, effort, size = 12, name = null, testId }) {
  const detail = modelDetail({ model, effort });
  return (
    <span className="agentchip" title={[providerName(provider), detail].filter(Boolean).join(' · ')} data-testid={testId}>
      <ProviderMark provider={provider} size={size} />
      <span className="agentchip__name">{name ?? providerName(provider)}</span>
      {detail && <span className="agentchip__detail mono">{detail}</span>}
    </span>
  );
}
