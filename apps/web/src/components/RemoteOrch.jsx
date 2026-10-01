// RemoteOrch.jsx — el orquestador de agentes del IDE, visto desde /remote en
// la web. El IDE manda un snapshot (`state.orch`) cada vez que cambia y atiende
// las acciones que se le piden (`orch` + action): parar una tarea, ver su
// terminal o su diff, cambiar el modelo de un rol… Aquí solo se pinta y se pide.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/useT';
import { Select } from './Select';
import { IconArrowLeft, IconExternal, IconRefresh, IconStop, IconTrash } from './Icons';
import { WaveText } from './WaveText';

const FINAL = ['done', 'failed', 'stopped', 'exited'];
const isFinal = (st) => FINAL.includes(st);
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini', lixbon: 'Lixbon', coordinador: 'Coordinador' };

function useNow(active, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const elapsed = (task, now) => dur((isFinal(task.status) ? task.updated : now) - task.created);

/** Tareas de un run como árbol: el padre y debajo sus hijas. */
function tree(tasks, run) {
  const list = tasks.filter((t) => t.run === run);
  const kids = new Map();
  for (const t of list) {
    const k = t.parent || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t);
  }
  const out = [];
  const walk = (p) => (kids.get(p) || []).sort((a, b) => a.created - b.created).forEach((t) => { out.push(t); walk(t.id); });
  walk('');
  return out;
}

function pendingQuestions(messages) {
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.reply_to));
  return messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
}

