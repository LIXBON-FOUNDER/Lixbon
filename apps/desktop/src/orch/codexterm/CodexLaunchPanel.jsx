// CodexLaunchPanel.jsx — antes de abrir la pestaña de Codex: carpeta, modelo y esfuerzo
// opcionales, y la política, argv y avisos que da el host (codex_term_policy). No lanza nada
// hasta "Abrir"; si hay avisos, exige marcarlos y manda acknowledged.
import { useEffect, useState } from 'react';
import { Select } from '../../components/Select';
import { ArgvDisplay } from '../policy/EffectivePolicyView';
import { modelOptions, effortOptions } from '../providers/roleConfig';
import { codexTerm as defaultApi, isNeedsAck, policyText } from './codexTermContract';
import '../policy/policy.css';

export const ACK_LABEL = 'Entiendo los avisos y quiero abrir Codex';

/**
 * `resume` ({ id, title }): reanuda esa sesión guardada en lugar de abrir una nueva.
 * @param {{ cwd: string, codex: object|null, resume?: { id: string, title?: string }|null, api?: typeof defaultApi,
 *   onOpened: (res: object, args: object) => void, onCancel?: () => void }} props
 */
export function CodexLaunchPanel({ cwd, codex, resume = null, api = defaultApi, onOpened, onCancel }) {
  const resumeId = resume?.id || '';
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [pol, setPol] = useState(null);
  const [error, setError] = useState(null);
  const [ack, setAck] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    setPol(null); setError(null); setAck(false);
    if (!cwd) return undefined;
    api.policy({ cwd, model, effort, ...(resumeId ? { resume: resumeId } : {}) })
      .then((p) => alive && setPol({ policy: p?.policy ?? null, argv: Array.isArray(p?.argv) ? p.argv : [], warnings: Array.isArray(p?.warnings) ? p.warnings : [] }))
      .catch((e) => alive && setError(`No se pudo leer la política: ${e?.message || e}`));
    return () => { alive = false; };
  }, [cwd, model, effort, resumeId, api]);

  const hasWarnings = Boolean(pol?.warnings.length);
  const canOpen = Boolean(cwd && pol && !opening && (!hasWarnings || ack));
  const open = async () => {
    if (!canOpen) return;
    setOpening(true); setError(null);
    const args = { cwd, model, effort, ...(resumeId ? { resume: resumeId, title: resume.title } : {}) };
    try {
      const res = await api.open({ ...args, cols: 200, rows: 40, acknowledged: hasWarnings ? ack : false });
      onOpened(res, args);
    } catch (e) {
      if (isNeedsAck(e)) { setAck(false); setError('El host pide confirmar los avisos antes de abrir Codex.'); }
      else setError(`No se pudo abrir Codex: ${e?.message || e}`);
    }
    setOpening(false);
  };

  return (
    <section className="policy codexlaunch" aria-label={resume ? 'Reanudar una sesión de Codex' : 'Abrir Codex en una terminal'}>
      <h3 className="policy__title">{resume ? 'Reanudar sesión de Codex' : 'Codex en una terminal'}</h3>
      <dl className="policy__details">
        {resume && <><dt>Sesión</dt><dd data-testid="codex-resume-title">{resume.title || resumeId}</dd></>}
        <dt>Carpeta</dt>
        <dd className="mono" data-testid="codex-cwd">{cwd || 'Abre una carpeta primero'}</dd>
        <dt>Modelo</dt>
        <dd><Select className="select--fill" value={model} onChange={setModel} options={modelOptions(codex, model)} title="Modelo de Codex" /></dd>
        <dt>Esfuerzo</dt>
        <dd><Select className="select--fill" value={effort} onChange={setEffort} options={effortOptions(codex, effort)} title="Esfuerzo de Codex" /></dd>
        {pol && <>
          {policyText(pol.policy) && <><dt>Política</dt><dd data-testid="codex-policy">{policyText(pol.policy)}</dd></>}
          <dt>Comando (argv exacto)</dt>
          <dd><code data-testid="codex-argv" className="mono"><ArgvDisplay argv={pol.argv} /></code></dd>
          <dt>Advertencias</dt>
          <dd>{hasWarnings ? <ul className="policy__warnings" data-testid="codex-warnings">{pol.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : '—'}</dd>
        </>}
      </dl>
      {!pol && !error && cwd && <p className="policy__muted">Resolviendo la política…</p>}
      {error && <p role="alert" className="policy__error">{error}</p>}
      {hasWarnings && (
        <label className="policy__ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {ACK_LABEL}
        </label>
      )}
      <div className="codexlaunch__actions">
        {onCancel && <button type="button" className="lk" onClick={onCancel}>Cancelar</button>}
        <button type="button" className="policy__launch" disabled={!canOpen} onClick={open}>{opening ? 'Abriendo…' : resume ? 'Reanudar' : 'Abrir'}</button>
      </div>
    </section>
  );
}
