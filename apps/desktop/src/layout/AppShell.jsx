// AppShell.jsx — cascarón del IDE: activity bar + explorador + editor + chat + status bar.
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useVersion } from '../hooks/useVersion';

import { ActivityBar } from './ActivityBar';
import { SidePanel } from './SidePanel';
import { StatusBar } from './StatusBar';
import { UpdateModal } from '../components/UpdateModal';

import { FileTree } from '../sections/Workspace/FileTree';
import { EditorTabs } from '../editor/EditorTabs';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { ChatPanel } from '../chat/ChatPanel';
import { Metrics } from '../sections/Metrics/Metrics';
import { Settings } from '../sections/Settings/Settings';

export function AppShell() {
  const { panels, panelWidths, setPanelWidth, centerView, editorFontSize, serverUrl } = useAppStore();
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate } = useVersion();

  const hasTabs = useEditorStore((s) => s.tabs.length > 0);

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

      if (e.key === 's') {
        e.preventDefault();
        store.saveActive();
      } else if (e.key === 'w') {
        e.preventDefault();
        if (store.activePath) store.closeTab(store.activePath);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        store.cycleTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
    // Editor con pestañas
    return (
      <div className="editor-area">
        <EditorTabs />
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
          {renderCenter()}
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
