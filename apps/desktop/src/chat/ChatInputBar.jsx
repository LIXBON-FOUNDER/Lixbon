// ChatInputBar.jsx — caja de entrada del chat (crema, redondeada, según diseño web)
// con menciones de archivo (@) y selector de modelo.
//
// El menú "/", el de @-menciones y el de opciones del agente se montan en un
// portal sobre <body> con posición fija: `.shell__center` tiene overflow:hidden
// (lo necesita el panel redondeado) y eso los recortaba — igual que Select.jsx.
import { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { listFiles } from '../lib/tauri';
import { runCommand } from '../lib/commands';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';
import { ModelPicker } from './ModelPicker';
import {
  IconSend, IconStop, IconX, IconFileCode, IconHammer, IconClip,
  IconPlus, IconTerminal, IconHistory, IconFolder, IconSun,
  IconGitCommit, IconChart, IconList, IconCheck, IconUser,
  IconPuzzle, IconGear,
} from '../components/Icons';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Comandos "/" del composer: acciones instantáneas, no texto para el modelo.
    Espejo de apps/cli/lixbon_cli/commands.py::COMMAND_SPECS — mismo nombre
    de comando para quien viene del CLI. Lo que allí es solo de terminal
    (doctor, ps, nodes, bar…) no tiene equivalente aquí y se omite. */
const SLASH_COMMANDS = [
  { cmd: 'new', desc: 'Nueva conversación', Icon: IconPlus, run: () => runCommand('chat.newConversation') },
  { cmd: 'clear', desc: 'Vaciar el contexto y empezar de cero', Icon: IconPlus, run: () => runCommand('chat.newConversation') },
  { cmd: 'mode', desc: 'Modo del agente (auto-aplicar, auto-run)', Icon: IconHammer, run: () => runCommand('chat.toggleAgentMenu') },
  { cmd: 'approve', desc: 'Auto-aprobar cambios del agente', Icon: IconCheck, run: () => runCommand('chat.toggleApprove') },
  { cmd: 'undo', desc: 'Revertir el último cambio', Icon: IconHistory, run: () => runCommand('chat.undoLast') },
  { cmd: 'diff', desc: 'Ver el último cambio', Icon: IconFolder, run: () => runCommand('chat.viewLastDiff') },
  { cmd: 'commit', desc: 'Confirmar cambios en Git', Icon: IconGitCommit, run: () => runCommand('git.open') },
  { cmd: 'model', desc: 'Cambiar de modelo', Icon: IconSun, run: () => runCommand('chat.focusModelPicker') },
  { cmd: 'usage', desc: 'Ver consumo de la cuenta', Icon: IconChart, run: () => runCommand('chat.openUsage') },
  { cmd: 'copy', desc: 'Copiar la última respuesta', Icon: IconClip, run: () => runCommand('chat.copyLast') },
  { cmd: 'save', desc: 'Guardar la conversación en Markdown', Icon: IconFileCode, run: () => runCommand('chat.saveMarkdown') },
  { cmd: 'history', desc: 'Ver conversaciones anteriores', Icon: IconHistory, run: () => runCommand('chat.showHistory') },
  { cmd: 'workspace', desc: 'Cambiar la carpeta de trabajo', Icon: IconFolder, run: () => runCommand('chat.openWorkspace') },
  { cmd: 'init', desc: 'Generar LIXBON.md con el contexto del proyecto', Icon: IconFileCode, run: () => runCommand('chat.init') },
  { cmd: 'tools', desc: 'Herramientas y permisos del agente', Icon: IconPuzzle, run: () => runCommand('settings.openAgent') },
  { cmd: 'allow', desc: 'Comandos que el agente ejecuta sin preguntar', Icon: IconPuzzle, run: () => runCommand('settings.openAgent') },
  { cmd: 'login', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'logout', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'key', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'config', desc: 'Ajustes', Icon: IconGear, run: () => runCommand('workbench.openSettings') },
  { cmd: 'remote', desc: 'Control remoto por QR', Icon: IconTerminal, run: () => runCommand('remote.open') },
  { cmd: 'help', desc: 'Ver todos los comandos', Icon: IconList, run: () => runCommand('workbench.commandPalette') },
];

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
  const [images, setImages] = useState([]); // { name, dataUrl, base64 }
  const [mentions, setMentions] = useState([]); // { name, path, rel }
  const [mentionQuery, setMentionQuery] = useState(null); // null = menú cerrado
  const [mentionSel, setMentionSel] = useState(0);
  const [allFiles, setAllFiles] = useState([]);
  const [slashSel, setSlashSel] = useState(0);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const barRef = useRef(null);
  const agentBtnRef = useRef(null);
  const agentPopRef = useRef(null);

  const {
    send, stop, streaming, agentMode, setAgentMode,
    autoApprove, setAutoApprove, autoRunCommands, setAutoRunCommands,
  } = useChatStore();
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const agentActive = agentMode && !!workspaceRoot;

  // La lista de @-menciones es del workspace ABIERTO: si se cambia de
  // carpeta, la caché vieja no vale — sin esto, mencionar mostraba archivos
  // del proyecto anterior hasta reiniciar la app.
  useEffect(() => { setAllFiles([]); }, [workspaceRoot]);

  // El botón de opciones también se abre desde el comando /mode.
  useEffect(() => {
    const onToggle = () => setAgentMenuOpen((v) => !v);
    window.addEventListener('lixbon:toggle-agent-menu', onToggle);
    return () => window.removeEventListener('lixbon:toggle-agent-menu', onToggle);
  }, []);

  const agentMenuPos = useAnchoredAbove(agentBtnRef, agentMenuOpen, { align: 'left' });

  useEffect(() => {
    if (!agentMenuOpen) return;
    const onDown = (e) => {
      if (agentBtnRef.current?.contains(e.target) || agentPopRef.current?.contains(e.target)) return;
      setAgentMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setAgentMenuOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [agentMenuOpen]);

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
    setSlashSel(0);
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

  // Menú "/": solo cuando TODO el mensaje es un token "/algo" sin espacios —
  // en cuanto se completa la frase (aparece un espacio) el menú se cierra solo.
  const slashMatches = useMemo(() => {
    const m = /^\/(\w*)$/.exec(text);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
  }, [text]);
  const slashOpen = slashMatches.length > 0;
  const menuOpen = mentionQuery !== null && mentionMatches.length > 0;
  const cmdmenuPos = useAnchoredAbove(barRef, slashOpen, { matchWidth: true });
  const mentionMenuPos = useAnchoredAbove(barRef, menuOpen, { matchWidth: true });

  const pickSlash = (entry) => {
    if (!entry) return;
    setText('');
    entry.run();
  };

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

  const handleSend = () => {
    if (streaming || (!text.trim() && !images.length)) return;
    // /remote con argumentos extra (el menú "/" solo cubre el token solo):
    // sigue abriendo el control remoto en vez de mandarlo al modelo.
    if (/^\/remote(\s|$)/i.test(text.trim())) {
      runCommand('remote.open');
      setText('');
      return;
    }
    send(text, null, images, mentions);
    setText('');
    setImages([]);
    setMentions([]);
  };

  const onKeyDown = (e) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((s) => Math.min(s + 1, slashMatches.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashMatches[slashSel] || slashMatches[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
    }
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
    <div className="chat-inputbar" ref={barRef}>
      {slashOpen && cmdmenuPos && createPortal(
        <div className="cmdmenu" style={cmdmenuPos}>
          {slashMatches.map((c, i) => (
            <div
              key={c.cmd}
              className={`cmdrow ${i === slashSel ? 'is-sel' : ''}`}
              onPointerEnter={() => setSlashSel(i)}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}
            >
              <span className="cmdrow__icon"><c.Icon size={13} /></span>
              <span className="cmdrow__name">/{c.cmd}</span>
              <span className="cmdrow__desc">{c.desc}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}

      {(images.length > 0 || mentions.length > 0) && (
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

      {menuOpen && mentionMenuPos && createPortal(
        <div className="mention-menu" style={mentionMenuPos}>
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
        </div>,
        document.body,
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
      />

      {/* Una sola fila, minimalista: adjuntar, opciones del agente (un botón
          que abre el resto), el texto (crece hasta 6 líneas), modelo y enviar. */}
      <div className="chat-inputbar__row">
        <button
          className="chat-inputbar__attach"
          onClick={() => fileInputRef.current?.click()}
          title="Adjuntar imagen (o pega con Ctrl+V)"
        >
          <IconClip size={15} />
        </button>

        <div className="agentmenu-wrap">
          <button
            ref={agentBtnRef}
            className={`chat-inputbar__opts ${agentActive ? 'is-on' : ''}`}
            disabled={!workspaceRoot}
            onClick={() => setAgentMenuOpen((v) => !v)}
            title={workspaceRoot ? 'Opciones del agente (/mode)' : 'Abre una carpeta de trabajo para usar el agente'}
          >
            <IconHammer size={14} />
          </button>

          {agentMenuOpen && agentMenuPos && createPortal(
            <div className="agentmenu" ref={agentPopRef} style={agentMenuPos}>
              <div className="agentmenu__row">
                <span>Agente</span>
                <button
                  className={`settings__toggle ${agentMode ? 'is-on' : ''}`}
                  onClick={() => setAgentMode(!agentMode)}
                >
                  <span className="settings__toggle-knob" />
                </button>
              </div>
              <p className="agentmenu__hint">
                {agentActive
                  ? 'Puede crear y editar archivos de tu carpeta de trabajo.'
                  : 'Actívalo para que el modelo edite archivos (con tu aprobación).'}
              </p>
              {agentActive && (
                <>
                  <div className="agentmenu__row">
                    <span>Auto-aplicar cambios</span>
                    <button
                      className={`settings__toggle ${autoApprove ? 'is-on' : ''}`}
                      onClick={() => setAutoApprove(!autoApprove)}
                    >
                      <span className="settings__toggle-knob" />
                    </button>
                  </div>
                  <div className="agentmenu__row">
                    <span>Comandos sin preguntar</span>
                    <button
                      className={`settings__toggle ${autoRunCommands ? 'is-on' : ''}`}
                      onClick={() => setAutoRunCommands(!autoRunCommands)}
                    >
                      <span className="settings__toggle-knob" />
                    </button>
                  </div>
                </>
              )}
            </div>,
            document.body,
          )}
        </div>

        <textarea
          ref={textareaRef}
          className="chat-inputbar__textarea"
          placeholder="Escríbele al agente…  (@ para mencionar un archivo)"
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={streaming}
        />

        <ModelPicker />

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
