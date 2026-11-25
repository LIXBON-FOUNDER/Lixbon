import { FileIcon } from '@lixbon/icons/file-icons';
// PreviewInspector.jsx — panel derecho. No repite el navegador: responde «¿qué debía lograr esto,
// con qué contexto y con qué permisos?».
import { useState } from 'react';
import { usePreviewStore, attemptById, taskOf, attemptsOfTask } from './previewStore';
import { REVIEW_FILES, PROOF_PACKS } from './previewData';
import { I, Tabs } from './PreviewUi';
import { policyName } from './previewVocab';

function Section({ title, aside, children }) {
  return (
    <section className="ade__inspector-section pv-insp__sec">
      <div className="pv-insp__sechead"><span className="ssec__label">{title}</span>{aside}</div>
      {children}
    </section>
  );
}

function TaskTab({ task }) {
  const s = usePreviewStore();
  const siblings = task.run ? s.tasks.filter((t) => t.run === task.run && t.id !== task.id) : [];
  return (
    <>
      <Section title="Objetivo"><p className="pv-insp__p">{task.objective}</p></Section>
      {task.criteria.length > 0 && <Section title="Criterios de aceptación"><ul className="pv-insp__list">{task.criteria.map((c) => <li key={c}><I n="check" size={11} />{c}</li>)}</ul></Section>}
      {task.constraints.length > 0 && <Section title="Restricciones"><ul className="pv-insp__list pv-insp__list--plain">{task.constraints.map((c) => <li key={c}>{c}</li>)}</ul></Section>}
      {task.decisions.length > 0 && <Section title="Decisiones tomadas"><ul className="pv-insp__list pv-insp__list--plain">{task.decisions.map((c) => <li key={c}>{c}</li>)}</ul></Section>}
      {task.run && (
        <Section title="Tarea principal">
          <p className="pv-insp__p">Forma parte de <b>{task.run}</b>{siblings.length > 0 && <>, junto con {siblings.map((c) => c.title).join(' e ')}</>}.</p>
        </Section>
      )}
    </>
  );
}

function ChangesTab({ a }) {
  const s = usePreviewStore();
  const files = REVIEW_FILES[a.id]?.slice().sort((left, right) => ({high: 0, medium: 1, low: 2}[left.risk] ?? 3) - ({high: 0, medium: 1, low: 2}[right.risk] ?? 3));
  const rv = s.review(a.id);
  return (
    <>
      <Section title="Desde la base" aside={<span className="pv-muted">{a.files} archivos</span>}>
        <div className="pv-insp__stat"><b className="pv-good mono">+{a.add}</b><b className="pv-bad mono">−{a.del}</b>{a.tests && <span className="pv-tag">pruebas {a.tests.pass}/{a.tests.total}</span>}</div>
      </Section>
      <Section title="Archivos">
        {files ? (
          <ul className="pv-insp__files">
            {files.slice(0, 8).map((f) => <li key={f.path} className={rv.reviewed[f.path] ? 'is-done' : ''}><span className={`pv-riskdot pv-riskdot--${f.risk}`} title={`riesgo ${f.risk}`} /><FileIcon nombre={f.path} size={16} /><span className="mono pv-trunc">{f.path}</span><span className="pv-good mono">+{f.add}</span><span className="pv-bad mono">−{f.del}</span></li>)}
            {files.length > 8 && <li className="pv-muted">+{files.length - 8} más en la revisión</li>}
          </ul>
        ) : <p className="pv-muted pv-insp__p">La lista detallada está en la revisión.</p>}
      </Section>
      <Section title="Revisión">
        <div className="pv-wrap">
          <button type="button" className="btn btn--accent btn--sm" onClick={() => s.setView(PROOF_PACKS[a.id] ? 'proof' : 'review')}>Pruebas del intento</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setView('review')}>Revisar los cambios</button>
        </div>
        <p className="pv-muted pv-insp__p">{Object.values(rv.reviewed).filter(Boolean).length} archivos revisados · {rv.comments.filter((c) => !c.sent).length} comentarios sin resolver</p>
      </Section>
    </>
  );
}

