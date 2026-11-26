import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { queryAdeCore } from './coreQueries';
import { useProviderCapabilities } from './useProviderCapabilities';
import { ATTEMPT_PROFILES, describeCommandError, newRequestId } from './attemptCommands';
import { ContextPackageResult } from './ContextPreview';
import { openInAde } from './f6Navigation';
import { ProviderSelect } from '../components/ProviderSelect';

/** Both flows use a Core-verified package and an explicit recipient. Success never changes focus. */
export function AttemptTransfer({ attempt, task, projectId, source: incomingSource, active = true }) {
  const [kind, setKind] = useState(null);
  const [source, setSource] = useState(undefined);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [profile, setProfile] = useState('explorar');
  const [instruction, setInstruction] = useState('');
  const [newTask, setNewTask] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [pkg, setPkg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const guard = useRef(false);
  const request = useRef(null);
  const { snapshot } = useProviderCapabilities({ enabled: active && Boolean(kind) });
  const providers = (snapshot?.providers ?? []).filter((p) => p.matrix?.capabilities?.start?.state === 'available');
  const final = ['done', 'failed', 'stopped', 'exited'].includes(attempt?.status);
  const project = projectId ?? attempt?.project_id;
  const touch = () => { request.current = null; setReviewed(false); setError(null); };
  const start = (flow) => { setSource(incomingSource ? { ...incomingSource } : undefined); setKind(flow); setPkg(null); setResult(null); touch(); };
  const build = async () => {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null); setReviewed(false);
    try {
      const built = await invoke('orch_call', { cmd: 'context_package_build', args: { attempt_id: attempt.id } });
      const verified = await queryAdeCore('context_package_preview', { package: JSON.stringify(built.package) });
      if (verified.status !== 'valid' || verified.package?.source?.attempt_id !== attempt.id || verified.package?.source?.project_id !== project) throw new Error('context_package_source_mismatch');
      setPkg(verified);
    } catch (e) { setError(describeCommandError(e).message); }
    finally { guard.current = false; setBusy(false); }
  };
  const ready = !busy && provider && providers.some((p) => p.id === provider) && reviewed
    && (attempt ? pkg?.status === 'valid' : Boolean(task?.id || (source?.file && source?.revision)))
    && (kind === 'handoff' ? final : instruction.trim() && (!(attempt || task) || newTask));
  const send = async (event) => {
    event.preventDefault();
    if (!ready || guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    request.current ??= newRequestId().slice(0, 60);
    try {
      const args = kind === 'handoff'
        ? { task_id: attempt.task_id, from_attempt_id: attempt.id, provider, ...(model.trim() && { model: model.trim() }), ...(instruction.trim() && { instruction: instruction.trim() }), package_id: pkg.package_id }
        : { request_id: request.current, project_id: project, ...(attempt ? { attempt_id: attempt.id, new_task: true, package: JSON.stringify(pkg.package) } : task ? { task_id: task.id, new_task: true } : {}),
          ...source, instruction: instruction.trim(), provider, ...(model.trim() && { model: model.trim() }), profile };
      const outcome = await invoke('orch_call', { cmd: kind === 'handoff' ? 'attempt_handoff' : 'attempt_delegate', args });
      if (!outcome?.attempt_id || !outcome?.task_id || !['Requested', 'Replayed'].includes(outcome.status)) throw new Error('Respuesta de transferencia inválida; verifica Activity antes de reintentar.');
      setResult(outcome);
    } catch (e) { setError(describeCommandError(e).message); }
    finally { guard.current = false; setBusy(false); }
  };
  if (!project) return null;
  return <section className="f6-card" aria-label="Delegar y transferir contexto">
    {!kind ? <div className="nat__actions">
      <button className="btn btn--ghost btn--sm" onClick={() => start('delegate')}>Delegate…</button>
      {final && <button className="btn btn--ghost btn--sm" onClick={() => start('handoff')}>Agent Handoff…</button>}
    </div> : result ? <div role="status">
      <p>{kind === 'handoff' ? 'Handoff registrado. Consulta el nuevo Attempt para seguir su lanzamiento.' : 'Delegación creada, pendiente de aprobación.'} {result.attempt_id}</p>
      <button className="lk" onClick={() => openInAde({ project_id: project, task_id: result.task_id, attempt_id: result.attempt_id })}>Abrir Attempt nuevo</button>
      <button className="lk" onClick={() => setKind(null)}>Cerrar</button>
    </div> : <form onSubmit={send}>
      <h4>{kind === 'handoff' ? 'Agent Handoff' : 'Delegate'}</h4>
      <p>FROM: {attempt ? `${attempt.task_id} / ${attempt.id} · ${attempt.provider} · ${attempt.status}` : task?.id ?? project}</p>
      {source?.file && <p>Origen: {source.file}:{source.line ?? 1}{source.end_line ? `–${source.end_line}` : ''} · revisión {source.revision}</p>}
      {kind === 'delegate' && (attempt || task) && <label><input type="checkbox" checked={newTask} disabled={busy} onChange={(e) => { setNewTask(e.target.checked); touch(); }} /> Crear una Task nueva desde este origen</label>}
      <p>{kind === 'handoff' ? 'Continúa la misma Task en un Attempt nuevo. Se conserva el perfil; Core determina el worktree local. No se transfiere la sesión del proveedor.' : 'Crea una Task y Attempt nuevos, sujetos a aprobación. Core determina el worktree local.'}</p>
      <label>TO · Proveedor <ProviderSelect aria-label="Proveedor receptor" providers={providers} placeholder="Elige un proveedor" value={provider} disabled={busy} onChange={(e) => { setProvider(e.target.value); touch(); }} /></label>
      <label>Modelo opcional <input value={model} maxLength={200} disabled={busy} onChange={(e) => { setModel(e.target.value); touch(); }} /></label>
      {kind === 'delegate' && <label>Perfil <select value={profile} disabled={busy} onChange={(e) => { setProfile(e.target.value); touch(); }}>{ATTEMPT_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
      <label>Encargo <textarea value={instruction} rows={3} maxLength={12000} disabled={busy} onChange={(e) => { setInstruction(e.target.value); touch(); }} /></label>
      {attempt && <><button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={build}>Construir y verificar ContextPackage</button>
        {pkg && <ContextPackageResult response={pkg} />}</>}
      <label><input type="checkbox" checked={reviewed} disabled={busy || (attempt && !pkg)} onChange={(e) => setReviewed(e.target.checked)} /> Revisé el origen, el receptor y {attempt ? 'el contexto y sus omisiones' : task ? 'la Task de origen' : 'el rango de código'}; confirmo esta transferencia</label>
      <div className="nat__actions"><button className="btn btn--primary btn--sm" disabled={!ready}>{busy ? 'Procesando…' : 'Confirmar transferencia'}</button><button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setKind(null)}>Cancelar</button></div>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
