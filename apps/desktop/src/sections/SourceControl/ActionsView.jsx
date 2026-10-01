// ActionsView.jsx — GitHub Actions del repositorio en el modo Git: workflows a
// la izquierda; en el centro sus ejecuciones o el detalle de una (jobs, pasos
// y log por paso). Se puede lanzar un workflow (workflow_dispatch), cancelar,
// re-ejecutar entera, solo lo fallido o un job. Todo por la CLI `gh`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGitStore } from '../../store/gitStore';
import { useChatStore } from '../../store/chatStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { toast } from '../../store/toastStore';
import { githubSlug } from '../../lib/githubSlug';
import { openExternal } from '../../lib/tauri';
import { showConfirm } from '../../lib/confirm';
import {
  ghStatus, listWorkflows, listRuns, viewRun, rerunRun, rerunJob, cancelRun, setWorkflowEnabled,
  dispatchWorkflow, jobLog, workflowDispatch, runState,
} from '../../lib/github';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { Switch } from '../../components/Switch';
import { SpinRing } from '../../components/Ring';
import { LogoMark } from '../../components/Logo';
import {
  IconExternal, IconRefresh, IconPlay, IconStop, IconRotate, IconChevronRight, IconChevronLeft, IconGitBranch, IconX,
} from '../../components/Icons';
import { StatusIcon, STATE_TEXT, duration, secsBetween } from './ghShared';
import { hace } from '../../team/lib/tiempo';

const EVENT_LABEL = {
  push: 'push', pull_request: 'pull request', workflow_dispatch: 'manual', schedule: 'programado',
  release: 'release', pull_request_target: 'pull request', workflow_run: 'tras otro workflow', repository_dispatch: 'API',
};
const ACTIVE = new Set(['running', 'queued']);
const errText = (e) => String(e?.message || e);

function askAgent(text) {
  useWorkbenchStore.getState().setMode('agent');
  useChatStore.getState().send(text);
}

/** Repite `fn` cada `ms` mientras `on` sea verdadero (y la vista esté montada). */
function usePoll(fn, ms, on) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

// ── Lanzar un workflow ──────────────────────────────────────────────────

