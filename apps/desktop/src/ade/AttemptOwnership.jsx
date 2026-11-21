import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCoreQuery } from './useCoreQuery';
import { useProviderCapabilities } from './useProviderCapabilities';
import { canDo } from './capabilityModel';
import { describeCommandError, newRequestId } from './attemptCommands';
import { openAttemptWorkspace } from './f6Navigation';

export function AttemptOwnership({ attempt, active = true, onChanged }) {
  const state = useCoreQuery('attempt_return_preview', { attempt_id: attempt.id }, { enabled: active, pollMs: 3000 });
  const { snapshot } = useProviderCapabilities({ enabled: active && attempt.status === 'running' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const guard = useRef(false);
  const data = state.status === 'ready' ? state.data : null;
  const human = data?.owner === 'human';
  const canTake = data?.owner === 'agent' && attempt.status === 'running' && attempt.provider_session?.resumable
    && canDo(snapshot, attempt.provider, 'interrupt') && canDo(snapshot, attempt.provider, 'resume');
  const command = async () => {
    if (guard.current || !confirm) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      // New key after a rejected request: the Core remembers failed outcomes as well.
      const result = await invoke('orch_call', { cmd: confirm === 'take' ? 'attempt_take_over' : 'attempt_return_to_agent',
        args: { attempt_id: attempt.id, request_id: newRequestId(), confirm: true } });
      const took = confirm === 'take';
      if (result?.attempt_id !== attempt.id || result.owner !== (took ? 'human' : 'agent')
        || ![took ? 'TakenOver' : 'Returned', 'Replayed'].includes(result.status)) {
        throw new Error('invalid_response: Core no confirmó el cambio de propietario de este Attempt.');
      }
      setConfirm(null); state.retry(); onChanged?.();
      // Core has confirmed its safe boundary; only now may this CTA open the human workspace.
      if (took) await openAttemptWorkspace(attempt.id);
    } catch (e) { setError(describeCommandError(e).message); state.retry(); }
    finally { guard.current = false; setBusy(false); }
  };
  const changes = data?.human_changes;
  return <section className="f6-card" aria-label="Control del intento">
    <h4>Control del intento</h4>
    <p role="status">{busy ? 'Esperando confirmación del Core…' : data ? (human ? 'Tú tienes el control de este Attempt.' : 'El agente tiene el control.') : 'No se pudo verificar quién tiene el control.'}</p>
    {state.error && <p role="alert">{state.error}</p>}
    {!confirm && <div className="nat__actions">
      {canTake && <button className="btn btn--ghost btn--sm" onClick={() => setConfirm('take')}>Take Over…</button>}
      {human && <button className="btn btn--ghost btn--sm" disabled={!data.can_return} title={data.blocker?.message} onClick={() => setConfirm('return')}>Return to Agent…</button>}
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={async () => { try { await openAttemptWorkspace(attempt.id); } catch (e) { setError(describeCommandError(e).message); } }}>Abrir workspace en IDE</button>
    </div>}
    {human && data.blocker && <p>{data.blocker.message}</p>}
    {confirm && <div>
      {confirm === 'take' ? <p>Interrumpir al agente en una frontera segura y trabajar en el mismo Attempt y worktree.</p> : <>
        <p>Reanudar la misma sesión con tus cambios actuales, sin descartarlos.</p>
        {changes ? <div>
          <p>Procedencia: {changes.provenance} · {changes.completeness}. Base {changes.base_commit ?? 'desconocida'} → {changes.head_commit ?? 'desconocida'}</p>
          <p>Commits: {changes.commits?.total ?? 'desconocido'} · archivos: {changes.files?.total ?? 'desconocido'} · sin commit: {changes.uncommitted?.total ?? 'desconocido'}</p>
          <ul>{changes.uncommitted?.items?.map((f) => <li key={f.path}>{f.status} {f.path}</li>)}</ul>
          {changes.gaps?.length > 0 && <p role="alert">No se pudo comprobar: {changes.gaps.join(', ')}</p>}
        </div> : <p role="alert">Cambios humanos no disponibles.</p>}
      </>}
      <button className="btn btn--primary btn--sm" disabled={busy || (confirm === 'take' ? !canTake : !human || !data?.can_return || !changes)} onClick={command}>{busy ? 'Esperando…' : 'Confirmar'}</button>
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirm(null)}>Cancelar</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
