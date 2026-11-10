import { useEffect, useId, useRef, useState } from 'react';
import { changePolicy, describeCommandError } from './attemptCommands';
import { queryAdeCore } from './coreQueries';
import { CoreModelNotice } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';
import { CATEGORIES, LEVELS, restriction } from './autonomyContract';
import './AutonomyEditor.css';

/**
 * LXO-210 · Autonomía: qué puede hacer cada acción por su cuenta y quién lo decide. El Core es la autoridad (docs/core/POLICY.md): aquí se LEE la
 * policy efectiva y se PIDE un cambio; guardar no garantiza nada hasta que el Core lo acepta, y después de guardar se vuelve a leer.
 *
 * - Lo heredado y lo sobrescrito nunca se confunden: cada fila dice el ORIGEN del nivel efectivo y si este ámbito lo sobrescribe.
 * - Antes de guardar se previsualiza el efecto (`policy_effective` con `preview`, sin escribir nada). Dar MÁS autonomía es explícito y exige
 *   una confirmación aparte; endurecer o volver a heredar no.
 * - `project` e `intento` solo pueden endurecer; las opciones que el Core rechazaría salen desactivadas con su motivo (el Core vuelve a comprobar).
 * - Una revisión vieja (`policy_stale`) no pisa lo que otro cambió: se recarga y se avisa.
 */
const CATEGORY_TEXT = Object.freeze({
  start: ['Arrancar un intento', 'Crear una Task con intento, reintentar o continuar. Su aprobación inicial sigue siendo de Desktop.'],
  answer: ['Responder preguntas', 'Contestar la pregunta de un agente.'],
  queue: ['Encolar instrucciones', 'Dejar una instrucción para después del turno en curso.'],
  steer: ['Corregir el turno en curso', 'Inyectar una instrucción en el próximo punto seguro.'],
  stop: ['Detener y enviar', 'Interrumpir el turno y enviar una instrucción nueva.'],
  fork: ['Bifurcar (Fork)', 'Crear una Task hija desde un intento.'],
  review: ['Revisar', 'Aceptar o rechazar el trabajo de un intento.'],
  integrate: ['Integrar', 'Fusionar o publicar un PR del trabajo aceptado.'],
  cleanup: ['Limpiar recursos', 'Quitar el worktree de una Task.'],
  provider_permissions: ['Permisos del proveedor', 'Lo que el agente pide permiso para ejecutar.'],
});
const LEVEL_TEXT = Object.freeze({ allow: 'Permitir', confirm: 'Pedir confirmación', elevated: 'Elevado (fuera de banda)', deny: 'Denegar' });
const SOURCE_TEXT = Object.freeze({ baseline: 'Base del actor', global: 'Global', project: 'Proyecto', attempt: 'Intento', floor: 'Mínimo de seguridad' });
const ACTOR_TEXT = Object.freeze({ desktop_person: 'una persona en Desktop', cli_person: 'una persona en el CLI', mobile_person: 'una persona en el móvil', automation: 'una automatización', agent: 'un agente', core: 'el Core' });
const SCOPE_TEXT = Object.freeze({ global: 'Global', project: 'Este proyecto', attempt: 'Este intento' });
const DIRECTION_TEXT = Object.freeze({
  tighten: 'Reduce la autonomía.',
  loosen: 'DA MÁS AUTONOMÍA.',
  same: 'No cambia el nivel efectivo: solo lo fija en este ámbito.',
  reset: 'Vuelve a heredar.',
});
const INHERIT = 'inherit';

const layerLevel = (c, kind) => c.layers[kind] ?? null;

/** Lo más laxo que el Core admite como override en `kind`: el nivel que ese ámbito heredaría sin override (solo project/attempt). */
function parentLevel(c, kind) {
  if (kind === 'global') return null;
  const above = kind === 'project' ? [c.layers.baseline, c.layers.global] : [c.layers.baseline, c.layers.global, c.layers.project];
  return above.filter(Boolean).reduce((a, b) => (restriction(b) > restriction(a) ? b : a));
}

function optionBlock(c, kind, level) {
  if (c.floor && restriction(level) < restriction(c.floor)) return `Nunca baja de «${LEVEL_TEXT[c.floor]}»`;
  const parent = parentLevel(c, kind);
  if (parent && restriction(level) < restriction(parent)) return 'Un ámbito más cercano solo puede endurecer';
  return null;
}

