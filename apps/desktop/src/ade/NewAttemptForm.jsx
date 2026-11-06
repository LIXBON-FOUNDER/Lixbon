import { useId, useRef, useState } from 'react';
import { ATTEMPT_PROFILES, createTaskOnly, createTaskWithAttempt, describeCommandError, newRequestId } from './attemptCommands';
import { useProviderCapabilities } from './useProviderCapabilities';
import './NewAttemptForm.css';

/**
 * LXO-150 · Se puede crear SOLO la Task (sin intento: queda `not_started`, para adoptarle un worktree externo o darle el intento después) o la Task
 * con su primer intento. Antes de enviar, una vista previa dice QUÉ pasará con el botón o con Enter: en qué Project, qué se crea, que nada se ejecuta y
 * que el intento tendrá un worktree nuevo y propio. No hay selector de host (el Core tiene uno solo) ni worktree compartido (no existe): se dice, no se oculta.
 *
 * LXO-141 · Crear una Task con su primer Attempt en el Project abierto. La persona elige proveedor, perfil y (opcional) modelo
 * y esfuerzo; lo demás —que el Attempt nazca `pending_approval`, el plazo, el worktree— lo fija el Core. Crear NO lanza nada:
 * el intento queda esperando la aprobación de la persona, que se da en el detalle del intento.
 *
 * Solo se ofrecen los proveedores que el Core dice que pueden arrancar (`start` disponible): lo que no se sabe no se habilita.
 */
const startable = (provider) => provider?.matrix?.capabilities?.start?.state === 'available';

export function NewAttemptForm({ projectId, projectName = null, coreModel, active = true, onCreated }) {
  const uid = useId();
  const enabled = Boolean(active && projectId && coreModel?.vNext);
  const { snapshot, unsupported, probing } = useProviderCapabilities({ enabled });
  const [open, setOpen] = useState(false);
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

  if (!enabled) return null;

  const providers = (snapshot?.providers ?? []).filter(startable);
  const chosen = providers.some((p) => p.id === provider) ? provider : providers[0]?.id ?? '';
  const taskOnly = mode === 'task';
  const ready = !busy && title.trim() !== '' && (taskOnly || (Boolean(chosen) && instructions.trim() !== ''));

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    requestId.current ??= newRequestId();
    setBusy(true);
    setError(null);
    try {
      const base = { requestId: requestId.current, projectId, title: title.trim(), objective: title.trim(), spec: instructions.trim() };
      const created = taskOnly
        ? await createTaskOnly(base)
        : await createTaskWithAttempt({ ...base, attempt: { provider: chosen, profile, model, effort } });
      requestId.current = null;
      setTitle('');
      setInstructions('');
      setModel('');
      setEffort('');
      setOpen(false);
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
    <section className="nat" aria-label="Nuevo intento" data-testid="new-attempt">
      {!open ? (
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setOpen(true)} data-testid="new-attempt-open">Nuevo intento</button>
      ) : (
        <form className="nat__form" onSubmit={submit} data-testid="new-attempt-form">
          <h3 className="ssec__label">Nuevo intento</h3>
          <fieldset className="nat__field nat__modes" data-testid="new-attempt-modes">
            <legend>¿Qué creas?</legend>
            <label>
              <input type="radio" name={`${uid}-mode`} value="attempt" checked={!taskOnly} onChange={() => setMode('attempt')} data-testid="new-attempt-mode-attempt" />
              {' '}La tarea y su primer intento (espera tu aprobación)
            </label>
            <label>
              <input type="radio" name={`${uid}-mode`} value="task" checked={taskOnly} onChange={() => setMode('task')} data-testid="new-attempt-mode-task" />
              {' '}Solo la tarea, sin ejecutar (después puedes adoptarle un worktree externo o crearle el intento)
            </label>
          </fieldset>
          {note && <p className="nat__note" role="status" data-testid="new-attempt-note">{note}</p>}
          <label className="nat__field" htmlFor={`${uid}-title`}>
            <span>Título de la tarea</span>
            <input id={`${uid}-title`} type="text" value={title} maxLength={512} onChange={(e) => setTitle(e.target.value)} data-testid="new-attempt-title" />
          </label>
          <label className="nat__field" htmlFor={`${uid}-instructions`}>
            <span>{taskOnly ? 'Instrucciones (opcional)' : 'Instrucciones para el agente'}</span>
            <textarea id={`${uid}-instructions`} rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="new-attempt-instructions" />
          </label>
          {!taskOnly && (<>
          <div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-provider`}>
              <span>Proveedor</span>
              <select id={`${uid}-provider`} value={chosen} onChange={(e) => setProvider(e.target.value)} disabled={!providers.length} data-testid="new-attempt-provider">
                {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
            </label>
            <label className="nat__field" htmlFor={`${uid}-profile`}>
              <span>Perfil de permisos</span>
              <select id={`${uid}-profile`} value={profile} onChange={(e) => setProfile(e.target.value)} data-testid="new-attempt-profile">
                {ATTEMPT_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-model`}>
              <span>Modelo (opcional)</span>
              <input id={`${uid}-model`} type="text" value={model} maxLength={128} onChange={(e) => setModel(e.target.value)} data-testid="new-attempt-model" />
            </label>
            <label className="nat__field" htmlFor={`${uid}-effort`}>
              <span>Esfuerzo (opcional)</span>
              <input id={`${uid}-effort`} type="text" value={effort} maxLength={128} onChange={(e) => setEffort(e.target.value)} data-testid="new-attempt-effort" />
            </label>
          </div>
          </>)}
          <div className="nat__preview" role="region" aria-label="Qué ocurrirá al crear" aria-live="polite" data-testid="new-attempt-preview">
            <strong>{taskOnly ? 'Crear (o Enter) hará esto:' : 'Crear el intento (o Enter) hará esto:'}</strong>
            <ul>
              <li data-testid="new-attempt-preview-project">Proyecto: <span className="mono">{where}</span> (el que tienes abierto; no se deduce de ninguna carpeta).</li>
              {taskOnly ? (
                <li data-testid="new-attempt-preview-what">Crea la tarea «{title.trim() || '…'}» sin intento: no hay worktree ni proveedor y no se ejecuta nada.</li>
              ) : (
                <>
                  <li data-testid="new-attempt-preview-what">Crea la tarea «{title.trim() || '…'}» y su intento 1 con <span className="mono">{chosen || '…'}</span> · {profileLabel}{model.trim() ? ` · ${model.trim()}` : ''}{effort.trim() ? ` · ${effort.trim()}` : ''}.</li>
                  <li data-testid="new-attempt-preview-approval">Nada se ejecuta todavía: el intento queda esperando tu aprobación.</li>
                  <li data-testid="new-attempt-preview-worktree">Al aprobarlo, el Core le dará un worktree nuevo y propio (no se comparte con otras tareas), en este equipo.</li>
                </>
              )}
            </ul>
          </div>
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="new-attempt-error">
              <span>{error.message}</span>
              {error.detail !== error.message && (
                <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
              )}
            </div>
          )}
          <div className="nat__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!ready} data-testid="new-attempt-submit">{busy ? 'Creando…' : taskOnly ? 'Crear tarea' : 'Crear intento'}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
