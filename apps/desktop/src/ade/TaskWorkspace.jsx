import { useId } from 'react';
import { useCoreQuery } from './useCoreQuery';
import './TaskWorkspace.css';

// Task Workspace / Inspector de solo lectura (LXO-98).
// Presenta exclusivamente lo que devuelve `task_detail` (project_id + task_id). No infiere host/origen ni
// ningún campo ausente: lo que no llega se muestra como "No informado". La ruta es ubicación, nunca identidad.

const MISSING = 'No informado';

export const TASK_STATUS_LABELS = {
  starting: 'Iniciando',
  running: 'En ejecución',
  waiting: 'Esperando',
  awaiting_terminal_approval: 'Esperando aprobación de terminal',
  done: 'Terminada',
  failed: 'Fallida',
  stopped: 'Detenida',
  exited: 'Cerrada',
};
const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting', 'awaiting_terminal_approval']);
const FINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'exited']);

const REVIEW_LABELS = { accepted: 'Aceptada', rejected: 'Rechazada' };
const INTEGRATION_LABELS = {
  merged: 'Integrada',
  conflict: 'Conflicto',
  error: 'Error',
  target_moved: 'Destino movido',
};

// Campos del contrato `task_detail` que pueden faltar en una respuesta parcial.
const DETAIL_FIELDS = [
  'run_id', 'parent_id', 'root_id', 'provider', 'model', 'created_at', 'updated_at', 'child_ids',
  'phase', 'messages', 'cwd', 'branch', 'worktree', 'merged', 'review', 'integration',
];
const MAX_QUESTIONS_SHOWN = 5;

