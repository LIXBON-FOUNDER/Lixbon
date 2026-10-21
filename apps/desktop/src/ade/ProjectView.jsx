import { useId, useRef, useState } from 'react';
import { ResourcesInventory } from './ResourcesInventory';
import './ProjectView.css';

/**
 * Vista de Project (LXO-204) · SLICE PARCIAL, solo presentacional y de solo lectura.
 *
 * Los contratos de Core (LXO-90/91/92/93) aún no existen en master: todas las props de
 * abajo son PROVISIONALES y pueden cambiar de forma cuando Core las fije. Este componente
 * no consulta nada, no crea nada y no muta nada: pinta lo que recibe y avisa por callbacks.
 *
 * Props (todas opcionales; lo que falte se muestra como «no disponible», nunca como vacío):
 *
 *  projectId         string · project_id duradero. Es la identidad del Project y NO cambia
 *                    al cambiar de ubicación.
 *  projectName       string · etiqueta legible suministrada por Core.
 *
 *  locations         Slice de ubicaciones conocidas: { state, items, message }.
 *                    item: { machine, path, primary, state, last_seen } (DTO de solo lectura
 *                    de LXO-90). state: 'ok' | 'missing'. El DTO no trae location_id ni
 *                    disponibilidad: no se inventan, y la ruta NO es identidad del Project.
 *                    Las ubicaciones se muestran y no son navegables (no hay ID duradero).
 *
 *  summary           { state, counts, message }. counts: { tasks, attempts, attention,
 *                    resources } con enteros ≥ 0 o null. SOLO se muestran los números que
 *                    Core suministra; la vista jamás cuenta filas ni suma nada.
 *
 *  tasks             Slice de filas Task legacy: { state, items, message }.
 *                    item: { task_id, title?, status, project_id? }
 *  filter            'active' | 'final' | 'all' (controlada) · defaultFilter (no controlada)
 *  onFilterChange    (filter) => void
 *
 *  attention         Slice: { state, items, message }.
 *                    item: { attention_id, kind, text?, task_id?, attempt_id?, project_id? }
 *  activity          Slice: { state, items, message }.
 *                    item: { activity_id, kind?, text?, occurred_at?, task_id?, attempt_id?,
 *                            project_id? }  (el texto humano lo pone Core)
 *  resources         Slice: { state, items, message }.
 *                    item: { resource_id, kind?, label?, availability?, project_id? }
 *  resourceInventory Inventario de recursos de LXO-93 (PROVISIONAL, solo lectura): ver el
 *                    typedef ResourceInventory en ResourcesInventory.jsx. Se monta dentro de
 *                    Resources y no se acota por Project: debe llegar ya acotado. Ausente =
 *                    «inventario no disponible» (LXO-93 está en Backlog); no se inventan filas.
 *
 *  Estados de slice: 'ready' | 'loading' | 'error' | 'partial' | 'degraded' | 'unavailable'.
 *  Un slice 'loading' con `refreshing: true` es una relectura sana de datos ya cargados: el aviso dice
 *  «Actualizando desde Core.» en lugar de «Cargando…» y no se presenta como dato desactualizado.
 *  Cualquier otro valor (o slice ausente) se pinta como estado desconocido / no disponible.
 *  Con 'error', 'unavailable' o estado desconocido NO se pintan los items (no son fiables);
 *  con 'loading', 'partial' y 'degraded' sí, junto al aviso.
 *
 * Callbacks de navegación: reciben SOLO el ID duradero del destino, nada más.
 *  onOpenTask(taskId)  onOpenAttempt(attemptId)
 *  onOpenAttention(attentionId)  onOpenResource(resourceId)
 *  Sin callback, o sin ID duradero en el item, el elemento se pinta sin acción.
 *
 * Distinción de ejes: el estado de la Task (pastilla), la Attention (lo que espera a una
 * persona) y la Activity (lo ocurrido) son tres secciones distintas y no se derivan entre sí.
 */

export const TASK_FILTERS = Object.freeze([
  { id: 'active', label: 'Activas' },
  { id: 'final', label: 'Finales' },
  { id: 'all', label: 'Todas' },
]);

/**
 * Estados legacy de Task (docs/VOCABULARIO.md §2). «Activas» = no finales, incluidos los que
 * esperan a una persona (`waiting`, `awaiting_terminal_approval`). Lo que no esté en ninguna
 * lista es «desconocido»: solo entra en «Todas».
 */
export const ACTIVE_TASK_STATUSES = Object.freeze(['starting', 'running', 'waiting', 'awaiting_terminal_approval']);
export const FINAL_TASK_STATUSES = Object.freeze(['done', 'failed', 'exited', 'stopped']);

