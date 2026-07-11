// ChatInputBar.jsx — caja de entrada del chat (crema, redondeada, según diseño web)
// con chip de contexto del editor y selector de modelo.
import { useRef, useState, useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import { languageLabel } from '../editor/languages';
import { ModelPicker } from './ModelPicker';
import { IconSend, IconStop, IconX, IconFileCode, IconHammer } from '../components/Icons';

const MAX_CONTEXT_CHARS = 24000; // evita reventar la ventana del modelo

export function ChatInputBar() {
  const [text, setText] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const textareaRef = useRef(null);

  const { send, stop, streaming, agentMode, setAgentMode } = useChatStore();
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.path === s.activePath));
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const agentActive = agentMode && !!workspaceRoot;

  // Autocrecer el textarea hasta 6 líneas
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }, [text]);

  const buildContext = () => {
    if (!includeContext || !activeTab) return null;
    const ctx = useEditorStore.getState().getActiveContext();
    if (!ctx) return null;
    const isSelection = !!ctx.selection;
    let code = isSelection ? ctx.selection : ctx.content;
    if (!code.trim()) return null;
    if (code.length > MAX_CONTEXT_CHARS) {
      code = code.slice(0, MAX_CONTEXT_CHARS) + '\n… (recortado)';
    }
    return { name: ctx.name, path: ctx.path, code, language: languageLabel(ctx.name), isSelection };
  };

  const handleSend = () => {
    if (streaming || !text.trim()) return;
    send(text, buildContext());
    setText('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-inputbar">
      {activeTab && (
        <div className="chat-inputbar__chips">
          {includeContext ? (
            <span className="ctx-chip" title={`Se adjunta ${activeTab.name} como contexto`}>
              <IconFileCode size={13} />
              {activeTab.name}
              <button onClick={() => setIncludeContext(false)} title="No adjuntar contexto">
                <IconX size={12} />
              </button>
            </span>
          ) : (
            <button className="ctx-chip ctx-chip--off" onClick={() => setIncludeContext(true)}>
              <IconFileCode size={13} />
              Adjuntar {activeTab.name}
            </button>
          )}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="chat-inputbar__textarea"
        placeholder={agentActive ? 'Pide un cambio en tu código…' : 'Pregunta sobre tu código…'}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={streaming}
      />

      <div className="chat-inputbar__row">
        <div className="chat-inputbar__left">
          <button
            className={`agent-toggle ${agentActive ? 'is-on' : ''}`}
            disabled={!workspaceRoot}
            onClick={() => setAgentMode(!agentMode)}
            title={
              workspaceRoot
                ? agentActive
                  ? 'Agente activo: el modelo puede crear y editar archivos (con tu aprobación). Clic para desactivar.'
                  : 'Activar el agente: el modelo podrá crear y editar archivos del workspace.'
                : 'Abre una carpeta de trabajo para usar el agente'
            }
          >
            <IconHammer size={12} />
            Agente
          </button>
          <ModelPicker />
        </div>
        {streaming ? (
          <button className="chat-inputbar__send" onClick={stop} title="Detener">
            <IconStop size={15} />
          </button>
        ) : (
          <button
            className="chat-inputbar__send"
            onClick={handleSend}
            disabled={!text.trim()}
            title="Enviar (Enter)"
          >
            <IconSend size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
