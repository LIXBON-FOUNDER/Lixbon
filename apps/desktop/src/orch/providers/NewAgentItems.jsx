// NewAgentItems.jsx — proveedores en "+ Nuevo" del modo Agente.
import { ClaudeMark } from '../../components/Logo';
import { newAgentEntries, canOpenChat } from './newAgentEntries';

/** `onPick(id)` solo se llama para motores con chat; los deshabilitados nunca lo disparan. */
export function NewAgentItems({ providers, onPick }) {
  return newAgentEntries(providers).map((e) => (
    <button key={e.id} type="button" className={`menu__item ${e.disabled ? 'is-disabled' : ''}`} disabled={e.disabled} aria-disabled={e.disabled}
      title={e.reason || undefined} data-testid={`newagent-${e.id}`}
      onClick={() => { if (!e.disabled && canOpenChat(e.id)) onPick(e.id); }}>
      {e.id === 'claude' ? <ClaudeMark size={14} /> : <span style={{ width: 14, display: 'inline-block' }} aria-hidden />}
      <span className="menu__main">{e.label}{e.reason && <span className="newagent__reason"> — {e.reason}</span>}</span>
    </button>
  ));
}
