// ResourcesInventory.jsx — inventario de recursos de SOLO LECTURA (LXO-101, parcial).
//
// PROVISIONAL: no existe todavía ninguna consulta ResourceInventory viva ni el contrato de Core
// LXO-93 en master. La forma de los props de abajo es una propuesta alineada con LXO-93 y puede
// cambiar cuando Core lo publique. Este componente no consulta nada: solo pinta lo que recibe.
//
// Reglas de la vista:
//  · Solo lectura: sin acciones de borrar/archivar/adoptar/limpiar/reparar ni de Git; sin escaneo
//    del disco. La ubicación (rama, ruta) es metadato, no un enlace ni un botón.
//  · «Desconocido» y «No disponible» no son «Falta». Falta solo si Core lo clasifica así (o
//    informa exists === false).
//  · Un candidato externo no tiene propietario: nunca se muestra el `owner` aunque venga.
//  · Una rama conservada sin fusionar es un aviso, no un error de integridad.
//  · El contador de avisos se muestra solo si Core lo suministra (`warningCount`); jamás se
//    deriva de las filas ni de los filtros.
import { useMemo, useState } from 'react';
import './ResourcesInventory.css';

/**
 * @typedef {'known'|'external_candidate'|'missing'} ResourceClassification
 *
 * @typedef {Object} ResourceEntry
 * @property {string} id                     ID duradero del recurso (clave estable).
 * @property {ResourceClassification} classification  Clasificación dada por Core.
 * @property {string|null} [projectId]       ID duradero del proyecto.
 * @property {string|null} [hostId]          ID duradero del host.
 * @property {string|null} [taskId]          ID duradero de la tarea (si hay).
 * @property {string|null} [runId]           ID duradero de la ejecución (si hay).
 * @property {string|null} [branch]          Rama: metadato de ubicación.
 * @property {string|null} [path]            Ruta: metadato de ubicación.
 * @property {string|null} [owner]           Propietario; no aplica a candidatos externos.
 * @property {boolean|null} [dirty]          null/undefined = desconocido.
 * @property {boolean|null} [merged]         null/undefined = desconocido.
 * @property {boolean|null} [exists]         null/undefined = desconocido.
 * @property {'available'|'unavailable'} [availability]  'unavailable' = Core no pudo leer los
 *   valores (p. ej. host sin conexión); distinto de «falta».
 *
 * @typedef {Object} ResourceInventory
 * @property {ResourceEntry[]} resources
 * @property {number} [warningCount]         Contador de avisos de Core; opcional.
 * @property {string} [generatedAt]          Instante de la lectura de Core (texto tal cual).
 */

const NONE = '__none__';

export const STATE_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'known', label: 'Conocido' },
  { value: 'external_candidate', label: 'Candidato externo' },
  { value: 'missing', label: 'Falta' },
  { value: 'unknown', label: 'Desconocido / no disponible' },
  { value: 'dirty', label: 'Con cambios' },
  { value: 'clean', label: 'Limpio' },
  { value: 'merged', label: 'Fusionado' },
  { value: 'unmerged', label: 'Sin fusionar (aviso)' },
];

const isUnavailable = (r) => r.availability === 'unavailable';
const isUnset = (v) => v === null || v === undefined;
// Falta: Core lo clasifica así (su veredicto manda, incluso si otros valores no se pudieron leer), o un
// recurso conocido con exists === false. Si Core no pudo leer los valores (availability 'unavailable')
// el exists de un recurso conocido no es fiable: es «No disponible», no «Falta».
const isMissing = (r) => r.classification === 'missing' || (r.classification === 'known' && !isUnavailable(r) && r.exists === false);

/** Sección en la que se pinta la fila; sigue a isMissing para que etiqueta, sección y filtro coincidan. */
export function sectionOf(r) {
  if (isMissing(r)) return 'missing';
  if (r.classification === 'external_candidate') return 'external_candidate';
  if (r.classification === 'known') return 'known';
  return 'unclassified';
}