export function AutonomyEditor({ projectId = null, attemptId = null, defaultOpen = false }) {
  const uid = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [kind, setKind] = useState(attemptId ? 'attempt' : projectId ? 'project' : 'global');
  const state = useCoreQuery('policy_effective', { project_id: projectId ?? undefined, attempt_id: attemptId ?? undefined }, { enabled: open });
  const view = state.data ?? null;
  const [edit, setEdit] = useState(null); // { category, value }
  const [preview, setPreview] = useState({ status: 'idle' });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const token = useRef(0);

  const scope = kind === 'global' ? { kind } : { kind, id: kind === 'project' ? projectId : attemptId };
  const revision = view?.revision ?? null;

  // La previsualización la calcula el Core con las mismas reglas que al guardar, y NO escribe nada.
  useEffect(() => {
    if (!edit || revision === null) { setPreview({ status: 'idle' }); return undefined; }
    const mine = ++token.current;
    setPreview({ status: 'loading' });
    queryAdeCore('policy_effective', {
      projectId, attemptId, preview: { scope, category: edit.category, level: edit.value === INHERIT ? null : edit.value },
    }).then((r) => { if (token.current === mine) setPreview({ status: 'ready', value: r.preview }); })
      .catch((e) => { if (token.current === mine) setPreview({ status: 'error', error: describeCommandError(e) }); });
    return () => { token.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, revision, kind, projectId, attemptId]);

  const discard = () => { setEdit(null); setAck(false); setError(null); };
  const pick = (category, value, current) => {
    setNotice(null);
    setError(null);
    setAck(false);
    setEdit(value === current ? null : { category, value });
  };
  const chooseScope = (next) => { setKind(next); discard(); setNotice(null); };

  const save = async () => {
    const p = preview.value;
    setBusy(true);
    setError(null);
    try {
      const r = await changePolicy({ scope, category: edit.category, level: edit.value === INHERIT ? null : edit.value, expectedRevision: revision, confirm: Boolean(p.needs_confirm && ack) });
      setNotice(r.status === 'Unchanged' ? 'No había nada que cambiar.' : `Guardado (revisión ${r.revision}). Queda en Activity.`);
      discard();
    } catch (failure) {
      setError(describeCommandError(failure));
      // Con la policy ya cambiada el borrador y su previsualización no valen: se descartan, pero el aviso se queda.
      if (/policy_stale/i.test(String(failure?.message ?? failure))) { setEdit(null); setAck(false); }
    } finally {
      // Recargar del Core siempre: no se da nada por hecho por cuenta de la interfaz.
      state.retry();
      setBusy(false);
    }
  };

  if (!open) {
    return <button type="button" className="lk" onClick={() => setOpen(true)} data-testid="autonomy-open">Autonomía…</button>;
  }

  const canEdit = Boolean(view?.actor.can_edit);
  const editing = edit && view ? view.categories.find((c) => c.category === edit.category) : null;
  const after = edit && preview.status === 'ready' && preview.value.valid ? preview.value.categories.find((c) => c.category === edit.category) : null;

  return (
    <section className="autonomy" aria-labelledby={`${uid}-t`} data-testid="autonomy">
      <div className="resinv__head">
        <h3 id={`${uid}-t`} className="autonomy__title">Autonomía</h3>
        <button type="button" className="lk" onClick={() => { setOpen(false); discard(); setNotice(null); }} data-testid="autonomy-close">Cerrar</button>
      </div>
      {view ? (
        <>
          <p className="nat__hint" data-testid="autonomy-actor">
            El Core decide qué puede hacer {ACTOR_TEXT[view.actor.class]}. Esto es lo que se aplica ahora (revisión {view.revision}); cada cambio queda en Activity.
          </p>
          {!canEdit && <p className="ade-notice ade-notice--warn" role="note" data-testid="autonomy-readonly">Solo una persona en Desktop puede cambiar la policy: aquí solo se lee.</p>}
          <fieldset className="autonomy__scopes" disabled={busy}>
            <legend>Ámbito del cambio</legend>
            {['global', ...(projectId ? ['project'] : []), ...(attemptId ? ['attempt'] : [])].map((k) => (
              <label key={k}>
                <input type="radio" name={`${uid}-scope`} value={k} checked={kind === k} onChange={() => chooseScope(k)} data-testid={`autonomy-scope-${k}`} />
                {' '}{SCOPE_TEXT[k]}
              </label>
            ))}
          </fieldset>
          <table className="autonomy__table" data-testid="autonomy-table">
            <caption className="autonomy__caption">Nivel efectivo de cada acción y lo que este ámbito sobrescribe</caption>
            <thead>
              <tr><th scope="col">Acción</th><th scope="col">Nivel efectivo</th><th scope="col">Origen</th><th scope="col">{SCOPE_TEXT[kind]}</th></tr>
            </thead>
            <tbody>
              {CATEGORIES.map((category) => {
                const c = view.categories.find((x) => x.category === category);
                const mine = layerLevel(c, kind);
                const value = edit?.category === category ? edit.value : (mine ?? INHERIT);
                const selectId = `${uid}-${category}`;
                return (
                  <tr key={category} data-category={category} data-effective={c.level} data-source={c.source} data-draft={edit?.category === category ? 'true' : undefined}>
                    <th scope="row">
                      <span>{CATEGORY_TEXT[category][0]}</span>
                      <small className="autonomy__desc">{CATEGORY_TEXT[category][1]}</small>
                    </th>
                    <td data-testid={`autonomy-level-${category}`}>
                      <span className={`autonomy__level autonomy__level--${c.level}`}>{LEVEL_TEXT[c.level]}</span>
                      {c.floor && <small className="autonomy__desc"> · mínimo: {LEVEL_TEXT[c.floor]}</small>}
                      {!c.enforced && <small className="autonomy__desc" data-testid={`autonomy-unenforced-${category}`}> · aún no se aplica en ningún comando</small>}
                    </td>
                    <td data-testid={`autonomy-source-${category}`}>{SOURCE_TEXT[c.source]}</td>
                    <td>
                      <label htmlFor={selectId} className="autonomy__sr">{CATEGORY_TEXT[category][0]}: nivel en {SCOPE_TEXT[kind]}</label>
                      <select id={selectId} value={value} disabled={!canEdit || busy} onChange={(e) => pick(category, e.target.value, mine ?? INHERIT)} data-testid={`autonomy-select-${category}`}>
                        <option value={INHERIT}>Heredar (sin override)</option>
                        {LEVELS.map((level) => {
                          const block = optionBlock(c, kind, level);
                          return <option key={level} value={level} disabled={Boolean(block)} title={block ?? undefined}>{LEVEL_TEXT[level]}{block ? ` — ${block}` : ''}</option>;
                        })}
                      </select>
                      {' '}
                      <span className="autonomy__tag" data-testid={`autonomy-tag-${category}`}>{edit?.category === category ? 'Sin guardar' : mine ? 'Sobrescrito' : 'Heredado'}</span>
                      {mine && edit?.category !== category && canEdit && (
                        <button type="button" className="lk" disabled={busy} onClick={() => pick(category, INHERIT, mine)} data-testid={`autonomy-reset-${category}`}>Volver a heredar</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {notice && <p role="status" data-testid="autonomy-notice">{notice}</p>}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="autonomy-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
          {edit && editing && (
            <div className="autonomy__pending" role="group" aria-label="Cambio pendiente" data-testid="autonomy-pending">
              <p><strong>{CATEGORY_TEXT[edit.category][0]}</strong> en {SCOPE_TEXT[kind].toLowerCase()}: {edit.value === INHERIT ? 'volver a heredar' : LEVEL_TEXT[edit.value]}.</p>
              {preview.status === 'loading' && <p role="status">Calculando el efecto con el Core…</p>}
              {preview.status === 'error' && <p className="ade-notice ade-notice--error" role="alert">{preview.error.message}</p>}
              {preview.status === 'ready' && !preview.value.valid && (
                <p className="ade-notice ade-notice--error" role="alert" data-testid="autonomy-invalid" data-code={preview.value.code}>{describeCommandError(`${preview.value.code}: ${preview.value.message}`).message}</p>
              )}
              {preview.status === 'ready' && preview.value.valid && (
                <>
                  <p data-testid="autonomy-effect">
                    Efecto: {LEVEL_TEXT[preview.value.before]} → <strong>{LEVEL_TEXT[preview.value.after]}</strong>
                    {after ? ` (origen: ${SOURCE_TEXT[after.source]})` : ''}.
                  </p>
                  <p className={preview.value.direction === 'loosen' ? 'ade-notice ade-notice--warn' : 'nat__hint'} data-testid="autonomy-direction" data-direction={preview.value.direction}>
                    {DIRECTION_TEXT[preview.value.direction]}
                  </p>
                  {preview.value.needs_confirm && (
                    <label className="ade-notice ade-notice--warn">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="autonomy-ack" />
                      {' '}Entiendo que esto da más autonomía a «{CATEGORY_TEXT[edit.category][0]}» y quiero aplicarlo.
                    </label>
                  )}
                </>
              )}
              <div className="nat__actions">
                <button
                  type="button"
                  className={`btn btn--sm ${preview.status === 'ready' && preview.value.needs_confirm ? 'btn--danger' : 'btn--primary'}`}
                  disabled={busy || preview.status !== 'ready' || !preview.value.valid || (preview.value.needs_confirm && !ack)}
                  onClick={save}
                  data-testid="autonomy-save"
                >{busy ? 'Guardando…' : 'Guardar'}</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={discard} data-testid="autonomy-discard">Descartar</button>
              </div>
            </div>
          )}
        </>
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p role="status">Leyendo la policy del Core.</p>
      )}
    </section>
  );
}
