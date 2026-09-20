// AppShell.jsx — cascarón de Lixbon: sidebar único (logo, rama, nav, cuenta) +
// panel central que muestra el chat, salvo en Git y GitHub, donde el PR de la
// rama actual ocupa el panel central y el sidebar pasa a cambios/commit.
// Terminal bajo demanda. Ajustes y Control remoto se abren como ventana
// flotante para no desplazar el chat.
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';

import { Sidebar } from './Sidebar';
import { BottomPanel } from './BottomPanel';
import { UpdateModal } from '../components/UpdateModal';

import { FileQuickView } from '../sections/Workspace/FileQuickView';
import { DiffView } from '../sections/SourceControl/DiffView';
import { GitHubView } from '../sections/SourceControl/GitHubView';
import { ChatPanel } from '../chat/ChatPanel';
import { Settings } from '../sections/Settings/Settings';
import { QuickOpen } from '../components/QuickOpen';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { RemoteModal } from '../components/RemoteModal';
import { useVersion } from '../hooks/useVersion';
import { registerBuiltinCommands } from '../commands/builtin';
import { dispatchKeydown } from '../lib/keymap';

export function AppShell() {
  const {
    panels, sidebarOpen, leftView, diffData,
    serverUrl, quickOpen, commandPalette,
    modalView, modalSection, closeModal,
  } = useAppStore();
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate } = useVersion();

  // Reabrir la última carpeta de trabajo (el sandbox Rust no persiste)
  useEffect(() => {
    useAppStore.getState().restoreWorkspace();
    // Sin consultar al remoto no hay forma de saber que hay commits nuevos:
    // el botón de Git no podría ofrecer "Pull" nunca.
    useGitStore.getState().startAutoFetch();
  }, []);

  // Vigilancia de disco: el backend emite `fs:changed` con las rutas cambiadas
  // (edición externa, git, build tools…). Se reenvía como evento de ventana
  // para que el árbol de Archivos (y quien más lo necesite) se refresque.
  useEffect(() => {
    let unlisten;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('fs:changed', () => {
        window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Atajos globales: se resuelven contra el keymap central, que dispara
  // comandos del registro.
  useEffect(() => {
    registerBuiltinCommands();
    const onKeyDown = (e) => dispatchKeydown(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const showGitHub = sidebarOpen && leftView === 'git';

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
        <Sidebar />

        <main className="shell__center panel" style={{ animationDelay: '0.05s' }}>
          {showGitHub ? (
            <GitHubView />
          ) : (
            <div className="shell__center-main">
              {sidebarOpen && leftView === 'explorer' && <FileQuickView />}
              <ChatPanel />
            </div>
          )}

          {/* Montado SIEMPRE y oculto con display: si se desmontara al plegar
              la Terminal, los PTY quedarían huérfanos en Rust (el shell seguiría
              vivo sin nadie que lo cierre) y al reabrir se crearía otro shell
              duplicado perdiendo además el buffer del terminal. */}
          <div style={{ display: panels.terminal ? 'contents' : 'none' }}>
            <BottomPanel />
          </div>
        </main>
      </div>

      {quickOpen && <QuickOpen />}
      {commandPalette && <CommandPalette />}
      <ConfirmDialog />

      {modalView === 'settings' && (
        <Modal title="Ajustes" onClose={closeModal} size="lg">
          <Settings initialSection={modalSection} />
        </Modal>
      )}
      {modalView === 'remote' && (
        <Modal
          title="Control remoto"
          subtitle="Maneja esta sesión desde tu app móvil o la web"
          onClose={closeModal}
          size="md"
        >
          <RemoteModal />
        </Modal>
      )}
      {modalView === 'diff' && (
        <Modal title={diffData?.title || 'Diferencias'} onClose={closeModal} size="lg">
          <DiffView />
        </Modal>
      )}
    </div>
  );
}
