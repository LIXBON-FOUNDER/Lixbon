// AgentLabel.jsx — quién ejecuta: proveedor, modelo, esfuerzo y rol.
// Envuelve AgentChip (orch/agent), que se importa en MODO LECTURA para mantener el mismo aspecto que los
// chats, las pestañas de Codex y las tareas hijas. AgentChip trae AGENT_LABELS de orchStore.js (archivo
// caliente del slice G): si ese mapa cambia de sitio, solo se toca este archivo.
import { AgentChip } from '../../orch/agent/AgentChip';
import { roleName } from '../../orch/agent/agentIdentity';

/** @param {{agent: {provider: string, model?: string|null, effort?: string|null, role?: string|null}, showRole?: boolean}} props */
export function AgentLabel({ agent, showRole = true, size = 12 }) {
  if (!agent) return null;
  const rol = showRole ? roleName(agent.role) : null;
  return (
    <span className="ade-agent" data-provider={agent.provider}>
      <AgentChip provider={agent.provider} model={agent.model || undefined} effort={agent.effort || undefined} size={size} />
      {rol && <span className="ade-agent__role">{rol}</span>}
    </span>
  );
}
