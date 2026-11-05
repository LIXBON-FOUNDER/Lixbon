import { useId, useRef, useState } from 'react';
import { describeCommandError, forkAttempt, newRequestId } from './attemptCommands';
import { statusBadges, sizeEstimate } from './contextPreviewModel';
import { queryAdeCore } from './coreQueries';
import { useProviderCapabilities } from './useProviderCapabilities';
import './NewAttemptForm.css';

/**
 * LXO-153 · Fork de un intento: crea una ejecución NUEVA a partir de éste, sin tocarlo, y la deja pendiente de tu aprobación.
 *
 * Todo lo que el Core hará se dice ANTES de confirmar: con qué proveedor, con qué contexto (solo el encargo o un ContextPackage que
 * revisaste y que el Core comprueba que sale de ESTE intento), en qué worktree (siempre uno nuevo: compartirlo requiere una policy que
 * aún no existe) y que no se ejecuta hasta aprobarlo. Crear el Fork no roba el foco: abrirlo es un botón explícito.
 *
 * Solo se ofrecen los proveedores que el Core dice que pueden arrancar (`start` disponible).
 */
const startable = (provider) => provider?.matrix?.capabilities?.start?.state === 'available';

const OUTCOMES = {
  Requested: 'Fork pedido: queda pendiente de tu aprobación y no se ejecuta hasta entonces.',
  Replayed: 'Este Fork ya estaba pedido.',
};

/** ¿El paquete revisado sale de este intento? El Core lo vuelve a comprobar; aquí solo se evita pedir lo que se va a rechazar. */
export const packageIsFromAttempt = (response, attempt) => response?.status === 'valid'
  && response.package?.source?.attempt_id === attempt.id
  && response.package?.source?.task_id === attempt.task_id;

