// AgentPanel.jsx — permisos del agente del chat: qué puede tocar sin preguntar.
import { useChatStore } from '../../../store/chatStore';

export function AgentPanel() {
  const {
    agentMode, setAgentMode,
    autoApprove, setAutoApprove,
    nativeTools, setNativeTools,
    autoRunCommands, setAutoRunCommands,
    commandAllowlist, setCommandAllowlist,
  } = useChatStore();

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Modo agente</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Activar el agente
            <span className="settings__row-hint">
              {agentMode
                ? ' · el modelo puede crear, editar y eliminar archivos del workspace'
                : ' · el chat solo conversa, sin tocar archivos'}
            </span>
          </span>
          <button
            className={`settings__toggle ${agentMode ? 'is-on' : ''}`}
            onClick={() => setAgentMode(!agentMode)}
            role="switch"
            aria-checked={agentMode}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Herramientas nativas
            <span className="settings__row-hint">
              {' · '}tool_calls del modelo (más fiable); el modelo debe declarar la capacidad <code>tools</code>
            </span>
          </span>
          <button
            className={`settings__toggle ${nativeTools ? 'is-on' : ''}`}
            onClick={() => setNativeTools(!nativeTools)}
            role="switch"
            aria-checked={nativeTools}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Permisos</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Aplicar cambios de archivos sin preguntar
            <span className="settings__row-hint">
              {autoApprove
                ? ' · el agente escribe directo (el diff queda en el chat)'
                : ' · cada cambio pide aprobación con vista previa del diff'}
            </span>
          </span>
          <button
            className={`settings__toggle ${autoApprove ? 'is-on' : ''}`}
            onClick={() => setAutoApprove(!autoApprove)}
            role="switch"
            aria-checked={autoApprove}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Ejecutar comandos sin preguntar
            <span className="settings__row-hint">
              {' · '}correr comandos es irreversible; por eso se pide aparte del auto-aplicado de archivos
            </span>
          </span>
          <button
            className={`settings__toggle ${autoRunCommands ? 'is-on' : ''}`}
            onClick={() => setAutoRunCommands(!autoRunCommands)}
            role="switch"
            aria-checked={autoRunCommands}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__field">
          <label className="settings__row-label">
            Comandos permitidos sin confirmación
            <span className="settings__row-hint">
              {' · '}un prefijo por línea (p. ej. «npm test»); los que llevan {'&&'}, |, ;, {'>'} siempre piden confirmación
            </span>
          </label>
          <textarea
            className="settings__textarea"
            rows={4}
            spellCheck={false}
            value={commandAllowlist.join('\n')}
            onChange={(e) => setCommandAllowlist(e.target.value.split('\n'))}
          />
        </div>
      </section>
    </>
  );
}