// «Desconocido»: alguno de los campos de estado que la fila MUESTRA es desconocido o no disponible.
// «Existe» de una fila clasificada como Falta se muestra como «No» (veredicto de Core), no como desconocido.
const hasUnknownShown = (r) =>
  isUnavailable(r) || (r.classification !== 'missing' && isUnset(r.exists)) || isUnset(r.dirty) || isUnset(r.merged);

/** ¿Cumple la entrada el filtro de estado? Predicados, no un estado único: dirty y unmerged pueden coincidir. */
export function matchesState(r, filter) {
  switch (filter) {
    case 'all': return true;
    case 'known': return sectionOf(r) === 'known';
    case 'external_candidate': return sectionOf(r) === 'external_candidate';
    case 'missing': return isMissing(r);
    case 'unknown': return hasUnknownShown(r);
    case 'dirty': return !isUnavailable(r) && r.dirty === true;
    case 'clean': return !isUnavailable(r) && r.dirty === false;
    case 'merged': return !isUnavailable(r) && r.merged === true;
    case 'unmerged': return !isUnavailable(r) && r.merged === false;
    default: return true;
  }
}

const CLASS_LABEL = { known: 'Conocido', external_candidate: 'Candidato externo', missing: 'Falta' };

// Secciones distintas: nunca se mezclan conocidos, candidatos externos y recursos que faltan.
const SECTIONS = [
  { key: 'known', title: 'Conocidos' },
  { key: 'external_candidate', title: 'Candidatos externos (sin propietario)' },
  { key: 'missing', title: 'Faltan' },
  { key: 'unclassified', title: 'Sin clasificar por Core' },
];

