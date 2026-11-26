import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useCoreQuery } from './useCoreQuery';
import { openInAde, useIdeAttempt } from './f6Navigation';
import { AttemptActivity } from './AttemptActivity';
import { AttemptQueue } from './AttemptQueue';
import { AttemptStop } from './AttemptStop';
import { AttemptProofPack } from './AttemptProofPack';
import { AttemptPinnedDiff } from './AttemptPinnedDiff';
import { AttemptOwnership } from './AttemptOwnership';
import { AttemptTransfer } from './AttemptTransfer';
import { relativeFile } from './f6Contract';
import './f6.css';

export function relativeEditorFile(root, path) {
  if (!root || !path) return null;
  const base = root.replaceAll('\\', '/').replace(/\/$/, '');
  const full = path.replaceAll('\\', '/');
  if (!full.startsWith(`${base}/`)) return null;
  const file = full.slice(base.length + 1);
  return relativeFile(file) ? file : null;
}

export function IdeOwnershipBanner({ active, onSelect }) {
  const scope = useIdeAttempt((s) => s.scope);
  const root = useAppStore((s) => s.workspaceRoot);
  const path = useFileViewStore((s) => s.activePath);
  const file = relativeEditorFile(root, path);
  const bound = Boolean(scope && scope.root === root);
  const query = useCoreQuery('work_at', { project_id: scope?.project_id, path: file ?? '.lixbon',
    worktree_id: scope?.worktree_id }, { enabled: active && bound, pollMs: 3000 });
  useEffect(() => {
    const refresh = () => query.retry();
    window.addEventListener('lixbon:fs-changed', refresh);
    return () => window.removeEventListener('lixbon:fs-changed', refresh);
  }, [query.retry]);
  const report = query.status === 'ready' ? query.data : null;
  const owner = report?.owner;
  const select = (a) => onSelect({ project_id: scope.project_id, task_id: a.task_id, attempt_id: a.id ?? a.attempt_id });
  if (!bound) return <details className="f6-ide f6-ide--unbound"><summary>AI Work</summary><p>Workspace sin vínculo verificado. Abre un Attempt desde ADE para consultar su propietario.</p></details>;
  return <div className="f6-ide" aria-label="AI Work" role="region">
    {!bound ? <p>AI Work · Workspace sin vínculo verificado. Abre un Attempt desde ADE para consultar su propietario.</p> : <>
      <p>{scope.task_id} / {scope.attempt_id} · {scope.branch ?? 'sin rama'} · {scope.host ?? 'host no informado'} · {scope.root}</p>
      {path && !file && <p role="alert">El archivo seleccionado pertenece a otro workspace. No se añade como contexto de este Attempt.</p>}
      {!report && <p role="status">{query.error ? `Propiedad desconocida: ${query.error}` : 'Verificando propiedad…'}</p>}
      {owner?.state === 'none' && <p>Sin propietario activo · {owner.reason}. Los intentos históricos no poseen este workspace.</p>}
      {owner?.state === 'ambiguous' && <p role="alert">Propiedad ambigua: selecciona un Attempt explícitamente.</p>}
      {(owner?.state === 'owned' ? [owner.attempt] : owner?.candidates ?? []).map((a) => <span key={a.id}>
        AI WORK · {a.task_id} / {a.id} · {a.provider} · {a.status} · {a.held_by === 'human' ? 'control humano' : 'control del agente'}{' '}
        <button className="lk" onClick={() => select(a)}>Abrir sidecar {a.id}</button>{' '}
        <button className="lk" onClick={() => openInAde({ project_id: scope.project_id, task_id: a.task_id, attempt_id: a.id })}>Open in ADE</button>
      </span>)}
      {report?.evidence.completeness === 'partial' && <p>Evidencia parcial: no se conoce todo el historial de esta ruta.</p>}
      {report?.touched_by.length > 0 && <details><summary>Attempts que tocaron {file ?? 'esta ruta'}</summary><ul>{report.touched_by.map((a) => <li key={a.attempt_id}>{a.attempt_id} · {a.status} · {a.evidence.provenance}{' '}
        {a.link && <button className="lk" onClick={() => window.dispatchEvent(new CustomEvent('lixbon:open-link', { detail: { url: a.link } }))}>Abrir diff de este Attempt</button>}
      </li>)}</ul></details>}
      <button className="lk" onClick={() => select({ id: scope.attempt_id, task_id: scope.task_id })}>Abrir Attempt del workspace</button>
    </>}
  </div>;
}

