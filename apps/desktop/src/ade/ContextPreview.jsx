import { useId, useRef, useState } from 'react';
import { formatUtc } from './attemptFormat';
import { MAX_PREVIEW_REQUEST_BYTES } from './contextPreviewContract';
import {
  ERROR_COPY, describeAttachment, describeSections, describeTests, describeTruncation, formatBytes, sizeEstimate, splitRedacted, statusBadges,
} from './contextPreviewModel';
import { queryAdeCore } from './coreQueries';
import './ContextPreview.css';

/**
 * LXO-136 · Vista previa de un ContextPackage (SOLO LECTURA): qué contexto viajaría a otra sesión, proveedor o host, revisado ANTES
 * de cualquier transferencia. La persona da el paquete (un archivo o texto pegado); el Core lo verifica con la misma puerta por la
 * que entraría a un Attempt y devuelve su resumen. Aquí no se edita, no se guarda, no se inicia ninguna transferencia (F6) y no hay
 * forma de ver lo que se redactó: un valor `[redactado]` se marca como tal y se queda así.
 */
const PAGE = 50;

function Redacted({ text }) {
  const parts = splitRedacted(text);
  if (parts.length === 0) return <span className="ade-missing">vacío</span>;
  return parts.map((p, i) => (p.redacted
    ? <mark key={i} className="cp-redacted" title="Este valor se ocultó al crear el paquete. No hay forma de verlo.">{p.text}</mark>
    : <span key={i}>{p.text}</span>));
}