const STATUS_LABEL = {
  starting: 'Arrancando',
  running: 'En curso',
  waiting: 'Esperando respuesta',
  awaiting_terminal_approval: 'Espera aprobación en terminal',
  done: 'Hecha',
  failed: 'Falló',
  exited: 'Salió',
  stopped: 'Detenida',
};

const AVAILABILITY_LABEL = {
  available: 'Disponible',
  unavailable: 'No disponible',
  unknown: 'Disponibilidad desconocida',
};

const LOCATION_STATE_LABEL = {
  ok: 'Presente',
  missing: 'Ruta no encontrada',
};

const COUNT_KEYS = [
  ['tasks', 'Tasks'],
  ['attempts', 'Attempts'],
  ['attention', 'Attention'],
  ['resources', 'Resources'],
];

const SLICE_NOTICE = {
  loading: { role: 'status', text: 'Cargando…' },
  error: { role: 'alert', text: 'No se pudo cargar esta sección.' },
  partial: { role: 'status', text: 'Datos parciales: puede faltar información.' },
  degraded: { role: 'status', text: 'Datos degradados: la fuente responde con limitaciones.' },
  unavailable: { role: 'status', text: 'No disponible: Core todavía no ofrece este dato.' },
};
const SHOW_ITEMS = new Set(['ready', 'loading', 'partial', 'degraded']);

export function taskMatchesFilter(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return ACTIVE_TASK_STATUSES.includes(status);
  if (filter === 'final') return FINAL_TASK_STATUSES.includes(status);
  return false;
}

const isId = (v) => typeof v === 'string' && v.length > 0;
const isCount = (v) => Number.isInteger(v) && v >= 0;

function normalizeSlice(slice) {
  if (!slice || typeof slice !== 'object') return { state: 'unavailable', items: [], message: null, supplied: false };
  return {
    state: typeof slice.state === 'string' ? slice.state : 'unknown',
    items: Array.isArray(slice.items) ? slice.items : [],
    message: typeof slice.message === 'string' && slice.message ? slice.message : null,
    refreshing: slice.refreshing === true,
    supplied: true,
  };
}

/** Descarta lo que Core marca como de otro Project. Lo que no trae project_id viene ya acotado. */
function scopeToProject(items, projectId) {
  if (!isId(projectId)) return { kept: items, foreign: false };
  const kept = items.filter((it) => !isId(it?.project_id) || it.project_id === projectId);
  return { kept, foreign: kept.length !== items.length };
}

function SliceNotice({ slice }) {
  const known = SLICE_NOTICE[slice.state];
  if (slice.state === 'ready') return null;
  const notice = slice.state === 'loading' && slice.refreshing
    ? { role: 'status', text: 'Actualizando desde Core.' }
    : known || { role: 'status', text: `Estado desconocido («${slice.state}»): no se puede fiar de esta sección.` };
  return (
    <p className={`pv__notice pv__notice--${known ? slice.state : 'unknown'}`} role={notice.role} aria-busy={slice.state === 'loading' ? 'true' : undefined} data-testid="slice-notice">
      {notice.text}{slice.message ? ` ${slice.message}` : ''}
    </p>
  );
}

function ForeignNote() {
  return <p className="pv__notice pv__notice--partial" role="status" data-testid="foreign-omitted">Se omitieron elementos que Core asigna a otro Project.</p>;
}

function Section({ title, headingId, note, children }) {
  return (
    <section className="pv__section" aria-labelledby={headingId}>
      <h3 className="pv__h" id={headingId}>{title}</h3>
      {note && <p className="pv__hint">{note}</p>}
      {children}
    </section>
  );
}

/** Botón de navegación por ID duradero, o texto plano si no hay callback o ID. */
function Target({ id, onOpen, className = '', label, children, testId }) {
  if (!isId(id) || typeof onOpen !== 'function') {
    return <span className={`pv__plain ${className}`}>{children}</span>;
  }
  return (
    <button type="button" className={`pv__link ${className}`} aria-label={label} data-testid={testId} onClick={() => onOpen(id)}>
      {children}
    </button>
  );
}

