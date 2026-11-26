import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../components/Modal';
import { providerName } from '../orch/agent/agentIdentity';
import { ProviderSelect } from '../components/ProviderSelect';
import { StatusIcon } from '@lixbon/icons/status';
import { ATTEMPT_PROFILES, createTaskOnly, createTaskWithAttempt, describeCommandError, newRequestId } from './attemptCommands';
import { useProviderCapabilities } from './useProviderCapabilities';
import './NewAttemptForm.css';

/**
 * LXO-150 · Se puede crear SOLO la Task (sin intento: queda `not_started`; hoy lo único que se le puede hacer es adoptarle un worktree externo: no hay RPC para darle su primer intento después) o la Task
 * con su primer intento. Antes de enviar, una vista previa dice QUÉ pasará con el botón o con Enter: en qué Project, qué se crea, que nada se ejecuta y
 * que el intento tendrá un worktree nuevo y propio. No hay selector de host (el Core tiene uno solo). El worktree compartido (LXO-248) no se elige aquí: se hace en el detalle del intento, antes de aprobarlo; la vista previa lo dice.
 *
 * LXO-141 · Crear una Task con su primer Attempt en el Project abierto. La persona elige proveedor, perfil y (opcional) modelo
 * y esfuerzo; lo demás —que el Attempt nazca `pending_approval`, el plazo, el worktree— lo fija el Core. Crear NO lanza nada:
 * el intento queda esperando la aprobación de la persona, que se da en el detalle del intento.
 *
 * Solo se ofrecen los proveedores que el Core dice que pueden arrancar (`start` disponible): lo que no se sabe no se habilita.
 */
const startable = (provider) => provider?.matrix?.capabilities?.start?.state === 'available';

function CreationSurface({ surface, title, subtitle, onClose, footer, children }) {
  return surface === 'page'
    ? <section className="nat-page"><header><p>{subtitle}</p><h2>{title}</h2></header>{children}<footer>{footer}</footer></section>
    : createPortal(<Modal title={title} subtitle={subtitle} onClose={onClose} footer={footer}>{children}</Modal>, document.body);
}

