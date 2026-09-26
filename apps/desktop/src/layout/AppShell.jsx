// AppShell.jsx — cuerpo del IDE: el modo activo (Agente, Editor, Diseño, Git),
// la barra de estado y las capas flotantes (paleta, Quick Open, ajustes…).
// El modo Editor se queda montado siempre: ahí viven los PTY del terminal y el
// estado de CodeMirror, que se perderían al desmontarlo.
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore } from '../store/chatStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useMcpStore } from '../store/mcpStore';
import { useProblemsStore } from '../store/problemsStore';

import { StatusBar } from './StatusBar';
import { UpdateModal } from '../components/UpdateModal';
import { EditorMode } from '../modes/EditorMode';
import { AgentMode } from '../modes/AgentMode';
import { DesignMode } from '../modes/DesignMode';
import { GitMode } from '../modes/GitMode';
import { Welcome } from '../modes/Welcome';
import { DiffView } from '../sections/SourceControl/DiffView';
import { SettingsPage } from '../modes/SettingsPage';
import { QuickOpen } from '../components/QuickOpen';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { RemoteModal } from '../components/RemoteModal';
import { Toasts } from '../components/Toasts';
import { useVersion } from '../hooks/useVersion';
import { registerBuiltinCommands } from '../commands/builtin';
import { dispatchKeydown } from '../lib/keymap';

export function AppShell() {
  const {
    diffData, serverUrl, quickOpen, commandPalette, workspaceRoot, workspaceReady,
    modalView, closeModal,
  } = useAppStore();
  const mode = useWorkbenchStore((s) => s.mode);
  const page = useWorkbenchStore((s) => s.page);
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate, error: updateError } = useVersion();
  const [skipWelcome, setSkipWelcome] = useState(false);

  useEffect(() => {
    useAppStore.getState().restoreWorkspace();
    useGitStore.getState().startAutoFetch();
  }, []);

  // `fs:changed` llega del vigilante de disco (agente, git, editores
  // externos): refresca el árbol y recarga las pestañas limpias.
  useEffect(() => {
    let unlisten;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('fs:changed', () => {
        window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
        useFileViewStore.getState().syncFromDisk(useChatStore.getState().streaming);
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    registerBuiltinCommands();
    const onKeyDown = (e) => dispatchKeydown(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (workspaceReady) useProblemsStore.getState().detect();
  }, [workspaceRoot, workspaceReady]);

  // Al acabar un turno del agente se comprueba de nuevo lo que haya tocado.
  const streaming = useChatStore((s) => s.streaming);
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) useProblemsStore.getState().scheduleAfterSave();
    wasStreaming.current = streaming;
  }, [streaming]);

  // Los servidores MCP dependen del proyecto (.lixbon/mcp.json).
  useEffect(() => {
    if (workspaceReady) useMcpStore.getState().load(workspaceRoot).catch(() => {});
  }, [workspaceRoot, workspaceReady]);

  // En el modo Git el diff se ve en el panel central, no en ventana flotante.
  useEffect(() => {
    if (mode === 'git' && modalView === 'diff') closeModal();
  }, [mode, modalView, closeModal]);

  const showWelcome = workspaceReady && !workspaceRoot && !skipWelcome;

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
            error={updateError}
          />
        </div>
      )}

      <div className="shell__body">
        {showWelcome ? (
          <Welcome onSkip={() => setSkipWelcome(true)} />
        ) : (
          <>
            <EditorMode active={!page && mode === 'editor'} />
            {page === 'settings' && <SettingsPage />}
            {!page && mode === 'agent' && <AgentMode />}
            {!page && mode === 'design' && <DesignMode />}
            {!page && mode === 'git' && <GitMode />}
          </>
        )}
      </div>

      {!showWelcome && <StatusBar />}

      {quickOpen && <QuickOpen />}
      {commandPalette && <CommandPalette />}
      <ConfirmDialog />
      <Toasts />

      {modalView === 'remote' && (
        <Modal
          title="Control remoto"
          onClose={closeModal}
          size="sm"
        >
          <RemoteModal />
        </Modal>
      )}
      {modalView === 'diff' && mode !== 'git' && (
        <Modal title={diffData?.title || 'Diferencias'} onClose={closeModal} size="lg">
          <DiffView />
        </Modal>
      )}
    </div>
  );
}