const text = (value) => (typeof value === 'string' && value.trim() ? value : null);

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return { iso, label: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` };
}

function describeError(error, { hasData }) {
  const message = String(error ?? '');
  const kept = hasData ? ' Se conserva la última respuesta.' : '';
  if (/tasks_project_not_found/i.test(message)) return `El Project ya no existe en el registro de Core con ese ID.${kept}`;
  if (/tasks_not_found|_not_found/i.test(message)) return `La Task ya no está disponible en este Project con ese ID.${kept}`;
  if (/(_unavailable|degraded|almac[eé]n.*no disponible)/i.test(message)) return `Core no tiene un almacén autoritativo disponible.${kept}`;
  if (/(_auth_required|authentication|unauthorized)/i.test(message)) return `Core no pudo autenticar esta lectura.${kept}`;
  if (/(timeout|disconnected|connection|transport|ipc.*closed)/i.test(message)) return `No se pudo completar la conexión con Core.${kept}`;
  if (/(_read_failed|_internal)/i.test(message)) return `Core no pudo leer este dato.${kept}`;
  return `Core devolvió un error al leer este dato.${kept}`;
}

function titleFor(state, hasData) {
  if (/_not_found/i.test(String(state.error ?? ''))) return hasData ? 'Target no disponible' : 'Target no encontrado';
  if (state.status === 'disconnected' || state.reason === 'disconnected') return 'Core desconectado';
  if (state.status === 'degraded' || state.reason === 'degraded') return 'Core degradado';
  return 'Error de Core';
}

function Missing({ children = MISSING }) {
  return <span className="twk__missing">{children}</span>;
}

function Value({ value, mono = false, fallback }) {
  const shown = text(value);
  if (!shown) return <Missing>{fallback}</Missing>;
  return mono ? <code className="twk__mono">{shown}</code> : <span>{shown}</span>;
}

function Row({ label, children }) {
  return (
    <div className="twk__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ id, title, children }) {
  return (
    <section className="twk__section" aria-labelledby={id}>
      <h3 id={id} className="twk__section-title">{title}</h3>
      <dl className="twk__list">{children}</dl>
    </section>
  );
}

function Time({ value }) {
  const time = formatTime(value);
  if (!time) return <Missing />;
  return <time dateTime={time.iso}>{time.label}</time>;
}

function TaskLink({ projectId, taskId, relation, onNavigate }) {
  const id = text(taskId);
  if (!id) return <Missing />;
  if (!onNavigate) return <code className="twk__mono">{id}</code>;
  return (
    <button
      type="button"
      className="twk__link"
      aria-label={`Abrir ${relation} ${id}`}
      onClick={() => onNavigate({ projectId, taskId: id })}
    >
      <code className="twk__mono">{id}</code>
    </button>
  );
}

function PhaseValue({ phase }) {
  if (phase === undefined) return <Missing />;
  if (phase === null) return <Missing>Sin fase registrada</Missing>;
  const name = text(phase?.name);
  if (!name) return <Missing />;
  const done = phase.done === true ? 'completada' : phase.done === false ? 'en curso' : null;
  return (
    <span>
      {name}{done ? ` · ${done}` : ''}
      {formatTime(phase.at) && <> · <Time value={phase.at} /></>}
    </span>
  );
}

function questionSummary(messages) {
  if (messages === undefined) return { missing: true };
  if (!Array.isArray(messages)) return { missing: true };
  const valid = messages.filter((message) => message && typeof message === 'object');
  const answered = new Set(valid.filter((message) => message.kind === 'reply').map((message) => message.reply_to));
  const questions = valid.filter((message) => message.kind === 'question');
  return { missing: false, total: questions.length, open: questions.filter((question) => !answered.has(question.id)) };
}

function QuestionsValue({ messages }) {
  const summary = questionSummary(messages);
  if (summary.missing) return <Missing />;
  if (summary.total === 0) return <Missing>Sin preguntas registradas</Missing>;
  const shown = summary.open.slice(0, MAX_QUESTIONS_SHOWN);
  return (
    <div className="twk__questions">
      <span>{summary.total} registrada{summary.total === 1 ? '' : 's'} · {summary.open.length} sin respuesta</span>
      {shown.length > 0 && (
        <ul className="twk__question-list" aria-label="Preguntas sin respuesta">
          {shown.map((question) => (
            <li key={String(question.id)}>
              <code className="twk__mono">#{String(question.id)}</code>{' '}
              <span>{text(question.from) ?? MISSING} → {text(question.to) ?? MISSING}</span>
              {text(question.body) && <q className="twk__quote">{question.body}</q>}
            </li>
          ))}
        </ul>
      )}
      {summary.open.length > shown.length && <span className="twk__hint">y {summary.open.length - shown.length} más sin respuesta</span>}
    </div>
  );
}

function ReviewValue({ review }) {
  if (review === undefined) return <Missing />;
  if (review === null) return <Missing>Sin revisión registrada</Missing>;
  const decision = text(review?.decision);
  if (!decision) return <Missing />;
  return (
    <span>
      {REVIEW_LABELS[decision] ?? `${decision} (decisión desconocida)`}
      {text(review.head_commit) && <> · commit <code className="twk__mono">{review.head_commit}</code></>}
      {formatTime(review.at) && <> · <Time value={review.at} /></>}
    </span>
  );
}

function IntegrationValue({ integration }) {
  if (integration === undefined) return <Missing />;
  if (integration === null) return <Missing>Sin integración registrada</Missing>;
  const outcome = text(integration?.outcome);
  if (!outcome) return <Missing />;
  return (
    <span>
      {INTEGRATION_LABELS[outcome] ?? `${outcome} (resultado desconocido)`}
      {integration.decision_id !== undefined && integration.decision_id !== null && <> · decisión <code className="twk__mono">#{String(integration.decision_id)}</code></>}
      {formatTime(integration.at) && <> · <Time value={integration.at} /></>}
    </span>
  );
}

function statusInfo(status) {
  const raw = text(status);
  if (!raw) return { label: MISSING, group: 'unknown', raw: null };
  const group = ACTIVE_STATUSES.has(raw) ? 'active' : FINAL_STATUSES.has(raw) ? 'final' : 'unknown';
  return { label: TASK_STATUS_LABELS[raw] ?? `${raw} (estado desconocido)`, group, raw };
}

const GROUP_LABELS = { active: 'Activa', final: 'Final', unknown: MISSING };

function Banner({ state, hasData, projectId, taskId }) {
  const { status } = state;
  if (status === 'loading') {
    return <div className="twk__banner" role="status">Conectando con Core para cargar el detalle de la Task…</div>;
  }
  if (status === 'refreshing') {
    return <div className="twk__banner" role="status">Actualizando desde Core…</div>;
  }
  if (status === 'stale') {
    const kind = state.reason === 'disconnected' ? 'desconectado' : state.reason === 'degraded' ? 'degradado' : 'con error';
    return (
      <div className="twk__banner twk__banner--stale" role="status">
        <strong>Datos desactualizados · Core {kind}</strong>
        <span>{describeError(state.error, { hasData: true })}</span>
        <code className="twk__mono">{state.error}</code>
        {state.retry && <button type="button" className="twk__action" onClick={state.retry}>Reintentar</button>}
      </div>
    );
  }
  if (['degraded', 'disconnected', 'error'].includes(status)) {
    return (
      <div className="twk__banner twk__banner--error" role="alert">
        <strong>{titleFor(state, hasData)}</strong>
        <span>{describeError(state.error, { hasData })}</span>
        <span className="twk__hint">Target: Project <code className="twk__mono">{projectId}</code> · Task <code className="twk__mono">{taskId}</code></span>
        <code className="twk__mono">{state.error}</code>
        {state.retry && <button type="button" className="twk__action" onClick={state.retry}>Reintentar</button>}
      </div>
    );
  }
  return null;
}

/**
 * Vista presentacional y de solo lectura de una Task.
 *
 * Props:
 * - `projectId`, `taskId`: IDs durables del target seleccionado (obligatorios para mostrar datos).
 * - `detail`: estado de `useCoreQuery('task_detail', …)`: `{ status, data, error, reason, updatedAt, retry }`.
 * - `project`: `{ id, name }` opcional; el nombre solo se usa si `project.id === projectId`.
 * - `onNavigate({ projectId, taskId })`: opcional; navegación a padre/raíz/hijas por ID durable. Sin él, son texto.
 * - `variant`: `'workspace'` (por defecto) o `'inspector'` (solo cambia la clase CSS compacta).
 */
export function TaskWorkspaceView({ projectId, taskId, detail, project = null, onNavigate, variant = 'workspace' }) {
  const uid = useId();
  const state = detail ?? { status: 'idle', data: null, error: null, reason: null, updatedAt: null };
  const hasTarget = Boolean(text(projectId) && text(taskId));
  const task = state.data?.task;
  const verified = Boolean(task) && hasTarget && task.id === taskId && task.project_id === projectId;
  const mismatched = Boolean(task) && hasTarget && !verified;
  const visible = verified ? task : null;
  const busy = state.status === 'loading' || state.status === 'refreshing';
  const className = `twk twk--${variant === 'inspector' ? 'inspector' : 'workspace'}`;
  const headingId = `${uid}-title`;
  const info = statusInfo(visible?.status);
  const projectName = project && project.id === projectId ? text(project.name) : null;
  const missingFields = visible ? DETAIL_FIELDS.filter((field) => !(field in visible)) : [];
  const childIds = Array.isArray(visible?.child_ids) ? visible.child_ids.filter((id) => text(id)) : null;
  const refreshable = verified && state.status === 'ready' && state.retry;

  if (!hasTarget) {
    return (
      <section className={className} aria-labelledby={headingId} data-state="idle">
        <h2 id={headingId} className="twk__title">Task</h2>
        <p className="twk__empty" role="status">Selecciona un Project y una Task del Core para ver su detalle.</p>
      </section>
    );
  }

  return (
    <section className={className} aria-labelledby={headingId} aria-busy={busy} data-state={state.status} data-target-verified={verified}>
      <header className="twk__head">
        <h2 id={headingId} className="twk__title">{visible ? (text(visible.title) ?? 'Task sin título') : 'Task'}</h2>
        {visible && (
          <span className={`twk__status twk__status--${info.group}`} data-status={info.raw ?? ''}>{info.label}</span>
        )}
        {refreshable && <button type="button" className="twk__action" onClick={state.retry}>Actualizar</button>}
      </header>

      <Banner state={state} hasData={Boolean(visible)} projectId={projectId} taskId={taskId} />

      {mismatched && (
        <div className="twk__banner twk__banner--error" role="alert">
          <strong>Respuesta no verificada</strong>
          <span>La respuesta de Core no corresponde al Project y Task seleccionados; no se muestra para evitar mezclar identidades.</span>
          <span className="twk__hint">Seleccionado: Project <code className="twk__mono">{projectId}</code> · Task <code className="twk__mono">{taskId}</code></span>
        </div>
      )}

      {visible && missingFields.length > 0 && (
        <div className="twk__banner twk__banner--partial" role="status">
          <strong>Respuesta parcial de Core</strong>
          <span>Faltan campos del contrato: {missingFields.join(', ')}. Se muestran como «{MISSING}».</span>
        </div>
      )}

      {visible && (
        <div className="twk__body">
          <Section id={`${uid}-identity`} title="Identidad">
            <Row label="Task"><Value value={visible.title} fallback="Task sin título" /></Row>
            <Row label="Task ID"><Value value={visible.id} mono /></Row>
            <Row label="Project"><Value value={projectName} /></Row>
            <Row label="Project ID"><Value value={visible.project_id} mono /></Row>
            <Row label="Tipo">
              {visible.parent_id === null ? 'Raíz' : text(visible.parent_id) ? 'Hija' : <Missing />}
            </Row>
          </Section>

          <Section id={`${uid}-state`} title="Estado">
            <Row label="Estado">
              <span>{info.label}</span>
              {info.raw && <> <code className="twk__mono">{info.raw}</code></>}
            </Row>
            <Row label="Grupo"><span>{GROUP_LABELS[info.group]}</span></Row>
            <Row label="Fase"><PhaseValue phase={visible.phase} /></Row>
            <Row label="Preguntas"><QuestionsValue messages={visible.messages} /></Row>
            <Row label="Revisión"><ReviewValue review={visible.review} /></Row>
            <Row label="Integración"><IntegrationValue integration={visible.integration} /></Row>
            <Row label="Marca merged">
              {visible.merged === true ? 'Marcada como integrada' : visible.merged === false ? 'No marcada' : <Missing />}
            </Row>
          </Section>

          <Section id={`${uid}-run`} title="Ejecución y jerarquía">
            <Row label="Proveedor"><Value value={visible.provider} /></Row>
            <Row label="Modelo solicitado"><Value value={visible.model} /></Row>
            <Row label="Run"><Value value={visible.run_id} mono /></Row>
            <Row label="Raíz">
              {visible.root_id === visible.id ? <span>Esta Task</span> : <TaskLink projectId={visible.project_id} taskId={visible.root_id} relation="Task raíz" onNavigate={onNavigate} />}
            </Row>
            <Row label="Padre">
              {visible.parent_id === null ? <Missing>Sin padre (raíz)</Missing> : <TaskLink projectId={visible.project_id} taskId={visible.parent_id} relation="Task padre" onNavigate={onNavigate} />}
            </Row>
            <Row label="Hijas">
              {childIds === null && <Missing />}
              {childIds?.length === 0 && <Missing>Sin hijas</Missing>}
              {childIds?.length > 0 && (
                <ul className="twk__children" aria-label="Tasks hijas">
                  {childIds.map((id) => (
                    <li key={id}><TaskLink projectId={visible.project_id} taskId={id} relation="Task hija" onNavigate={onNavigate} /></li>
                  ))}
                </ul>
              )}
            </Row>
          </Section>

          <Section id={`${uid}-location`} title="Ubicación">
            <Row label="cwd"><Value value={visible.cwd} mono /></Row>
            <Row label="Rama"><Value value={visible.branch} mono /></Row>
            <Row label="Worktree"><Value value={visible.worktree} mono /></Row>
          </Section>
          <p className="twk__hint">La ruta es una ubicación, no la identidad de la Task: la identidad son los IDs durables.</p>

          <Section id={`${uid}-time`} title="Tiempos">
            <Row label="Creada"><Time value={visible.created_at} /></Row>
            <Row label="Actualizada"><Time value={visible.updated_at} /></Row>
            <Row label="Última lectura"><Time value={state.updatedAt} /></Row>
          </Section>

          <p className="twk__hint twk__verified">Target verificado: la respuesta coincide con el Project ID y Task ID seleccionados. Solo lectura.</p>
        </div>
      )}
    </section>
  );
}

/**
 * Task Workspace conectado a Core. Si el shell ya consulta `task_detail`, pasa ese estado en `detail`
 * y no se lanza una segunda consulta; si no, consulta por sí mismo (`enabled` la pausa).
 */
export function TaskWorkspace({ projectId, taskId, detail, enabled = true, pollMs, ...rest }) {
  const hasTarget = Boolean(text(projectId) && text(taskId));
  const own = useCoreQuery(
    'task_detail',
    { project_id: projectId ?? null, task_id: taskId ?? null },
    { enabled: enabled && hasTarget && !detail, ...(pollMs ? { pollMs } : {}) },
  );
  return <TaskWorkspaceView projectId={projectId} taskId={taskId} detail={detail ?? own} {...rest} />;
}

export default TaskWorkspace;
