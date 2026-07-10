// AppShell.jsx — cascarón del IDE: activity bar + explorador + editor + chat + status bar.
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useVersion } from '../hooks/useVersion';

import { ActivityBar } from './ActivityBar';
import { SidePanel } from './SidePanel';
import { StatusBar } from './StatusBar';
import { UpdateModal } from '../components/UpdateModal';

import { FileTree } from '../sections/Workspace/FileTree';
import { EditorTabs } from '../editor/EditorTabs';
import { RunControls } from '../editor/RunControls';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { TerminalPanel } from '../editor/TerminalPanel';
import { ChatPanel } from '../chat/ChatPanel';
import { Metrics } from '../sections/Metrics/Metrics';
import { Settings } from '../sections/Settings/Settings';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { IconX } from '../components/Icons';

const TERM_MIN_H = 120;
const TERM_MAX_H = 640;

export function AppShell() {
  const {
    panels, panelWidths, setPanelWidth,
    panelHeights, setPanelHeight, togglePanel,
    centerView, editorFontSize, serverUrl,
  } = useAppStore();
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate } = useVersion();

  const hasTabs = useEditorStore((s) => s.tabs.length > 0);
  const termFrame = useRef(null);

  // Reabrir la última carpeta de trabajo (el sandbox Rust no persiste)
  useEffect(() => {
    useAppStore.getState().restoreWorkspace();
  }, []);

  // Tamaño de letra del editor (ajustable en Ajustes)
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${editorFontSize}px`);
  }, [editorFontSize]);

  // Atajos globales del IDE (CodeMirror maneja Ctrl+S dentro del editor;
  // aquí cubrimos Ctrl+W y Ctrl+Tab, y Ctrl+S cuando el foco está fuera).
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const store = useEditorStore.getState();

      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (e.shiftKey) store.saveAll();
        else store.saveActive();
      } else if (e.key === 'w') {
        e.preventDefault();
        if (store.activePath) store.closeTab(store.activePath);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        store.cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key === '`' || e.key === 'ñ') {
        e.preventDefault();
        useAppStore.getState().togglePanel('terminal');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Arrastre del borde superior del panel de terminal para redimensionarlo.
  const startTermDrag = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeights.terminal || 240;
    const onMove = (ev) => {
      if (termFrame.current) cancelAnimationFrame(termFrame.current);
      termFrame.current = requestAnimationFrame(() => {
        const next = Math.min(TERM_MAX_H, Math.max(TERM_MIN_H, startH + (startY - ev.clientY)));
        setPanelHeight('terminal', next);
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const renderCenter = () => {
    if (centerView === 'metrics') {
      return (
        <div className="center-view">
          <Metrics />
        </div>
      );
    }
    if (centerView === 'settings') {
      return (
        <div className="center-view">
          <Settings />
        </div>
      );
    }
    if (centerView === 'git') {
      return (
        <div className="center-view">
          <SourceControl />
        </div>
      );
    }
    // Editor con pestañas
    return (
      <div className="editor-area">
        <div className="editor-toolbar">
          <EditorTabs />
          <RunControls />
        </div>
        {hasTabs ? (
          <CodeMirrorHost />
        ) : (
          <div className="editor-empty">
            <span className="brand">LIXBON</span>
            <p>Abre un archivo desde el explorador para empezar a editar.</p>
            <p>
              <kbd>Ctrl</kbd> + <kbd>S</kbd> guarda · <kbd>Ctrl</kbd> + <kbd>W</kbd> cierra la pestaña
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="shell">
      {updateInfo && !dismissed && (
        <div className="update-modal__anchor">
          <UpdateModal
            updateInfo={updateInfo}
            serverUrl={serverUrl}
            onInstall={installUpdate}
            onDismiss={dismissUpdate}
            isDownloading={isDownloading}
            downloadProgress={downloadProgress}
          />
        </div>
      )}
      <div className="shell__body">
        <ActivityBar />

        {panels.explorer && (
          <SidePanel
            side="left"
            width={panelWidths.explorer}
            onWidthChange={(w) => setPanelWidth('explorer', w)}
          >
            <FileTree />
          </SidePanel>
        )}

        <main className="shell__center">
          <div className="shell__center-main">
            {renderCenter()}
          </div>

          {panels.terminal && (
            <div
              className="terminal-dock"
              style={{ height: panelHeights.terminal || 240 }}
            >
              <div className="terminal-dock__resizer" onPointerDown={startTermDrag} />
              <div className="terminal-dock__head">
                <span className="terminal-dock__title">Terminal</span>
                <button
                  className="icon-btn"
                  onClick={() => togglePanel('terminal')}
                  title="Ocultar terminal (Ctrl+`)"
                >
                  <IconX size={15} />
                </button>
              </div>
              <TerminalPanel />
            </div>
          )}
        </main>

        {panels.chat && (
          <SidePanel
            side="right"
            width={panelWidths.chat}
            onWidthChange={(w) => setPanelWidth('chat', w)}
          >
            <ChatPanel />
          </SidePanel>
        )}
      </div>

      <StatusBar />
    </div>
  );
}
