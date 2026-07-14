// AppShell.jsx — cascarón del IDE: activity bar + explorador + editor + chat +
// dock inferior (terminal/problemas) + status bar. Ajustes y Consumo se abren
// como ventana flotante para no desplazar el área de trabajo.
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useGitStore } from '../store/gitStore';
import { useVersion } from '../hooks/useVersion';

import { ActivityBar } from './ActivityBar';
import { SidePanel } from './SidePanel';
import { BottomPanel } from './BottomPanel';
import { StatusBar } from './StatusBar';
import { UpdateModal } from '../components/UpdateModal';

import { FileTree } from '../sections/Workspace/FileTree';
import { SearchPanel } from '../sections/Search/SearchPanel';
import { OutlinePanel } from '../sections/Outline/OutlinePanel';
import { ExtensionsPanel } from '../sections/Extensions/ExtensionsPanel';
import { EditorTabs } from '../editor/EditorTabs';
import { RunControls } from '../editor/RunControls';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { Preview } from '../editor/Preview';
import { ChatPanel } from '../chat/ChatPanel';
import { Metrics } from '../sections/Metrics/Metrics';
import { Settings } from '../sections/Settings/Settings';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { DiffView } from '../sections/SourceControl/DiffView';
import { Welcome } from '../sections/Workspace/Welcome';
import { QuickOpen } from '../components/QuickOpen';
import { CommandPalette } from '../components/CommandPalette';
import { Modal } from '../components/Modal';
import { InlineEdit } from '../editor/InlineEdit';
import { useExtStore } from '../store/extStore';
import { registerBuiltinCommands } from '../commands/builtin';
import { dispatchKeydown } from '../lib/keymap';

export function AppShell() {
  const {
    panels, panelWidths, setPanelWidth,
    centerView, editorFontSize, serverUrl,
    leftView, quickOpen, commandPalette, previewOpen,
    modalView, modalSection, closeModal,
  } = useAppStore();
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate } = useVersion();

  const hasTabs = useEditorStore((s) => s.tabs.length > 0);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);

  // Reabrir la última carpeta de trabajo (el sandbox Rust no persiste)
  // y re-aplicar el tema de editor persistido (extensiones)
  useEffect(() => {
    useAppStore.getState().restoreWorkspace();
    useExtStore.getState().hydrateTheme();
    // Sin consultar al remoto no hay forma de saber que hay commits nuevos:
    // el botón de Git no podría ofrecer "Pull" nunca.
    useGitStore.getState().startAutoFetch();
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

  const renderCenter = () => {
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

          {panels.terminal && <BottomPanel />}
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

      {modalView === 'settings' && (
        <Modal title="Ajustes" onClose={closeModal} size="lg">
          <Settings initialSection={modalSection} />
        </Modal>
      )}
      {modalView === 'metrics' && (
        <Modal
          title="Consumo"
          subtitle="Cuotas del período y tokens por día"
          onClose={closeModal}
          size="md"
        >
          <Metrics />
        </Modal>
      )}

      <StatusBar />
    </div>
  );
}
