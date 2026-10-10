// TaskDiffView.jsx - revisión del diff de una tarea del orquestador (vista propia, no reviewStore).
// Muestra el diff de la rama de la tarea contra su base_commit y registra Aceptar/Rechazar
// como decisión humana con orch_review_task. Contrato: ./reviewContract.js

import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultReviewApi } from './taskReview';
import { REVIEW_DECISIONS, REVIEW_ERRORS, BASE_SOURCES, shortSha, structuredError, errorText, isNotFound } from './reviewContract';
import './review.css';

const STATUS_LABELS = { added: 'Nuevo', modified: 'Modificado', deleted: 'Eliminado', renamed: 'Renombrado' };

function patchLineClass(line) {
  if (line.startsWith('@@')) return 'tdv__ln tdv__ln--hunk';
  if (line.startsWith('+')) return 'tdv__ln tdv__ln--add';
  if (line.startsWith('-')) return 'tdv__ln tdv__ln--del';
  return 'tdv__ln';
}

function Patch({ patch }) {
  if (!patch) return <div className="tdv__nopatch">Sin patch para mostrar (binario o vacío).</div>;
  const lines = patch.replace(/\n$/, '').split('\n');
  return (
    <pre className="tdv__patch mono">
      {lines.map((l, i) => <div key={i} className={patchLineClass(l)}>{l || ' '}</div>)}
    </pre>
  );
}

