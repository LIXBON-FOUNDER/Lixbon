// NewAgentItems.jsx — proveedores en "+ Nuevo" del modo Agente.
import { ClaudeMark } from '../../components/Logo';
import { newAgentEntries, canOpenChat } from './newAgentEntries';

/**
 * `onPick(id)` solo para motores con chat (nunca Codex). `onOpenTerminal(id)` para Codex,
 * que abre el panel previo a su pestaña de terminal. Los deshabilitados no disparan nada.
 */
export function NewAgentItems({ providers, onPick, onOpenTerminal }) {
  return newAgentEntries(providers).map((e) => (
    <button key={e.id} type="button" className={`menu__item ${e.disabled ? 'is-disabled' : ''}`} disabled={e.disabled} aria-disabled={e.disabled}
      title={e.reason || undefined} data-testid={`newagent-${e.id}`}
      onClick={() => {
        if (e.disabled) return;
        if (e.kind === 'terminal') onOpenTerminal?.(e.id);
        else if (canOpenChat(e.id)) onPick(e.id);
      }}>
      {e.id === 'claude' ? <ClaudeMark size={14} /> : <span style={{ width: 14, display: 'inline-block' }} aria-hidden />}
      <span className="menu__main">{e.label}{e.kind === 'terminal' && !e.disabled && <span className="newagent__reason"> — terminal</span>}{e.reason && <span className="newagent__reason"> — {e.reason}</span>}</span>
    </button>
  ));
}
