import { useId, useRef, useState } from 'react';
import { cancelRace, describeCommandError, newRequestId, startRace } from './attemptCommands';
import { attemptStatusInfo } from './adeLabels';
import { AttemptCompare } from './AttemptCompare';
import { PackageReview, packageIsFromAttempt } from './AttemptFork';
import { queryAdeCore } from './coreQueries';
import { CoreModelNotice } from './CoreModelNotice';
import { MAX_CANDIDATES, MIN_CANDIDATES, isFinalStatus } from './raceContract';
import { useCoreQuery } from './useCoreQuery';
import { useProviderCapabilities } from './useProviderCapabilities';
import './NewAttemptForm.css';

/**
 * LXO-216 · Race: lanzar de 2 a 4 candidatos comparables desde este intento (docs/core/RACE.md). Cada candidato es un Fork real: su propio intento,
 * rama y worktree, pendiente de TU aprobación. Todo lo que el Core hará se dice ANTES de confirmar, y después cada columna es un intento real que
 * se ve tal como está, también los que no se pudieron lanzar.
 *
 * - No hay ganador ni puntuación, y nada se cancela porque otro candidato termine: cancelar es un botón explícito (uno o los que quedan).
 * - Crear el Race, o que un candidato cambie de estado, no mueve el foco ni abre nada: abrir un intento o Compare es siempre una elección.
 * - Lo que el Core no tiene (host o worktree por candidato, coste estimado) no se ofrece ni se inventa: se dice.
 */
const startable = (provider) => provider?.matrix?.capabilities?.start?.state === 'available';
const blank = () => ({ provider: '', model: '', effort: '', title: '' });
const SUMMARY_LINE = 'Cada candidato trabaja en un worktree nuevo e independiente, con su propia rama, y nace pendiente de tu aprobación: no se ejecuta ninguno hasta que lo apruebes.';

