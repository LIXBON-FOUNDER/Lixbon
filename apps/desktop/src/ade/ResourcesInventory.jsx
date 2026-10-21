// ResourcesInventory.jsx — inventario de recursos de SOLO LECTURA (LXO-101).
//
// Consume el DTO de Core de `resource_inventory` (docs/core/RESOURCES.md) TAL CUAL: no hay un
// modelo alterno ni una clasificación propia. El DTO llega como:
//
//   {
//     v: 1,
//     machine: 'm-1',
//     filters: { project_id: null, probe: true },
//     repos: [{ project_id, machine, path, scan: 'ok'|'unavailable'|'other_machine', reason? }],
//     worktrees: [{
//       target: { machine, project_id, repo, path },
//       state: 'tracked'|'missing_on_disk'|'not_registered'|'orphan_candidate'|'external'|'unknown',
//       origin: 'task'|'lixbon_dir'|'external',
//       physical: 'present'|'missing'|'unknown',
//       git: { registered: true|false|null, branch, detached, locked, prunable },
//       owner: { task_id, run_id, status } | null,
//       dirty: 'clean'|'dirty'|'unknown'|'skipped',
//       merged: 'merged'|'unmerged'|'unknown'|'skipped',
//       into: string|null,
//       needs_review: true|false|null,
//     }],
//     preserved_branches: [{
//       target: { machine, project_id, repo, branch },
//       branch_exists: true|false|null,
//       owner: { task_id, run_id, status } | null,
//       merged, into, needs_review,
//     }],
//     warnings: { branches_to_review: number|null, worktrees_by_state: {…} },
//   }
//
// Reglas de la vista (LXO-101):
//  · Solo lectura: ni una operación de Git, ni un enlace, ni un botón. Ruta y rama son metadato.
//  · Cada categoría de Core va a su sección y no se mezcla con otra: los seis estados de
//    worktree, los repos con escaneo no disponible, los de otro equipo y las ramas conservadas.
//  · «Falta» solo lo afirma el sistema de archivos (`state: missing_on_disk`): `unknown` y un
//    escaneo no disponible NO son falta, aunque git haya fallado.
//  · `needs_review` es el veredicto de Core: gobierna el aviso y el filtro «Por revisar»; no se
//    deduce de `merged === 'unmerged'`.
//  · `dirty`/`merged` con valor `skipped` («no evaluado») se muestran distintos de `unknown`.
//  · `owner: null` significa «sin propietario», no «desconocido».
//  · El contador de avisos es `warnings.branches_to_review` tal cual; nunca se deriva de las filas.
//  · El acotado es por Project ID (`project_id`), nunca por ProjectLocation.
import { useMemo, useState } from 'react';
import './ResourcesInventory.css';

const NONE = '__none__';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0;
/** Texto del DTO tal cual; `null` si Core no lo da. */
const text = (v) => (isId(v) ? v : null);

/** Estados de `worktrees[].state` (vocabulario cerrado de Core). */
const WORKTREE_STATES = new Set([
  'tracked',
  'missing_on_disk',
  'not_registered',
  'orphan_candidate',
  'external',
  'unknown',
]);

const STATE_LABEL = {
  tracked: 'Registrado',
  missing_on_disk: 'Falta en disco',
  not_registered: 'No registrado en git',
  orphan_candidate: 'Candidato huérfano',
  external: 'Externo',
  unknown: 'Desconocido',
};

const ORIGIN_LABEL = {
  task: 'Task de Lixbon',
  lixbon_dir: 'Carpeta de Lixbon',
  external: 'Externo',
};

const PHYSICAL_LABEL = { present: 'Presente', missing: 'Falta', unknown: 'Desconocido' };

// `skipped` es «no se evaluó» (probe=false o no hay carpeta que mirar): NO es «desconocido».
const DIRTY_LABEL = { clean: 'Limpio', dirty: 'Con cambios', unknown: 'Desconocido', skipped: 'No evaluado' };
const MERGED_LABEL = { merged: 'Fusionado', unmerged: 'Sin fusionar', unknown: 'Desconocido', skipped: 'No evaluado' };

const SCAN_LABEL = { ok: 'Escaneo correcto', unavailable: 'No disponible', other_machine: 'Otro equipo' };

const REASON_LABEL = {
  path_missing: 'La ruta no existe',
  not_a_repository: 'No es un repositorio',
  git_not_installed: 'git no está instalado',
  timeout: 'git agotó el tiempo',
  git_failed: 'git falló',
  other_machine: 'El repo está en otro equipo',
};