export function AttemptFork({ attempt, onForked, onOpenAttempt, active = true }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const { snapshot, unsupported, probing } = useProviderCapabilities({ enabled: Boolean(active && open) });
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [title, setTitle] = useState('');
  const [withPackage, setWithPackage] = useState(false);
  const [packageText, setPackageText] = useState('');
  const [preview, setPreview] = useState({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  // Una clave por INTENCIÓN: reintentar tras un fallo de red devuelve el mismo Fork; si cambia lo que se pide, la clave también.
  const requestId = useRef(null);
  const previewSeq = useRef(0);

  if (!attempt?.id || !attempt?.task_id || attempt.status === 'pending_approval') return null;

  const touch = () => { requestId.current = null; setError(null); };
  const providers = (snapshot?.providers ?? []).filter(startable);
  const chosen = providers.some((p) => p.id === provider) ? provider : (providers.find((p) => p.id === attempt.provider) ?? providers[0])?.id ?? '';
  const sameProvider = chosen === attempt.provider;
  const packageReady = !withPackage || (preview.status === 'done' && packageIsFromAttempt(preview.response, attempt));
  const ready = Boolean(chosen) && packageReady && !busy;

  const review = async () => {
    const mine = ++previewSeq.current;
    setPreview({ status: 'loading' });
    try {
      const response = await queryAdeCore('context_package_preview', { package: packageText });
      if (mine === previewSeq.current) setPreview({ status: 'done', response });
    } catch (failure) {
      if (mine === previewSeq.current) setPreview({ status: 'error', message: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  const editPackage = (text) => {
    previewSeq.current += 1;
    setPackageText(text);
    setPreview({ status: 'idle' });
    touch();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    requestId.current ??= newRequestId();
    setBusy(true);
    setError(null);
    try {
      const result = await forkAttempt({
        requestId: requestId.current,
        sourceAttemptId: attempt.id,
        provider: chosen,
        model,
        effort,
        title,
        // Se manda EXACTAMENTE el texto que se revisó (editarlo borra la revisión).
        package: withPackage ? packageText : undefined,
      });
      setOutcome({ text: OUTCOMES[result?.status] ?? 'Fork registrado.', taskId: result?.task_id ?? null, attemptId: result?.attempt_id ?? null });
      requestId.current = null;
      setOpen(false);
      onForked?.(result);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  let note = null;
  if (unsupported) note = 'Este Core no informa de lo que ofrece cada proveedor: no se puede bifurcar.';
  else if (!snapshot) note = 'Comprobando los proveedores…';
  else if (!providers.length) note = probing ? 'El Core está comprobando los proveedores…' : 'Ningún proveedor puede arrancar un intento ahora mismo; mira «Proveedores» más abajo.';

  return (
    <section className="nat nat-fork" aria-label="Bifurcar el intento" data-testid="attempt-fork">
      {outcome && (
        <p role="status" data-testid="attempt-fork-outcome">
          {outcome.text}
          {outcome.attemptId && <> Intento nuevo: <code className="mono">{outcome.attemptId}</code>.</>}
          {outcome.attemptId && outcome.taskId && onOpenAttempt && (
            <> <button type="button" className="lk" onClick={() => onOpenAttempt({ taskId: outcome.taskId, attemptId: outcome.attemptId })} data-testid="attempt-fork-go">Abrir el intento nuevo</button></>
          )}
        </p>
      )}
      {!open ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)} data-testid="attempt-fork-open">Bifurcar…</button>
      ) : (
        <form className="nat__form" onSubmit={submit} data-testid="attempt-fork-form">
          <h3 className="ssec__label">Bifurcar este intento</h3>
          <p className="nat__hint" data-testid="attempt-fork-source">
            Crea un intento <strong>nuevo</strong> a partir de <code className="mono">{attempt.id}</code> ({attempt.provider}). Este intento no se modifica y puede seguir corriendo.
          </p>
          {note && <p className="nat__note" role="status" data-testid="attempt-fork-note">{note}</p>}
          <div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-provider`}>
              <span>Proveedor</span>
              <select id={`${uid}-provider`} value={chosen} onChange={(e) => { setProvider(e.target.value); touch(); }} disabled={!providers.length} data-testid="attempt-fork-provider">
                {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
            </label>
            <label className="nat__field" htmlFor={`${uid}-title`}>
              <span>Título (opcional)</span>
              <input id={`${uid}-title`} type="text" value={title} maxLength={512} onChange={(e) => { setTitle(e.target.value); touch(); }} data-testid="attempt-fork-title" />
            </label>
          </div>
          <div className="nat__row">
            <label className="nat__field" htmlFor={`${uid}-model`}>
              <span>Modelo (opcional)</span>
              <input id={`${uid}-model`} type="text" value={model} maxLength={128} onChange={(e) => { setModel(e.target.value); touch(); }} data-testid="attempt-fork-model" />
            </label>
            <label className="nat__field" htmlFor={`${uid}-effort`}>
              <span>Esfuerzo (opcional)</span>
              <input id={`${uid}-effort`} type="text" value={effort} maxLength={128} onChange={(e) => { setEffort(e.target.value); touch(); }} data-testid="attempt-fork-effort" />
            </label>
          </div>
          <p className="nat__hint" data-testid="attempt-fork-inherit">
            {sameProvider
              ? 'Vacío: hereda el modelo y el esfuerzo de este intento. El rol y el perfil de permisos se heredan siempre.'
              : 'Es otro proveedor: el modelo y el esfuerzo de este intento no se arrastran (son del proveedor). El rol y el perfil de permisos se heredan siempre.'}
          </p>

          <fieldset className="nat__field" data-testid="attempt-fork-context">
            <legend>Contexto que recibe</legend>
            <label>
              <input type="radio" name={`${uid}-ctx`} checked={!withPackage} onChange={() => { setWithPackage(false); touch(); }} data-testid="attempt-fork-ctx-clean" />
              {' '}Solo el encargo de la tarea (no hereda nada de lo que hizo este intento)
            </label>
            <label>
              <input type="radio" name={`${uid}-ctx`} checked={withPackage} onChange={() => { setWithPackage(true); touch(); }} data-testid="attempt-fork-ctx-package" />
              {' '}El encargo y un paquete de contexto de este intento
            </label>
          </fieldset>
          {withPackage && (
            <div className="nat__field" data-testid="attempt-fork-package">
              <label htmlFor={`${uid}-package`}><span>Paquete de contexto (JSON)</span></label>
              <textarea id={`${uid}-package`} rows={5} value={packageText} onChange={(e) => editPackage(e.target.value)} data-testid="attempt-fork-package-text" />
              <div className="nat__actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={!packageText.trim() || preview.status === 'loading'} onClick={review} data-testid="attempt-fork-package-review">
                  {preview.status === 'loading' ? 'Revisando…' : 'Revisar el paquete'}
                </button>
              </div>
              <PackageReview preview={preview} attempt={attempt} />
            </div>
          )}

          <p className="nat__hint" data-testid="attempt-fork-worktree">
            Trabaja en un <strong>worktree nuevo e independiente</strong>, con su propia rama. Compartir el del intento original no está disponible: requiere una policy que todavía no existe.
          </p>
          <p className="nat__hint" data-testid="attempt-fork-approval">El Fork nace pendiente de tu aprobación: no se ejecuta hasta que la des.</p>
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-fork-error">
              <span>{error.message}</span>
              {error.detail !== error.message && (
                <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
              )}
            </div>
          )}
          <div className="nat__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!ready} data-testid="attempt-fork-submit">{busy ? 'Pidiendo…' : 'Bifurcar'}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}

export function PackageReview({ preview, attempt }) {
  if (preview.status === 'idle') return <p className="nat__hint" data-testid="attempt-fork-package-pending">Revisa el paquete antes de bifurcar: el Core lo verifica y comprueba que sale de este intento.</p>;
  if (preview.status === 'loading') return <p role="status">Revisando el paquete…</p>;
  if (preview.status === 'error') {
    return <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-fork-package-error"><span>No se pudo revisar el paquete.</span><details><summary>Detalle técnico</summary><code>{preview.message}</code></details></div>;
  }
  const { response } = preview;
  if (response.status !== 'valid') {
    return (
      <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-fork-package-invalid" data-code={response.error?.code}>
        <span>El paquete no pasa la verificación del Core: no se puede usar para bifurcar.</span>
        <details><summary>Detalle técnico</summary><code>{response.error?.code}: {response.error?.message}</code></details>
      </div>
    );
  }
  const fromHere = packageIsFromAttempt(response, attempt);
  const size = sizeEstimate(response.summary);
  return (
    <div data-testid="attempt-fork-package-valid" data-from-attempt={fromHere ? 'true' : 'false'}>
      <ul className="cp-badges" aria-label="Estado del paquete">
        {statusBadges(response).map((b) => <li key={b.id} className={`cp-badge cp-badge--${b.tone}`} data-badge={b.id} title={b.help}><span aria-hidden="true">{b.glyph}</span> {b.label}</li>)}
      </ul>
      <p>Identidad verificada: <code className="mono">{response.package_id}</code> · pesa {size.package} (≈ {size.approxTokens} tokens).</p>
      {fromHere
        ? <p data-testid="attempt-fork-package-origin">Sale de este intento ({response.package.source.provider}).</p>
        : <p className="ade-notice ade-notice--error" role="alert" data-testid="attempt-fork-package-foreign">Este paquete sale de <code className="mono">{response.package.source.attempt_id}</code>, no de este intento: el Core lo rechazaría.</p>}
    </div>
  );
}