export function AttemptRace({ attempt, onOpenAttempt, active = true }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const { snapshot, unsupported, probing } = useProviderCapabilities({ enabled: Boolean(active && open) });
  const [candidates, setCandidates] = useState([blank(), blank()]);
  const [withPackage, setWithPackage] = useState(false);
  const [packageText, setPackageText] = useState('');
  const [preview, setPreview] = useState({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [raceId, setRaceId] = useState(null);
  const [fresh, setFresh] = useState(null); // el estado que devolvió el comando, hasta que llegue la primera lectura
  const [comparing, setComparing] = useState(null);
  const [confirming, setConfirming] = useState(null); // { all: true } | { attemptId }
  const [cancelNote, setCancelNote] = useState(null);
  // Una clave por INTENCIÓN: reintentar la misma petición no duplica a los ya creados; si cambia lo que se pide, la clave también.
  const requestId = useRef(null);
  const lastRequest = useRef(null);
  const previewSeq = useRef(0);

  const list = useCoreQuery('task_race_status', { source_attempt_id: attempt?.id }, { enabled: Boolean(active && open && attempt?.id) });
  const race = useCoreQuery('task_race_status', { race_id: raceId ?? undefined }, { enabled: Boolean(active && raceId) });

  if (!attempt?.id || !attempt?.task_id || attempt.status === 'pending_approval') return null;

  const providers = (snapshot?.providers ?? []).filter(startable);
  const providerOf = (c) => (providers.some((p) => p.id === c.provider) ? c.provider : (providers.find((p) => p.id === attempt.provider) ?? providers[0])?.id ?? '');
  const packageReady = !withPackage || (preview.status === 'done' && packageIsFromAttempt(preview.response, attempt));
  const ready = providers.length > 0 && candidates.length >= MIN_CANDIDATES && packageReady && !busy;
  const view = race.data ?? (fresh && fresh.race_id === raceId ? fresh : null);

  const touch = () => { requestId.current = null; setError(null); };
  const patch = (i, change) => { setCandidates((cs) => cs.map((c, k) => (k === i ? { ...c, ...change } : c))); touch(); };
  const addCandidate = () => { setCandidates((cs) => (cs.length < MAX_CANDIDATES ? [...cs, blank()] : cs)); touch(); };
  const removeCandidate = (i) => { setCandidates((cs) => (cs.length > MIN_CANDIDATES ? cs.filter((_, k) => k !== i) : cs)); touch(); };

  const reviewPackage = async () => {
    const mine = ++previewSeq.current;
    setPreview({ status: 'loading' });
    try {
      const response = await queryAdeCore('context_package_preview', { package: packageText });
      if (mine === previewSeq.current) setPreview({ status: 'done', response });
    } catch (failure) {
      if (mine === previewSeq.current) setPreview({ status: 'error', message: failure instanceof Error ? failure.message : String(failure) });
    }
  };
  const editPackage = (text) => { previewSeq.current += 1; setPackageText(text); setPreview({ status: 'idle' }); touch(); };

  const launch = async (request) => {
    setBusy(true);
    setError(null);
    try {
      const result = await startRace(request);
      lastRequest.current = request;
      setFresh(result);
      setRaceId(result.race_id);
      setOpen(false);
      setComparing(null);
      setCancelNote(null);
      list.retry();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (!ready) return;
    requestId.current ??= newRequestId();
    launch({
      requestId: requestId.current,
      sourceAttemptId: attempt.id,
      candidates: candidates.map((c) => ({ ...c, provider: providerOf(c) })),
      // Se manda EXACTAMENTE el texto que se revisó (editarlo borra la revisión).
      package: withPackage ? packageText : undefined,
    });
  };

  const retryFailed = () => { if (lastRequest.current) launch(lastRequest.current); };

  const doCancel = async (attemptId) => {
    setBusy(true);
    setError(null);
    try {
      const r = await cancelRace(raceId, attemptId);
      const failed = r.results.filter((x) => x.outcome === 'failed');
      setCancelNote(failed.length
        ? { tone: 'error', text: `No se pudo detener ${failed.length === 1 ? 'un candidato' : `${failed.length} candidatos`}: siguen en marcha. ${failed[0].error ?? ''}` }
        : { tone: 'ok', text: attemptId ? 'Candidato cancelado.' : 'Se canceló lo que quedaba.' });
      setFresh(r.race);
      setConfirming(null);
      race.retry();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  let note = null;
  if (unsupported) note = 'Este Core no informa de lo que ofrece cada proveedor: no se puede lanzar un Race.';
  else if (!snapshot) note = 'Comprobando los proveedores…';
  else if (!providers.length) note = probing ? 'El Core está comprobando los proveedores…' : 'Ningún proveedor puede arrancar un intento ahora mismo.';

  const past = (list.data?.races ?? []).filter((r) => r.race_id !== raceId);

  return (
    <section className="nat nat-race" aria-label="Race de intentos" data-testid="attempt-race">
      {view && (
        <RaceResult
          view={view}
          busy={busy}
          confirming={confirming}
          setConfirming={setConfirming}
          cancelNote={cancelNote}
          onCancel={doCancel}
          onRetry={lastRequest.current ? retryFailed : null}
          comparing={comparing}
          setComparing={setComparing}
          onOpenAttempt={onOpenAttempt}
          active={active}
          onClose={() => { setRaceId(null); setFresh(null); setComparing(null); setConfirming(null); setCancelNote(null); lastRequest.current = null; }}
        />
      )}
      {raceId && !view && (race.error ? <CoreModelNotice error={race.error} onRetry={race.retry} /> : <p role="status">Leyendo el Race…</p>)}
      {error && !open && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-race-error">
          <span>{error.message}</span>
          {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
        </div>
      )}
      {!open ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)} data-testid="attempt-race-open">Race…</button>
      ) : (
        <form className="nat__form" onSubmit={submit} data-testid="attempt-race-form">
          <h3 className="ssec__label">Lanzar un Race desde este intento</h3>
          <p className="nat__hint" data-testid="attempt-race-source">
            Lanza de {MIN_CANDIDATES} a {MAX_CANDIDATES} intentos <strong>nuevos y comparables</strong> a partir de <code className="mono">{attempt.id}</code> ({attempt.provider}). Este intento no se modifica.
          </p>
          {note && <p className="nat__note" role="status" data-testid="attempt-race-note">{note}</p>}
          {past.length > 0 && (
            <p className="nat__hint" data-testid="attempt-race-past">
              Ya hay {past.length === 1 ? 'un Race' : `${past.length} Races`} de este intento:{' '}
              {past.map((r) => (
                <button key={r.race_id} type="button" className="lk" onClick={() => { setRaceId(r.race_id); setFresh(null); setOpen(false); }} data-testid={`attempt-race-past-${r.race_id}`}>
                  {r.requested} candidatos
                </button>
              ))}
            </p>
          )}
          {candidates.map((c, i) => (
            <fieldset key={i} className="nat__field" data-testid={`attempt-race-candidate-${i}`}>
              <legend>Candidato {i + 1}</legend>
              <div className="nat__row">
                <label className="nat__field" htmlFor={`${uid}-p${i}`}>
                  <span>Proveedor</span>
                  <select id={`${uid}-p${i}`} value={providerOf(c)} onChange={(e) => patch(i, { provider: e.target.value })} disabled={!providers.length} data-testid={`attempt-race-provider-${i}`}>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                </label>
                <label className="nat__field" htmlFor={`${uid}-m${i}`}>
                  <span>Modelo (opcional)</span>
                  <input id={`${uid}-m${i}`} type="text" value={c.model} maxLength={128} onChange={(e) => patch(i, { model: e.target.value })} data-testid={`attempt-race-model-${i}`} />
                </label>
              </div>
              <div className="nat__row">
                <label className="nat__field" htmlFor={`${uid}-e${i}`}>
                  <span>Esfuerzo (opcional)</span>
                  <input id={`${uid}-e${i}`} type="text" value={c.effort} maxLength={128} onChange={(e) => patch(i, { effort: e.target.value })} data-testid={`attempt-race-effort-${i}`} />
                </label>
                <label className="nat__field" htmlFor={`${uid}-t${i}`}>
                  <span>Título (opcional)</span>
                  <input id={`${uid}-t${i}`} type="text" value={c.title} maxLength={512} onChange={(e) => patch(i, { title: e.target.value })} data-testid={`attempt-race-title-${i}`} />
                </label>
              </div>
              {candidates.length > MIN_CANDIDATES && (
                <button type="button" className="lk" onClick={() => removeCandidate(i)} data-testid={`attempt-race-remove-${i}`}>Quitar el candidato {i + 1}</button>
              )}
            </fieldset>
          ))}
          {candidates.length < MAX_CANDIDATES && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={addCandidate} data-testid="attempt-race-add">Añadir un candidato</button>
          )}

          <fieldset className="nat__field" data-testid="attempt-race-context">
            <legend>Contexto común a todos</legend>
            <label>
              <input type="radio" name={`${uid}-ctx`} checked={!withPackage} onChange={() => { setWithPackage(false); touch(); }} data-testid="attempt-race-ctx-clean" />
              {' '}Solo el encargo de la tarea (no heredan nada de lo que hizo este intento)
            </label>
            <label>
              <input type="radio" name={`${uid}-ctx`} checked={withPackage} onChange={() => { setWithPackage(true); touch(); }} data-testid="attempt-race-ctx-package" />
              {' '}El encargo y un paquete de contexto de este intento (el mismo para todos)
            </label>
          </fieldset>
          {withPackage && (
            <div className="nat__field" data-testid="attempt-race-package">
              <label htmlFor={`${uid}-package`}><span>Paquete de contexto (JSON)</span></label>
              <textarea id={`${uid}-package`} rows={5} value={packageText} onChange={(e) => editPackage(e.target.value)} data-testid="attempt-race-package-text" />
              <div className="nat__actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={!packageText.trim() || preview.status === 'loading'} onClick={reviewPackage} data-testid="attempt-race-package-review">
                  {preview.status === 'loading' ? 'Revisando…' : 'Revisar el paquete'}
                </button>
              </div>
              <PackageReview preview={preview} attempt={attempt} />
            </div>
          )}

          <ul className="nat__hint" aria-label="Qué va a pasar" data-testid="attempt-race-implications">
            <li>{SUMMARY_LINE}</li>
            <li>No se elige ganador y no se cancela a nadie cuando otro termine: cancelar es un botón explícito.</li>
            <li>Hay un tope de tareas sin terminar: los candidatos que no quepan quedan como fallidos, sin deshacer a los demás.</li>
            <li data-testid="attempt-race-cost">El Core no estima el coste ni el uso de cada candidato: cada uno consume cuota de su proveedor.</li>
            <li>No se puede elegir host ni worktree compartido por candidato: hoy hay un solo host y cada candidato recibe el suyo.</li>
          </ul>
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-race-form-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
          <div className="nat__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!ready} data-testid="attempt-race-submit">{busy ? 'Lanzando…' : `Lanzar ${candidates.length} candidatos`}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}

function RaceResult({ view, busy, confirming, setConfirming, cancelNote, onCancel, onRetry, comparing, setComparing, onOpenAttempt, active, onClose }) {
  const failedCount = view.summary.failed;
  const open = (c) => () => onOpenAttempt?.({ taskId: c.task_id, attemptId: c.attempt_id });
  return (
    <div className="nat__form" role="group" aria-label="Estado del Race" data-testid="race-result" data-race-id={view.race_id}>
      <h3 className="ssec__label">Race · {view.requested} candidatos</h3>
      <p className="nat__hint" data-testid="race-context">
        Salen de <code className="mono">{view.source_attempt_id}</code>. Contexto común: {view.strategy === 'context_package' ? <>un paquete de contexto (<code className="mono">{view.package_id}</code>)</> : 'solo el encargo de la tarea'}.
      </p>
      {failedCount > 0 && (
        <p className="ade-notice ade-notice--error" role="alert" data-testid="race-partial">
          {failedCount === 1 ? 'Un candidato no se pudo lanzar' : `${failedCount} candidatos no se pudieron lanzar`}. Los demás siguen adelante y se pueden comparar.
          {onRetry && <> <button type="button" className="lk" disabled={busy} onClick={onRetry} data-testid="race-retry">Reintentar los que faltan</button></>}
        </p>
      )}
      <ol className="race__list" aria-label="Candidatos">
        {view.candidates.map((c) => {
          const info = attemptStatusInfo(c.status);
          const launched = c.outcome === 'launched';
          return (
            <li key={c.index} className="race__item" data-testid={`race-candidate-${c.index}`} data-outcome={c.outcome} data-status={c.status ?? undefined}>
              <strong>Candidato {c.index + 1}</strong>
              {' · '}<span>{c.provider ?? '—'}{c.model ? ` · ${c.model}` : ''}</span>
              {' · '}
              {launched && <span data-testid={`race-status-${c.index}`}>{c.status ? info.label : 'Sin estado'}</span>}
              {c.outcome === 'failed' && <span data-testid={`race-status-${c.index}`}>No se pudo lanzar: {describeCommandError(c.code).message}</span>}
              {c.outcome === 'not_attempted' && <span data-testid={`race-status-${c.index}`}>No se llegó a intentar</span>}
              {launched && <> <code className="mono">{c.attempt_id}</code></>}
              {launched && onOpenAttempt && <> <button type="button" className="lk" onClick={open(c)} data-testid={`race-open-${c.index}`}>Abrir el intento</button></>}
              {launched && c.status && !isFinalStatus(c.status) && (
                confirming?.attemptId === c.attempt_id ? (
                  <span role="group" aria-label={`Cancelar el candidato ${c.index + 1}`}>
                    {' '}<button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => onCancel(c.attempt_id)} data-testid={`race-cancel-yes-${c.index}`}>Sí, cancelar este candidato</button>
                    {' '}<button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirming(null)}>No</button>
                  </span>
                ) : (
                  <> <button type="button" className="lk" disabled={busy} onClick={() => setConfirming({ attemptId: c.attempt_id })} data-testid={`race-cancel-${c.index}`}>Cancelar este candidato</button></>
                )
              )}
            </li>
          );
        })}
      </ol>
      <p className="nat__hint" data-testid="race-summary">
        {view.summary.launched} lanzados · {view.summary.active} sin terminar · {view.summary.finished} terminados · {view.summary.failed} fallidos. El Core no elige ganador: eso lo decides tú al comparar.
      </p>
      {cancelNote && <p role="status" className={cancelNote.tone === 'error' ? 'ade-notice ade-notice--error' : undefined} data-testid="race-cancel-note">{cancelNote.text}</p>}
      <div className="nat__actions">
        {view.compare.attempt_ids && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setComparing(view.compare.attempt_ids)} data-testid="race-compare">Abrir Compare</button>
        )}
        {view.cancellable.length > 0 && (confirming?.all ? (
          <span role="group" aria-label="Cancelar lo que queda">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => onCancel(null)} data-testid="race-cancel-all-yes">Sí, cancelar lo que queda ({view.cancellable.length})</button>
            {' '}<button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirming(null)}>No</button>
          </span>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirming({ all: true })} data-testid="race-cancel-all">Cancelar lo que queda</button>
        ))}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} data-testid="race-close">Cerrar</button>
      </div>
      {!view.compare.attempt_ids && <p className="nat__hint" data-testid="race-compare-wait">Compare se abre cuando haya al menos dos candidatos lanzados.</p>}
      {comparing && <AttemptCompare attemptIds={comparing} active={active} onClose={() => setComparing(null)} onOpenAttempt={onOpenAttempt} />}
    </div>
  );
}
