import { useId, useRef, useState } from 'react';
import { ATTEMPT_PROFILES, createTaskWithAttempt, describeCommandError, newRequestId } from './attemptCommands';
import { useProviderCapabilities } from './useProviderCapabilities';
import './NewAttemptForm.css';

/**
 * LXO-141 · Crear una Task con su primer Attempt en el Project abierto. La persona elige proveedor, perfil y (opcional) modelo
 * y esfuerzo; lo demás —que el Attempt nazca `pending_approval`, el plazo, el worktree— lo fija el Core. Crear NO lanza nada:
 * el intento queda esperando la aprobación de la persona, que se da en el detalle del intento.
 *
 * Solo se ofrecen los proveedores que el Core dice que pueden arrancar (`start` disponible): lo que no se sabe no se habilita.
 */
const startable = (provider) => provider?.matrix?.capabilities?.start?.state === 'available';

export function NewAttemptForm({ projectId, coreModel, active = true, onCreated }) {
  const uid = useId();
  const enabled = Boolean(active && projectId && coreModel?.vNext);
  const { snapshot, unsupported, probing } = useProviderCapabilities({ enabled });
  const [open, setOpen] = useState(false);
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
  const ready = Boolean(chosen) && title.trim() !== '' && instructions.trim() !== '' && !busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    requestId.current ??= newRequestId();
    setBusy(true);
    setError(null);
    try {
      const created = await createTaskWithAttempt({
        requestId: requestId.current,
        projectId,
        title: title.trim(),
        objective: title.trim(),
        spec: instructions.trim(),
        attempt: { provider: chosen, profile, model, effort },
      });
      requestId.current = null;
      setTitle('');
      setInstructions('');
      setModel('');
      setEffort('');
      setOpen(false);
      onCreated?.({ projectId, taskId: created.task_id, attemptId: created.attempt_id, status: created.status });
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  let note = null;
  if (unsupported) note = 'Este Core no informa de lo que ofrece cada proveedor: no se puede crear un intento.';
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
          {note && <p className="nat__note" role="status" data-testid="new-attempt-note">{note}</p>}
          <label className="nat__field" htmlFor={`${uid}-title`}>
            <span>Título de la tarea</span>
            <input id={`${uid}-title`} type="text" value={title} maxLength={512} onChange={(e) => setTitle(e.target.value)} data-testid="new-attempt-title" />
          </label>
          <label className="nat__field" htmlFor={`${uid}-instructions`}>
            <span>Instrucciones para el agente</span>
            <textarea id={`${uid}-instructions`} rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="new-attempt-instructions" />
          </label>
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
          <p className="nat__hint">Crear el intento no lo ejecuta: queda esperando tu aprobación.</p>
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="new-attempt-error">
              <span>{error.message}</span>
              {error.detail !== error.message && (
                <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
              )}
            </div>
          )}
          <div className="nat__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!ready} data-testid="new-attempt-submit">{busy ? 'Creando…' : 'Crear intento'}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
