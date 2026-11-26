import { FileIcon } from '@lixbon/icons/file-icons';
import { useCoreQuery } from './useCoreQuery';
import { CoreModelNotice } from './CoreModelNotice';
import { AutonomyEditor } from './AutonomyEditor';
import { ContextPreview, ContextPackageResult } from './ContextPreview';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { queryAdeCore } from './coreQueries';
import { describeSections, sizeEstimate } from './contextPreviewModel';
import { StatusIcon } from '@lixbon/icons/status';
import { ATTEMPT_PROFILES, describeCommandError } from './attemptCommands';
import { createPortal } from 'react-dom';
import { Modal } from '../components/Modal';
import { AttemptPinnedDiff } from './AttemptPinnedDiff';

const POLICY_LABELS = { start: 'Arrancar intentos', answer: 'Responder preguntas', queue: 'Encolar instrucciones', steer: 'Corregir el turno', stop: 'Detener y enviar', fork: 'Bifurcar', review: 'Revisar', integrate: 'Integrar', cleanup: 'Limpiar recursos', provider_permissions: 'Permisos del proveedor' };

export function CoreAutonomy({ projectId, attemptId, active, profile }) {
  const state = useCoreQuery('policy_effective', { project_id: projectId, attempt_id: attemptId }, { enabled: Boolean(active && attemptId) });
  const categories = state.data?.categories;
  return <div className="ade-core-autonomy">
    <h3>Perfil de autonomía</h3>
    <p className="ade-core-autonomy__profile">{ATTEMPT_PROFILES.find(p => p.id === profile)?.label || profile || 'Perfil no informado'}</p>
    {state.error && <CoreModelNotice error={state.error} onRetry={state.retry} />}
    {[[['allow'], 'Lo hace solo'], [['confirm', 'elevated'], 'Te pregunta antes'], [['deny'], 'Nunca lo hace']].map(([levels, title]) => <section key={title}><h4>{title}</h4>{categories ? <ul>{categories.filter((item) => levels.includes(item.level)).map((item) => <li key={item.category}>{POLICY_LABELS[item.category]}{!item.enforced && <span> · declarado, aún no aplicado</span>}{item.level === 'elevated' && <span> · confirmación fuera de banda</span>}</li>)}{!categories.some((item) => levels.includes(item.level)) && <li>Ninguna acción en este nivel.</li>}</ul> : <p>{state.status === 'loading' ? 'Cargando…' : 'No informado'}</p>}</section>)}
    <p>Lo rutinario lo hace solo; lo delicado te lo pregunta. Integrar siempre lo decides tú.</p>
    {attemptId && <AutonomyEditor key={attemptId} attemptId={attemptId} projectId={projectId} />}
  </div>;
}

export function CoreContext({ attemptId, projectId, active }) {
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(null);
  useEffect(() => () => { pending.current = null; }, []);
  const prepare = async () => {
    if (busy || !active || !attemptId || !projectId) return;
    const request = {};
    pending.current = request;
    setBusy(true); setError(''); setResponse(null);
    try {
      const built = await invoke('orch_call', { cmd: 'context_package_build', args: { attempt_id: attemptId } });
      const verified = await queryAdeCore('context_package_preview', { package: JSON.stringify(built.package) });
      if (pending.current !== request) return;
      if (verified.status !== 'valid' || verified.package?.source?.attempt_id !== attemptId || verified.package?.source?.project_id !== projectId) throw new Error('El contexto no corresponde al intento seleccionado.');
      setResponse(verified);
    } catch (failure) { if (pending.current === request) setError(describeCommandError(failure).message); }
    finally { if (pending.current === request) { pending.current = null; setBusy(false); } }
  };
  const sections = response ? describeSections(response.package, response.summary) : null;
  const size = response ? sizeEstimate(response.summary) : null;
  return <div className="ade-core-context">
    <h3>Paquete de contexto</h3>
    <p>Lo que recibe el siguiente agente, sea cual sea: un resumen, no la conversación entera.</p>
    <button type="button" className="btn btn--ghost" onClick={prepare} disabled={busy || !attemptId || !projectId || !active}>{busy ? 'Preparando…' : response ? 'Actualizar contexto' : 'Preparar contexto'}</button>
    {error && <p className="ade-notice ade-notice--error" role="alert">{error}</p>}
    {!response && <p className="ade-core-context__empty">Prepara el paquete para ver qué información incluiría este intento.</p>}
    {sections ? <ul className="ade-core-context__checklist">{sections.map(section => <li key={section.id}><StatusIcon kind={section.state === 'included' ? 'done' : 'paused'} size={16} /><span>{section.label}<small>{section.state === 'included' ? 'Incluido' : section.state === 'omitted' ? 'Omitido en parte' : 'Ausente'}{section.detail ? ` · ${section.detail}` : ''}</small></span></li>)}</ul> : <dl>{['Objetivo de la tarea', 'Restricciones y decisiones', 'Lo relevante de la conversación', 'Cambios del repositorio desde la base', 'Resumen del intento', 'Estado de las pruebas', 'Transcripción completa'].map((label) => <div key={label}><dt>{label}</dt><dd>No informado</dd></div>)}</dl>}
    {response && <><p className="ade-core-context__size">{size.package} · ≈ {size.approxTokens} tokens estimados</p><details><summary>Contenido verificado y omisiones</summary><ContextPackageResult response={response} /></details></>}
    <h4>Secretos</h4><p>{response ? 'Paquete verificado por el Core. Revisa las omisiones y los avisos de los adjuntos.' : 'No informado'}</p><h4>Compartido con</h4><p>No informado</p>
    <details><summary>Revisar un paquete desde un archivo</summary><ContextPreview /></details>
  </div>;
}

