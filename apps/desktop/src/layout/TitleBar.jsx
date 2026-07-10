// TitleBar.jsx — barra de ventana propia (decorations: false).
// Izquierda: logo + menús (Archivo/Editar/Ver/Terminal). Centro: arrastre.
// Derecha: toggle del chat + controles de ventana (min/max/cerrar).
// En modo `minimal` (carga y login) solo logo, título y controles.
import { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';

import { useAppStore } from '../store/appStore';
import { useEditorStore, getLiveView } from '../store/editorStore';
import { useTerminalStore } from '../store/terminalStore';
import { pickDirectory } from '../lib/tauri';
import {
  IconWinMin, IconWinMax, IconWinRestore, IconX, IconPanelRight, IconCheck,
} from '../components/Icons';

/** Ejecuta un comando de CodeMirror sobre la vista viva (si hay editor). */
function withView(fn) {
  const view = getLiveView();
  if (!view) return;
  fn(view);
  view.focus();
}

export function TitleBar({ minimal = false }) {
  const {
    panels, togglePanel, centerView, setCenterView,
    autoSave, setAutoSave, openWorkspace,
    leftView, openLeftPanel, setQuickOpen,
  } = useAppStore();
  const hasActiveTab = useEditorStore((s) => !!s.activePath);

  const [openMenu, setOpenMenu] = useState(null); // etiqueta del menú abierto
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef(null);

  const win = getCurrentWindow();

  // Estado maximizado (para alternar el icono max/restore)
  useEffect(() => {
    let unlisten = null;
    let alive = true;
    win.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { alive = false; if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cerrar menús con clic fuera o Escape
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) setOpenMenu(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const handleOpenFolder = async () => {
    const selected = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
    if (selected) {
      await openWorkspace(selected);
      if (!useAppStore.getState().panels.explorer) togglePanel('explorer');
      setCenterView('editor');
    }
  };

  const newTerminal = (shell) => {
    if (!useAppStore.getState().panels.terminal) togglePanel('terminal');
    useTerminalStore.getState().addSession(shell);
  };

  const editorStore = () => useEditorStore.getState();

  const menus = [
    {
      label: 'Archivo',
      items: [
        { label: 'Abrir carpeta…', shortcut: '', run: handleOpenFolder },
        { sep: true },
        { label: 'Guardar', shortcut: 'Ctrl+S', disabled: !hasActiveTab, run: () => editorStore().saveActive() },
        { label: 'Guardar todo', shortcut: 'Ctrl+Mayús+S', run: () => editorStore().saveAll() },
        { label: 'Autoguardado', check: autoSave, run: () => setAutoSave(!autoSave) },
        { sep: true },
        { label: 'Cerrar pestaña', shortcut: 'Ctrl+W', disabled: !hasActiveTab, run: () => {
            const s = editorStore();
            if (s.activePath) s.closeTab(s.activePath);
          } },
        { sep: true },
        { label: 'Salir', run: () => win.close() },
      ],
    },
    {
      label: 'Editar',
      items: [
        { label: 'Deshacer', shortcut: 'Ctrl+Z', disabled: !hasActiveTab, run: () => withView(undo) },
        { label: 'Rehacer', shortcut: 'Ctrl+Y', disabled: !hasActiveTab, run: () => withView(redo) },
        { sep: true },
        { label: 'Buscar…', shortcut: 'Ctrl+F', disabled: !hasActiveTab, run: () => withView(openSearchPanel) },
        { label: 'Seleccionar todo', shortcut: 'Ctrl+A', disabled: !hasActiveTab, run: () => withView(selectAll) },
      ],
    },
    {
      label: 'Ver',
      items: [
        { label: 'Ir a archivo…', shortcut: 'Ctrl+P', run: () => setQuickOpen(true) },
        { label: 'Buscar en archivos', shortcut: 'Ctrl+Mayús+F', run: () => openLeftPanel('search') },
        { sep: true },
        { label: 'Explorador', check: panels.explorer && leftView === 'explorer', run: () => openLeftPanel('explorer') },
        { label: 'Control de código', check: panels.explorer && leftView === 'git', run: () => openLeftPanel('git') },
        { label: 'Extensiones', check: panels.explorer && leftView === 'extensions', run: () => openLeftPanel('extensions') },
        { label: 'Chat', check: panels.chat, run: () => togglePanel('chat') },
        { label: 'Terminal', shortcut: 'Ctrl+`', check: panels.terminal, run: () => togglePanel('terminal') },
        { sep: true },
        { label: 'Editor', check: centerView === 'editor', run: () => setCenterView('editor') },
        { label: 'Métricas', check: centerView === 'metrics', run: () => setCenterView('metrics') },
        { label: 'Ajustes', check: centerView === 'settings', run: () => setCenterView('settings') },
      ],
    },
    {
      label: 'Terminal',
      items: [
        { label: 'Nuevo terminal (PowerShell)', run: () => newTerminal('powershell') },
        { label: 'Nuevo terminal (cmd)', run: () => newTerminal('cmd') },
        { label: 'Nuevo terminal (bash)', run: () => newTerminal('bash') },
        { sep: true },
        { label: panels.terminal ? 'Ocultar panel' : 'Mostrar panel', shortcut: 'Ctrl+`', run: () => togglePanel('terminal') },
      ],
    },
  ];

  return (
    <header className="titlebar" ref={barRef}>
      <div className="titlebar__left">
        <img src="/favicon.svg" className="titlebar__logo" alt="" draggable={false} />
        {!minimal && (
          <nav className="menubar">
            {menus.map((menu) => (
              <div key={menu.label} className="menubar__entry">
                <button
                  className={`menubar__btn ${openMenu === menu.label ? 'is-open' : ''}`}
                  onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
                  onMouseEnter={() => { if (openMenu) setOpenMenu(menu.label); }}
                >
                  {menu.label}
                </button>
                {openMenu === menu.label && (
                  <div className="menubar__dropdown">
                    {menu.items.map((item, i) =>
                      item.sep ? (
                        <div key={i} className="ctx-menu__sep" />
                      ) : (
                        <button
                          key={i}
                          className="ctx-menu__item menubar__item"
                          disabled={item.disabled}
                          onClick={() => { setOpenMenu(null); item.run(); }}
                        >
                          <span className="menubar__item-check">
                            {item.check && <IconCheck size={13} />}
                          </span>
                          <span className="menubar__item-label">{item.label}</span>
                          {item.shortcut && (
                            <span className="menubar__item-shortcut">{item.shortcut}</span>
                          )}
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </nav>
        )}
      </div>

      <div className="titlebar__drag" data-tauri-drag-region>
        <span className="titlebar__title" data-tauri-drag-region>LIXBON</span>
      </div>

      <div className="titlebar__right">
        {!minimal && (
          <button
            className={`titlebar__chat ${panels.chat ? 'is-active' : ''}`}
            onClick={() => togglePanel('chat')}
            title={panels.chat ? 'Ocultar chat' : 'Mostrar chat'}
          >
            <IconPanelRight size={17} />
          </button>
        )}
        <div className="titlebar__controls">
          <button className="titlebar__win-btn" onClick={() => win.minimize()} title="Minimizar">
            <IconWinMin size={16} />
          </button>
          <button
            className="titlebar__win-btn"
            onClick={() => win.toggleMaximize()}
            title={maximized ? 'Restaurar' : 'Maximizar'}
          >
            {maximized ? <IconWinRestore size={15} /> : <IconWinMax size={14} />}
          </button>
          <button
            className="titlebar__win-btn titlebar__win-btn--close"
            onClick={() => win.close()}
            title="Cerrar"
          >
            <IconX size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