function DispatchForm({ workflow, info, branch, onClose, onDone }) {
  const [ref, setRef] = useState(branch || '');
  const [values, setValues] = useState(() => Object.fromEntries(info.inputs.map((i) => [i.name, i.default || (i.type === 'choice' ? i.options[0] || '' : '')])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setValues((cur) => ({ ...cur, [k]: v }));
  const missing = info.inputs.filter((i) => i.required && String(values[i.name] ?? '') === '');

  const submit = async (e) => {
    e.preventDefault();
    if (!ref.trim() || missing.length) return;
    setBusy(true);
    setError('');
    try {
      await dispatchWorkflow(workflow.id, ref.trim(), values);
      toast(`«${workflow.name}» lanzado en ${ref.trim()}`);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ghd__card ghdispatch rise" onSubmit={submit}>
      <div className="ghdispatch__head">
        <strong>Ejecutar «{workflow.name}»</strong>
        <button type="button" className="ic" onClick={onClose} aria-label="Cerrar"><IconX size={13} /></button>
      </div>
      <label className="fieldlabel">
        <span>Rama o tag</span>
        <div className="field field--strong"><IconGitBranch size={13} /><input value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} /></div>
      </label>
      {info.inputs.map((inp) => (
        <label key={inp.name} className="fieldlabel">
          <span>{inp.description || inp.name}{inp.required && <em className="ghdispatch__req"> *</em>} <span className="mono scm2__muted">{inp.name}</span></span>
          {inp.type === 'boolean' ? (
            <Switch checked={String(values[inp.name]) === 'true'} onChange={(v) => set(inp.name, v ? 'true' : 'false')} label={inp.name} />
          ) : inp.type === 'choice' && inp.options.length ? (
            <Select value={values[inp.name]} onChange={(v) => set(inp.name, v)} options={inp.options.map((o) => ({ value: o, label: o }))} />
          ) : (
            <div className="field field--strong"><input value={values[inp.name]} onChange={(e) => set(inp.name, e.target.value)} spellCheck={false} /></div>
          )}
        </label>
      ))}
      {error && <span className="scm2__error">{error}</span>}
      <div className="ghdispatch__acts">
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn--accent" disabled={busy || !ref.trim() || missing.length > 0}>
          {busy ? <SpinRing size={12} color="var(--on-accent)" /> : <IconPlay size={12} />} Ejecutar
        </button>
      </div>
    </form>
  );
}

// ── Lista de ejecuciones ────────────────────────────────────────────────

function RunRow({ run, index, onOpen, onChanged }) {
  const st = runState(run);
  const [busy, setBusy] = useState(false);
  const act = async (e, fn, ok) => {
    e.stopPropagation();
    setBusy(true);
    try { await fn(); toast(ok); onChanged(); } catch (err) { toast(errText(err), { tone: 'danger' }); } finally { setBusy(false); }
  };
  const secs = ACTIVE.has(st) ? secsBetween(run.startedAt || run.createdAt, new Date().toISOString()) : secsBetween(run.startedAt || run.createdAt, run.updatedAt);
  return (
    <div className={`ghrun is-${st}`} role="button" tabIndex={0} style={{ animationDelay: `${Math.min(index, 12) * 20}ms` }}
      onClick={() => onOpen(run.databaseId)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(run.databaseId); }}>
      <StatusIcon state={st} size={18} />
      <span className="ghrun__text">
        <span className="ghrun__title">{run.displayTitle || run.name}</span>
        <span className="ghrun__meta">
          <span>{run.workflowName} <span className="mono">#{run.number}</span></span>
          <span>· {EVENT_LABEL[run.event] || run.event}</span>
          {run.headBranch && <span className="ghrun__branch mono">{run.headBranch}</span>}
          {run.attempt > 1 && <span>· intento {run.attempt}</span>}
        </span>
      </span>
      <span className="ghrun__when">
        <span>{hace(run.createdAt)}</span>
        <span className="mono">{ACTIVE.has(st) ? STATE_TEXT[st].toLowerCase() : duration(secs)}</span>
      </span>
      <span className="ghrun__acts">
        {busy ? <SpinRing size={13} /> : ACTIVE.has(st) ? (
          <button className="ic" title="Cancelar la ejecución" onClick={(e) => act(e, () => cancelRun(run.databaseId), 'Cancelando la ejecución…')}><IconStop size={13} /></button>
        ) : (
          <>
            {st === 'fail' && <button className="ic" title="Re-ejecutar lo que falló" onClick={(e) => act(e, () => rerunRun(run.databaseId, true), 'Re-ejecutando los jobs fallidos…')}><IconRotate size={13} /></button>}
            <button className="ic" title="Re-ejecutar todo" onClick={(e) => act(e, () => rerunRun(run.databaseId, false), 'Re-ejecutando…')}><IconRefresh size={13} /></button>
          </>
        )}
        <button className="ic" title="Abrir en GitHub" onClick={(e) => { e.stopPropagation(); openExternal(run.url); }}><IconExternal size={13} /></button>
      </span>
    </div>
  );
}

function RunsPanel({ slug, workflow, onOpen, onWorkflowsChanged }) {
  const { branch } = useGitStore();
  const [status, setStatus] = useState('');
  const [onlyBranch, setOnlyBranch] = useState(false);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [dispatch, setDispatch] = useState(undefined); // undefined: cargando · null: no se puede
  const [showForm, setShowForm] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await listRuns({ workflow: workflow?.id, branch: onlyBranch ? branch : '', status });
      setRuns(list);
      setError('');
    } catch (e) {
      setError(errText(e));
      setRuns((cur) => cur || []);
    }
  }, [workflow?.id, onlyBranch, branch, status]);

  useEffect(() => { setRuns(null); load(); }, [load]);
  const active = (runs || []).some((r) => ACTIVE.has(runState(r)));
  usePoll(load, active ? 5000 : 30000, true);

  useEffect(() => {
    setShowForm(false);
    if (!workflow || workflow.state !== 'active') { setDispatch(null); return undefined; }
    let gone = false;
    setDispatch(undefined);
    workflowDispatch(slug, workflow.path, branch).then((d) => { if (!gone) setDispatch(d); }).catch(() => { if (!gone) setDispatch(null); });
    return () => { gone = true; };
  }, [slug, workflow, branch]);

  const toggleWorkflow = async () => {
    const on = workflow.state !== 'active';
    if (!on) {
      const { choice } = await showConfirm({
        title: `Desactivar «${workflow.name}»`,
        message: 'No volverá a ejecutarse con ningún evento hasta que lo actives otra vez.',
        options: [{ id: 'yes', label: 'Desactivar', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
      });
      if (choice !== 'yes') return;
    }
    setToggling(true);
    try {
      await setWorkflowEnabled(workflow.id, on);
      await onWorkflowsChanged();
      toast(on ? 'Workflow activado' : 'Workflow desactivado');
    } catch (e) {
      toast(errText(e), { tone: 'danger' });
    } finally {
      setToggling(false);
    }
  };

  const counts = useMemo(() => {
    const c = { ok: 0, fail: 0, active: 0 };
    for (const r of runs || []) { const s = runState(r); if (s === 'ok') c.ok++; else if (s === 'fail') c.fail++; else if (ACTIVE.has(s)) c.active++; }
    return c;
  }, [runs]);

  return (
    <div className="ghd scroll">
      <div className="ghd__main">
        <div className="ghd__head rise">
          <div className="ghruns__titlerow">
            <span className="ghd__title">{workflow ? workflow.name : 'Todas las ejecuciones'}</span>
            <div className="panelhead__fill" />
            {workflow && dispatch && (
              <button className="btn btn--accent btn--sm" onClick={() => setShowForm((v) => !v)}><IconPlay size={11} /> Ejecutar workflow</button>
            )}
            {workflow && dispatch === undefined && workflow.state === 'active' && <SpinRing size={12} />}
          </div>
          <div className="ghd__meta">
            {workflow ? <span className="mono">{workflow.path}</span> : <span>Todos los workflows del repositorio</span>}
            {runs && <span>· {counts.ok} correctas · {counts.fail} fallidas{counts.active ? ` · ${counts.active} en curso` : ''}</span>}
            {workflow && (
              <button className="lk ghruns__toggle" onClick={toggleWorkflow} disabled={toggling}>
                · {workflow.state === 'active' ? 'Desactivar' : 'Activar'}
              </button>
            )}
          </div>
        </div>

        {showForm && dispatch && (
          <DispatchForm workflow={workflow} info={dispatch} branch={branch} onClose={() => setShowForm(false)}
            onDone={() => { setShowForm(false); setTimeout(load, 2500); setTimeout(load, 7000); }} />
        )}
        {workflow && dispatch === null && workflow.state === 'active' && (
          <span className="scm2__muted ghruns__hint">Este workflow no tiene <code>workflow_dispatch</code>: solo se ejecuta con sus eventos.</span>
        )}

        <div className="ghruns__filters">
          <Segmented size="sm" width={78} value={status} onChange={setStatus}
            options={[{ value: '', label: 'Todas' }, { value: 'in_progress', label: 'En curso' }, { value: 'failure', label: 'Fallidas' }, { value: 'success', label: 'Correctas' }]} />
          {branch && (
            <Segmented size="sm" width={104} value={onlyBranch ? 'b' : 'all'} onChange={(v) => setOnlyBranch(v === 'b')}
              options={[{ value: 'all', label: 'Todas las ramas' }, { value: 'b', label: branch.length > 14 ? `${branch.slice(0, 13)}…` : branch }]} />
          )}
          <div className="panelhead__fill" />
          <button className="lk" onClick={load}><IconRefresh size={12} /> Actualizar</button>
        </div>

        {error && <span className="scm2__error">{error}</span>}
        {runs === null && <span className="skeleton ghlist__skeleton" />}
        {runs?.length === 0 && !error && <div className="ghd__card scm2__muted">No hay ejecuciones con estos filtros.</div>}
        {runs?.length > 0 && (
          <div className="ghruns">
            {runs.map((r, i) => <RunRow key={r.databaseId} run={r} index={i} onOpen={onOpen} onChanged={() => setTimeout(load, 1500)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detalle de una ejecución ────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- quita los códigos de color ANSI del log
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function LogLines({ lines }) {
  const [all, setAll] = useState(false);
  const MAX = 1500;
  const shown = all || lines.length <= MAX ? lines : lines.slice(-MAX);
  return (
    <div className="ghlog mono">
      {!all && lines.length > MAX && <button className="lk ghlog__more" onClick={() => setAll(true)}>Mostrar las {lines.length - MAX} líneas anteriores</button>}
      {shown.map((l, i) => {
        const text = l.text.replace(ANSI, '');
        if (text.startsWith('##[endgroup]')) return null;
        const kind = text.startsWith('##[error]') ? 'err' : text.startsWith('##[warning]') ? 'warn' : text.startsWith('##[group]') ? 'group' : text.startsWith('[command]') ? 'cmd' : '';
        return (
          <div key={i} className={`ghlog__line ${kind ? `is-${kind}` : ''}`}>
            <span className="ghlog__n">{i + 1 + (shown.length < lines.length ? lines.length - shown.length : 0)}</span>
            <span className="ghlog__t">{text.replace(/^##\[(error|warning|group)\]/, '').replace(/^\[command\]/, '$ ')}</span>
          </div>
        );
      })}
    </div>
  );
}

function JobPane({ job, runDone, onRerun }) {
  const st = runState({ status: job.status?.toLowerCase(), conclusion: job.conclusion?.toLowerCase() });
  const done = !ACTIVE.has(st);
  const [log, setLog] = useState(null);
  const [logErr, setLogErr] = useState('');
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => {
    setLog(null);
    setLogErr('');
    if (!done) return undefined;
    let gone = false;
    jobLog(job.databaseId)
      .then((g) => { if (!gone) setLog(g); })
      .catch((e) => { if (!gone) setLogErr(errText(e)); });
    return () => { gone = true; };
  }, [job.databaseId, done]);

  const steps = job.steps || [];
  // Grupos del log ↔ pasos: por nombre y, si no casa, por orden.
  const byStep = useMemo(() => {
    const map = new Map();
    if (!log) return map;
    const left = [...log];
    for (const s of steps) {
      const i = left.findIndex((g) => g.step === s.name);
      if (i >= 0) { map.set(s.number, left[i]); left.splice(i, 1); }
    }
    const pending = steps.filter((s) => !map.has(s.number) && s.conclusion?.toLowerCase() !== 'skipped');
    pending.forEach((s, i) => { if (left[i]) map.set(s.number, left[i]); });
    return map;
  }, [log, steps]);

  useEffect(() => {
    const failed = steps.filter((s) => s.conclusion?.toLowerCase() === 'failure').map((s) => s.number);
    setOpen(new Set(failed));
  }, [job.databaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (n) => setOpen((cur) => { const s = new Set(cur); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  const failedStep = steps.find((s) => s.conclusion?.toLowerCase() === 'failure');

  const fixWithAgent = () => {
    const group = failedStep && byStep.get(failedStep.number);
    const tail = (group?.lines || []).slice(-80).map((l) => l.text.replace(ANSI, '')).join('\n');
    askAgent(`El job «${job.name}» de GitHub Actions falló${failedStep ? ` en el paso «${failedStep.name}»` : ''}. Encuentra la causa en el repositorio y arréglala.${tail ? `\n\nÚltimas líneas del log:\n\`\`\`\n${tail}\n\`\`\`` : ''}`);
  };

  return (
    <div className="ghjob rise">
      <div className="ghjob__head">
        <StatusIcon state={st} size={20} />
        <div className="ghjob__title">
          <strong>{job.name}</strong>
          <span className="scm2__muted">{STATE_TEXT[st]}{done && secsBetween(job.startedAt, job.completedAt) != null ? ` · ${duration(secsBetween(job.startedAt, job.completedAt))}` : ''}</span>
        </div>
        <div className="panelhead__fill" />
        {st === 'fail' && <button className="btn btn--ghost btn--sm" onClick={fixWithAgent}><LogoMark size={11} /> Resolver con el agente</button>}
        {runDone && <button className="btn btn--ghost btn--sm" onClick={() => onRerun(job)}><IconRefresh size={11} /> Re-ejecutar job</button>}
        <button className="ic" title="Abrir en GitHub" onClick={() => openExternal(job.url)}><IconExternal size={13} /></button>
      </div>
      {!done && <span className="scm2__muted ghjob__note">El log estará disponible cuando termine el job. Los pasos se actualizan solos.</span>}
      {logErr && <span className="scm2__error ghjob__note">No se pudo leer el log: {logErr}</span>}
      <div className="ghsteps">
        {steps.map((s) => {
          const sst = runState({ status: s.status?.toLowerCase(), conclusion: s.conclusion?.toLowerCase() });
          const group = byStep.get(s.number);
          const isOpen = open.has(s.number) && group;
          return (
            <div key={s.number} className={`ghstep ${isOpen ? 'is-open' : ''}`}>
              <button className="ghstep__row" onClick={() => group && toggle(s.number)} disabled={!group}>
                <span className={`ghstep__chev ${isOpen ? 'is-open' : ''}`}>{group ? <IconChevronRight size={11} /> : null}</span>
                <StatusIcon state={sst} size={14} />
                <span className="ghstep__name">{s.name}</span>
                <span className="mono ghstep__time">{sst === 'skip' ? 'omitido' : duration(secsBetween(s.startedAt, s.completedAt))}</span>
              </button>
              {isOpen && <LogLines lines={group.lines} />}
            </div>
          );
        })}
        {done && log === null && !logErr && <span className="ghjob__note"><SpinRing size={12} /> Cargando el log…</span>}
      </div>
    </div>
  );
}

function RunDetail({ id, onBack }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await viewRun(id);
      setRun(r);
      setError('');
      setJobId((cur) => {
        if (cur && r.jobs?.some((j) => j.databaseId === cur)) return cur;
        const failed = r.jobs?.find((j) => j.conclusion === 'failure');
        const running = r.jobs?.find((j) => j.status === 'in_progress');
        return (failed || running || r.jobs?.[0])?.databaseId ?? null;
      });
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);

  useEffect(() => { setRun(null); setJobId(null); load(); }, [load]);
  const st = runState(run);
  usePoll(load, 4000, ACTIVE.has(st));

  const act = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toast(ok); setTimeout(load, 1500); } catch (e) { toast(errText(e), { tone: 'danger' }); } finally { setBusy(''); }
  };

  if (error && !run) {
    return (
      <div className="ghd__empty ghd__empty--col">
        <span className="scm2__error">{error}</span>
        <button className="btn btn--ghost" onClick={load}><IconRefresh size={12} /> Reintentar</button>
        <button className="lk" onClick={onBack}><IconChevronLeft size={12} /> Volver a las ejecuciones</button>
      </div>
    );
  }
  if (!run) return <div className="ghd__empty"><SpinRing size={16} /></div>;

  const jobs = run.jobs || [];
  const job = jobs.find((j) => j.databaseId === jobId);
  const done = !ACTIVE.has(st);
  const anyFailed = jobs.some((j) => ['failure', 'cancelled', 'timed_out'].includes(j.conclusion));
  const total = done ? secsBetween(run.startedAt || run.createdAt, run.updatedAt) : secsBetween(run.startedAt || run.createdAt, new Date().toISOString());

  return (
    <div className="ghd ghd--run scroll">
      <div className="ghd__main">
        <button className="lk ghback" onClick={onBack}><IconChevronLeft size={12} /> Ejecuciones</button>
        <div className={`ghrunhead is-${st} rise`}>
          <StatusIcon state={st} size={28} />
          <div className="ghrunhead__text">
            <span className="ghd__title">{run.displayTitle || run.name}</span>
            <div className="ghd__meta">
              <span>{run.workflowName} <span className="mono">#{run.number}</span></span>
              <span>· {EVENT_LABEL[run.event] || run.event}</span>
              {run.headBranch && <span className="ghrun__branch mono">{run.headBranch}</span>}
              <span className="mono">{run.headSha?.slice(0, 7)}</span>
              {run.attempt > 1 && <span>· intento {run.attempt}</span>}
              <span>· {hace(run.createdAt)}</span>
              {total != null && <span>· {duration(total)}</span>}
            </div>
          </div>
          <div className="ghrunhead__acts">
            {!done ? (
              <button className="btn btn--ghost ghbtn--danger" disabled={!!busy} onClick={() => act('cancel', () => cancelRun(run.databaseId), 'Cancelando la ejecución…')}>
                {busy === 'cancel' ? <SpinRing size={12} /> : <IconStop size={12} />} Cancelar
              </button>
            ) : (
              <>
                {anyFailed && (
                  <button className="btn btn--ghost" disabled={!!busy} onClick={() => act('failed', () => rerunRun(run.databaseId, true), 'Re-ejecutando los jobs fallidos…')}>
                    {busy === 'failed' ? <SpinRing size={12} /> : <IconRotate size={12} />} Re-ejecutar fallidos
                  </button>
                )}
                <button className="btn btn--ghost" disabled={!!busy} onClick={() => act('all', () => rerunRun(run.databaseId, false), 'Re-ejecutando todos los jobs…')}>
                  {busy === 'all' ? <SpinRing size={12} /> : <IconRefresh size={12} />} Re-ejecutar todo
                </button>
              </>
            )}
            <button className="ic" title="Abrir en GitHub" onClick={() => openExternal(run.url)}><IconExternal size={14} /></button>
          </div>
        </div>

        <div className="ghrunbody">
          <div className="ghjobs">
            <span className="ssec__label">Jobs · {jobs.length}</span>
            {jobs.length === 0 && <span className="scm2__muted">{done ? 'Sin jobs.' : 'Esperando a que empiecen los jobs…'}</span>}
            {jobs.map((j) => {
              const jst = runState({ status: j.status?.toLowerCase(), conclusion: j.conclusion?.toLowerCase() });
              return (
                <button key={j.databaseId} className={`ghjobitem ${j.databaseId === jobId ? 'is-active' : ''}`} onClick={() => setJobId(j.databaseId)}>
                  <StatusIcon state={jst} size={15} />
                  <span className="ghjobitem__name">{j.name}</span>
                  <span className="mono ghjobitem__time">{ACTIVE.has(jst) ? '' : duration(secsBetween(j.startedAt, j.completedAt))}</span>
                </button>
              );
            })}
          </div>
          {job
            ? <JobPane key={job.databaseId} job={job} runDone={done} onRerun={(j) => act('job', () => rerunJob(j.databaseId), `Re-ejecutando «${j.name}»…`)} />
            : <div className="ghd__empty">Elige un job.</div>}
        </div>
      </div>
    </div>
  );
}

// ── Vista ───────────────────────────────────────────────────────────────

export function ActionsView({ runId, onRunChange }) {
  const { remoteUrl } = useGitStore();
  const slug = remoteUrl && remoteUrl.includes('github.com') ? githubSlug(remoteUrl) : '';
  const [status, setStatus] = useState(null);
  const [workflows, setWorkflows] = useState(null);
  const [wfId, setWfId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { ghStatus().then(setStatus); }, []);

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflows(await listWorkflows());
      setError('');
    } catch (e) {
      setError(errText(e));
      setWorkflows([]);
    }
  }, []);

  useEffect(() => { if (status === 'ok' && slug) loadWorkflows(); }, [status, slug, loadWorkflows]);

  if (status === null) return <div className="ghd__empty"><SpinRing size={16} /></div>;
  if (!slug) return <div className="ghd__empty">El remoto de este repositorio no es GitHub.</div>;
  if (status !== 'ok') {
    return (
      <div className="ghwrap">
        <div className="ghnotice">
          {status === 'missing'
            ? <>Instala <button className="lk is-accent" onClick={() => openExternal('https://cli.github.com')}>GitHub CLI</button> e inicia sesión con <code>gh auth login</code> para ver y controlar GitHub Actions desde aquí.</>
            : <>Inicia sesión en GitHub CLI con <code>gh auth login</code> en el terminal para ver y controlar GitHub Actions desde aquí.</>}
        </div>
        <div className="ghd__empty"><button className="lk" onClick={() => openExternal(`https://github.com/${slug}/actions`)}><IconExternal size={12} /> Abrir Actions en GitHub</button></div>
      </div>
    );
  }

  const workflow = workflows?.find((w) => w.id === wfId) || null;
  const pick = (id) => { setWfId(id); onRunChange(null); };

  return (
    <div className="ghlayout">
      <div className="ghlist">
        <div className="ghlist__bar ghlist__bar--row">
          <span className="ssec__label">Workflows</span>
          <button className="ic" title="Actualizar" onClick={loadWorkflows}><IconRefresh size={12} /></button>
        </div>
        <button className={`ghitem ${wfId === null ? 'is-active' : ''}`} onClick={() => pick(null)}>
          <span className="ghitem__icon"><IconPlay size={13} /></span>
          <span className="ghitem__text"><span className="ghitem__title">Todas las ejecuciones</span></span>
        </button>
        {error && <span className="scm2__error ghlist__pad">{error}</span>}
        {workflows === null && <span className="skeleton ghlist__skeleton" />}
        {workflows?.length === 0 && !error && <span className="scm2__muted ghlist__pad">Este repositorio no tiene workflows.</span>}
        {workflows?.map((w, i) => (
          <button key={w.id} className={`ghitem ${wfId === w.id ? 'is-active' : ''} ${w.state !== 'active' ? 'is-off' : ''}`} style={{ animationDelay: `${i * 25}ms` }} onClick={() => pick(w.id)}>
            <span className="ghitem__icon ghitem__icon--wf"><IconPlay size={13} /></span>
            <span className="ghitem__text">
              <span className="ghitem__title">{w.name}</span>
              <span className="scm2__muted mono ghitem__path">{w.path.replace(/^\.github\/workflows\//, '')}{w.state !== 'active' ? ' · desactivado' : ''}</span>
            </span>
          </button>
        ))}
      </div>
      {runId
        ? <RunDetail key={runId} id={runId} onBack={() => onRunChange(null)} />
        : <RunsPanel slug={slug} workflow={workflow} onOpen={onRunChange} onWorkflowsChanged={loadWorkflows} />}
    </div>
  );
}