function Locations({ slice, headingId }) {
  const kept = slice.items;
  return (
    <Section title="Ubicaciones" headingId={headingId} note="El Project es el mismo en todas sus ubicaciones; la ruta no es su identidad.">
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <>
          {slice.state === 'ready' && kept.length === 0 && <p className="pv__empty">Core no conoce ubicaciones para este Project.</p>}
          {kept.length > 0 && (
            <ul className="pv__list" aria-labelledby={headingId}>
              {kept.map((loc, i) => {
                const known = Boolean(LOCATION_STATE_LABEL[loc?.state]);
                const lastSeen = isId(loc?.last_seen) ? loc.last_seen : null;
                return (
                  <li key={`loc-${i}`} className="pv__row pv__row--loc" data-testid="location">
                    <span className="pv__loc-host" data-testid="location-machine">{isId(loc?.machine) ? loc.machine : 'Máquina desconocida'}</span>
                    <span className={`pv__loc-path ${loc?.path ? '' : 'pv__muted'}`} data-testid="location-path">{loc?.path || 'Ruta desconocida'}</span>
                    {loc?.primary === true && <span className="pv__current" data-testid="location-primary">Principal</span>}
                    <span className={`pv__avail ${known ? `pv__avail--loc-${loc.state}` : 'pv__avail--unknown'}`} data-testid="location-state" data-state={known ? loc.state : 'unknown'}>
                      {known ? LOCATION_STATE_LABEL[loc.state] : 'Estado desconocido'}
                    </span>
                    {lastSeen
                      ? <span className="pv__time" data-testid="location-last-seen">Visto por última vez: <time dateTime={lastSeen}>{lastSeen}</time></span>
                      : <span className="pv__time pv__muted" data-testid="location-last-seen">Última vez visto: desconocido</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function Summary({ summary, headingId }) {
  const slice = summary && typeof summary === 'object'
    ? { state: typeof summary.state === 'string' ? summary.state : 'unknown', message: typeof summary.message === 'string' && summary.message ? summary.message : null, refreshing: summary.refreshing === true }
    : { state: 'unavailable', message: null, refreshing: false };
  const counts = summary?.counts && typeof summary.counts === 'object' ? summary.counts : {};
  return (
    <Section title="Resumen de Core" headingId={headingId} note="Contadores autoritativos suministrados por Core. Esta vista no los calcula.">
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <dl className="pv__counts">
          {COUNT_KEYS.map(([key, label]) => (
            <div key={key} className="pv__count" data-testid={`count-${key}`}>
              <dt>{label}</dt>
              {isCount(counts[key])
                ? <dd>{counts[key]}</dd>
                : <dd className="pv__muted" aria-label="No informado por Core">—</dd>}
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

function FilterGroup({ value, onChange, labelId, hintId }) {
  const refs = useRef({});
  const move = (index) => {
    const n = TASK_FILTERS.length;
    const next = TASK_FILTERS[(index + n) % n];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  const onKeyDown = (e, index) => {
    const keys = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: TASK_FILTERS.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    move(keys[e.key]);
  };
  return (
    <div className="pv__filters" role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId}>
      {TASK_FILTERS.map((f, i) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={value === f.id}
          tabIndex={value === f.id ? 0 : -1}
          ref={(el) => { refs.current[f.id] = el; }}
          className={`pv__filter ${value === f.id ? 'is-on' : ''}`}
          data-testid={`filter-${f.id}`}
          onClick={() => onChange(f.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function Tasks({ slice, projectId, filter, onFilter, onOpenTask, headingId }) {
  const labelId = `${headingId}-filter`;
  const hintId = `${headingId}-hint`;
  const { kept, foreign } = scopeToProject(slice.items, projectId);
  const visible = kept.filter((t) => taskMatchesFilter(t?.status, filter));
  const unknownHidden = filter !== 'all' && kept.some((t) => !ACTIVE_TASK_STATUSES.includes(t?.status) && !FINAL_TASK_STATUSES.includes(t?.status));
  return (
    <section className="pv__section" aria-labelledby={headingId}>
      <h3 className="pv__h" id={headingId}>Tasks <span className="pv__tag">estado de la Task</span></h3>
      <div className="pv__filterbar">
        <span id={labelId} className="pv__filterlabel">Filtro</span>
        <FilterGroup value={filter} onChange={onFilter} labelId={labelId} hintId={hintId} />
      </div>
      <p className="pv__hint" id={hintId}>
        Activas: {ACTIVE_TASK_STATUSES.join(', ')}. Finales: {FINAL_TASK_STATUSES.join(', ')}. Un estado fuera de esas listas es desconocido y solo aparece en «Todas».
      </p>
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <>
          {foreign && <ForeignNote />}
          {unknownHidden && <p className="pv__notice pv__notice--partial" role="status" data-testid="unknown-status-hidden">Hay Tasks con estado desconocido que solo se ven en «Todas».</p>}
          {slice.state === 'ready' && kept.length === 0 && <p className="pv__empty" data-testid="tasks-empty">Core no devuelve Tasks para este Project.</p>}
          {kept.length > 0 && visible.length === 0 && (slice.state === 'ready' || slice.state === 'partial' || slice.state === 'degraded') && (
            <p className="pv__empty" data-testid="tasks-filtered-empty">Ninguna Task coincide con el filtro «{TASK_FILTERS.find((f) => f.id === filter)?.label}».</p>
          )}
          {visible.length > 0 && (
            <ul className="pv__list" aria-labelledby={headingId}>
              {visible.map((t, i) => {
                const known = Boolean(STATUS_LABEL[t?.status]);
                return (
                  <li key={t?.task_id || `task-${i}`} className="pv__row" data-testid={isId(t?.task_id) ? `task-${t.task_id}` : 'task-sin-id'}>
                    <Target id={t?.task_id} onOpen={onOpenTask} className="pv__rowlink" testId={isId(t?.task_id) ? `open-task-${t.task_id}` : undefined}>
                      <span className="pv__title">{t?.title || t?.task_id || 'Task sin ID duradero'}</span>
                    </Target>
                    <span className={`pv__status ${known ? `pv__status--${t.status}` : 'pv__status--unknown'}`} data-testid="task-status" data-status={known ? t.status : 'unknown'}>
                      {known ? STATUS_LABEL[t.status] : `Estado desconocido${isId(t?.status) ? ` («${t.status}»)` : ''}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RelatedTargets({ scope, item, onOpenTask, onOpenAttempt }) {
  return (
    <>
      {isId(item?.task_id) && <Target id={item.task_id} onOpen={onOpenTask} className="pv__sublink" label={`Abrir Task ${item.task_id}`} testId={`${scope}-open-task-${item.task_id}`}>Task {item.task_id}</Target>}
      {isId(item?.attempt_id) && <Target id={item.attempt_id} onOpen={onOpenAttempt} className="pv__sublink" label={`Abrir Attempt ${item.attempt_id}`} testId={`${scope}-open-attempt-${item.attempt_id}`}>Attempt {item.attempt_id}</Target>}
    </>
  );
}

function Attention({ slice, projectId, onOpenAttention, onOpenTask, onOpenAttempt, headingId }) {
  const { kept, foreign } = scopeToProject(slice.items, projectId);
  return (
    <Section title={<>Attention <span className="pv__tag pv__tag--attn">espera a una persona</span></>} headingId={headingId}>
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <>
          {foreign && <ForeignNote />}
          {slice.state === 'ready' && kept.length === 0 && <p className="pv__empty" data-testid="attention-empty">Core no informa de nada que requiera atención.</p>}
          {kept.length > 0 && (
            <ul className="pv__list" aria-labelledby={headingId}>
              {kept.map((a, i) => (
                <li key={a?.attention_id || `attn-${i}`} className="pv__row pv__row--attn" data-testid={isId(a?.attention_id) ? `attention-${a.attention_id}` : 'attention-sin-id'}>
                  <Target id={a?.attention_id} onOpen={onOpenAttention} className="pv__rowlink" testId={isId(a?.attention_id) ? `open-attention-${a.attention_id}` : undefined}>
                    <code className="pv__kind" data-testid="attention-kind">{isId(a?.kind) ? a.kind : 'tipo desconocido'}</code>
                    <span className="pv__title">{a?.text || 'Core no suministró texto para esta Attention.'}</span>
                  </Target>
                  <RelatedTargets scope="attention" item={a} onOpenTask={onOpenTask} onOpenAttempt={onOpenAttempt} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function Activity({ slice, projectId, onOpenTask, onOpenAttempt, headingId }) {
  const { kept, foreign } = scopeToProject(slice.items, projectId);
  return (
    <Section title={<>Activity <span className="pv__tag">lo ocurrido</span></>} headingId={headingId}>
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <>
          {foreign && <ForeignNote />}
          {slice.state === 'ready' && kept.length === 0 && <p className="pv__empty" data-testid="activity-empty">Core no informa de actividad reciente.</p>}
          {kept.length > 0 && (
            <ol className="pv__list pv__list--timeline" aria-labelledby={headingId}>
              {kept.map((ev, i) => (
                <li key={ev?.activity_id || `act-${i}`} className="pv__row pv__row--act" data-testid={isId(ev?.activity_id) ? `activity-${ev.activity_id}` : 'activity-sin-id'}>
                  {isId(ev?.occurred_at) ? <time className="pv__time" dateTime={ev.occurred_at}>{ev.occurred_at}</time> : <span className="pv__time pv__muted">Hora desconocida</span>}
                  {ev?.text
                    ? <span className="pv__title" data-testid="activity-text">{ev.text}</span>
                    : <span className="pv__title pv__muted" data-testid="activity-no-text">
                      Core no suministró texto para esta Activity.{isId(ev?.kind) && <> Tipo sin interpretar: <code className="pv__kind">{ev.kind}</code></>}
                    </span>}
                  <RelatedTargets scope="activity" item={ev} onOpenTask={onOpenTask} onOpenAttempt={onOpenAttempt} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Section>
  );
}

function Resources({ slice, inventory, projectId, onOpenResource, headingId }) {
  const { kept, foreign } = scopeToProject(slice.items, projectId);
  return (
    <Section title="Resources" headingId={headingId}>
      <SliceNotice slice={slice} />
      {SHOW_ITEMS.has(slice.state) && (
        <>
          {foreign && <ForeignNote />}
          {slice.state === 'ready' && kept.length === 0 && <p className="pv__empty" data-testid="resources-empty">Core no informa de recursos del Project.</p>}
          {kept.length > 0 && (
            <ul className="pv__list" aria-labelledby={headingId}>
              {kept.map((r, i) => {
                const avail = AVAILABILITY_LABEL[r?.availability] ? r.availability : 'unknown';
                return (
                  <li key={r?.resource_id || `res-${i}`} className="pv__row" data-testid={isId(r?.resource_id) ? `resource-${r.resource_id}` : 'resource-sin-id'}>
                    <Target id={r?.resource_id} onOpen={onOpenResource} className="pv__rowlink" testId={isId(r?.resource_id) ? `open-resource-${r.resource_id}` : undefined}>
                      {isId(r?.kind) && <code className="pv__kind">{r.kind}</code>}
                      <span className="pv__title">{r?.label || r?.resource_id || 'Recurso sin ID duradero'}</span>
                    </Target>
                    <span className={`pv__avail pv__avail--${avail}`}>{AVAILABILITY_LABEL[avail]}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {/* Inventario de SOLO LECTURA (LXO-101). Sin datos LXO-93 pinta «no disponible», jamás filas inventadas. */}
      <ResourcesInventory inventory={inventory} />
    </Section>
  );
}

export function ProjectView({
  projectId, projectName,
  locations,
  summary,
  tasks, filter, defaultFilter = 'active', onFilterChange,
  attention, activity, resources, resourceInventory,
  onOpenTask, onOpenAttempt, onOpenAttention, onOpenResource,
}) {
  const uid = useId();
  const [innerFilter, setInnerFilter] = useState(defaultFilter);
  const requested = filter ?? innerFilter;
  const activeFilter = TASK_FILTERS.some((f) => f.id === requested) ? requested : 'active';
  const setFilter = (next) => {
    if (filter === undefined) setInnerFilter(next);
    if (typeof onFilterChange === 'function') onFilterChange(next);
  };

  const locSlice = normalizeSlice(locations);
  const titleId = `${uid}-title`;

  return (
    <article className="pv" aria-labelledby={titleId} data-testid="project-view">
      <header className="pv__head">
        <h2 className="pv__name" id={titleId}>{projectName || (isId(projectId) ? projectId : 'Project sin identificar')}</h2>
        {isId(projectId)
          ? <code className="pv__id pv__id--project" data-testid="project-id">{projectId}</code>
          : <span className="pv__notice pv__notice--unknown" role="status" data-testid="project-id-missing">Sin project_id duradero: no se puede navegar desde esta vista.</span>}
      </header>

      <Summary summary={summary} headingId={`${uid}-summary`} />
      <Locations slice={locSlice} headingId={`${uid}-locations`} />
      <Attention slice={normalizeSlice(attention)} projectId={projectId} onOpenAttention={onOpenAttention} onOpenTask={onOpenTask} onOpenAttempt={onOpenAttempt} headingId={`${uid}-attention`} />
      <Tasks slice={normalizeSlice(tasks)} projectId={projectId} filter={activeFilter} onFilter={setFilter} onOpenTask={onOpenTask} headingId={`${uid}-tasks`} />
      <Activity slice={normalizeSlice(activity)} projectId={projectId} onOpenTask={onOpenTask} onOpenAttempt={onOpenAttempt} headingId={`${uid}-activity`} />
      <Resources slice={normalizeSlice(resources)} inventory={resourceInventory} projectId={projectId} onOpenResource={onOpenResource} headingId={`${uid}-resources`} />
    </article>
  );
}