/** Texto de un valor booleano de Core: Sí/No, o «Desconocido»/«No disponible», nunca «Falta». */
function boolText(entry, value, yes, no) {
  if (isUnavailable(entry)) return 'No disponible';
  if (isUnset(value)) return 'Desconocido';
  return value ? yes : no;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

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

function idOptions(entries, field, noneLabel) {
  const vals = entries.map((r) => r[field]).filter((v) => !isUnset(v) && v !== '');
  const opts = [{ value: 'all', label: 'Todos' }, ...uniqueSorted(vals).map((v) => ({ value: v, label: v }))];
  if (entries.some((r) => isUnset(r[field]) || r[field] === '')) opts.push({ value: NONE, label: noneLabel });
  return opts;
}

const matchesId = (r, field, filter) =>
  filter === 'all' || (filter === NONE ? isUnset(r[field]) || r[field] === '' : r[field] === filter);

function Row({ r }) {
  const external = r.classification === 'external_candidate';
  const unmerged = !isUnavailable(r) && r.merged === false;
  const section = sectionOf(r);
  // La etiqueta visible sigue a isMissing (igual que el estilo, la sección y el filtro «Falta»).
  const cls = CLASS_LABEL[section] ?? 'Sin clasificar';
  return (
    <li className={`resinv__row resinv__row--${section}`} data-testid="resinv-row" data-resource-id={r.id}>
      <div className="resinv__head">
        <span className="resinv__id">{r.id}</span>
        <span className={`resinv__tag resinv__tag--${section}`} data-testid="resinv-class">{cls}</span>
        {unmerged && (
          <span className="resinv__tag resinv__tag--warning" data-testid="resinv-unmerged-warning">
            Rama conservada sin fusionar
          </span>
        )}
        {isUnavailable(r) && <span className="resinv__tag resinv__tag--unavailable" data-testid="resinv-unavailable">No disponible</span>}
      </div>
      <dl className="resinv__meta">
        <dt>Proyecto</dt><dd>{r.projectId || '—'}</dd>
        <dt>Host</dt><dd>{r.hostId || '—'}</dd>
        <dt>Tarea</dt><dd>{r.taskId || '—'}</dd>
        <dt>Ejecución</dt><dd>{r.runId || '—'}</dd>
        <dt>Propietario</dt>
        <dd data-testid="resinv-owner">{external ? 'Sin propietario' : (r.owner || 'Desconocido')}</dd>
        <dt>Ubicación (metadato)</dt>
        <dd className="resinv__loc">
          <span data-testid="resinv-branch">{r.branch || '—'}</span>
          <span className="resinv__path" data-testid="resinv-path">{r.path || '—'}</span>
        </dd>
        <dt>Existe</dt><dd data-testid="resinv-exists">{r.classification === 'missing' ? 'No' : boolText(r, r.exists, 'Sí', 'No')}</dd>
        <dt>Cambios</dt><dd data-testid="resinv-dirty">{boolText(r, r.dirty, 'Con cambios', 'Limpio')}</dd>
        <dt>Fusión</dt><dd data-testid="resinv-merged">{boolText(r, r.merged, 'Fusionado', 'Sin fusionar')}</dd>
      </dl>
    </li>
  );
}

/**
 * @param {{ inventory?: ResourceInventory|null }} props
 * `inventory` ausente/null = Core no ha entregado inventario (no disponible, no «vacío»).
 */
export function ResourcesInventory({ inventory = null }) {
  const [project, setProject] = useState('all');
  const [host, setHost] = useState('all');
  const [state, setState] = useState('all');

  // Sin lista `resources` no hay inventario: es «no disponible», nunca una lista vacía ni filas inventadas.
  const available = Array.isArray(inventory?.resources);
  const entries = useMemo(() => (available ? inventory.resources.filter((r) => r && typeof r === 'object') : []), [available, inventory]);
  const projectOptions = useMemo(() => idOptions(entries, 'projectId', 'Sin proyecto'), [entries]);
  const hostOptions = useMemo(() => idOptions(entries, 'hostId', 'Sin host'), [entries]);
  const visible = useMemo(
    () => entries.filter((r) => matchesId(r, 'projectId', project) && matchesId(r, 'hostId', host) && matchesState(r, state)),
    [entries, project, host, state],
  );

  // Solo el número que Core suministra; nunca se calcula a partir de las filas.
  const warningCount = available && Number.isInteger(inventory.warningCount) && inventory.warningCount >= 0 ? inventory.warningCount : null;

  return (
    <section className="resinv" aria-label="Inventario de recursos" data-testid="resinv">
      <header className="resinv__bar">
        <h4 className="resinv__title">Inventario de recursos</h4>
        <span className="resinv__badge" data-testid="resinv-readonly">Solo lectura</span>
        {warningCount !== null && (
          <span className="resinv__badge resinv__badge--warning" data-testid="resinv-warning-count">
            Avisos (Core): {warningCount}
          </span>
        )}
      </header>
      <p className="resinv__note">
        Vista provisional con datos de Core; sin contrato LXO-93 todavía. «Desconocido» y «No disponible» no significan que falte el recurso.
      </p>

      {!available ? (
        <p className="resinv__empty" data-testid="resinv-unavailable-inventory">
          Inventario no disponible: Core (LXO-93) todavía no entrega datos de recursos. No se muestra ningún recurso.
        </p>
      ) : (
        <>
          <div className="resinv__filters">
            <FilterSelect id="resinv-project" label="Proyecto" value={project} onChange={setProject} options={projectOptions} />
            <FilterSelect id="resinv-host" label="Host" value={host} onChange={setHost} options={hostOptions} />
            <FilterSelect id="resinv-state" label="Estado" value={state} onChange={setState} options={STATE_FILTERS} />
          </div>
          <p className="resinv__count" data-testid="resinv-shown" aria-live="polite">
            Mostrando {visible.length} de {entries.length}
          </p>
          {entries.length === 0 ? (
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
                    {rows.map((r, i) => <Row key={r.id ?? `row-${i}`} r={r} />)}
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
