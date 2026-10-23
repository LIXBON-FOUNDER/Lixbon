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
//  · `owner: null` significa «sin propietario», no «desconocido». Un `owner` objeto sin `task_id`,
//    ausente o malformado NO es «sin propietario»: se dice lo que Core no informó.
//  · Vocabulario fuera del contrato (`state`, `scan`, `origin`, `dirty`, `merged`, `physical`,
//    `needs_review`…) es «Desconocido» con el valor crudo; nunca se colapsa en «No disponible» ni «Falta».
//  · El contador de avisos es `warnings.branches_to_review` tal cual y nunca se deriva de las filas. Su
//    alcance es el de la petición (`filters.project_id`, docs/core/RESOURCES.md §Aviso): el filtro local por
//    Project no lo recalcula, y la etiqueta dice a qué abarca.
//  · Solo se entiende `v: 1`. Otra versión (o ninguna) es estado desconocido: ni filas ni contador.
//    `v: null` cuenta como versión ausente (no como una versión declarada). Sin listas contractuales:
//    · sin versión (ausente o null) o `v: 1` → «Core no entregó el inventario»;
//    · una versión declarada distinta de 1 → incompatibilidad, aunque no traiga listas.
//    Con listas pero sin versión (ausente o null) o con otra versión → incompatibilidad («sin versión» / `v=N`).
//  · Sin contador de Core (`branches_to_review: null`, p. ej. `filters.probe=false`) se dice que no hay contador;
//    no se inventa un número. Sin contador no hay nada que atribuir a otro Project: el aviso de «contador de otro
//    Project» solo sale si Core entregó un número, y nunca junto al de «sin contador».
//  · El acotado es por Project ID (`project_id`), nunca por ProjectLocation. Al cambiar el Project
//    externo se restablecen los filtros locales.
import { useMemo, useState } from 'react';
import './ResourcesInventory.css';

const NONE = '__none__';
/** Única versión del DTO de `resource_inventory` que esta vista entiende. */
export const SUPPORTED_VERSION = 1;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0;
/** Texto del DTO tal cual; `null` si Core no lo da. */
const text = (v) => (isId(v) ? v : null);
const hasKey = (map, v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v);
/**
 * Etiqueta de un vocabulario cerrado de Core. Un valor fuera del contrato es «Desconocido» (con el valor
 * crudo para trazarlo), nunca otro estado: no se convierte en «No disponible», «Falta» ni «Sin…».
 */
function vocab(map, v) {
  if (hasKey(map, v)) return map[v];
  return isId(v) ? `Desconocido («${v}» no reconocido)` : 'Desconocido';
}

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

const REPO_SECTION = { ok: 'scan_ok', unavailable: 'scan_unavailable', other_machine: 'scan_other_machine' };

function repoRow(entry, index) {
  const scan = typeof entry.scan === 'string' ? entry.scan : '';
  return {
    kind: 'repo',
    // Un escaneo fuera del contrato es «desconocido»: no se afirma que git no esté disponible.
    section: hasKey(REPO_SECTION, scan) ? REPO_SECTION[scan] : 'unknown',
    coreState: scan || null,
    projectId: text(entry.project_id),
    machine: text(entry.machine),
    entry,
    key: `repo:${index}:${text(entry.machine) ?? ''}|${text(entry.path) ?? ''}`,
  };
}

function incompatibleInventory(version) {
  return { incompatible: true, version: version ?? null, rows: [], branchesToReview: null, probe: null, scope: { kind: 'unknown', projectId: null } };
}

/**
 * Lee el DTO de Core. Devuelve `null` cuando no hay inventario utilizable (eso es «no
 * disponible», nunca una lista vacía ni filas inventadas).
 */
export function readInventory(inventory) {
  if (!isObject(inventory)) return null;
  // Una versión declarada que no es la soportada es incompatibilidad, aunque no traiga listas: no es «Core no entregó».
  // `null` es versión ausente, no una versión declarada.
  if (inventory.v != null && inventory.v !== SUPPORTED_VERSION) return incompatibleInventory(inventory.v);
  const repos = Array.isArray(inventory.repos) ? inventory.repos : null;
  const worktrees = Array.isArray(inventory.worktrees) ? inventory.worktrees : null;
  const preserved = Array.isArray(inventory.preserved_branches) ? inventory.preserved_branches : null;
  if (!repos && !worktrees && !preserved) return null;

  // Solo `v: 1`. Otra versión (o ninguna) no es un inventario fiable: estado desconocido, sin filas ni contador.
  if (inventory.v !== SUPPORTED_VERSION) return incompatibleInventory(inventory.v);

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

  return { incompatible: false, version: SUPPORTED_VERSION, rows, branchesToReview, probe: probeOf(inventory.filters), scope: countScope(inventory.filters) };
}