function SidecarAttempt({ target, active }) {
  const [tab, setTab] = useState('agent');
  const state = useCoreQuery('attempt_detail_v2', { attempt_id: target.attempt_id }, { enabled: active, pollMs: 3000 });
  const taskState = useCoreQuery('task_detail_v2', { task_id: target.task_id }, { enabled: active });
  const knownProject = useRef(null);
  if (taskState.data?.task) knownProject.current = taskState.data.task.project_id;
  const known = useRef(null);
  if (state.data?.attempt) known.current = state.data.attempt;
  const attempt = state.data?.attempt ?? known.current;
  const scope = useIdeAttempt((s) => s.scope);
  const path = useFileViewStore((s) => s.activePath);
  const cursor = useFileViewStore((s) => s.cursor);
  const root = useAppStore((s) => s.workspaceRoot);
  const file = relativeEditorFile(root, path);
  const source = scope?.attempt_id === target.attempt_id && scope.root === root && file && scope.revision
    ? { file, line: cursor?.selectionStartLine ?? cursor?.line ?? 1, end_line: cursor?.selectionEndLine ?? cursor?.line ?? 1, revision: scope.revision } : undefined;
  if (!attempt || attempt.id !== target.attempt_id || attempt.task_id !== target.task_id || knownProject.current !== target.project_id) return <p role="status">{state.error ?? 'Verificando Attempt del sidecar…'}</p>;
  return <>
    <p><strong>{attempt.id}</strong> · {attempt.provider} / {attempt.model ?? 'modelo no informado'} · {attempt.status}</p>
    <p>El sidecar permanece vinculado a este Attempt al cambiar de archivo.</p>
    <button className="lk" onClick={() => openInAde(target)}>Open in ADE</button>
    <div role="group" aria-label="Vista del sidecar"><button className="btn btn--ghost btn--sm" aria-pressed={tab === 'agent'} onClick={() => setTab('agent')}>Agente</button><button className="btn btn--ghost btn--sm" aria-pressed={tab === 'review'} onClick={() => setTab('review')}>Review inline</button></div>
    <div hidden={tab !== 'agent'}>
      <AttemptOwnership attempt={attempt} active={active && tab === 'agent'} onChanged={state.retry} />
      <AttemptQueue attempt={attempt} active={active && tab === 'agent'} contextSource={source ? { project_id: target.project_id, task_id: target.task_id, attempt_id: target.attempt_id, file: source.file, line: source.line, revision: source.revision, view: 'overview' } : undefined} />
      <AttemptStop taskId={attempt.task_id} status={attempt.status} onStopped={state.retry} />
      <AttemptTransfer key={attempt.id} attempt={attempt} projectId={target.project_id} source={source} active={active && tab === 'agent'} />
      <AttemptActivity attemptId={attempt.id} coreModel={{ vNext: true }} active={active && tab === 'agent'} />
    </div>
    {tab === 'review' && <div>
      <AttemptProofPack attempt={attempt} active={active} />
      <AttemptTransfer attempt={attempt} projectId={target.project_id} source={source} active={active} />
      {active && <AttemptPinnedDiff attempt={attempt} file={file} />}
      <button className="lk" onClick={() => openInAde(target)}>Abrir revisión completa en ADE</button>
    </div>}
  </>;
}

export function IdeAgentSidecars({ target, active, onClose }) {
  const [visited, setVisited] = useState([]);
  // Retained panels keep the Core composer draft and scroll tied to an explicit Attempt.
  if (target && !visited.some((t) => t.attempt_id === target.attempt_id)) setVisited([...visited, target]);
  return <aside className="f6-sidecar" aria-label="Agente del IDE" hidden={!target}>
    <button className="btn btn--ghost btn--sm" onClick={onClose}>Cerrar sidecar</button>
    {visited.map((t) => <div key={t.attempt_id} hidden={t.attempt_id !== target?.attempt_id}>
      <SidecarAttempt target={t} active={active && t.attempt_id === target?.attempt_id} />
    </div>)}
  </aside>;
}
