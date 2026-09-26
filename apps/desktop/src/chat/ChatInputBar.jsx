// ChatInputBar.jsx — caja de entrada del chat (crema, redondeada, según diseño web)
// con menciones de archivo (@) y selector de modelo.
//
// El menú "/", el de @-menciones y el de opciones del agente se montan en un
// portal sobre <body> con posición fija: `.shell__center` tiene overflow:hidden
// (lo necesita el panel redondeado) y eso los recortaba — igual que Select.jsx.
import { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore, useSessionsStore, CHAT_MODES } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { listFiles } from '../lib/tauri';
import { runCommand } from '../lib/commands';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';
import { ModelPicker } from './ModelPicker';
import { Select } from '../components/Select';
import { CLAUDE_MODES, claudeModelOptions } from '../lib/claudeCode';
import { Switch } from '../components/Switch';
import { ClaudeMark } from '../components/Logo';
import { EffortSlider } from './EffortSlider';
import { ProgressRing } from '../components/Ring';
import {
  IconStop, IconX, IconFileCode, IconHammer, IconClip, IconChevronDown, IconAt, IconArrowUp,
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
  { cmd: 'mode', desc: 'Modo: Agente, Plan o Preguntar', Icon: IconHammer, run: () => runCommand('chat.toggleAgentMenu') },
  { cmd: 'agent', desc: 'Modo Agente: edita y ejecuta', Icon: IconHammer, run: () => runCommand('chat.mode.agent') },
  { cmd: 'plan', desc: 'Modo Plan: investiga y propone antes de tocar nada', Icon: IconList, run: () => runCommand('chat.mode.plan') },
  { cmd: 'ask', desc: 'Modo Preguntar: solo lectura', Icon: IconUser, run: () => runCommand('chat.mode.ask') },
  { cmd: 'approve', desc: 'Auto-aprobar cambios del agente', Icon: IconCheck, run: () => runCommand('chat.toggleApprove') },
  { cmd: 'undo', desc: 'Revertir el último cambio', Icon: IconHistory, run: () => runCommand('chat.undoLast') },
  { cmd: 'diff', desc: 'Ver el último cambio', Icon: IconFolder, run: () => runCommand('chat.viewLastDiff') },
  { cmd: 'commit', desc: 'Confirmar cambios en Git', Icon: IconGitCommit, run: () => runCommand('git.open') },
  { cmd: 'model', desc: 'Cambiar de modelo', Icon: IconSun, run: () => runCommand('chat.focusModelPicker') },
  { cmd: 'usage', desc: 'Ver consumo de la cuenta', Icon: IconChart, run: () => runCommand('chat.openUsage') },
  { cmd: 'copy', desc: 'Copiar la última respuesta', Icon: IconClip, run: () => runCommand('chat.copyLast') },
  { cmd: 'save', desc: 'Exportar la conversación a Markdown', Icon: IconFileCode, run: () => runCommand('chat.saveMarkdown') },
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

// En una sesión de Claude Code solo valen las acciones del IDE que tienen
// sentido para él (las que cambian lo que el IDE muestra: conversación nueva,
// modelo, modo); el resto de "/" son los comandos del propio Claude Code.
const CLAUDE_LOCAL = new Set(['new', 'clear', 'mode', 'plan', 'undo', 'diff', 'model', 'copy', 'save', 'history', 'workspace']);

function claudeSlashCommands(commands = []) {
  const local = SLASH_COMMANDS.filter((c) => CLAUDE_LOCAL.has(c.cmd));
  const taken = new Set(local.map((c) => c.cmd));
  const remote = commands
    .filter((c) => c?.name && !taken.has(c.name) && !c.name.startsWith('__'))
    .map((c) => ({ cmd: c.name, desc: c.description || 'Comando de Claude Code', hint: c.hint, Icon: IconTerminal, claude: true }));
  return [...local, ...remote];
}

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
    send, stop, streaming, chatMode, setChatMode, cycleChatMode,
    autoApprove, setAutoApprove, autoRunCommands, setAutoRunCommands,
  } = useChatStore();
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const contextWindow = useAppStore((s) => s.contextWindow);
  const messages = useChatStore((s) => s.messages);
  const engine = useChatStore((s) => s.engine);
  const ccContext = useChatStore((s) => s.ccContext);
  const ccModel = useChatStore((s) => s.ccModel);
  const setCcModel = useChatStore((s) => s.setCcModel);
  const ccCommands = useChatStore((s) => s.ccCommands);
  const ccModels = useChatStore((s) => s.ccModels);
  const ccMode = useChatStore((s) => s.ccMode);
  const setCcMode = useChatStore((s) => s.setCcMode);
  const ccEffort = useChatStore((s) => s.ccEffort);
  const setCcEffort = useChatStore((s) => s.setCcEffort);
  const activeKey = useSessionsStore((s) => s.activeKey);
  const isClaude = engine === 'claude';
  const agentActive = !!workspaceRoot;
  const modes = isClaude ? CLAUDE_MODES : CHAT_MODES;
  const currentMode = isClaude ? ccMode : chatMode;
  const mode = modes.find((m) => m.id === currentMode) || modes[0];
  const pickMode = isClaude ? setCcMode : setChatMode;
  const modelOptions = useMemo(() => claudeModelOptions(ccModels), [ccModels]);
  const effortLevels = useMemo(() => {
    const m = (ccModels || []).find((x) => (ccModel ? x.value === ccModel : x.value === 'default'));
    return m?.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
  }, [ccModels, ccModel]);

  // Claude Code arranca al abrir su sesión: así anuncia modelos y comandos
  // antes del primer mensaje y la primera respuesta no espera al arranque.
  useEffect(() => {
    if (isClaude && workspaceRoot) useChatStore.getState().warmup?.();
  }, [isClaude, workspaceRoot, activeKey]);

  // Estimación gruesa (≈4 caracteres por token): basta para avisar antes de
  // que el modelo empiece a recortar la conversación.
  const ctxWindow = isClaude ? ccContext.window : contextWindow;
  const contextPct = useMemo(() => {
    if (isClaude) return Math.min(100, Math.round((ccContext.used / ccContext.window) * 100));
    const chars = messages.reduce((n, m) => n + (m.content?.length || 0), 0) + text.length;
    return Math.min(100, Math.round((chars / 4 / contextWindow) * 100));
  }, [messages, text, contextWindow, isClaude, ccContext]);

  // Otros paneles (Diseño, búsqueda…) pueden dejar texto preparado aquí.
  useEffect(() => {
    const onCompose = (e) => {
      if (!barRef.current || barRef.current.offsetParent === null) return; // instancia oculta
      const add = e.detail?.text || '';
      setText((prev) => (prev ? `${prev}\n${add}` : add));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('lixbon:compose', onCompose);
    return () => window.removeEventListener('lixbon:compose', onCompose);
  }, []);

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

  // Autocrecer: se ve todo lo escrito hasta ~45% de la ventana, luego scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, Math.min(window.innerHeight * 0.45, 360)) + 'px';
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
    const m = /^\/([\w:-]*)$/.exec(text);
    if (!m) return [];
    const q = m[1].toLowerCase();
    const list = isClaude ? claudeSlashCommands(ccCommands) : SLASH_COMMANDS;
    return list.filter((c) => c.cmd.toLowerCase().startsWith(q)).slice(0, 60);
  }, [text, isClaude, ccCommands]);
  const slashOpen = slashMatches.length > 0;
  useEffect(() => {
    if (slashOpen) document.querySelector('.cmdmenu .cmdrow.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [slashSel, slashOpen]);
  const menuOpen = mentionQuery !== null && mentionMatches.length > 0;
  const cmdmenuPos = useAnchoredAbove(barRef, slashOpen, { matchWidth: true });
  const mentionMenuPos = useAnchoredAbove(barRef, menuOpen, { matchWidth: true });

  const pickSlash = (entry) => {
    if (!entry) return;
    if (entry.claude) {
      // Con argumentos se deja escrito para completarlo; sin ellos va directo.
      if (entry.hint) {
        setText(`/${entry.cmd} `);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      setText('');
      send(`/${entry.cmd}`, null, [], []);
      return;
    }
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

  const insertAt = () => {
    const next = text && !/\s$/.test(text) ? `${text} @` : `${text}@`;
    setText(next);
    detectMention(next, next.length);
    requestAnimationFrame(() => textareaRef.current?.focus());
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
    if (e.key === 'Tab' && e.shiftKey && workspaceRoot) {
      e.preventDefault();
      cycleChatMode();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={`chat-inputbar ${isClaude ? 'chat-inputbar--claude' : ''}`} ref={barRef}>
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
              <span className="cmdrow__name">/{c.cmd}{c.hint ? <span className="cmdrow__hint"> {c.hint}</span> : null}</span>
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

      <textarea
        ref={textareaRef}
        className="chat-inputbar__textarea"
        placeholder={isClaude ? (agentActive ? 'Pídele algo a Claude Code, @ para mencionar un archivo' : 'Abre una carpeta de trabajo para usar Claude Code')
          : !agentActive ? 'Pregunta lo que quieras, / para comandos'
          : chatMode === 'plan' ? 'Describe qué quieres hacer y el agente propondrá un plan'
            : chatMode === 'ask' ? 'Pregunta sobre el código, @ para mencionar un archivo'
              : 'Pide algo, @ para mencionar un archivo, / para comandos'}
        rows={1}
        value={text}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={streaming}
      />

      <div className="chat-inputbar__row">
        {isClaude && (
          <span className="chat-inputbar__engine" title="Estás hablando con Claude Code">
            <ClaudeMark size={12} />Claude Code
          </span>
        )}
        <div className="agentmenu-wrap">
          <button
            ref={agentBtnRef}
            className={`chat-inputbar__mode ${agentActive ? `is-on mode--${mode.tone || mode.id}` : ''}`}
            onClick={() => setAgentMenuOpen((v) => !v)}
            title={workspaceRoot ? 'Modo del chat (Shift+Tab para alternar)' : 'Abre una carpeta de trabajo para usar el agente'}
          >
            {agentActive && <span className="modedot" />}
            {agentActive ? mode.label : 'Chat'}
            <IconChevronDown size={12} className={`chev ${agentMenuOpen ? 'is-flipped' : ''}`} />
          </button>

          {agentMenuOpen && agentMenuPos && createPortal(
            <div className="agentmenu" ref={agentPopRef} style={agentMenuPos}>
              {workspaceRoot ? (
                <>
                  <div className="agentmenu__title">
                    <span>Modo</span>
                    <span className="agentmenu__kbd"><kbd>Shift</kbd><kbd>Tab</kbd></span>
                  </div>
                  {modes.map((m) => (
                    <button
                      key={m.id}
                      className={`modeopt mode--${m.tone || m.id} ${m.id === currentMode ? 'is-active' : ''}`}
                      onClick={() => { pickMode(m.id); setAgentMenuOpen(false); textareaRef.current?.focus(); }}
                    >
                      <span className="modedot" />
                      <span className="modeopt__text">
                        <span className="modeopt__label">{m.label}</span>
                        <span className="modeopt__desc">{m.desc}</span>
                      </span>
                      {m.id === currentMode && <IconCheck size={13} />}
                    </button>
                  ))}
                  {!isClaude && chatMode === 'agent' && (
                    <div className="agentmenu__opts">
                      <div className="agentmenu__row">
                        <span>Aplicar cambios sin preguntar</span>
                        <Switch checked={autoApprove} onChange={setAutoApprove} label="Aplicar cambios sin preguntar" />
                      </div>
                      <div className="agentmenu__row">
                        <span>Ejecutar comandos sin preguntar</span>
                        <Switch checked={autoRunCommands} onChange={setAutoRunCommands} label="Ejecutar comandos sin preguntar" />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="agentmenu__hint">Abre una carpeta de trabajo para usar los modos Agente, Plan y Preguntar.</p>
              )}
            </div>,
            document.body,
          )}
        </div>

        {isClaude
          ? <Select up className="modelpicker modelpicker--claude" value={ccModel} onChange={setCcModel} options={modelOptions} title="Modelo de Claude Code" />
          : <ModelPicker />}
        {isClaude && effortLevels.length > 0 && (
          <EffortSlider levels={effortLevels} value={ccEffort} onChange={setCcEffort} />
        )}

        <div className="chat-inputbar__fill" />

        <button className="ic" onClick={() => fileInputRef.current?.click()} title="Adjuntar imagen (o pega con Ctrl+V)">
          <IconClip size={15} />
        </button>
        {workspaceRoot && (
          <button className="ic" onClick={insertAt} title="Mencionar un archivo (@)">
            <IconAt size={15} />
          </button>
        )}

        <span className="tipw chat-inputbar__ctx">
          <ProgressRing value={contextPct} size={20} />
          <span className="tip mono">Contexto {contextPct}% · {ctxWindow.toLocaleString('es')} tokens</span>
        </span>

        {streaming ? (
          <button className="chat-inputbar__send" onClick={stop} title="Detener">
            <IconStop size={14} />
          </button>
        ) : (
          <button
            className="chat-inputbar__send"
            onClick={handleSend}
            disabled={!text.trim() && !images.length}
            title="Enviar (Enter)"
          >
            <IconArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
