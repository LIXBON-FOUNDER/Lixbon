// ChatInputBar.jsx — caja de entrada del chat (crema, redondeada, según diseño web)
// con chip de contexto del editor y selector de modelo.
import { useRef, useState, useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import { languageLabel } from '../editor/languages';
import { ModelPicker } from './ModelPicker';
import { IconSend, IconStop, IconX, IconFileCode, IconHammer, IconClip } from '../components/Icons';

const MAX_CONTEXT_CHARS = 24000; // evita reventar la ventana del modelo
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Blob/File → base64 (sin el prefijo data:) + dataUrl para la miniatura. */
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('No es una imagen'));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error('La imagen supera los 8 MB'));
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(',')[1] || '';
      resolve({ name: file.name || 'imagen.png', dataUrl, base64 });
    };
    reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
    reader.readAsDataURL(file);
  });
}

export function ChatInputBar() {
  const [text, setText] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [images, setImages] = useState([]); // { name, dataUrl, base64 }
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const { send, stop, streaming, agentMode, setAgentMode } = useChatStore();
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.path === s.activePath));
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const agentActive = agentMode && !!workspaceRoot;

  const addFiles = async (files) => {
    for (const f of files) {
      try {
        const img = await readImage(f);
        setImages((prev) => [...prev, img]);
      } catch { /* ignora no-imágenes / demasiado grandes */ }
    }
  };

  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.type.startsWith('image/'));
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs.map((it) => it.getAsFile()).filter(Boolean));
    }
  };

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
    if (streaming || (!text.trim() && !images.length)) return;
    send(text, buildContext(), images);
    setText('');
    setImages([]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-inputbar">
      {(activeTab || images.length > 0) && (
        <div className="chat-inputbar__chips">
          {activeTab && (includeContext ? (
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
          ))}
          {images.map((img, i) => (
            <span key={i} className="img-chip" title={img.name}>
              <img src={img.dataUrl} alt={img.name} />
              <button onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))} title="Quitar imagen">
                <IconX size={11} />
              </button>
            </span>
          ))}
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
        onPaste={onPaste}
        disabled={streaming}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
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
          <button
            className="chat-inputbar__attach"
            onClick={() => fileInputRef.current?.click()}
            title="Adjuntar imagen (o pega con Ctrl+V)"
          >
            <IconClip size={15} />
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
            disabled={!text.trim() && !images.length}
            title="Enviar (Enter)"
          >
            <IconSend size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
