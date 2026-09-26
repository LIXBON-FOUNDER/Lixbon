// StatusBar.jsx — línea de estado: git, agente, cursor, lenguaje y conexión.
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useUsageStore, resetLabel } from '../store/usageStore';
import { useProblemsStore, problemCounts } from '../store/problemsStore';
import { useGitStore } from '../store/gitStore';
import { useChatStore, useOpenSessions, useSessionsStore } from '../store/chatStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { languageLabel } from '../editor/languages';
import { SpinRing, ProgressRing } from '../components/Ring';
import { IconGitBranch } from '../components/Icons';

const CONN = { connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Sin conexión' };

export function StatusBar() {
  const { connectionStatus, latency, workspaceRoot } = useAppStore();
  const { branch, ahead, behind, changes, isRepo } = useGitStore();
  const streaming = useChatStore((s) => s.streaming);
  const waiting = useChatStore((s) => !!s.pendingApproval || !!s.pendingQuestion);
  const activePath = useFileViewStore((s) => s.activePath);
  const cursor = useFileViewStore((s) => s.cursor);
  const mode = useWorkbenchStore((s) => s.mode);
  const setMode = useWorkbenchStore((s) => s.setMode);
  const title = useChatStore((s) => s.conversationTitle);
  const background = useOpenSessions().filter((o) => !o.active && (o.streaming || o.waiting));
  const bgWaiting = background.find((o) => o.waiting);
  const session = useUsageStore((s) => s.buckets?.session);
  const loadUsage = useUsageStore((s) => s.load);
  const checker = useProblemsStore((s) => s.checker);
  const { errors, warnings } = problemCounts(useProblemsStore((s) => s.problems));
  const showProblems = () => {
    setMode('editor');
    useWorkbenchStore.getState().setDockTab('problems');
    useAppStore.getState().showTerminal();
  };

  useEffect(() => { if (!streaming) loadUsage(true); }, [streaming, loadUsage]);

  return (
    <footer className="statusbar">
      {workspaceRoot && isRepo && branch && (
        <button className="statusbar__item statusbar__item--strong" onClick={() => setMode('git')}>
          <IconGitBranch size={12} />
          {branch}
          {(ahead > 0 || behind > 0) && <span>{ahead > 0 ? ` ↑${ahead}` : ''}{behind > 0 ? ` ↓${behind}` : ''}</span>}
        </button>
      )}
      {changes.length > 0 && <span className="statusbar__item">{changes.length} cambios</span>}
      {(streaming || waiting) && (
        <button className="statusbar__item statusbar__item--agent" onClick={() => setMode('agent')}>
          {waiting ? <span className="dot dot--pulse" /> : <SpinRing size={11} />}
          {waiting ? 'El agente espera tu respuesta' : title ? `${title} · trabajando` : 'Agente trabajando'}
        </button>
      )}
      {checker && (
        <button className={`statusbar__item ${errors ? 'statusbar__item--err' : ''}`} onClick={showProblems} title="Problemas">
          {errors} {errors === 1 ? 'error' : 'errores'}{warnings ? ` · ${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}` : ''}
        </button>
      )}
      {background.length > 0 && (
        <button
          className="statusbar__item statusbar__item--agent"
          onClick={() => { useSessionsStore.getState().activate((bgWaiting || background[0]).key); setMode('agent'); }}
          title="Agentes trabajando en otras conversaciones"
        >
          {bgWaiting ? <span className="dot dot--accent dot--pulse" /> : <SpinRing size={11} />}
          {bgWaiting ? `«${bgWaiting.title || 'Otro agente'}» espera tu permiso` : `${background.length} ${background.length === 1 ? 'agente más' : 'agentes más'} trabajando`}
        </button>
      )}
      <div className="statusbar__fill" />
      {mode === 'editor' && activePath && (
        <>
          {cursor && <span className="statusbar__item">Ln {cursor.line}, Col {cursor.col}{cursor.selected ? ` (${cursor.selected} sel.)` : ''}</span>}
          <span className="statusbar__item">UTF-8</span>
          <span className="statusbar__item statusbar__item--strong">{languageLabel(activePath)}</span>
        </>
      )}
      {session && !session.unlimited && (
        <button
          className="statusbar__item"
          onClick={() => useAppStore.getState().openModal('settings', 'usage')}
          title={`Sesión ${Math.round(session.percent || 0)}% · ${resetLabel(session.reset_at)}`}
        >
          <ProgressRing value={session.percent || 0} size={12} stroke={3} />
          {Math.round(session.percent || 0)}%
        </button>
      )}
      <span className={`statusbar__item statusbar__conn is-${connectionStatus}`}>
        <span className="dot" />
        {CONN[connectionStatus] || connectionStatus}
        {connectionStatus === 'connected' && latency > 0 ? ` · ${latency} ms` : ''}
      </span>
    </footer>
  );
}