export function OrchStatus({ status, size = 14 }) {
  const t = useT('remote');
  return <span className={`rorch-st rorch-st--${status}`} style={{ width: size, height: size }} title={t(`orch.status.${status}`)} />;
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`set-toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="set-toggle__knob" />
    </button>
  );
}

function Seg({ value, onChange, options }) {
  return (
    <div className="rseg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Detalle de una tarea ────────────────────────────────────────────────────

function Activity({ task, orch, t }) {
  const name = (id) => orch.tasks.find((x) => x.id === id)?.title || id;
  const mine = orch.messages.filter((m) => m.from === task.id || m.to === task.id);
  const open = pendingQuestions(orch.messages).filter((q) => q.to === task.id || q.from === task.id);
  return (
    <div className="rorch-activity">
      {open.map((q) => (
        <div key={q.id} className="rorch-question">
          <span className="rorch-eyebrow">{t('orch.questionFrom', { from: name(q.from), to: name(q.to) })}</span>
          <p>{q.body}</p>
          <span className="remote__dim">{t('orch.questionHint')}</span>
        </div>
      ))}
      {task.spec && <section className="rorch-block"><span className="rorch-label">{t('orch.spec')}</span><p className="rorch-text">{task.spec}</p></section>}
      {task.summary && (
        <section className="rorch-block">
          <span className="rorch-label">{t('orch.summary')}</span>
          <p className="rorch-text">{task.summary}</p>
          {task.files?.length > 0 && <code className="rorch-files">{task.files.join(' · ')}</code>}
        </section>
      )}
      {task.report && <section className="rorch-block"><span className="rorch-label">{t('orch.report')}</span><code className="rorch-files">{task.report}</code></section>}
      <section className="rorch-block">
        <span className="rorch-label">{t('orch.phases')}</span>
        {task.phases?.length ? (
          <ol className="rorch-phases">
            {task.phases.map((p, i) => {
              const st = p.done ? 'done' : isFinal(task.status) ? 'stopped' : 'running';
              return (
                <li key={i}>
                  <OrchStatus status={st} size={12} />
                  <span className="rorch-phase-name">{p.name}</span>
                  <span className="remote__dim">{p.done ? t('orch.phaseDone') : st === 'running' ? t('orch.phaseRunning') : t('orch.phaseOpen')}</span>
                  {p.note && <span className="rorch-phase-note">{p.note}</span>}
                </li>
              );
            })}
          </ol>
        ) : <span className="remote__dim">{t('orch.noPhases')}</span>}
      </section>
      <section className="rorch-block">
        <span className="rorch-label">{t('orch.messages')}</span>
        {mine.length ? (
          <ul className="rorch-msgs">
            {mine.slice().reverse().map((m) => (
              <li key={m.id}>
                <span className="rorch-msg-head"><b>{t(`orch.kind.${m.kind}`)}</b> {name(m.from)} → {name(m.to)}</span>
                <span>{m.body}</span>
              </li>
            ))}
          </ul>
        ) : <span className="remote__dim">{t('orch.noMessages')}</span>}
      </section>
    </div>
  );
}

function Terminal({ task, state, send, t }) {
  const term = state.orchTerm[task.id];
  const live = state.orch.live.includes(task.id);
  useEffect(() => {
    send('term', { task: task.id });
    if (!live) return undefined;
    const id = setInterval(() => send('term', { task: task.id }), 3000);
    return () => clearInterval(id);
  }, [task.id, live, send]);
  return (
    <div className="rorch-term-wrap">
      <div className="rorch-term-bar">
        <span className="remote__dim">{live ? t('orch.termLive') : t('orch.termClosed')}</span>
        <button type="button" className="rorch-link" onClick={() => send('term', { task: task.id })}><IconRefresh size={13} /> {t('orch.refresh')}</button>
      </div>
      <pre className="rorch-term">{term ? (term.text || t('orch.termEmpty')) : t('orch.loading')}</pre>
    </div>
  );
}

function Diff({ task, state, send, t }) {
  const d = state.orchDiff[task.id];
  useEffect(() => { send('diff', { task: task.id }); }, [task.id, task.updated, send]);
  if (!d) return <p className="remote__dim">{t('orch.loading')}</p>;
  return (
    <div className="rorch-diff">
      <pre className="rorch-stat">{d.stat || t('orch.noCommits')}</pre>
      {d.diff && (
        <pre className="rorch-patch">
          {d.diff.split('\n').map((l, i) => (
            <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'is-add' : l.startsWith('-') && !l.startsWith('---') ? 'is-del' : l.startsWith('@@') ? 'is-hunk' : l.startsWith('diff ') ? 'is-file' : ''}>{l}{'\n'}</span>
          ))}
        </pre>
      )}
      {d.truncated && <p className="remote__dim">{t('orch.diffTruncated')}</p>}
    </div>
  );
}

function TaskDetail({ task, state, send, onBack, t }) {
  const orch = state.orch;
  const [tab, setTab] = useState('activity');
  const final = isFinal(task.status);
  const now = useNow(!final);
  const parent = task.parent ? orch.tasks.find((x) => x.id === task.parent) : null;
  return (
    <div className="rorch-detail">
      <button type="button" className="rorch-link rorch-back" onClick={onBack}><IconArrowLeft size={14} /> {t('orch.back')}</button>
      <div className="rorch-detail-head">
        <OrchStatus status={task.status} size={20} />
        <div className="rorch-detail-text">
          <h2>{task.title || task.id}</h2>
          <p className="remote__dim">
            {t(`orch.status.${task.status}`)} · {elapsed(task, now)} · {task.role ? `${t(`orch.role.${task.role}`)} · ` : ''}{AGENTS[task.agent] || task.agent}
            {task.model ? ` (${task.model}${task.effort ? `, ${task.effort}` : ''})` : ''}
            {parent ? ` · ${t('orch.childOf', { name: parent.title || parent.id })}` : ` · ${t('orch.coordinator')}`}
          </p>
          {task.branch && <code className="rorch-branch">{task.branch}</code>}
        </div>
        <div className="rorch-detail-acts">
          {task.pr_url && <a className="rorch-link" href={task.pr_url} target="_blank" rel="noreferrer"><IconExternal size={13} /> PR</a>}
          {task.merged && <span className="rorch-pill is-ok">{t('orch.merged')}</span>}
          {!final && parent && (
            <button type="button" className="rorch-link is-danger" onClick={() => send('stop', { task: task.id })}><IconStop size={13} /> {t('orch.stop')}</button>
          )}
        </div>
      </div>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { value: 'activity', label: t('orch.tabActivity') },
          ...(task.parent ? [{ value: 'term', label: t('orch.tabTerminal') }] : []),
          ...(task.branch ? [{ value: 'diff', label: t('orch.tabChanges') }] : []),
        ]}
      />
      {tab === 'activity' && <Activity task={task} orch={orch} t={t} />}
      {tab === 'term' && <Terminal task={task} state={state} send={send} t={t} />}
      {tab === 'diff' && <Diff task={task} state={state} send={send} t={t} />}
    </div>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────

function Runs({ state, send, onOpen, t }) {
  const orch = state.orch;
  const asking = useMemo(() => new Set(pendingQuestions(orch.messages).map((q) => q.from)), [orch.messages]);
  const anyLive = orch.tasks.some((x) => !isFinal(x.status));
  const now = useNow(anyLive, 5000);
  if (!orch.runs.length) {
    return (
      <div className="rorch-empty">
        <p>{t('orch.noRuns')}</p>
        <code>/orquestar {t('orch.objectivePlaceholder')}</code>
      </div>
    );
  }
  return (
    <div className="rorch-runs">
      {orch.runs.map((r) => {
        const tasks = tree(orch.tasks, r.id);
        const kids = tasks.filter((x) => x.parent);
        const done = kids.filter((x) => x.status === 'done').length;
        const bad = kids.filter((x) => x.status === 'failed' || x.status === 'exited').length;
        const root = tasks.find((x) => !x.parent);
        const working = root && !isFinal(root.status);
        return (
          <section key={r.id} className="rorch-run">
            <div className="rorch-run-head">
              <div className="rorch-run-text">
                {working ? <WaveText text={r.objective} className="rorch-run-title" /> : <span className="rorch-run-title">{r.objective}</span>}
                <span className="remote__dim">{r.repo}{kids.length ? ` · ${t('orch.progress', { done, total: kids.length })}` : ''}</span>
              </div>
              {kids.length > 0 && (
                <span className="rorch-bar" aria-hidden="true">
                  <i className="is-done" style={{ width: `${(done / kids.length) * 100}%` }} />
                  <i className="is-bad" style={{ width: `${(bad / kids.length) * 100}%` }} />
                </span>
              )}
              <button type="button" className="rorch-icon" title={t('orch.removeRun')} aria-label={t('orch.removeRun')} onClick={() => send('remove_run', { run: r.id })}><IconTrash size={14} /></button>
            </div>
            {tasks.map((x) => {
              const phase = x.phases?.[x.phases.length - 1];
              return (
                <button key={x.id} type="button" className="rorch-task" style={{ paddingLeft: 10 + x.depth * 18 }} onClick={() => onOpen(x.id)}>
                  <OrchStatus status={x.status} />
                  <span className="rorch-task-main">
                    <span className="rorch-task-title">{x.title || x.id}</span>
                    <span className="rorch-task-meta">
                      {x.role ? `${t(`orch.role.${x.role}`)} · ` : ''}{AGENTS[x.agent] || x.agent}{x.model ? ` · ${x.model}` : ''}
                      {phase && !isFinal(x.status) ? ` · ${phase.name}` : ''}
                    </span>
                  </span>
                  {asking.has(x.id) && <span className="rorch-pill is-ask" title={t('orch.hasQuestion')}>?</span>}
                  {x.merged && <span className="rorch-pill is-ok">{t('orch.merged')}</span>}
                  <span className="rorch-time">{elapsed(x, now)}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function Settings({ state, send, t }) {
  const orch = state.orch;
  useEffect(() => { if (state.orchAgents === null) send('agents', {}); }, [state.orchAgents, send]);
  const claude = state.orchAgents?.find((a) => a.id === 'claude');
  const models = claude?.models?.length ? claude.models : ['haiku', 'sonnet', 'opus'];
  const efforts = claude?.efforts?.length ? claude.efforts : EFFORTS;
  return (
    <div className="rorch-settings">
      <section className="rorch-card">
        <div className="rorch-row">
          <div className="rorch-row-text">
            <span className="rorch-row-label">{t('orch.enabled')}</span>
            <span className="remote__dim">{orch.lxo_exists ? t('orch.enabledHint') : t('orch.noLxo')}</span>
          </div>
          <Toggle checked={orch.enabled} onChange={(on) => send('enable', { on })} label={t('orch.enabled')} />
        </div>
      </section>

      <span className="rorch-label">{t('orch.roles')}</span>
      <p className="remote__dim rorch-hint">{t('orch.rolesHint')}</p>
      <section className="rorch-card">
        {orch.roles.map((r) => (
          <div key={r.id} className="rorch-row rorch-row--role">
            <div className="rorch-row-text">
              <span className="rorch-row-label">{r.label} {r.read_only && <span className="rorch-pill is-ok">{t('orch.readOnly')}</span>}</span>
              <span className="remote__dim">{r.purpose}</span>
            </div>
            <div className="rorch-role-ctl">
              <Select
                value={r.model}
                onChange={(model) => send('settings', { role: r.id, model })}
                options={[...new Set([...models, r.model])].map((m) => ({ value: m, label: m }))}
                aria-label={t('orch.model')}
              />
              <Select
                value={r.effort || ''}
                onChange={(effort) => send('settings', { role: r.id, effort })}
                options={[{ value: '', label: t('orch.effortDefault') }, ...efforts.map((e) => ({ value: e, label: t(`orch.effort.${e}`) }))]}
                aria-label={t('orch.effortLabel')}
              />
            </div>
          </div>
        ))}
      </section>

      <div className="rorch-label-row">
        <span className="rorch-label">{t('orch.agents')}</span>
        <button type="button" className="rorch-link" onClick={() => send('agents', { refresh: true })}><IconRefresh size={13} /> {t('orch.recheck')}</button>
      </div>
      <section className="rorch-card">
        {state.orchAgents === null && <p className="remote__dim">{t('orch.checkingAgents')}</p>}
        {state.orchAgents?.length === 0 && <p className="remote__dim">{t('orch.noAgents')}</p>}
        {state.orchAgents?.map((a) => (
          <div key={a.id} className="rorch-row">
            <div className="rorch-row-text">
              <span className="rorch-row-label">{a.label}</span>
              <span className="remote__dim">{a.strengths}</span>
              <code className="rorch-files">{a.models.length ? a.models.slice(0, 8).join(', ') + (a.models.length > 8 ? '…' : '') : t('orch.noModels')}</code>
            </div>
          </div>
        ))}
      </section>

      <span className="rorch-label">{t('orch.notifications')}</span>
      <section className="rorch-card">
        {['notify_phases', 'notify_done', 'notify_questions'].map((k) => (
          <div key={k} className="rorch-row">
            <div className="rorch-row-text">
              <span className="rorch-row-label">{t(`orch.${k}`)}</span>
              <span className="remote__dim">{t(`orch.${k}Hint`)}</span>
            </div>
            <Toggle checked={!!orch.settings[k]} onChange={(v) => send('settings', { [k]: v })} label={t(`orch.${k}`)} />
          </div>
        ))}
      </section>
    </div>
  );
}

// ── Vista ───────────────────────────────────────────────────────────────────

export function RemoteOrch({ state, sendCommand }) {
  const t = useT('remote');
  const [view, setView] = useState('runs');
  const [taskId, setTaskId] = useState(null);
  const send = useMemo(() => (action, args) => sendCommand({ type: 'orch', action, args }, { quiet: true }), [sendCommand]);
  const orch = state.orch;
  const task = taskId && orch?.tasks.find((x) => x.id === taskId);
  const [errorAt, setErrorAt] = useState(0);
  useEffect(() => {
    if (!state.orchError) return undefined;
    setErrorAt(state.orchError.at);
    const id = setTimeout(() => setErrorAt(0), 6000);
    return () => clearTimeout(id);
  }, [state.orchError]);

  if (!orch) {
    return (
      <div className="rorch-empty">
        <p>{t('orch.loading')}</p>
        <button type="button" className="rorch-link" onClick={() => send('refresh', {})}><IconRefresh size={13} /> {t('orch.refresh')}</button>
      </div>
    );
  }
  if (!orch.enabled) {
    return (
      <div className="rorch-off">
        <span className="rorch-pill">{t('orch.experimental')}</span>
        <h2>{t('orch.title')}</h2>
        <p>{t('orch.offBody')}</p>
        <button type="button" className="pill-btn pill-btn--primary" onClick={() => send('enable', { on: true })}>{t('orch.enable')}</button>
      </div>
    );
  }
  return (
    <div className="rorch">
      {errorAt > 0 && state.orchError && <p className="remote__send-error" role="alert">{state.orchError.message}</p>}
      {task ? (
        <TaskDetail key={task.id} task={task} state={state} send={send} onBack={() => setTaskId(null)} t={t} />
      ) : (
        <>
          <div className="rorch-top">
            <Seg value={view} onChange={setView} options={[{ value: 'runs', label: t('orch.runs') }, { value: 'settings', label: t('orch.settings') }]} />
            {orch.workspace && <span className="remote__dim">{orch.workspace}</span>}
          </div>
          {view === 'runs' ? <Runs state={state} send={send} onOpen={setTaskId} t={t} /> : <Settings state={state} send={send} t={t} />}
        </>
      )}
    </div>
  );
}
