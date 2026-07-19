// ChatInputBar.jsx — caja de entrada del chat (crema, redondeada, según diseño web)
// con chip de contexto del editor y selector de modelo.
import { useRef, useState, useEffect, useMemo } from 'react';
import { useChatStore } from '../store/chatStore';
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import { languageLabel } from '../editor/languages';
import { listFiles } from '../lib/tauri';
import { ModelPicker } from './ModelPicker';
import { IconSend, IconStop, IconX, IconFileCode, IconHammer, IconClip } from '../components/Icons';

const MAX_CONTEXT_CHARS = 24000; // evita reventar la ventana del modelo
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Fuzzy match por subsecuencia (igual que QuickOpen). -1 = no coincide. */
function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 3 : 1;
    score += streak - Math.min(idx - ti, 20) * 0.05;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}

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
  const [mentions, setMentions] = useState([]); // { name, path, rel }
  const [mentionQuery, setMentionQuery] = useState(null); // null = menú cerrado
  const [mentionSel, setMentionSel] = useState(0);
  const [allFiles, setAllFiles] = useState([]);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const {
    send, stop, streaming, agentMode, setAgentMode,
    autoApprove, setAutoApprove, autoRunCommands, setAutoRunCommands,
  } = useChatStore();
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

  // ── @-menciones: detecta "@token" ANTES del cursor y abre el menú ────────
  const detectMention = (value, caret) => {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) { setMentionQuery(null); return; }
    setMentionQuery(m[1]);
    setMentionSel(0);
    if (!allFiles.length && workspaceRoot) {
      listFiles().then(setAllFiles).catch(() => {});
    }
  };

  const onChange = (e) => {
    setText(e.target.value);
    detectMention(e.target.value, e.target.selectionStart);
  };

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const pool = allFiles.filter((f) => !mentions.some((mn) => mn.path === f.path));
    if (!q) return pool.slice(0, 8);
    return pool
      .map((f) => ({ f, s: fuzzyScore(f.rel, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.f);
  }, [allFiles, mentions, mentionQuery]);

  const pickMention = (file) => {
    // Quita el "@token" que disparó el menú del texto.
    const el = textareaRef.current;
    const caret = el ? el.selectionStart : text.length;
    const before = text.slice(0, caret).replace(/(^|\s)@([^\s@]*)$/, '$1');
    const after = text.slice(caret);
    setText(before + after);
    setMentions((prev) => prev.some((m) => m.path === file.path)
      ? prev : [...prev, { name: file.name, path: file.path, rel: file.rel }]);
    setMentionQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

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
    send(text, buildContext(), images, mentions);
    setText('');
    setImages([]);
    setMentions([]);
  };

  const menuOpen = mentionQuery !== null && mentionMatches.length > 0;

  const onKeyDown = (e) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSel((s) => Math.min(s + 1, mentionMatches.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSel((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionMatches[mentionSel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-inputbar">
      {(activeTab || images.length > 0 || mentions.length > 0) && (
        <div className="chat-inputbar__chips">
          {mentions.map((m) => (
            <span key={m.path} className="ctx-chip" title={m.rel}>
              <IconFileCode size={13} />
              @{m.name}
              <button
                onClick={() => setMentions((prev) => prev.filter((x) => x.path !== m.path))}
                title="Quitar mención"
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
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

      {menuOpen && (
        <div className="mention-menu">
          {mentionMatches.map((f, i) => (
            <div
              key={f.path}
              className={`mention-menu__item ${i === mentionSel ? 'is-selected' : ''}`}
              onPointerEnter={() => setMentionSel(i)}
              onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}
            >
              <IconFileCode size={13} />
              <span className="mention-menu__name">{f.name}</span>
              <span className="mention-menu__rel">{f.rel}</span>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="chat-inputbar__textarea"
        placeholder={agentActive ? 'Pide un cambio en tu código…  (@ para mencionar un archivo)' : 'Pregunta sobre tu código…  (@ para mencionar un archivo)'}
        rows={1}
        value={text}
        onChange={onChange}
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
          {agentActive && (
            <>
              <button
                className={`agent-toggle ${autoApprove ? 'is-on' : ''}`}
                onClick={() => setAutoApprove(!autoApprove)}
                title={autoApprove
                  ? 'Auto-aplicar ACTIVO: el agente escribe archivos sin pedir aprobación (los cambios se pueden revertir). Clic para exigir aprobación por cambio.'
                  : 'Auto-aplicar inactivo: cada cambio de archivo pide tu aprobación. Clic para dejar que el agente aplique directo.'}
              >
                Auto
              </button>
              <button
                className={`agent-toggle ${autoRunCommands ? 'is-on' : ''}`}
                onClick={() => setAutoRunCommands(!autoRunCommands)}
                title={autoRunCommands
                  ? 'Auto-run ACTIVO: el agente ejecuta comandos sin preguntar (los peligrosos siguen pidiendo aprobación). Clic para confirmar cada comando.'
                  : 'Auto-run inactivo: los comandos piden confirmación salvo los de la allowlist (tests, builds). Clic para ejecutar sin preguntar.'}
              >
                Run
              </button>
            </>
          )}
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