export function TaskDiffView({ taskId, api = defaultReviewApi, onDecided, onReviewed }) {
  const [state, setState] = useState({ status: 'loading' });
  const [confirm, setConfirm] = useState(null); // 'accepted' | 'rejected' | null
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);   // { ok... } | { error: ... }
  const [sendError, setSendError] = useState(null);
  const [lastEvent, setLastEvent] = useState(null); // último orch-task-reviewed de esta tarea
  const busy = useRef(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ status: 'loading' });
    setConfirm(null); setResult(null); setSendError(null); setComment('');
    try {
      const d = await api.fetchDiff(taskId);
      if (id !== reqId.current) return;
      setState({ status: 'ready', diff: d });
    } catch (e) {
      if (id !== reqId.current) return;
      setState({ status: 'error', error: errorText(e), notFound: isNotFound(e) });
    }
  }, [api, taskId]);

  useEffect(() => { load(); }, [load]);

  // orch-task-reviewed: refleja la última decisión de esta tarea (también si llegó de otra ventana).
  useEffect(() => {
    if (!api.subscribe) return undefined;
    return api.subscribe((p) => {
      if (!p || p.task_id !== taskId) return;
      setLastEvent(p);
      onReviewed?.(p);
    });
  }, [api, taskId, onReviewed]);

  async function send() {
    if (busy.current || state.status !== 'ready' || !confirm) return;
    busy.current = true; setSending(true); setSendError(null);
    try {
      const r = await api.review({ task_id: taskId, decision: confirm, head_commit: state.diff.head_commit,
        comment: confirm === REVIEW_DECISIONS.rejected ? comment : undefined });
      setResult(r);
      if (!structuredError(r)) { setConfirm(null); onDecided?.(r); }
    } catch (e) {
      setSendError(isNotFound(e) ? 'El host no encuentra esta tarea.' : errorText(e));
    } finally {
      busy.current = false; setSending(false);
    }
  }

  if (state.status === 'loading') return <div className="tdv" role="status">Cargando diff…</div>;
  if (state.status === 'error') {
    const msg = state.notFound ? 'El host no encuentra esta tarea.' : state.error;
    return (
      <div className="tdv">
        <div className="tdv__notice tdv__notice--error" role="alert">No se pudo cargar el diff: {msg}</div>
        <button className="lk" onClick={load}>Reintentar</button>
      </div>
    );
  }

  const { diff } = state;
  const files = Array.isArray(diff.files) ? diff.files : [];
  const err = structuredError(result);
  const done = result && !err ? result : null;
  const moved = err?.error === REVIEW_ERRORS.headMoved;
  const totalAdd = files.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = files.reduce((s, f) => s + (f.deletions || 0), 0);

  return (
    <div className="tdv">
      <div className="tdv__head">
        <span>Base <span className="mono" data-testid="tdv-base" title={diff.base_commit}>{shortSha(diff.base_commit)}</span></span>
        <span>→ Head <span className="mono" data-testid="tdv-head" title={diff.head_commit}>{shortSha(diff.head_commit)}</span></span>
        <span className="tdv__totals">{files.length} archivo{files.length === 1 ? '' : 's'} · <span className="tdv__add">+{totalAdd}</span> <span className="tdv__del">−{totalDel}</span></span>
        <button className="lk" onClick={load} disabled={sending}>Recargar diff</button>
      </div>
      {diff.base_source === BASE_SOURCES.mergeBase && (
        <div className="tdv__notice tdv__notice--warn" data-testid="tdv-merge-base">
          Base aproximada: esta tarea no tiene base_commit registrado y la base se tomó con git merge-base. El diff puede incluir o dejar fuera cambios.
        </div>
      )}
      {diff.truncated && (
        <div className="tdv__notice tdv__notice--warn" data-testid="tdv-truncated">
          El diff está truncado: el host no envió todos los cambios. Revisa la rama completa antes de aceptar.
        </div>
      )}
      {files.length === 0 ? (
        <div className="tdv__empty" data-testid="tdv-empty">Sin cambios entre la base y el head de la rama.</div>
      ) : (
        <>
          <ul className="tdv__files">
            {files.map((f) => (
              <li key={f.path}><a href={`#tdv-${f.path}`} className="mono">{f.path}</a> <span className="tdv__st">{STATUS_LABELS[f.status] || f.status}</span> <span className="tdv__add">+{f.additions || 0}</span> <span className="tdv__del">−{f.deletions || 0}</span></li>
            ))}
          </ul>
          {files.map((f) => (
            <section key={f.path} id={`tdv-${f.path}`} className="tdv__file" data-testid={`tdv-file-${f.path}`}>
              <header className="tdv__fhead mono">{f.path} <span className="tdv__st">{STATUS_LABELS[f.status] || f.status}</span></header>
              <Patch patch={f.patch} />
            </section>
          ))}
        </>
      )}

      {done && (
        <div className="tdv__notice" data-testid="tdv-done">
          {done.decision === REVIEW_DECISIONS.accepted ? 'Diff aceptado' : 'Diff rechazado'} en <span className="mono">{shortSha(done.head_commit)}</span>.
        </div>
      )}
      {lastEvent && !done && (
        <div className="tdv__notice" data-testid="tdv-last-review">
          Última revisión: {lastEvent.decision === REVIEW_DECISIONS.accepted ? 'aceptado' : 'rechazado'} en <span className="mono">{shortSha(lastEvent.head_commit)}</span>.
        </div>
      )}
      {moved && (
        <div className="tdv__notice tdv__notice--warn" role="alert" data-testid="tdv-head-moved">
          La rama se movió: ahora está en <span className="mono">{shortSha(err.found_commit)}</span>, no en el head que revisaste ({shortSha(diff.head_commit)}). No se registró la decisión. Recarga el diff y revísalo de nuevo.
          <button className="lk" onClick={load}>Recargar diff</button>
        </div>
      )}
      {err && !moved && (
        <div className="tdv__notice tdv__notice--error" role="alert">
          {`Error: ${err.error}`}
        </div>
      )}
      {sendError && <div className="tdv__notice tdv__notice--error" role="alert">{sendError}</div>}

      {!done && !moved && (
        confirm ? (
          <div className="tdv__confirm" data-testid="tdv-confirm">
            <p>{confirm === REVIEW_DECISIONS.accepted
              ? <>¿Aceptar el diff en <span className="mono">{shortSha(diff.head_commit)}</span>? Habilita Integrar para este head.</>
              : <>¿Rechazar el diff en <span className="mono">{shortSha(diff.head_commit)}</span>?</>}</p>
            {confirm === REVIEW_DECISIONS.rejected && (
              <label className="tdv__comment">Comentario (opcional)
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} disabled={sending} />
              </label>
            )}
            <div className="tdv__actions">
              <button className={confirm === REVIEW_DECISIONS.rejected ? 'lk is-danger' : 'lk'} onClick={send} disabled={sending}>
                {sending ? 'Enviando…' : confirm === REVIEW_DECISIONS.accepted ? 'Confirmar aceptar' : 'Confirmar rechazo'}
              </button>
              <button className="lk" onClick={() => setConfirm(null)} disabled={sending}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="tdv__actions">
            <button className="lk" onClick={() => setConfirm(REVIEW_DECISIONS.accepted)}>Aceptar</button>
            <button className="lk is-danger" onClick={() => setConfirm(REVIEW_DECISIONS.rejected)}>Rechazar</button>
          </div>
        )
      )}
    </div>
  );
}
