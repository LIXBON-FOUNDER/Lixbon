// AppShell.jsx — cuerpo del IDE: el modo activo (Agente, Editor, Diseño, Git),
// la barra de estado y las capas flotantes (paleta, Quick Open, ajustes…).
// El modo Editor se queda montado siempre: ahí viven los PTY del terminal y el
// estado de CodeMirror, que se perderían al desmontarlo. El Orquestador (ADE)
// se queda montado tras su primera visita, oculto e inerte, para conservar su
// vista, filtros, scroll y foco; mientras está oculto no consulta ni sondea.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore } from '../store/chatStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useMcpStore } from '../store/mcpStore';
import { useProblemsStore } from '../store/problemsStore';

import { StatusBar } from './StatusBar';
import { useAvisoFlotante } from '../chat/avisoFlotante';
import { UpdateModal } from '../components/UpdateModal';
import { EditorMode } from '../modes/EditorMode';
import { AgentMode } from '../modes/AgentMode';
import { DesignMode } from '../modes/DesignMode';
import { GitMode } from '../modes/GitMode';
import { OrchestratorMode } from '../orch/OrchestratorMode';
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

const ID_ATTRIBUTES = ['data-project-id', 'data-task-id', 'data-attention-id'];
const quoteAttr = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

/** Firma de un elemento con foco: React recrea nodos al vaciarse las listas ocultas, así que se
    guarda con qué IDs durables volver a encontrarlo. */
function focusSignature(el) {
  const ids = ID_ATTRIBUTES.filter((name) => el.hasAttribute(name));
  return { node: el, id: el.id || null, role: el.getAttribute('role'), tag: el.tagName.toLowerCase(), ids: ids.map((name) => [name, el.getAttribute(name)]) };
}

function resolveFocus(signature, host) {
  if (!signature || !host) return null;
  if (signature.node.isConnected && host.contains(signature.node)) return signature.node;
  if (signature.id) {
    const byId = document.getElementById(signature.id);
    return byId && host.contains(byId) ? byId : null;
  }
  if (!signature.ids.length) return null;
  let selector = signature.tag;
  if (signature.role) selector += `[role=${quoteAttr(signature.role)}]`;
  for (const [name, value] of signature.ids) selector += `[${name}=${quoteAttr(value)}]`;
  for (const name of ID_ATTRIBUTES) {
    if (!signature.ids.some(([present]) => present === name)) selector += `:not([${name}])`;
  }
  return host.querySelector(selector);
}

// Las listas ocultas se rellenan de nuevo desde la última foto de Core y las filas por Project tardan
// algo más: el scroll y el foco se reintentan en esta ventana, salvo que la persona interactúe antes.
const SETTLE_DELAYS = [0, 60, 150, 300, 600];

/** Mantiene un modo montado pero fuera de juego mientras no es el activo: `inert` + `aria-hidden`
    (sin foco ni teclado) y `visibility: hidden` en una caja que conserva su tamaño, de modo que el
    scroll no se pierde. Al volver restaura el scroll y, solo si el foco está vacante, el foco. */
function RetainedMode({ active, name, children }) {
  const hostRef = useRef(null);
  const activeRef = useRef(active);
  const settling = useRef(false);
  const scrolls = useRef(new Map());
  const lastFocus = useRef(null);

  useLayoutEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    if (!active || wasActive) return undefined;
    const host = hostRef.current;
    let focusDone = false;
    const attempt = () => {
      for (const [el, top] of scrolls.current) {
        if (!el.isConnected) scrolls.current.delete(el);
        else if (el.scrollTop !== top) el.scrollTop = top;
      }
      if (focusDone) return;
      // Si la persona ya movió el foco a otro sitio, no se le quita.
      const current = document.activeElement;
      if (current && current !== document.body && current !== document.documentElement) { focusDone = true; return; }
      const target = resolveFocus(lastFocus.current, host);
      if (!target) return;
      target.focus({ preventScroll: true });
      focusDone = document.activeElement === target;
    };
    const timers = [];
    const finish = () => {
      timers.forEach(clearTimeout);
      host.removeEventListener('wheel', finish);
      host.removeEventListener('keydown', finish);
      host.removeEventListener('pointerdown', finish);
      settling.current = false;
    };
    settling.current = true;
    attempt();
    SETTLE_DELAYS.forEach((delay, index) => {
      timers.push(setTimeout(() => {
        attempt();
        if (index === SETTLE_DELAYS.length - 1) finish();
      }, delay));
    });
    host.addEventListener('wheel', finish);
    host.addEventListener('keydown', finish);
    host.addEventListener('pointerdown', finish);
    return finish;
  }, [active]);

  return (
    <div
      ref={hostRef}
      data-retained-mode={name}
      data-retained-state={active ? 'active' : 'hidden'}
      aria-hidden={!active}
      inert={!active}
      style={active ? { display: 'contents' } : { position: 'absolute', inset: 0, display: 'flex', visibility: 'hidden', pointerEvents: 'none' }}
      onScrollCapture={(e) => {
        // Solo con el modo visible y asentado: vaciar una lista oculta o rellenarla recorta el scroll y eso no es de la persona.
        if (activeRef.current && !settling.current && e.target instanceof Element) scrolls.current.set(e.target, e.target.scrollTop);
      }}
      onFocus={(e) => { if (activeRef.current) lastFocus.current = focusSignature(e.target); }}
    >
      {children}
    </div>
  );
}

export function AppShell() {
  const {
    diffData, serverUrl, quickOpen, commandPalette, workspaceRoot, workspaceReady,
    modalView, closeModal,
  } = useAppStore();
  const mode = useWorkbenchStore((s) => s.mode);
  const page = useWorkbenchStore((s) => s.page);
  const { updateInfo, installUpdate, isDownloading, downloadProgress, dismissed, dismissUpdate, error: updateError } = useVersion();
  const [skipWelcome, setSkipWelcome] = useState(false);
  // El Orquestador se monta en la primera visita y ya no se desmonta al cambiar de modo.
  const [orchRetained, setOrchRetained] = useState(mode === 'orch');
  if (mode === 'orch' && !orchRetained) setOrchRetained(true);
  useAvisoFlotante(); // la mascota sobre otras apps cuando el agente termina

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
      <div className="shell__body">
        {showWelcome ? (
          <Welcome onSkip={() => setSkipWelcome(true)} />
        ) : (
          <>
            <EditorMode active={mode === 'editor'} />
            {mode === 'agent' && <AgentMode />}
            {mode === 'design' && <DesignMode />}
            {mode === 'git' && <GitMode />}
            {orchRetained && (
              <RetainedMode active={mode === 'orch'} name="orch">
                <OrchestratorMode modeActive={mode === 'orch'} />
              </RetainedMode>
            )}
          </>
        )}
      </div>

      {!showWelcome && <StatusBar />}

      {page === 'settings' && <SettingsPage />}
      {quickOpen && <QuickOpen />}
      {commandPalette && <CommandPalette />}
      <ConfirmDialog />
      <Toasts>
        {updateInfo && !dismissed && (
          <UpdateModal
            updateInfo={updateInfo}
            serverUrl={serverUrl}
            onInstall={installUpdate}
            onDismiss={dismissUpdate}
            isDownloading={isDownloading}
            downloadProgress={downloadProgress}
            error={updateError}
          />
        )}
      </Toasts>

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
