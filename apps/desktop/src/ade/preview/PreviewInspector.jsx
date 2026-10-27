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
        <Section title="Coordinador" aside={<span className="pv-tag pv-tag--dim">Run</span>}>
          <p className="pv-insp__p">Forma parte de <b>{task.run}</b>. Tasks hermanas: {siblings.map((c) => c.title).join(', ') || '—'}.</p>
        </Section>
      )}
    </>
  );
}

function ChangesTab({ a }) {
  const s = usePreviewStore();
  const files = REVIEW_FILES[a.id];
  const rv = s.review(a.id);
  return (
    <>
      <Section title="Desde la base" aside={<span className="pv-muted">{a.files} archivos</span>}>
        <div className="pv-insp__stat"><b className="pv-good mono">+{a.add}</b><b className="pv-bad mono">−{a.del}</b>{a.tests && <span className="pv-tag">pruebas {a.tests.pass}/{a.tests.total}</span>}</div>
      </Section>
      <Section title="Archivos">
        {files ? (
          <ul className="pv-insp__files">
            {files.slice(0, 8).map((f) => <li key={f.path} className={rv.reviewed[f.path] ? 'is-done' : ''}><span className={`pv-riskdot pv-riskdot--${f.risk}`} title={`riesgo ${f.risk}`} /><span className="mono pv-trunc">{f.path}</span><span className="pv-good mono">+{f.add}</span><span className="pv-bad mono">−{f.del}</span></li>)}
            {files.length > 8 && <li className="pv-muted">+{files.length - 8} más en la revisión</li>}
          </ul>
        ) : <p className="pv-muted pv-insp__p">La lista detallada está en la revisión.</p>}
      </Section>
      <Section title="Revisión">
        <div className="pv-wrap">
          <button type="button" className="btn btn--accent btn--sm" onClick={() => s.setView(PROOF_PACKS[a.id] ? 'proof' : 'review')}>Proof Pack</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setView('review')}>Revisar los cambios</button>
        </div>
        <p className="pv-muted pv-insp__p">{Object.values(rv.reviewed).filter(Boolean).length} revisados · {rv.comments.filter((c) => !c.sent).length} comentarios pendientes</p>
      </Section>
    </>
  );
}

function ContextTab({ a }) {
  const sibs = usePreviewStore((s) => attemptsOfTask(s, a.taskId));
  const other = sibs.find((x) => x.id !== a.id);
  const rows = [
    ['Objetivo de la Task', true],
    ['Restricciones y decisiones', true],
    ['Resumen del hilo (solo lo relevante)', true],
    ['Estado del repo (base → head)', true],
    [other ? `Resumen del Intento ${other.label}` : 'Resúmenes de otros Intentos', Boolean(other)],
    ['Estado de las pruebas', true],
    ['Transcripción completa', false],
  ];
  return (
    <>
      <Section title={`ContextPackage ${a.ctx}`} aside={<span className="pv-tag pv-tag--dim">neutral · versionado</span>}>
        <p className="pv-insp__p">Lo que recibe el siguiente agente; no una transcripción que finge ser otro modelo.</p>
        <ul className="pv-insp__list pv-insp__list--plain">
          {rows.map(([k, sent]) => <li key={k} className={sent ? '' : 'pv-muted'}><span className={sent ? 'pv-good' : 'pv-muted'}>{sent ? '✓' : '—'}</span> {k}</li>)}
        </ul>
      </Section>
      <Section title="Redacción"><p className="pv-insp__p">3 secretos redactados con la política estricta.</p></Section>
      {sibs.length > 1 && (
        <Section title="Compartido con">
          <div className="pv-wrap">{sibs.filter((x) => x.id !== a.id).map((x) => <span key={x.id} className="pv-tag">Intento {x.label} · {x.ctx}</span>)}</div>
          <p className="pv-muted pv-insp__p">Mismo paquete: la comparación es justa.</p>
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
          <li className="pv-zone pv-tone-done"><b>Sin preguntar</b><span>leer el Project · escribir en su worktree · pruebas · lint · build</span></li>
          <li className="pv-zone pv-tone-waiting"><b>Pregunta</b><span>red · push · publicar · migraciones · instalar fuera del entorno</span></li>
          <li className="pv-zone pv-tone-failed"><b>Nunca</b><span>secretos · producción · borrar fuera del worktree</span></li>
        </ul>
        <p className="pv-muted pv-insp__p">Menos preguntas sin acostumbrarte a aprobar a ciegas: lo rutinario dentro del contrato; una persona en la frontera. Integrar siempre lo decide una persona.</p>
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
      <div className="panelhead"><span className="panelhead__title">Inspector</span><span className="panelhead__meta">{task.title} · Intento {a.label}</span></div>
      <div className="pv-insp__tabs">
        <Tabs value={tab} onChange={setTab} label="Inspector" options={[{ id: 'task', label: 'Task' }, { id: 'changes', label: 'Cambios' }, { id: 'context', label: 'Contexto' }, { id: 'autonomy', label: 'Autonomía' }]} />
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