/** Secciones: una por categoría de Core. Ninguna se mezcla con otra. */
export const SECTIONS = [
  { key: 'scan_ok', title: 'Repos con escaneo correcto' },
  { key: 'scan_unavailable', title: 'Repos no disponibles' },
  { key: 'scan_other_machine', title: 'Repos en otro equipo' },
  { key: 'tracked', title: 'Worktrees registrados' },
  { key: 'missing_on_disk', title: 'Faltan en disco' },
  { key: 'not_registered', title: 'No registrados en git' },
  { key: 'orphan_candidate', title: 'Candidatos huérfanos' },
  { key: 'external', title: 'Externos' },
  { key: 'unknown', title: 'Desconocidos' },
  { key: 'preserved', title: 'Ramas conservadas' },
];

export const STATE_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'scan_ok', label: 'Escaneo correcto' },
  { value: 'scan_unavailable', label: 'Escaneo no disponible' },
  { value: 'scan_other_machine', label: 'Otro equipo' },
  { value: 'tracked', label: 'Registrado' },
  { value: 'missing_on_disk', label: 'Falta en disco' },
  { value: 'not_registered', label: 'No registrado en git' },
  { value: 'orphan_candidate', label: 'Candidato huérfano' },
  { value: 'external', label: 'Externo' },
  { value: 'unknown', label: 'Desconocido' },
  { value: 'preserved', label: 'Rama conservada' },
];

/** El aviso y el filtro los gobierna `needs_review` de Core, no `merged === 'unmerged'`. */
export const REVIEW_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'needs_review', label: 'Solo los que Core marca para revisar' },
];

/**
 * Fila derivada del DTO: conserva la entrada original (`entry`) y añade solo lo que la vista
 * necesita para agrupar, filtrar y tener una clave estable de React.
 */
function worktreeRow(entry, index) {
  const target = isObject(entry.target) ? entry.target : {};
  const state = typeof entry.state === 'string' ? entry.state : '';
  return {
    kind: 'worktree',
    // Un estado que Core no reconoce nunca es «falta»: se muestra como desconocido.
    section: WORKTREE_STATES.has(state) ? state : 'unknown',
    coreState: state || null,
    projectId: text(target.project_id),
    machine: text(target.machine),
    entry,
    key: `wt:${index}:${text(target.machine) ?? ''}|${text(target.project_id) ?? ''}|${text(target.repo) ?? ''}|${text(target.path) ?? ''}`,
  };
}

function preservedRow(entry, index) {
  const target = isObject(entry.target) ? entry.target : {};
  return {
    kind: 'preserved',
    section: 'preserved',
    coreState: null,
    projectId: text(target.project_id),
    machine: text(target.machine),
    entry,
    key: `pb:${index}:${text(target.machine) ?? ''}|${text(target.project_id) ?? ''}|${text(target.repo) ?? ''}|${text(target.branch) ?? ''}`,
  };
}

function repoRow(entry, index) {
  const scan = typeof entry.scan === 'string' ? entry.scan : '';
  return {
    kind: 'repo',
    section: scan === 'ok' ? 'scan_ok' : scan === 'other_machine' ? 'scan_other_machine' : 'scan_unavailable',
    coreState: scan || null,
    projectId: text(entry.project_id),
    machine: text(entry.machine),
    entry,
    key: `repo:${index}:${text(entry.machine) ?? ''}|${text(entry.path) ?? ''}`,
  };
}

/**
 * Lee el DTO de Core. Devuelve `null` cuando no hay inventario utilizable (eso es «no
 * disponible», nunca una lista vacía ni filas inventadas).
 */
export function readInventory(inventory) {
  if (!isObject(inventory)) return null;
  const repos = Array.isArray(inventory.repos) ? inventory.repos : null;
  const worktrees = Array.isArray(inventory.worktrees) ? inventory.worktrees : null;
  const preserved = Array.isArray(inventory.preserved_branches) ? inventory.preserved_branches : null;
  if (!repos && !worktrees && !preserved) return null;

  const rows = [];
  (repos ?? []).forEach((entry, i) => { if (isObject(entry)) rows.push(repoRow(entry, i)); });
  (worktrees ?? []).forEach((entry, i) => { if (isObject(entry)) rows.push(worktreeRow(entry, i)); });
  (preserved ?? []).forEach((entry, i) => { if (isObject(entry)) rows.push(preservedRow(entry, i)); });

  const warnings = isObject(inventory.warnings) ? inventory.warnings : null;
  // El contador es el de Core (`warnings.branches_to_review`); nunca se deriva de las filas.
  const branchesToReview = warnings
    && Number.isInteger(warnings.branches_to_review)
    && warnings.branches_to_review >= 0
    ? warnings.branches_to_review
    : null;

  return { rows, branchesToReview };
}

