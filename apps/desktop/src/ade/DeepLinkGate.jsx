import { useEffect, useRef, useState } from 'react';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useIdeAttempt } from './f6Navigation';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { queryAdeCore } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';
import { openAttemptWorkspace, openInAde } from './f6Navigation';
import { AttemptActivity } from './AttemptActivity';
import { AttemptProofPack } from './AttemptProofPack';
import { AttemptPinnedDiff } from './AttemptPinnedDiff';
import { PathText } from './PathText';
import './f6.css';

export function LinkDestination({ resolved }) {
  const target = resolved.target;
  const state = useCoreQuery('attempt_detail_v2', { attempt_id: target.attempt_id }, { enabled: Boolean(target.attempt_id) });
  const task = useCoreQuery('task_detail_v2', { task_id: target.task_id }, { enabled: Boolean(target.attempt_id && target.task_id) });
  const [error, setError] = useState(null);
  const attempt = state.status === 'ready' ? state.data?.attempt : null;
  if (!target.attempt_id) return <>
    <p>Abierto en ADE: {target.task_id ?? target.project_id}.</p>
    {target.file && <button className="btn btn--ghost btn--sm" onClick={async () => {
      try {
        const checked = await queryAdeCore('deep_link_resolve', { url: resolved.canonical });
        if (checked.status !== 'ready') throw new Error('link_stale: vuelve a revisar el destino.');
        const local = await queryAdeCore('project_workspace', { project_id: target.project_id, file: target.file });
        await useAppStore.getState().openWorkspace(local.root);
        useIdeAttempt.setState({ scope: null });
        await useFileViewStore.getState().revealLine(local.file, target.line ?? 1);
        useWorkbenchStore.getState().setMode('editor');
      } catch (e) { setError(String(e)); }
    }}>Abrir archivo del Project en IDE</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  if (state.error) return <p role="alert">{state.error}</p>;
  if (task.error) return <p role="alert">{task.error}</p>;
  if (!attempt || !task.data) return <p role="status">Cargando el destino autorizado…</p>;
  if (attempt.id !== target.attempt_id || attempt.task_id !== target.task_id || task.data.task.project_id !== target.project_id) return <p role="alert">link_target_mismatch: el destino cambió.</p>;
  return <>
    <p>{target.project_id} / {target.task_id} / {target.attempt_id} · {target.view ?? 'overview'}</p>
    {target.revision && <p>Revisión solicitada: <code>{target.revision}</code></p>}
    {target.file && <p>Archivo {target.file}:{target.line ?? 1}</p>}
    {target.view === 'activity' && <AttemptActivity attemptId={attempt.id} coreModel={{ vNext: true }} />}
    {target.view === 'review' && <AttemptProofPack attempt={attempt} expectedRevision={target.revision} />}
    {['diff', 'review'].includes(target.view) && <AttemptPinnedDiff attempt={attempt} revision={target.revision} file={target.file} line={target.line} />}
    {target.view === 'artifact' && <ul>{attempt.artifacts.map((a) => <li key={a.id}>{a.kind} · {a.kind === 'pull_request' ? 'URL protegida' : <PathText path={a.uri} repoRoot={attempt.worktree?.path} />}</li>)}</ul>}
    {target.file && <button className="btn btn--ghost btn--sm" onClick={async () => {
      try { await openAttemptWorkspace(attempt.id, target); } catch (e) { setError(String(e)); }
    }}>Abrir archivo en IDE</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}

/** Register the listener before reading launch URLs. The sequence guard rejects older resolutions. */
export function DeepLinkGate() {
  const [state, setState] = useState(null);
  const seq = useRef(0);
  const last = useRef({ url: null, at: 0 });
  const resolve = async (url) => {
    if (last.current.url === url && Date.now() - last.current.at < 1000) return;
    last.current = { url, at: Date.now() };
    const mine = ++seq.current;
    setState({ status: 'loading' });
    try {
      const response = await queryAdeCore('deep_link_resolve', { url });
      if (seq.current !== mine) return;
      setState(response);
      if (response.status === 'ready') {
        openInAde(response.target);
        const win = getCurrentWindow();
        await win.show(); await win.unminimize(); await win.setFocus();
      }
      return response;
    } catch (e) { if (seq.current === mine) setState({ status: 'error', message: String(e) }); }
  };
  useEffect(() => {
    let dead = false; let off;
    const accept = (urls) => { if (!dead && urls?.length) resolve(urls[urls.length - 1]); };
    (async () => {
      try {
        const stop = await onOpenUrl(accept);
        if (dead) { stop(); return; }
        off = stop;
        accept(await getCurrent());
      } catch { /* A browser preview has no native protocol transport. */ }
    })();
    // Also used by explicit Open-in-ADE actions; it still resolves through Core.
    const event = (e) => { if (!dead && e.detail?.url) resolve(e.detail.url).then((r) => e.detail.ack?.(r?.status === 'ready')); };
    window.addEventListener('lixbon:open-link', event);
    return () => { dead = true; ++seq.current; off?.(); window.removeEventListener('lixbon:open-link', event); };
  }, []);
  if (!state) return null;
  return <aside className="f6-link" role="region" aria-label="Destino del enlace">
    <button className="btn btn--ghost btn--sm" onClick={() => { ++seq.current; setState(null); }}>Cerrar destino</button>
    {state.status === 'loading' && <p role="status">Verificando enlace con Core…</p>}
    {state.status === 'error' && <p role="alert">No se pudo abrir el destino: {state.message}</p>}
    {state.status === 'stale' && <div role="alert">
      <p>link_stale: la revisión solicitada ya no está vigente. No se abrió el recurso.</p>
      <p>Solicitada: {state.revision.requested} · Actual: {state.revision.current ?? 'desconocida'}</p>
      <button className="btn btn--ghost btn--sm" onClick={async () => {
        const mine = ++seq.current;
        try {
          const { revision, ...target } = state.target;
          const fresh = await queryAdeCore('deep_link_generate', target);
          if (seq.current === mine) { setState(fresh); if (fresh.status === 'ready') openInAde(fresh.target); }
        } catch (e) { if (seq.current === mine) setState({ status: 'error', message: String(e) }); }
      }}>Abrir explícitamente la versión actual</button>
    </div>}
    {state.status === 'ready' && <LinkDestination key={state.canonical} resolved={state} />}
  </aside>;
}
