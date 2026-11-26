import { FileIcon } from '@lixbon/icons/file-icons';
import { useCoreQuery } from './useCoreQuery';
import { CoreModelNotice } from './CoreModelNotice';
import { AutonomyEditor } from './AutonomyEditor';
import { ContextPreview } from './ContextPreview';

const POLICY_LABELS = { start: 'Arrancar intentos', answer: 'Responder preguntas', queue: 'Encolar instrucciones', steer: 'Corregir el turno', stop: 'Detener y enviar', fork: 'Bifurcar', review: 'Revisar', integrate: 'Integrar', cleanup: 'Limpiar recursos', provider_permissions: 'Permisos del proveedor' };

export function CoreAutonomy({ projectId, attemptId, active }) {
  const state = useCoreQuery('policy_effective', { project_id: projectId, attempt_id: attemptId }, { enabled: Boolean(active && attemptId) });
  const categories = state.data?.categories;
  return <div className="ade-core-autonomy">
    <h3>Perfil de autonomía</h3>
    {state.error && <CoreModelNotice error={state.error} onRetry={state.retry} />}
    {[[['allow'], 'Lo hace solo'], [['confirm', 'elevated'], 'Te pregunta antes'], [['deny'], 'Nunca lo hace']].map(([levels, title]) => <section key={title}><h4>{title}</h4>{categories ? <ul>{categories.filter((item) => levels.includes(item.level)).map((item) => <li key={item.category}>{POLICY_LABELS[item.category]}{!item.enforced && <span> · declarado, aún no aplicado</span>}{item.level === 'elevated' && <span> · confirmación fuera de banda</span>}</li>)}{!categories.some((item) => levels.includes(item.level)) && <li>Ninguna acción en este nivel.</li>}</ul> : <p>{state.status === 'loading' ? 'Cargando…' : 'No informado'}</p>}</section>)}
    <p>Lo rutinario lo hace solo; lo delicado te lo pregunta. Integrar siempre lo decides tú.</p>
    {attemptId && <AutonomyEditor key={attemptId} attemptId={attemptId} projectId={projectId} />}
  </div>;
}

export function CoreContext() {
  return <div className="ade-core-context">
    <h3>Paquete de contexto</h3>
    <p>Lo que recibe el siguiente agente, sea cual sea: un resumen, no la conversación entera.</p>
    <p className="ade-core-context__empty">No hay un paquete de contexto informado para este intento.</p>
    <dl>{['Objetivo de la tarea', 'Restricciones y decisiones', 'Lo relevante de la conversación', 'Cambios del repositorio desde la base', 'Resumen del intento', 'Estado de las pruebas', 'Transcripción completa'].map((label) => <div key={label}><dt>{label}</dt><dd>No informado</dd></div>)}</dl>
    <h4>Secretos</h4><p>No informado</p><h4>Compartido con</h4><p>No informado</p>
    <details><summary>Revisar un paquete desde un archivo</summary><ContextPreview /></details>
  </div>;
}

export function CoreChanges({ attemptId, active, onReview }) {
  const state = useCoreQuery('attempt_proof_pack', { attempt_id: attemptId }, { enabled: Boolean(active && attemptId) });
  const pack = state.data;
  const changes = pack?.changes;
  const known = (evidence) => evidence && evidence.provenance !== 'unknown';
  return <div className="ade-core-changes">
    <h3>Desde la base{known(changes?.files) ? ` · ${changes.files.value} archivos` : ''}</h3>
    {!attemptId && <p>Elige un intento para ver sus archivos cambiados.</p>}
    {state.error && <CoreModelNotice error={state.error} onRetry={state.retry} />}
    <div className="ade-core-changes__stats"><span>{known(changes?.additions) ? `+${changes.additions.value}` : 'No informado'}</span><span>{known(changes?.deletions) ? `−${changes.deletions.value}` : ''}</span></div>
    <p>Pruebas · {known(pack?.tests) ? String(pack.tests.value) : 'No informado'}</p>
    <h4>Archivos</h4>
    {changes?.list?.length ? <ul>{changes.list.map((file) => <li key={file.path}><FileIcon nombre={file.path} size={16} /><code>{file.path}</code><span>{file.additions === null ? 'Binario' : `+${file.additions} −${file.deletions}`}</span></li>)}</ul> : <p>No hay archivos informados.</p>}
    <p className="ade-core-changes__risk">Riesgo por archivo · No informado</p>
    <h4>Revisión</h4><div className="ade-core-changes__actions"><button type="button" className="btn btn--ghost" disabled={!attemptId} onClick={onReview}>Pruebas del intento</button><button type="button" className="btn btn--ghost" disabled={!attemptId} onClick={onReview}>Revisar los cambios</button></div>
    <p>{pack?.coverage ? `${pack.coverage.covered_files} archivos revisados` : 'Revisión por archivo no informada.'}</p>
  </div>;
}