/**
 * Acota por Project ID. Lo que no trae `project_id` se conserva: no se puede afirmar que sea de
 * otro Project. En ningún caso se filtra por ProjectLocation (la ruta no es la identidad).
 */
export function scopeByProject(rows, projectId) {
  if (!isId(projectId)) return { rows, omitted: 0 };
  const kept = rows.filter((r) => r.projectId === null || r.projectId === projectId);
  return { rows: kept, omitted: rows.length - kept.length };
}

/** Sección de la fila (una de `SECTIONS`). */
export function sectionOf(row) {
  return row?.section ?? 'unknown';
}

/** ¿Cumple la fila el filtro de categoría? */
export function matchesState(row, filter) {
  return filter === 'all' || sectionOf(row) === filter;
}

/** ¿Cumple la fila el filtro de aviso? Solo `needs_review` de Core lo decide. */
export function matchesReview(row, filter) {
  if (filter === 'all') return true;
  return row?.kind !== 'repo' && row?.entry?.needs_review === true;
}

/** ¿Cumple la fila el filtro de Project ID? */
export function matchesProject(row, filter) {
  if (filter === 'all') return true;
  if (filter === NONE) return row?.projectId === null;
  return row?.projectId === filter;
}

/** «Falta» solo lo afirma el sistema de archivos. Ni `unknown` ni un escaneo no disponible. */
export function isMissing(row) {
  return row?.kind === 'worktree' && row?.entry?.state === 'missing_on_disk';
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function idOptions(rows, noneLabel) {
  const vals = rows.map((r) => r.projectId).filter((v) => v !== null);
  const opts = [{ value: 'all', label: 'Todos' }, ...uniqueSorted(vals).map((v) => ({ value: v, label: v }))];
  if (rows.some((r) => r.projectId === null)) opts.push({ value: NONE, label: noneLabel });
  return opts;
}

const registeredText = (v) => (v === true ? 'Sí' : v === false ? 'No' : 'No se pudo comprobar');
const branchExistsText = (v) => (v === true ? 'Sí' : v === false ? 'No' : 'No se pudo comprobar');

function FilterSelect({ id, label, value, onChange, options }) {
  return (
    <div className="resinv__filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** Etiqueta de la fila: el estado de Core, no una clasificación propia. */
function StateTag({ row }) {
  if (row.kind === 'repo') {
    return (
      <span className={`resinv__tag resinv__tag--${row.section}`} data-testid="resinv-state">
        {SCAN_LABEL[row.section === 'scan_ok' ? 'ok' : row.section === 'scan_other_machine' ? 'other_machine' : 'unavailable']}
      </span>
    );
  }
  if (row.kind === 'preserved') {
    return (
      <span className="resinv__tag resinv__tag--preserved" data-testid="resinv-state">
        Rama conservada
      </span>
    );
  }
  return (
    <span className={`resinv__tag resinv__tag--${row.section}`} data-testid="resinv-state">
      {STATE_LABEL[row.section]}
    </span>
  );
}

/** Aviso de Core (`needs_review`), nunca deducido de `merged === 'unmerged'`. */
function ReviewTag({ entry }) {
  if (!isObject(entry)) return null;
  if (entry.needs_review === true) {
    return (
      <span className="resinv__tag resinv__tag--warning" data-testid="resinv-needs-review">
        Por revisar
      </span>
    );
  }
  if (entry.needs_review === null) {
    return (
      <span className="resinv__tag resinv__tag--unavailable" data-testid="resinv-review-unknown">
        Revisión no evaluada
      </span>
    );
  }
  return null;
}

function OwnerFields({ owner }) {
  const hasOwner = isObject(owner);
  return (
    <>
      <dt>Propietario</dt>
      <dd data-testid="resinv-owner">{hasOwner ? (text(owner.task_id) ?? 'Sin propietario') : 'Sin propietario'}</dd>
      <dt>Ejecución</dt>
      <dd data-testid="resinv-run">{hasOwner ? (text(owner.run_id) ?? '—') : '—'}</dd>
      <dt>Estado de la tarea</dt>
      <dd data-testid="resinv-owner-status">{hasOwner ? (text(owner.status) ?? '—') : '—'}</dd>
    </>
  );
}

function WorktreeRow({ row }) {
  const entry = row.entry;
  const target = isObject(entry.target) ? entry.target : {};
  const git = isObject(entry.git) ? entry.git : {};
  const prunable = git.prunable === true;
  return (
    <li className={`resinv__row resinv__row--${row.section}`} data-testid="resinv-row" data-resource-key={row.key}>
      <div className="resinv__head">
        <span className="resinv__id" data-testid="resinv-target">{text(target.path) ?? '—'}</span>
        <StateTag row={row} />
        <ReviewTag entry={entry} />
        {prunable && (
          <span className="resinv__tag resinv__tag--unavailable" data-testid="resinv-prunable">
            git lo marca como podable
          </span>
        )}
      </div>
      <dl className="resinv__meta">
        <dt>Estado (Core)</dt><dd data-testid="resinv-core-state">{row.coreState ?? '—'}</dd>
        <dt>Proyecto</dt><dd data-testid="resinv-project">{row.projectId ?? 'Sin proyecto'}</dd>
        <dt>Máquina</dt><dd data-testid="resinv-machine">{row.machine ?? '—'}</dd>
        <dt>Repo</dt><dd className="resinv__path" data-testid="resinv-repo">{text(target.repo) ?? '—'}</dd>
        <dt>Origen</dt><dd data-testid="resinv-origin">{ORIGIN_LABEL[entry.origin] ?? 'Desconocido'}</dd>
        <dt>En disco</dt><dd data-testid="resinv-physical">{PHYSICAL_LABEL[entry.physical] ?? 'Desconocido'}</dd>
        <dt>Registrado en git</dt><dd data-testid="resinv-registered">{registeredText(git.registered)}</dd>
        <dt>Rama</dt><dd data-testid="resinv-branch">{text(git.branch) ?? '—'}</dd>
        <dt>Cambios</dt><dd data-testid="resinv-dirty">{DIRTY_LABEL[entry.dirty] ?? 'Desconocido'}</dd>
        <dt>Fusión</dt><dd data-testid="resinv-merged">{MERGED_LABEL[entry.merged] ?? 'Desconocido'}</dd>
        <dt>Destino</dt><dd data-testid="resinv-into">{text(entry.into) ?? '—'}</dd>
        <OwnerFields owner={entry.owner} />
      </dl>
    </li>
  );
}

function PreservedRow({ row }) {
  const entry = row.entry;
  const target = isObject(entry.target) ? entry.target : {};
  return (
    <li className={`resinv__row resinv__row--${row.section}`} data-testid="resinv-row" data-resource-key={row.key}>
      <div className="resinv__head">
        <span className="resinv__id" data-testid="resinv-target">{text(target.branch) ?? '—'}</span>
        <StateTag row={row} />
        <ReviewTag entry={entry} />
      </div>
      <dl className="resinv__meta">
        <dt>Proyecto</dt><dd data-testid="resinv-project">{row.projectId ?? 'Sin proyecto'}</dd>
        <dt>Máquina</dt><dd data-testid="resinv-machine">{row.machine ?? '—'}</dd>
        <dt>Repo</dt><dd className="resinv__path" data-testid="resinv-repo">{text(target.repo) ?? '—'}</dd>
        <dt>Rama</dt><dd data-testid="resinv-branch">{text(target.branch) ?? '—'}</dd>
        <dt>La rama existe</dt><dd data-testid="resinv-branch-exists">{branchExistsText(entry.branch_exists)}</dd>
        <dt>Fusión</dt><dd data-testid="resinv-merged">{MERGED_LABEL[entry.merged] ?? 'Desconocido'}</dd>
        <dt>Destino</dt><dd data-testid="resinv-into">{text(entry.into) ?? '—'}</dd>
        <OwnerFields owner={entry.owner} />
      </dl>
    </li>
  );
}

function RepoRow({ row }) {
  const entry = row.entry;
  const reason = text(entry.reason);
  return (
    <li className={`resinv__row resinv__row--${row.section}`} data-testid="resinv-row" data-resource-key={row.key}>
      <div className="resinv__head">
        <span className="resinv__id" data-testid="resinv-target">{text(entry.path) ?? '—'}</span>
        <StateTag row={row} />
      </div>
      <dl className="resinv__meta">
        <dt>Proyecto</dt><dd data-testid="resinv-project">{row.projectId ?? 'Sin proyecto'}</dd>
        <dt>Máquina</dt><dd data-testid="resinv-machine">{row.machine ?? '—'}</dd>
        <dt>Ruta</dt><dd className="resinv__path" data-testid="resinv-repo">{text(entry.path) ?? '—'}</dd>
        <dt>Escaneo (Core)</dt><dd data-testid="resinv-scan">{row.coreState ?? '—'}</dd>
        <dt>Motivo</dt><dd data-testid="resinv-reason">{reason ? (REASON_LABEL[reason] ?? reason) : '—'}</dd>
      </dl>
    </li>
  );
}

function Row({ row }) {
  if (row.kind === 'repo') return <RepoRow row={row} />;
  if (row.kind === 'preserved') return <PreservedRow row={row} />;
  return <WorktreeRow row={row} />;
}

/**
 * @param {{ inventory?: object|null, projectId?: string|null }} props
 * `inventory` es el DTO de `resource_inventory` (docs/core/RESOURCES.md). Ausente o sin las
 * listas contractuales = «no disponible», nunca una lista vacía ni filas inventadas.
 * `projectId` acota el inventario por Project ID; sin él se ve todo lo que llegó.
 */
export function ResourcesInventory({ inventory = null, projectId = null }) {
  const [projectFilter, setProjectFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [reviewFilter, setReviewFilter] = useState('all');

  const parsed = useMemo(() => readInventory(inventory), [inventory]);
  const scoped = useMemo(() => scopeByProject(parsed?.rows ?? [], projectId), [parsed, projectId]);
  const visible = useMemo(
    () => scoped.rows.filter((r) => matchesProject(r, projectFilter) && matchesState(r, stateFilter) && matchesReview(r, reviewFilter)),
    [scoped, projectFilter, stateFilter, reviewFilter],
  );
  const projectOptions = useMemo(() => idOptions(scoped.rows, 'Sin proyecto'), [scoped.rows]);
  // Solo el número que Core suministra; nunca se calcula a partir de las filas.
  const warningCount = parsed ? parsed.branchesToReview : null;

  return (
    <section className="resinv" aria-label="Inventario de recursos" data-testid="resinv">
      <header className="resinv__bar">
        <h4 className="resinv__title">Inventario de recursos</h4>
        <span className="resinv__badge" data-testid="resinv-readonly">Solo lectura</span>
        {warningCount !== null && (
          <span className="resinv__badge resinv__badge--warning" data-testid="resinv-warning-count">
            Ramas por revisar (Core): {warningCount}
          </span>
        )}
      </header>
      <p className="resinv__note">
        «Desconocido» y «No disponible» no significan que falte el recurso.
      </p>

      {!parsed ? (
        <p className="resinv__empty" data-testid="resinv-unavailable-inventory">
          Inventario de recursos no disponible: Core no ha entregado el inventario. No se muestra ningún recurso.
        </p>
      ) : (
        <>
          <div className="resinv__filters">
            <FilterSelect id="resinv-project" label="Proyecto" value={projectFilter} onChange={setProjectFilter} options={projectOptions} />
            <FilterSelect id="resinv-state" label="Estado" value={stateFilter} onChange={setStateFilter} options={STATE_FILTERS} />
            <FilterSelect id="resinv-review" label="Revisión" value={reviewFilter} onChange={setReviewFilter} options={REVIEW_FILTERS} />
          </div>
          {scoped.omitted > 0 && (
            <p className="resinv__note" role="status" data-testid="resinv-foreign-omitted">
              Se omitieron elementos que Core asigna a otro Project.
            </p>
          )}
          <p className="resinv__count" data-testid="resinv-shown" aria-live="polite">
            Mostrando {visible.length} de {scoped.rows.length}
          </p>
          {scoped.rows.length === 0 ? (
            <p className="resinv__empty">Core no informa recursos.</p>
          ) : visible.length === 0 ? (
            <p className="resinv__empty" data-testid="resinv-no-match">Ningún recurso coincide con los filtros.</p>
          ) : (
            SECTIONS.map(({ key, title }) => {
              const rows = visible.filter((r) => sectionOf(r) === key);
              if (rows.length === 0) return null;
              const headingId = `resinv-section-${key}`;
              return (
                <section key={key} className="resinv__section" aria-labelledby={headingId} data-testid={`resinv-section-${key}`}>
                  <h5 className="resinv__section-title" id={headingId}>{title} ({rows.length})</h5>
                  <ul className="resinv__list" aria-labelledby={headingId}>
                    {rows.map((r) => <Row key={r.key} row={r} />)}
                  </ul>
                </section>
              );
            })
          )}
        </>
      )}
    </section>
  );
}

export default ResourcesInventory;