function Row({ label, children }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

/** Una lista larga se muestra por tramos: un paquete en el tope (500 archivos) no pinta 500 filas de golpe. */
function Paged({ items, render, label, testId }) {
  const [shown, setShown] = useState(PAGE);
  const visible = items.slice(0, shown);
  const rest = items.length - visible.length;
  return (
    <>
      <ul className="cp-list" aria-label={label} data-testid={testId}>{visible.map(render)}</ul>
      {rest > 0 && (
        <button type="button" className="lk" onClick={() => setShown((n) => n + PAGE)} data-testid={`${testId}-more`}>
          Mostrar {Math.min(PAGE, rest)} más ({rest} sin mostrar)
        </button>
      )}
    </>
  );
}

function Badges({ response }) {
  return (
    <ul className="cp-badges" aria-label="Estado del paquete">
      {statusBadges(response).map((b) => (
        <li key={b.id} className={`cp-badge cp-badge--${b.tone}`} data-badge={b.id} title={b.help}>
          <span aria-hidden="true">{b.glyph}</span> {b.label}
        </li>
      ))}
    </ul>
  );
}

function Rejected({ response }) {
  const copy = ERROR_COPY[response.error.code];
  return (
    <div className="cp-reject" role="alert" data-testid="context-preview-invalid" data-code={response.error.code}>
      <Badges response={response} />
      <p className="cp-reject__title"><strong>{copy.title}.</strong> {copy.help}</p>
      <p className="cp-note">No se muestra su contenido: un paquete que no pasa la verificación no se usa para continuar un trabajo.</p>
      {response.error.code === 'id_mismatch' && response.declared_id !== undefined && (
        <dl className="cp-ids" data-testid="context-preview-ids">
          <Row label="Identidad que declara"><code>{response.declared_id ?? 'ninguna válida'}</code></Row>
          <Row label="Identidad de su contenido"><code>{response.recomputed_id}</code></Row>
        </dl>
      )}
      <details>
        <summary>Detalle técnico</summary>
        <code>{response.error.code}: {response.error.message}</code>
      </details>
    </div>
  );
}

function Accepted({ response }) {
  const { package: pkg, summary } = response;
  const size = sizeEstimate(summary);
  const sections = describeSections(pkg, summary);
  const created = formatUtc(pkg.created_at_ms);
  const rev = pkg.revision;
  const unc = pkg.uncommitted;
  const attachments = (pkg.attachments ?? []).map(describeAttachment);
  const artifacts = pkg.artifacts ?? [];
  const truncated = (pkg.truncated ?? []).map(describeTruncation);
  const tests = pkg.test_results ? describeTests(pkg.test_results) : null;
  const STATE_TEXT = { included: 'Incluido', absent: 'Ausente', omitted: 'Omitido en parte' };
  const STATE_GLYPH = { included: '✓', absent: '–', omitted: '⊘' };
  return (
    <div className="cp-result" data-testid="context-preview-valid" data-completeness={summary.completeness}>
      <Badges response={response} />

      <section aria-labelledby="cp-verif">
        <h4 id="cp-verif" className="ssec__label">Verificación</h4>
        <ul className="cp-list" data-testid="context-preview-verification">
          <li><span aria-hidden="true">✓</span> <strong>Identidad verificada.</strong> El contenido coincide con su hash <code className="mono">{response.package_id}</code>.</li>
          <li><span aria-hidden="true">✓</span> <strong>Sin credenciales.</strong> No se encontró nada con forma de secreto.</li>
          <li><span aria-hidden="true">?</span> <strong>Adjuntos sin comprobar.</strong> Sus bytes no llegan con el paquete: se verifican al recibirlos.</li>
        </ul>
      </section>

      <section aria-labelledby="cp-size">
        <h4 id="cp-size" className="ssec__label">Tamaño</h4>
        <p data-testid="context-preview-size">
          El paquete pesa <strong>{size.package}</strong> (≈ {size.approxTokens} tokens, estimación gruesa) y {attachments.length
            ? <>sus adjuntos suman <strong>{size.attachments}</strong>, que no entran en el mensaje.</>
            : 'no lleva adjuntos.'}
        </p>
      </section>

      <section aria-labelledby="cp-source">
        <h4 id="cp-source" className="ssec__label">Origen</h4>
        <dl data-testid="context-preview-source">
          <Row label="Proyecto"><span className="mono">{pkg.source.project_id}</span></Row>
          <Row label="Task"><span className="mono">{pkg.source.task_id}</span></Row>
          <Row label="Intento"><span className="mono">{pkg.source.attempt_id}</span></Row>
          <Row label="Proveedor">{pkg.source.provider}</Row>
          <Row label="Sesión del proveedor">{pkg.source.provider_session ? <span className="mono">{pkg.source.provider_session}</span> : <span className="ade-missing">sin sesión</span>}</Row>
          <Row label="Host"><span className="mono">{pkg.source.host}</span></Row>
          <Row label="Creado">{created ? <time dateTime={created.iso}>{created.label}</time> : <span className="ade-missing">no disponible</span>}</Row>
        </dl>
        <p className="cp-note">El origen lo fijó el Core al crear el paquete: no se puede editar. La sesión y el host son huellas, no identificadores.</p>
      </section>

      <section aria-labelledby="cp-included">
        <h4 id="cp-included" className="ssec__label">Qué trae y qué no</h4>
        <ul className="cp-list" data-testid="context-preview-sections">
          {sections.map((s) => (
            <li key={s.id} data-section={s.id} data-state={s.state}>
              <span aria-hidden="true">{STATE_GLYPH[s.state]}</span> {s.label}: <strong>{STATE_TEXT[s.state]}</strong>{s.detail ? ` · ${s.detail}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="cp-text">
        <h4 id="cp-text" className="ssec__label">Objetivo, decisiones y restricciones</h4>
        <dl>
          <Row label="Objetivo"><span data-testid="context-preview-objective"><Redacted text={pkg.objective} /></span></Row>
          <Row label="Resumen del hilo">{pkg.thread_summary ? <Redacted text={pkg.thread_summary} /> : <span className="ade-missing">ausente</span>}</Row>
        </dl>
        <h5 className="cp-sub">Decisiones</h5>
        {pkg.decisions.length ? <ul className="cp-list">{pkg.decisions.map((d, i) => <li key={i}><Redacted text={d} /></li>)}</ul> : <p className="ade-missing">ninguna</p>}
        <h5 className="cp-sub">Restricciones</h5>
        {pkg.constraints.length ? <ul className="cp-list">{pkg.constraints.map((c, i) => <li key={i}><Redacted text={c} /></li>)}</ul> : <p className="ade-missing">ninguna</p>}
      </section>

      <section aria-labelledby="cp-rev">
        <h4 id="cp-rev" className="ssec__label">Revisión de código</h4>
        {rev ? (
          <>
            <dl data-testid="context-preview-revision">
              <Row label="Base"><span className="mono">{rev.base_commit}</span></Row>
              <Row label="Head"><span className="mono">{rev.head_commit}</span></Row>
              <Row label="Árbol del head"><span className="mono">{rev.head_tree}</span></Row>
              <Row label="Rama">{rev.branch ? <span className="mono">{rev.branch}</span> : <span className="ade-missing">no informada</span>}</Row>
              <Row label="Diff original">{rev.diff_sha256 ? <><span className="mono">{rev.diff_sha256.slice(0, 16)}…</span>{Number.isSafeInteger(rev.diff_bytes) ? ` · ${formatBytes(rev.diff_bytes)}` : ''}</> : <span className="ade-missing">sin hash</span>}</Row>
            </dl>
            <h5 className="cp-sub">Archivos cambiados ({(rev.files ?? []).length})</h5>
            {(rev.files ?? []).length
              ? <Paged items={rev.files} label="Archivos cambiados" testId="context-preview-files" render={(f, i) => (
                <li key={`${f.path}-${i}`}><code className="mono">{f.path}</code>{' '}<span className="cp-diffstat">+{f.added ?? '?'} −{f.deleted ?? '?'}</span></li>
              )} />
              : <p className="ade-missing">ninguno</p>}
          </>
        ) : <p className="ade-missing" data-testid="context-preview-no-revision">Sin evidencia de código: {pkg.revision_absent_reason || 'el paquete no dice por qué'}.</p>}
      </section>

      <section aria-labelledby="cp-unc">
        <h4 id="cp-unc" className="ssec__label">Cambios sin commit</h4>
        {unc && (unc.staged_patch || unc.unstaged_patch || (unc.untracked ?? []).length) ? (
          <>
            <dl>
              <Row label="Parche preparado">{unc.staged_patch ? <code className="mono">{unc.staged_patch}</code> : <span className="ade-missing">ausente</span>}</Row>
              <Row label="Parche no preparado">{unc.unstaged_patch ? <code className="mono">{unc.unstaged_patch}</code> : <span className="ade-missing">ausente</span>}</Row>
            </dl>
            {(unc.untracked ?? []).length > 0 && (
              <Paged items={unc.untracked} label="Archivos sin seguimiento" testId="context-preview-untracked" render={(f) => (
                <li key={f.path}><code className="mono">{f.path}</code> · {formatBytes(f.bytes)}{f.attachment ? ' · con adjunto' : ' · sin contenido'}</li>
              )} />
            )}
          </>
        ) : <p className="ade-missing">El worktree no tenía cambios sin commit.</p>}
      </section>

      <section aria-labelledby="cp-tests">
        <h4 id="cp-tests" className="ssec__label">Pruebas y artefactos</h4>
        {tests ? <p data-testid="context-preview-tests"><code>{tests.command}</code> · pasan {tests.passed} · fallan {tests.failed} · ignoradas {tests.ignored}</p> : <p className="ade-missing">Sin resultado de pruebas.</p>}
        {artifacts.length ? (
          <ul className="cp-list" aria-label="Artefactos">{artifacts.map((a, i) => <li key={i}>{a.kind}: <code className="mono">{a.uri}</code>{Number.isSafeInteger(a.bytes) ? ` · ${formatBytes(a.bytes)}` : ''}</li>)}</ul>
        ) : <p className="ade-missing">Sin artefactos.</p>}
      </section>

      <section aria-labelledby="cp-att">
        <h4 id="cp-att" className="ssec__label">Adjuntos</h4>
        {attachments.length ? (
          <ul className="cp-list" aria-label="Adjuntos" data-testid="context-preview-attachments">
            {attachments.map((a) => (
              <li key={a.id} data-attachment-state={a.state}>
                <span className={`cp-att cp-att--${a.state}`}>{a.state === 'omitted' ? '⊘ Omitido' : a.state === 'unscanned' ? '? Sin escanear' : '✓ Escaneado'}</span>{' '}
                {a.kind} · {a.size} · <code className="mono">{a.id}</code>
                <span className="cp-sub-note"> {a.detail}</span>
              </li>
            ))}
          </ul>
        ) : <p className="ade-missing">Sin adjuntos.</p>}
      </section>

      <section aria-labelledby="cp-red">
        <h4 id="cp-red" className="ssec__label">Redacción y recortes</h4>
        <p data-testid="context-preview-redactions">
          {pkg.redactions > 0
            ? <><strong>{pkg.redactions}</strong> {pkg.redactions === 1 ? 'valor se ocultó' : 'valores se ocultaron'} al crear el paquete. No hay forma de verlos desde aquí.</>
            : 'No se ocultó ningún valor al crear el paquete.'}
        </p>
        {truncated.length > 0 ? (
          <ul className="cp-list" aria-label="Campos recortados" data-testid="context-preview-truncated">{truncated.map((t) => <li key={t.field}><span aria-hidden="true">✂</span> {t.text}</li>)}</ul>
        ) : <p>Ningún campo se recortó.</p>}
      </section>
    </div>
  );
}

export function ContextPreview() {
  const uid = useId();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState(null);
  const [state, setState] = useState({ status: 'idle' });
  const seq = useRef(0);
  const headingId = `${uid}-h`;
  const helpId = `${uid}-help`;

  async function review() {
    const mine = ++seq.current;
    setState({ status: 'loading' });
    try {
      const response = await queryAdeCore('context_package_preview', { package: text });
      if (mine === seq.current) setState({ status: 'done', response });
    } catch (error) {
      if (mine === seq.current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  function readFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_PREVIEW_REQUEST_BYTES) {
      setFileName(file.name);
      setText('');
      setState({ status: 'error', message: `El archivo pesa ${formatBytes(file.size)}: un ContextPackage v1 no pasa de 64 KiB sin adjuntos.` });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setFileName(file.name); setText(String(reader.result ?? '')); setState({ status: 'idle' }); };
    reader.onerror = () => setState({ status: 'error', message: 'No se pudo leer el archivo.' });
    reader.readAsText(file);
  }

  function clear() {
    seq.current += 1;
    setText('');
    setFileName(null);
    setState({ status: 'idle' });
  }

  return (
    <section className="cp" aria-labelledby={headingId} data-testid="context-preview">
      <h3 className="cp__h" id={headingId}>Revisar un ContextPackage</h3>
      <p className="cp-note" id={helpId}>
        Mira qué contexto viajaría antes de cualquier transferencia. Solo lectura: no se guarda el paquete ni se inicia nada.
        {' '}Lo redactado no se puede ver.
      </p>
      <div className="cp__input">
        <label className="cp__file">
          <span>Archivo del paquete (.json)</span>
          <input type="file" accept=".json,application/json" onChange={readFile} data-testid="context-preview-file" />
        </label>
        <label className="cp__text">
          <span>…o pega aquí su JSON</span>
          <textarea
            value={text}
            rows={4}
            spellCheck={false}
            aria-describedby={helpId}
            data-testid="context-preview-text"
            onChange={(e) => { setText(e.target.value); setFileName(null); if (state.status !== 'idle') setState({ status: 'idle' }); }}
          />
        </label>
        {fileName && <p className="cp-note" data-testid="context-preview-filename">Archivo: {fileName}</p>}
        <div className="cp__actions">
          <button type="button" className="lk cp__go" onClick={review} disabled={!text.trim() || state.status === 'loading'} data-testid="context-preview-review">Revisar paquete</button>
          <button type="button" className="lk" onClick={clear} disabled={!text && state.status === 'idle'}>Limpiar</button>
        </div>
      </div>
      <div aria-live="polite" className="cp__out">
        {state.status === 'loading' && <p className="cp-note" role="status" data-testid="context-preview-loading">Revisando el paquete…</p>}
        {state.status === 'error' && (
          <p className="cp-note cp-note--warn" role="alert" data-testid="context-preview-error">{state.message.replace(/^[a-z_]+: /, '')}</p>
        )}
        {state.status === 'done' && (state.response.status === 'invalid' ? <Rejected response={state.response} /> : <Accepted response={state.response} />)}
      </div>
    </section>
  );
}