/** `filters.probe` tal cual: `false` = Core no evaluó dirty/merged/needs_review; cualquier otra cosa no se supone. */
function probeOf(filters) {
  return isObject(filters) && typeof filters.probe === 'boolean' ? filters.probe : null;
}

/**
 * Alcance del contador de Core: el de la petición (`filters.project_id`), no el de las filas que la vista
 * decida mostrar. `null` = todos los Projects; un ID = ese Project; sin `filters` = no informado.
 */
function countScope(filters) {
  if (!isObject(filters)) return { kind: 'unknown', projectId: null };
  if (filters.project_id === null) return { kind: 'all', projectId: null };
  if (isId(filters.project_id)) return { kind: 'project', projectId: filters.project_id };
  return { kind: 'unknown', projectId: null };
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

/** ¿Cumple la fila el filtro del host/máquina publicado por Core? */
export function matchesMachine(row, filter) {
  if (filter === 'all') return true;
  if (filter === NONE) return row?.machine === null;
  return row?.machine === filter;
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

function machineOptions(rows) {
  const vals = rows.map((r) => r.machine).filter((v) => v !== null);
  const opts = [{ value: 'all', label: 'Todos' }, ...uniqueSorted(vals).map((v) => ({ value: v, label: v }))];
  if (rows.some((r) => r.machine === null)) opts.push({ value: NONE, label: 'Sin host informado' });
  return opts;
}

// `null` es «git no pudo responder» (contrato); cualquier otro valor fuera de true/false/null es desconocido.
const triState = (v) => (v === true ? 'Sí' : v === false ? 'No' : v === null ? 'No se pudo comprobar' : 'Desconocido');
const registeredText = triState;
const branchExistsText = triState;

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
        {vocab(SCAN_LABEL, row.coreState)}
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
      {vocab(STATE_LABEL, row.coreState)}
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
  if (entry.needs_review === false) return null;
  // Ni true, ni false, ni null (o ausente): fuera del contrato = desconocido, no «sin revisión».
  return (
    <span className="resinv__tag resinv__tag--unknown" data-testid="resinv-review-unrecognized">
      Revisión desconocida
    </span>
  );
}

/**
 * `owner: null` es la única forma de «sin propietario» (contrato). Un propietario que existe pero no trae
 * `task_id`, un campo ausente o uno malformado NO se presentan como «sin propietario».
 */
function ownerText(owner) {
  if (owner === null) return 'Sin propietario';
  if (owner === undefined) return 'Propietario no informado por Core';
  if (!isObject(owner)) return 'Propietario no reconocido';
  return text(owner.task_id) ?? 'Propietario sin task_id';
}

function OwnerFields({ owner }) {
  const hasOwner = isObject(owner);
  return (
    <>
      <dt>Propietario</dt>
      <dd data-testid="resinv-owner">{ownerText(owner)}</dd>
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
        <dt>Origen</dt><dd data-testid="resinv-origin">{vocab(ORIGIN_LABEL, entry.origin)}</dd>
        <dt>En disco</dt><dd data-testid="resinv-physical">{vocab(PHYSICAL_LABEL, entry.physical)}</dd>
        <dt>Registrado en git</dt><dd data-testid="resinv-registered">{registeredText(git.registered)}</dd>
        <dt>Rama</dt><dd data-testid="resinv-branch">{text(git.branch) ?? '—'}</dd>
        <dt>Cambios</dt><dd data-testid="resinv-dirty">{vocab(DIRTY_LABEL, entry.dirty)}</dd>
        <dt>Fusión</dt><dd data-testid="resinv-merged">{vocab(MERGED_LABEL, entry.merged)}</dd>
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
        <dt>Fusión</dt><dd data-testid="resinv-merged">{vocab(MERGED_LABEL, entry.merged)}</dd>
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
        <dt>Motivo</dt><dd data-testid="resinv-reason">{reason ? vocab(REASON_LABEL, reason) : '—'}</dd>
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
/**
 * Aviso del estado de la lectura (`useCoreQuery`). Una foto anterior se sigue mostrando con
 * `stale`; `loading`/`refreshing` no borran filas; `error`/`disconnected`/`degraded` se dicen tal
 * cual. El aviso nunca sustituye al DTO ni inventa filas.
 */
const INVENTORY_STATUS_TEXT = {
  loading: { role: 'status', text: 'Cargando el inventario desde Core.' },
  // `refreshing` es solo visual: un sondeo cada 15 s no debe anunciarse al lector de pantalla.
  refreshing: { role: null, text: 'Actualizando el inventario desde Core; se muestra la última foto.' },
  stale: { role: 'status', text: 'Foto desactualizada: la última lectura de Core no terminó; se muestra la anterior.' },
  error: { role: 'alert', text: 'No se pudo leer el inventario de Core.' },
  disconnected: { role: 'alert', text: 'Core desconectado: no se puede leer el inventario.' },
  degraded: { role: 'status', text: 'Core responde degradado: el inventario puede no estar disponible.' },
};
const RETRYABLE_STATUS = new Set(['stale', 'error', 'disconnected', 'degraded']);
/** Plazo agotado sin foto previa: el Core puede seguir escaneando; no es un fallo de lectura. */
const WAITING_NOTICE = { role: 'status', text: 'El Core está tardando; seguimos esperando.' };
const WAITING_RETRY_TEXT = 'Esperando la lectura anterior del Core';

const isTimeoutMessage = (message) => typeof message === 'string' && /^ade_query_timeout\b/.test(message);

function InventoryStatus({ status, onRetry }) {
  const state = typeof status?.state === 'string' ? status.state : null;
  const known = state ? INVENTORY_STATUS_TEXT[state] : null;
  if (!known) return null;
  const message = typeof status.message === 'string' && status.message ? status.message : null;
  // Hay una petición viva para esta clave: reintentar se engancharía a ella y no haría nada.
  const inFlight = status.inFlight === true;
  const waiting = state === 'error' && inFlight && isTimeoutMessage(message);
  const notice = waiting ? WAITING_NOTICE : known;
  const shownState = waiting ? 'waiting' : state;
  return (
    <div className={`resinv__note resinv__status resinv__status--${shownState}`} data-testid="resinv-status" data-state={shownState}>
      <p
        className="resinv__status-text"
        role={notice.role ?? undefined}
        aria-busy={state === 'loading' || state === 'refreshing' ? 'true' : undefined}
        data-testid="resinv-status-text"
      >
        {notice.text}
      </p>
      {/* En espera (plazo sin foto) el código de plazo no aporta nada: no se muestra el detalle. */}
      {message && !waiting && (
        <details className="resinv__status-detail" data-testid="resinv-status-detail">
          <summary>Detalle técnico</summary>
          <code>{message}</code>
        </details>
      )}
      {RETRYABLE_STATUS.has(state) && typeof onRetry === 'function' && (
        inFlight
          // aria-disabled (y no disabled) para que siga siendo enfocable y se lea su motivo; el click no reintenta.
          ? <button type="button" className="resinv__retry" aria-disabled="true" onClick={(event) => event.preventDefault()} data-testid="resinv-retry">{WAITING_RETRY_TEXT}</button>
          : <button type="button" className="resinv__retry" onClick={onRetry} data-testid="resinv-retry">Reintentar</button>
      )}
    </div>
  );
}

export function ResourcesInventory({ inventory = null, projectId = null, status = null, onRetry = null }) {
  const [projectFilter, setProjectFilter] = useState('all');
  const [machineFilter, setMachineFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [reviewFilter, setReviewFilter] = useState('all');

  // Al cambiar el Project externo seleccionado se restablecen los filtros locales: no deben arrastrarse
  // al Project nuevo. Ajuste durante el render (React lo reaplica antes de pintar).
  const scopeId = isId(projectId) ? projectId : null;
  const [lastScopeId, setLastScopeId] = useState(scopeId);
  if (lastScopeId !== scopeId) {
    setLastScopeId(scopeId);
    setProjectFilter('all');
    setMachineFilter('all');
    setStateFilter('all');
    setReviewFilter('all');
  }

  const parsed = useMemo(() => readInventory(inventory), [inventory]);
  const scoped = useMemo(() => scopeByProject(parsed?.rows ?? [], projectId), [parsed, projectId]);
  const visible = useMemo(
    () => scoped.rows.filter((r) => matchesProject(r, projectFilter) && matchesMachine(r, machineFilter) && matchesState(r, stateFilter) && matchesReview(r, reviewFilter)),
    [scoped, projectFilter, machineFilter, stateFilter, reviewFilter],
  );
  const projectOptions = useMemo(() => idOptions(scoped.rows, 'Sin proyecto'), [scoped.rows]);
  const hostOptions = useMemo(() => machineOptions(scoped.rows), [scoped.rows]);
  // Solo el número que Core suministra; nunca se calcula a partir de las filas. Su alcance es el de la
  // petición: si es de otro Project que el seleccionado, no se atribuye a este.
  const countScopeInfo = parsed?.scope ?? { kind: 'unknown', projectId: null };
  // Solo hay «contador de otro Project» si Core entregó un número: sin contador no hay nada que atribuir.
  const foreignCount = parsed !== null && !parsed.incompatible && parsed.branchesToReview !== null
    && countScopeInfo.kind === 'project' && scopeId !== null && countScopeInfo.projectId !== scopeId;
  const warningCount = parsed && !foreignCount ? parsed.branchesToReview : null;
  const scopeLabel = countScopeInfo.kind === 'all'
    ? 'todos los Projects'
    : countScopeInfo.kind === 'project' ? `Project ${countScopeInfo.projectId}` : 'alcance no informado';
  // Sin contador de Core (p. ej. `filters.probe=false`): se dice, y no se sustituye por ningún número.
  const noCountFromCore = Boolean(parsed) && !parsed.incompatible && parsed.branchesToReview === null;
  const countIsThisProject = countScopeInfo.kind === 'project' && countScopeInfo.projectId === scopeId;

  return (
    <section className="resinv" aria-label="Inventario de recursos" data-testid="resinv">
      <header className="resinv__bar">
        <h4 className="resinv__title">Inventario de recursos</h4>
        <span className="resinv__badge" data-testid="resinv-readonly">Solo lectura</span>
        {warningCount !== null && (
          <span className="resinv__badge resinv__badge--warning" data-testid="resinv-warning-count">
            Ramas por revisar (Core, {scopeLabel}): {warningCount}
          </span>
        )}
      </header>
      <InventoryStatus status={status} onRetry={onRetry} />
      <p className="resinv__note">
        «Desconocido» y «No disponible» no significan que falte el recurso.
      </p>
      {warningCount !== null && scopeId !== null && !countIsThisProject && (
        <p className="resinv__note" role="status" data-testid="resinv-count-scope-note">
          El contador de Core no es el de este Project ({scopeLabel}); los filtros de esta vista no lo recalculan.
        </p>
      )}
      {noCountFromCore && (
        <p className="resinv__note" role="status" data-testid="resinv-count-unavailable">
          {parsed.probe === false
            ? 'Core no evaluó la revisión (filters.probe=false): no hay contador de ramas por revisar.'
            : 'Core no informó un contador válido de ramas por revisar (warnings.branches_to_review).'}
          {' '}No se calcula a partir de las filas.
        </p>
      )}
      {foreignCount && (
        <p className="resinv__note" role="status" data-testid="resinv-count-foreign">
          El contador de Core corresponde a otro Project ({scopeLabel}) y no se atribuye a este.
        </p>
      )}

      {!parsed ? (
        <p className="resinv__empty" data-testid="resinv-unavailable-inventory">
          Inventario de recursos no disponible: Core no ha entregado el inventario. No se muestra ningún recurso.
        </p>
      ) : parsed.incompatible ? (
        <p className="resinv__empty" role="status" data-testid="resinv-incompatible-version">
          Versión de inventario no compatible ({parsed.version === null ? 'sin versión' : `v=${String(parsed.version)}`}): esta vista solo entiende v={SUPPORTED_VERSION}.
          Estado desconocido: no se muestra ningún recurso ni contador como fiables.
        </p>
      ) : (
        <>
          <div className="resinv__filters">
            <FilterSelect id="resinv-project" label="Proyecto" value={projectFilter} onChange={setProjectFilter} options={projectOptions} />
            <FilterSelect id="resinv-machine" label="Host" value={machineFilter} onChange={setMachineFilter} options={hostOptions} />
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
