// AppShell.jsx — cascarón del IDE: activity bar + explorador + editor + chat +
// dock inferior (terminal/problemas) + status bar. Ajustes y Consumo se abren
// como ventana flotante para no desplazar el área de trabajo.
import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
import { Breadcrumbs } from '../editor/Breadcrumbs';
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
import { ConfirmDialog } from '../components/ConfirmDialog';
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

  // Vigilancia de disco: el backend emite `fs:changed` con las rutas cambiadas.
  // Refresca el árbol (FileTree ya escucha el evento window) y recarga las
  // pestañas abiertas no sucias afectadas.
  useEffect(() => {
    let unlisten;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('fs:changed', (e) => {
        const paths = Array.isArray(e.payload) ? e.payload : [];
        window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
        useEditorStore.getState().onDiskChanged(paths);
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Persistir la sesión (pestañas abiertas) al cambiar de pestañas o de activa.
  useEffect(() => {
    return useEditorStore.subscribe((s, prev) => {
      if (s.tabs !== prev.tabs || s.activePath !== prev.activePath) {
        useEditorStore.getState().persistSession();
      }
    });
  }, []);

  // Guarda de cierre: si hay pestañas sin guardar, interceptar el cierre de la
  // ventana y ofrecer guardar antes de salir (evita perder cambios).
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten;
    (async () => {
      unlisten = await win.onCloseRequested(async (event) => {
        const dirty = useEditorStore.getState().tabs.filter((t) => t.dirty);
        if (dirty.length === 0) return; // sin cambios: cerrar sin más
        event.preventDefault();
        const { showConfirm } = await import('../lib/confirm');
        const { choice } = await showConfirm({
          message: `Hay ${dirty.length} archivo(s) con cambios sin guardar.`,
          options: [
            { id: 'save', label: 'Guardar y salir', kind: 'primary' },
            { id: 'discard', label: 'Salir sin guardar', kind: 'danger' },
            { id: 'cancel', label: 'Cancelar' },
          ],
        });
        if (choice === 'discard') { await win.destroy(); return; }
        if (choice !== 'save') return; // cancelado: se queda abierta
        await useEditorStore.getState().saveAll();
        // Si algún guardado falló, no cerrar: el usuario debe verlo.
        if (useEditorStore.getState().tabs.some((t) => t.dirty)) return;
        await win.destroy();
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

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
        {hasTabs && <Breadcrumbs />}
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

          {/* Montado SIEMPRE y oculto con display: si se desmontara al plegar
              (Ctrl+`), los PTY quedarían huérfanos en Rust (el shell seguiría
              vivo sin nadie que lo cierre) y al reabrir se crearía otro shell
              duplicado perdiendo además el buffer del terminal. */}
          <div style={{ display: panels.terminal ? 'contents' : 'none' }}>
            <BottomPanel />
          </div>
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
      <ConfirmDialog />
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
