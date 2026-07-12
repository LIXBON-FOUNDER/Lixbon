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
import { SearchPanel } from '../sections/Search/SearchPanel';
import { OutlinePanel } from '../sections/Outline/OutlinePanel';
import { ProblemsPanel } from '../sections/Problems/ProblemsPanel';
import { ExtensionsPanel } from '../sections/Extensions/ExtensionsPanel';
import { EditorTabs } from '../editor/EditorTabs';
import { RunControls } from '../editor/RunControls';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { Preview } from '../editor/Preview';
import { TerminalPanel } from '../editor/TerminalPanel';
import { ChatPanel } from '../chat/ChatPanel';
import { Metrics } from '../sections/Metrics/Metrics';
import { Settings } from '../sections/Settings/Settings';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { DiffView } from '../sections/SourceControl/DiffView';
import { Welcome } from '../sections/Workspace/Welcome';
import { QuickOpen } from '../components/QuickOpen';
import { CommandPalette } from '../components/CommandPalette';
import { InlineEdit } from '../editor/InlineEdit';
import { useExtStore } from '../store/extStore';
import { IconX } from '../components/Icons';
import { registerBuiltinCommands } from '../commands/builtin';
import { dispatchKeydown } from '../lib/keymap';

const TERM_MIN_H = 120;
const TERM_MAX_H = 640;

export function AppShell() {
  const {
    panels, panelWidths, setPanelWidth,
    panelHeights, setPanelHeight, togglePanel,
    centerView, editorFontSize, serverUrl,
    leftView, quickOpen, commandPalette, previewOpen,
  } = useAppStore();
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate } = useVersion();

  const hasTabs = useEditorStore((s) => s.tabs.length > 0);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const termFrame = useRef(null);

  // Reabrir la última carpeta de trabajo (el sandbox Rust no persiste)
  // y re-aplicar el tema de editor persistido (extensiones)
  useEffect(() => {
    useAppStore.getState().restoreWorkspace();
    useExtStore.getState().hydrateTheme();
  }, []);

  // Tamaño de letra del editor (ajustable en Ajustes)
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${editorFontSize}px`);
  }, [editorFontSize]);

  // Atajos globales del IDE: se resuelven contra el keymap central, que dispara
  // comandos del registro. CodeMirror sigue manejando Ctrl+S dentro del editor
  // (el doble disparo es inofensivo: guardar es idempotente).
  useEffect(() => {
    registerBuiltinCommands();
    const onKeyDown = (e) => dispatchKeydown(e);
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
    if (centerView === 'diff') {
      return <DiffView />;
    }
    // Editor con pestañas
    return (
      <div className="editor-area">
        <div className="editor-toolbar">
          <EditorTabs />
          <RunControls />
        </div>
        {hasTabs ? (
          previewOpen ? (
            <div className="editor-split">
              <CodeMirrorHost />
              <Preview />
            </div>
          ) : (
            <CodeMirrorHost />
          )
        ) : !workspaceRoot ? (
          <Welcome />
        ) : (
          <div className="editor-empty">
            <span className="brand">LIXBON</span>
            <p>Abre un archivo desde el explorador para empezar a editar.</p>
            <p>
              <kbd>Ctrl</kbd> + <kbd>S</kbd> guarda · <kbd>Ctrl</kbd> + <kbd>W</kbd> cierra la pestaña
              {' · '}<kbd>Ctrl</kbd> + <kbd>Mayús</kbd> + <kbd>P</kbd> comandos
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
            {leftView === 'search' ? (
              <SearchPanel />
            ) : leftView === 'outline' ? (
              <OutlinePanel />
            ) : leftView === 'problems' ? (
              <ProblemsPanel />
            ) : leftView === 'git' ? (
              <SourceControl />
            ) : leftView === 'extensions' ? (
              <ExtensionsPanel />
            ) : (
              <FileTree />
            )}
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

      {quickOpen && <QuickOpen />}
      {commandPalette && <CommandPalette />}
      <InlineEdit />

      <StatusBar />
    </div>
  );
}