export function NewAttemptForm({ projectId, projectName = null, coreModel, active = true, onCreated, onCancel, surface = 'dialog', triggerLabel = 'Nuevo intento' }) {
  const uid = useId();
  const enabled = Boolean(active && projectId && coreModel?.vNext);
  const { snapshot, unsupported, probing } = useProviderCapabilities({ enabled });
  const [open, setOpen] = useState(surface === 'page');
  const [mode, setMode] = useState('attempt');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState('');
  const [profile, setProfile] = useState(ATTEMPT_PROFILES[0].id);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Una clave por INTENCIÓN: reintentar tras un fallo de red devuelve la misma Task en vez de duplicarla.
  const requestId = useRef(null);

  if (!enabled) return surface === 'page' ? <div className="ade-view-empty"><h2>Nuevo intento</h2><p>{!projectId ? 'Selecciona un proyecto primero' : 'El Core aún no permite crear tareas con intentos'}</p></div> : <button type="button" className="btn btn--ghost btn--sm" disabled title={!projectId ? 'Selecciona un proyecto primero' : 'El Core aún no permite crear tareas con intentos'}>{triggerLabel}</button>;

  const providers = (snapshot?.providers ?? []).filter(startable);
  const chosen = providers.some((p) => p.id === provider) ? provider : providers[0]?.id ?? '';
  const taskOnly = mode === 'task';
  const ready = !busy && title.trim() !== '' && (taskOnly || (Boolean(chosen) && instructions.trim() !== ''));

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    // La misma clave con OTRO payload es un conflicto en el Core: solo se reutiliza si lo que se envía es lo mismo (reintento tras un fallo de red).
    const signature = JSON.stringify([mode, title.trim(), instructions.trim(), taskOnly ? null : [chosen, profile, model.trim(), effort.trim()]]);
    if (!requestId.current || requestId.current.signature !== signature) requestId.current = { id: newRequestId(), signature };
    setBusy(true);
    setError(null);
    try {
      const base = { requestId: requestId.current.id, projectId, title: title.trim(), objective: title.trim(), spec: instructions.trim() };
      const created = taskOnly
        ? await createTaskOnly(base)
        : await createTaskWithAttempt({ ...base, attempt: { provider: chosen, profile, model, effort } });
      requestId.current = null;
      setMode('attempt');
      setTitle('');
      setInstructions('');
      setModel('');
      setEffort('');
      setOpen(surface === 'page');
      onCreated?.({ projectId, taskId: created.task_id, attemptId: created.attempt_id ?? null, status: created.status });
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const profileLabel = ATTEMPT_PROFILES.find((p) => p.id === profile)?.label ?? profile;
  const where = projectName ? `${projectName} (${projectId})` : projectId;
  let note = null;
  if (taskOnly) note = null;
  else if (unsupported) note = 'Este Core no informa de lo que ofrece cada proveedor: no se puede crear un intento.';
  else if (!snapshot) note = 'Comprobando los proveedores…';
  else if (!providers.length) {
    note = probing ? 'El Core está comprobando los proveedores…' : 'Ningún proveedor puede arrancar un intento ahora mismo; mira «Proveedores» más abajo.';
  }

  return (
    <section className={`nat${surface === 'page' ? ' nat--page' : ''}`} aria-label="Nuevo intento" data-testid="new-attempt">
      <button type="button" hidden={open || surface === 'page'} className="btn btn--ghost btn--sm" onClick={() => setOpen(true)} data-testid="new-attempt-open">{triggerLabel}</button>
      {open && (
        <CreationSurface surface={surface} title="Nuevo intento" subtitle={projectName || projectId} onClose={() => { if (!busy) { setOpen(false); setError(null); requestId.current = null; onCancel?.(); } }} footer={<div className="nat__actions"><button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); setError(null); requestId.current = null; onCancel?.(); }} disabled={busy}>Cancelar</button><button type="submit" form={`${uid}-form`} className="btn btn--primary btn--sm" disabled={!ready} data-testid="new-attempt-submit">{busy ? 'Creando…' : taskOnly ? 'Crear tarea' : 'Crear intento'}</button></div>}>
        <form id={`${uid}-form`} className="nat__form" onSubmit={submit} data-testid="new-attempt-form">
          <details className="nat__extra"><summary>Opciones de creación</summary>
          <fieldset className="nat__field nat__modes" data-testid="new-attempt-modes">
            <legend>¿Qué creas?</legend>
            <label>
              <input type="radio" name={`${uid}-mode`} value="attempt" checked={!taskOnly} onChange={() => { setMode('attempt'); setError(null); }} data-testid="new-attempt-mode-attempt" />
              {' '}La tarea y su primer intento (espera tu aprobación)
            </label>
            <label>
              <input type="radio" name={`${uid}-mode`} value="task" checked={taskOnly} onChange={() => { setMode('task'); setError(null); }} data-testid="new-attempt-mode-task" />
              {' '}Solo la tarea, sin ejecutar (después puedes adoptarle un worktree externo)
            </label>
          </fieldset>
          </details>
          {/* Se anuncia el CAMBIO DE MODO, no cada letra del título (la vista previa de abajo no es una región viva). */}
          <p className="nat__sr" role="status" data-testid="new-attempt-announce">
            {taskOnly ? 'Se creará solo la tarea, sin intento.' : 'Se creará la tarea y su primer intento, que esperará tu aprobación.'}
          </p>
          {note && <p className="nat__note" role="status" data-testid="new-attempt-note">{note}</p>}
          <label className="nat__field" htmlFor={`${uid}-title`}>
            <span>Título de la tarea</span>
            <input id={`${uid}-title`} type="text" value={title} maxLength={512} onChange={(e) => setTitle(e.target.value)} data-testid="new-attempt-title" />
          </label>
          <label className="nat__field" htmlFor={`${uid}-instructions`}>
            <span>{taskOnly ? 'Instrucciones (opcional)' : 'Qué tiene que conseguir'}</span>
            <textarea id={`${uid}-instructions`} rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="new-attempt-instructions" />
          </label>
          {!taskOnly && (<>
          <div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-provider`}>
              <span>Agente</span>
              <ProviderSelect id={`${uid}-provider`} providers={providers} value={chosen} onChange={(e) => setProvider(e.target.value)} disabled={!providers.length || busy} data-testid="new-attempt-provider" />
            </label>
            <div className="nat__field"><span>Host</span><div className="nat__host" title="El Core crea el worktree en este equipo al aprobar el intento"><StatusIcon kind="monitor" size={16} /><span>Este equipo</span></div></div>
          </div>
            <label className="nat__field" htmlFor={`${uid}-profile`}>
              <span>Autonomía</span>
              <select id={`${uid}-profile`} value={profile} onChange={(e) => setProfile(e.target.value)} data-testid="new-attempt-profile">
                {ATTEMPT_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          <details className="nat__extra"><summary>Modelo y esfuerzo</summary><div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-model`}>
              <span>Modelo (opcional)</span>
              <input id={`${uid}-model`} type="text" value={model} maxLength={128} onChange={(e) => setModel(e.target.value)} data-testid="new-attempt-model" />
            </label>
            <label className="nat__field" htmlFor={`${uid}-effort`}>
              <span>Esfuerzo (opcional)</span>
              <input id={`${uid}-effort`} type="text" value={effort} maxLength={128} onChange={(e) => setEffort(e.target.value)} data-testid="new-attempt-effort" />
            </label>
          </div></details>
          </>)}
          {!taskOnly && <p className="nat__note">El intento esperará tu aprobación antes de ejecutarse.</p>}
          <details className="nat__extra"><summary>Qué ocurrirá al crear</summary>
          <div className="nat__preview" role="region" aria-label="Qué ocurrirá al crear" data-testid="new-attempt-preview">
            <strong>{taskOnly ? 'Crear (o Enter) hará esto:' : 'Crear el intento (o Enter) hará esto:'}</strong>
            <ul>
              <li data-testid="new-attempt-preview-project">Proyecto: <span className="mono">{where}</span> (el que tienes abierto; no se deduce de ninguna carpeta).</li>
              {taskOnly ? (
                <li data-testid="new-attempt-preview-what">Crea la tarea «{title.trim() || '…'}» sin intento: no hay worktree ni proveedor y no se ejecuta nada.</li>
              ) : (
                <>
                  <li data-testid="new-attempt-preview-what">Crea la tarea «{title.trim() || '…'}» y su intento 1 con <span>{chosen ? providerName(chosen) : '…'}</span> · {profileLabel}{model.trim() ? ` · ${model.trim()}` : ''}{effort.trim() ? ` · ${effort.trim()}` : ''}.</li>
                  <li data-testid="new-attempt-preview-approval">Nada se ejecuta todavía: el intento queda esperando tu aprobación.</li>
                  <li data-testid="new-attempt-preview-worktree">Al aprobarlo, el Core le dará un worktree nuevo y propio, en este equipo. Si prefieres reutilizar el de otro intento del Project, elígelo en el detalle del intento antes de aprobarlo.</li>
                </>
              )}
            </ul>
          </div>
          </details>
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="new-attempt-error">
              <span>{error.message}</span>
              {error.detail !== error.message && (
                <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
              )}
            </div>
          )}
        </form></CreationSurface>
      )}
    </section>
  );
}