export function CoreChanges({ attemptId, attempt, proofState, active, onReview }) {
  const [file, setFile] = useState(null);
  const own = useCoreQuery('attempt_proof_pack', { attempt_id: attemptId }, { enabled: Boolean(active && attemptId && !proofState) });
  const state = proofState ?? own;
  const pack = state.data;
  const changes = pack?.changes;
  const known = (evidence) => evidence && evidence.provenance !== 'unknown';
  const head = known(pack?.revision?.head_commit) ? pack.revision.head_commit.value : null;
  const canOpenDiff = Boolean(head && attempt?.id === attemptId);
  return <div className="ade-core-changes">
    <h3>Desde la base{known(changes?.files) ? ` · ${changes.files.value} archivos` : ''}</h3>
    {!attemptId && <p>Elige un intento para ver sus archivos cambiados.</p>}
    {state.error && <CoreModelNotice error={state.error} onRetry={state.retry} />}
    <div className="ade-core-changes__stats"><span>{known(changes?.additions) ? `+${changes.additions.value}` : 'No informado'}</span><span>{known(changes?.deletions) ? `−${changes.deletions.value}` : ''}</span></div>
    <p>Pruebas · {known(pack?.tests) ? String(pack.tests.value) : 'No informado'}</p>
    <h4>Archivos</h4>
    {changes?.list?.length ? <ul>{changes.list.map((changed) => <li key={changed.path}><button type="button" className="ade-core-changes__file" title={canOpenDiff ? changed.path : `${changed.path} · Revisión no disponible`} disabled={!canOpenDiff} onClick={()=>setFile({path:changed.path,revision:head})}><FileIcon nombre={changed.path} size={16} /><span>{changed.path.split('/').pop()}</span><span className="ade-core-changes__file-stat">{changed.additions === null || changed.deletions === null ? 'Binario' : <><em className="is-add">+{changed.additions}</em> <em className="is-del">−{changed.deletions}</em></>}</span></button></li>)}</ul> : <p>No hay archivos informados.</p>}
    <p className="ade-core-changes__risk">Riesgo por archivo · No informado</p>
    <h4>Revisión</h4><div className="ade-core-changes__actions"><button type="button" className="btn btn--ghost" disabled={!attemptId} onClick={onReview}>Pruebas del intento</button><button type="button" className="btn btn--ghost" disabled={!attemptId} onClick={onReview}>Revisar los cambios</button></div>
    <p>{Number.isSafeInteger(pack?.coverage?.covered_files) ? `${pack.coverage.covered_files} archivos revisados` : 'Revisión por archivo no informada.'}</p>
    {file && attempt?.id === attemptId && createPortal(<Modal title={file.path.split('/').pop()} subtitle={`Diff desde la base · revisión ${file.revision.slice(0,12)}`} size="lg" onClose={()=>setFile(null)}><AttemptPinnedDiff attempt={attempt} revision={file.revision} file={file.path} /></Modal>,document.body)}
  </div>;
}