function ContextTab({ a }) {
  const sibs = usePreviewStore((s) => attemptsOfTask(s, a.taskId));
  const other = sibs.find((x) => x.id !== a.id);
  const rows = [
    ['Objetivo de la tarea', true],
    ['Restricciones y decisiones', true],
    ['Lo relevante de la conversación', true],
    ['Cambios del repositorio desde la base', true],
    [other ? `Resumen del Intento ${other.label}` : 'Resúmenes de otros Intentos', Boolean(other)],
    ['Estado de las pruebas', true],
    ['Transcripción completa', false],
  ];
  return (
    <>
      <Section title="Paquete de contexto" aside={<span className="pv-tag pv-tag--dim">{a.ctx}</span>}>
        <p className="pv-insp__p">Lo que recibe el siguiente agente, sea cual sea: un resumen, no la conversación entera</p>
        <ul className="pv-insp__list pv-insp__list--plain">
          {rows.map(([k, sent]) => <li key={k} className={sent ? '' : 'pv-muted'}><span className={sent ? 'pv-good' : 'pv-muted'}>{sent ? '✓' : '—'}</span> {k}</li>)}
        </ul>
      </Section>
      <Section title="Secretos"><p className="pv-insp__p">3 ocultados antes de enviarlo, con la política estricta</p></Section>
      {sibs.length > 1 && (
        <Section title="Compartido con">
          <div className="pv-wrap">{sibs.filter((x) => x.id !== a.id).map((x) => <span key={x.id} className="pv-tag">Intento {x.label} · {x.ctx}</span>)}</div>
          <p className="pv-muted pv-insp__p">Los dos reciben lo mismo, así que la comparación es justa</p>
        </Section>
      )}
    </>
  );
}

function AutonomyTab({ a }) {
  return (
    <>
      <Section title="Perfil de autonomía" aside={<span className="pv-tag">{policyName(a.policy)}</span>}>
        <ul className="pv-zones">
          <li className="pv-zone pv-tone-done"><b>Lo hace solo</b><span>leer el Project · escribir en su worktree · pruebas · lint · build</span></li>
          <li className="pv-zone pv-tone-waiting"><b>Te pregunta antes</b><span>red · push · publicar · migraciones · instalar fuera del entorno</span></li>
          <li className="pv-zone pv-tone-failed"><b>Nunca lo hace</b><span>secretos · producción · borrar fuera del worktree</span></li>
        </ul>
        <p className="pv-muted pv-insp__p">Lo rutinario lo hace solo; lo delicado te lo pregunta. Integrar siempre lo decides tú</p>
      </Section>
    </>
  );
}

export function PreviewInspector() {
  const s = usePreviewStore();
  const a = attemptById(s, s.sel.attemptId);
  const [tab, setTab] = useState('task');
  if (!a) return null;
  const task = taskOf(s, a);
  return (
    <>
      <div className="panelhead"><span className="panelhead__title">Inspector</span><span className="panelhead__fill" /><span className="panelhead__meta">Intento {a.label}</span></div>
      <div className="pv-insp__tabs">
        <Tabs value={tab} onChange={setTab} label="Inspector" options={[{ id: 'task', label: 'Tarea' }, { id: 'changes', label: 'Cambios' }, { id: 'context', label: 'Contexto' }, { id: 'autonomy', label: 'Autonomía' }]} />
      </div>
      <div className="ade__inspector-content scroll">
        {tab === 'task' && <TaskTab task={task} />}
        {tab === 'changes' && <ChangesTab a={a} />}
        {tab === 'context' && <ContextTab a={a} />}
        {tab === 'autonomy' && <AutonomyTab a={a} />}
      </div>
    </>
  );
}
