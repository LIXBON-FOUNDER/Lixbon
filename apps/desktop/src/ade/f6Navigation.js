import { create } from 'zustand';
import { queryAdeCore } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useTerminalStore } from '../store/terminalStore';

export const useIdeAttempt = create(() => ({ scope: null }));
const editorSelections = new Map();
const browserSelections = new Map();
let workspaceIntent = 0;
let workspaceQueue = Promise.resolve();
const remembered = () => { try { return sessionStorage.getItem('lixbon-ide-attempt'); } catch { return null; } };
export async function restoreIdeAttempt() {
  const id = remembered();
  if (!id) return;
  try {
    const scope = await queryAdeCore('attempt_workspace', { attempt_id: id });
    if (scope.root === useAppStore.getState().workspaceRoot) useIdeAttempt.setState({ scope });
  } catch { /* The saved id is only a hint; no root or ownership is inferred. */ }
}

export function openInAde(scope) {
  const wb = useWorkbenchStore.getState();
  wb.setAdeSelection({ projectId: scope.project_id, taskId: scope.task_id, attemptId: scope.attempt_id ?? scope.id });
  wb.setOrchView('ade');
  wb.setMode('orch');
  window.dispatchEvent(new CustomEvent('lixbon:ade-open', { detail: useWorkbenchStore.getState().adeSelection }));
}

// Explicit user action only. A background result must never change the editor root.
export async function openAttemptWorkspace(attemptId, { file, line, revision } = {}) {
  const intent = ++workspaceIntent;
  const operation = workspaceQueue.then(() => openVerifiedWorkspace(attemptId, { file, line, revision }, intent));
  workspaceQueue = operation.catch(() => {});
  return operation;
}

async function openVerifiedWorkspace(attemptId, { file, line, revision }, intent) {
  if (intent !== workspaceIntent) throw new Error('workspace_changed: se eligió otro Attempt.');
  const scope = await queryAdeCore('attempt_workspace', { attempt_id: attemptId, file });
  if (intent !== workspaceIntent) throw new Error('workspace_changed: se eligió otro Attempt.');
  if (revision && !scope.revision?.startsWith(revision)) throw new Error('link_stale: la revisión del workspace cambió; revisa el enlace de nuevo.');
  const previousRoot = useAppStore.getState().workspaceRoot;
  const previousScope = useIdeAttempt.getState().scope;
  const wb = useWorkbenchStore.getState();
  if (previousScope?.root === previousRoot) browserSelections.set(previousScope.attempt_id, { ...wb.design });
  const files = useFileViewStore.getState();
  if (previousRoot) editorSelections.set(previousRoot, files.activePath);
  await useAppStore.getState().openWorkspace(scope.root);
  useIdeAttempt.setState({ scope });
  // A preview URL chosen for another Attempt must never appear under this one's identity.
  if (previousScope?.attempt_id !== attemptId) wb.setDesign(browserSelections.get(attemptId) ?? { ...wb.design, url: '' });
  try { sessionStorage.setItem('lixbon-ide-attempt', attemptId); } catch { /* storage unavailable */ }
  const terms = useTerminalStore.getState();
  const matching = terms.sessions.find((s) => s.cwd === scope.root);
  if (matching) terms.setActive(matching.key);
  else terms.addSession(undefined, scope.root);
  if (scope.file) await useFileViewStore.getState().revealLine(scope.file, line ?? 1);
  else if (previousRoot !== scope.root) {
    const rememberedFile = editorSelections.get(scope.root);
    if (rememberedFile && files.tabs.some((t) => t.path === rememberedFile)) files._activate(rememberedFile);
    else useFileViewStore.setState({ activePath: null, peekedPath: null, cursor: null });
  }
  useWorkbenchStore.getState().setMode('editor');
  return scope;
}
