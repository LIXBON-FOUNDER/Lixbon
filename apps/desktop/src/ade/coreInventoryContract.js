/**
 * Contrato de `resource_inventory` en el cliente ADE (LXO-101).
 *
 * REGLA GENERAL: el DTO del Core llega tal cual. Aquí no se traduce, no se completa y no se
 * reescribe nada: se COMPRUEBA el vocabulario cerrado, el eco de los filtros y la coherencia de
 * las entradas entre sí, tal y como las define docs/core/RESOURCES.md.
 *
 * · `skipped` («no evaluado») nunca se reescribe como «limpio» ni como «fusionado».
 * · `owner: null` sigue siendo «sin propietario» y `unknown` sigue siendo «desconocido».
 * · «Falta» (`missing_on_disk`) solo lo afirma el sistema de archivos, nunca un git que falló.
 *
 * Sin dependencias de Tauri ni de React: el DTO se puede comprobar sin levantar el shell.
 */

/**
 * Vocabularios cerrados de `resource_inventory` (docs/core/RESOURCES.md). No se amplían desde el
 * cliente: un valor fuera del contrato es una respuesta inválida, no un dato que se reinterpreté.
 */
export const RESOURCE_SCAN_VALUES = Object.freeze(['ok', 'unavailable', 'other_machine']);
export const RESOURCE_SCAN_REASONS = Object.freeze([
  'path_missing',
  'not_a_repository',
  'git_not_installed',
  'timeout',
  'git_failed',
  'other_machine',
]);
export const RESOURCE_WORKTREE_STATES = Object.freeze([
  'tracked',
  'missing_on_disk',
  'not_registered',
  'orphan_candidate',
  'external',
  'unknown',
]);
export const RESOURCE_WORKTREE_ORIGINS = Object.freeze(['task', 'lixbon_dir', 'external']);
export const RESOURCE_PHYSICAL_VALUES = Object.freeze(['present', 'missing', 'unknown']);
/**
 * `dirty` y `merged` comparten vocabulario. `skipped` es «no evaluado» (sin sondeo o sin carpeta
 * que mirar): NUNCA es «limpio» ni «fusionado», y el cliente no lo reescribe.
 */
export const RESOURCE_DIRTY_VALUES = Object.freeze(['clean', 'dirty', 'unknown', 'skipped']);
export const RESOURCE_MERGED_VALUES = Object.freeze(['merged', 'unmerged', 'unknown', 'skipped']);

const RESOURCE_SCAN_SET = new Set(RESOURCE_SCAN_VALUES);
const RESOURCE_SCAN_REASON_SET = new Set(RESOURCE_SCAN_REASONS);
const RESOURCE_WORKTREE_STATE_SET = new Set(RESOURCE_WORKTREE_STATES);
const RESOURCE_WORKTREE_ORIGIN_SET = new Set(RESOURCE_WORKTREE_ORIGINS);
const RESOURCE_PHYSICAL_SET = new Set(RESOURCE_PHYSICAL_VALUES);
const RESOURCE_DIRTY_SET = new Set(RESOURCE_DIRTY_VALUES);
const RESOURCE_MERGED_SET = new Set(RESOURCE_MERGED_VALUES);
const FINAL_TASK_STATUSES = new Set(['done', 'failed', 'stopped', 'exited']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value) => value === null || typeof value === 'string';
const nullableBoolean = (value) => value === null || typeof value === 'boolean';

/**
 * `target` del inventario: `{machine, project_id, repo, path|branch}`. La ubicación es metadato del
 * destino: el cliente no la deduce ni la completa.
 */
function validResourceTarget(target, locator, requestedProjectId) {
  return isPlainObject(target)
    && nullableText(target.machine)
    && nullableText(target.project_id)
    && (requestedProjectId === null || target.project_id === requestedProjectId)
    && typeof target.repo === 'string'
    && typeof target[locator] === 'string';
}

/** `owner: null` es «sin propietario»; un owner malformado NO es «sin propietario». */
function validResourceOwner(owner) {
  return owner === null || (isPlainObject(owner)
    && typeof owner.task_id === 'string' && Boolean(owner.task_id.trim())
    && typeof owner.run_id === 'string' && Boolean(owner.run_id.trim())
    && typeof owner.status === 'string' && Boolean(owner.status.trim()));
}

/** Lo que git respondió: `registered` puede ser `null` (no se pudo preguntar a git). */
function validResourceGit(git) {
  return isPlainObject(git)
    && nullableBoolean(git.registered)
    && nullableText(git.branch)
    && nullableBoolean(git.detached)
    && nullableBoolean(git.locked)
    && nullableBoolean(git.prunable);
}

/**
 * Coherencia de un repo con el contrato (docs/core/RESOURCES.md):
 *  · `scan: "ok"` no lleva motivo.
 *  · `scan: "other_machine"` lleva su propio motivo y no es esta máquina: el Core no ejecuta git
 *    en otro host, así que una ubicación de otra máquina sale así y solo así.
 */
function coherentResourceRepo(repo, coreMachine) {
  if (repo.scan === 'other_machine') {
    if (repo.reason !== 'other_machine' || typeof repo.project_id !== 'string') return false;
    if (repo.machine === null) return false;
    if (repo.machine === coreMachine) return false;
    return true;
  }
  if (repo.machine !== coreMachine) return false;
  if (repo.scan === 'unavailable' && repo.reason === 'other_machine') return false;
  return true;
}

/** Un repo escaneado: `scan` dice si se pudo mirar y `reason` por qué no, cuando no se pudo. */
function validResourceRepo(repo, coreMachine, requestedProjectId) {
  if (!isPlainObject(repo)
    || !nullableText(repo.project_id)
    || (requestedProjectId !== null && repo.project_id !== requestedProjectId)
    || !nullableText(repo.machine)
    || typeof repo.path !== 'string'
    || !RESOURCE_SCAN_SET.has(repo.scan)) return false;
  // `scan: "ok"` no lleva motivo; los demás lo llevan y tiene que ser del contrato.
  if (repo.scan === 'ok') {
    if (!(repo.reason === undefined || repo.reason === null)) return false;
  } else if (!RESOURCE_SCAN_REASON_SET.has(repo.reason)) {
    return false;
  }
  return coherentResourceRepo(repo, coreMachine);
}

/**
 * Coherencia de un worktree con la matriz «estado físico ↔ estado mostrado»
 * (docs/core/RESOURCES.md). El cliente NO decide el estado: lo comprueba.
 *
 *  · «Falta» (`missing_on_disk`) es un hecho del sistema de archivos, nunca una conclusión de un
 *    git que falló (filas 1 y 8 frente a la 3).
 *  · `tracked`/`not_registered`/`unknown` son worktrees que el Core conoce: una Task los declara,
 *    así que llevan dueño y origen `task`.
 *  · `orphan_candidate` y `external` son worktrees que NADIE declara: nunca llevan dueño.
 *  · `git.prunable` es informativo: Git puede listar una carpeta ausente sin emitir ese tag, y el
 *    productor conserva entonces `false`.
 */
function coherentResourceWorktree(worktree) {
  const { state, physical, git, owner, origin } = worktree;

  // «Falta» lo afirma el disco; el git no puede contradecirlo.
  if ((physical === 'missing') !== (state === 'missing_on_disk')) return false;
  switch (state) {
    case 'tracked':
      // existe | git lo registra | una Task lo declara
      return physical === 'present' && git.registered === true && origin === 'task' && owner !== null;
    case 'not_registered':
      // existe | git NO lo registra | una Task lo declara
      return physical === 'present' && git.registered === false && origin === 'task' && owner !== null;
    case 'unknown':
      // El disco no respondió: puede ser una Task conocida o un worktree listado por git sin dueño.
      if (physical === 'unknown') {
        if (origin === 'task') return owner !== null;
        return owner === null && git.registered === true;
      }
      // La carpeta existe, pero el repo no respondió a git: solo una Task puede conocerlo.
      return physical === 'present' && origin === 'task' && owner !== null && git.registered === null;
    case 'orphan_candidate':
      // existe | git lo registra | nadie lo declara y está bajo <repo>.lixbon-wt/
      return physical === 'present' && git.registered === true && origin === 'lixbon_dir' && owner === null;
    case 'external':
      // existe | git lo registra | nadie lo declara y está en otra ruta
      return physical === 'present' && git.registered === true && origin === 'external' && owner === null;
    case 'missing_on_disk':
      // no existe (lo afirma el disco). Con Task que lo declara, o sin Task pero con git
      // registrándolo (fila 8); `prunable` no determina el estado físico.
      if (origin === 'task') return owner !== null;
      return owner === null && git.registered === true;
    default:
      return false;
  }
}

/** `dirty` solo se sondea con carpeta presente y registro Git confirmado. */
function coherentResourceDirty(worktree, probe) {
  const canProbe = probe && worktree.physical === 'present' && worktree.git.registered === true;
  return canProbe ? worktree.dirty !== 'skipped' : worktree.dirty === 'skipped';
}

/**
 * Comprueba `needs_review` para cualquier worktree: el productor emite `false` si `origin` no es
 * `task`; para `task`, `true` requiere merge `unmerged` y dueño en estado final. El DTO no expone
 * `branch_exists` ni el Project del dueño; el cliente no los deduce de `git.branch` ni del destino,
 * y conserva el veredicto `false` del Core sin inferir esos hechos.
 */
function coherentResourceWorktreeReview(worktree) {
  if (worktree.origin !== 'task') return worktree.needs_review === false;
  if (!worktree.needs_review) return true;
  return worktree.merged === 'unmerged'
    && worktree.owner !== null
    && FINAL_TASK_STATUSES.has(worktree.owner.status);
}

/**
 * Un worktree del inventario. Sin sondeo el Core no calcula `dirty`/`merged` (salen `skipped`) ni
 * puede decir qué hay por revisar (`needs_review` es `null`): el cliente no inventa esos valores.
 */
function validResourceWorktree(worktree, probe, requestedProjectId) {
  return isPlainObject(worktree)
    && validResourceTarget(worktree.target, 'path', requestedProjectId)
    && RESOURCE_WORKTREE_STATE_SET.has(worktree.state)
    && RESOURCE_WORKTREE_ORIGIN_SET.has(worktree.origin)
    && RESOURCE_PHYSICAL_SET.has(worktree.physical)
    && validResourceGit(worktree.git)
    && validResourceOwner(worktree.owner)
    && RESOURCE_DIRTY_SET.has(worktree.dirty)
    && RESOURCE_MERGED_SET.has(worktree.merged)
    && nullableText(worktree.into)
    && nullableBoolean(worktree.needs_review)
    && coherentResourceDirty(worktree, probe)
    && (probe
      ? typeof worktree.needs_review === 'boolean'
        && worktree.merged !== 'skipped'
        && coherentResourceWorktreeReview(worktree)
      : worktree.needs_review === null
        && worktree.dirty === 'skipped'
        && worktree.merged === 'skipped')
    && coherentResourceWorktree(worktree);
}

/**
 * Una rama conservada (la Task liberó su worktree y la rama sigue sin fusionar). «Ramas por
 * revisar» son las que EXISTEN: una rama que git da por inexistente no se puede revisar.
 */
function coherentResourcePreservedReview(branch) {
  const shouldReview = branch.branch_exists === true && branch.merged === 'unmerged';
  return branch.needs_review === shouldReview
    && !(branch.branch_exists === false && branch.merged === 'unmerged');
}

function validResourcePreserved(branch, probe, requestedProjectId) {
  return isPlainObject(branch)
    && validResourceTarget(branch.target, 'branch', requestedProjectId)
    && nullableBoolean(branch.branch_exists)
    && validResourceOwner(branch.owner)
    && branch.owner !== null
    && RESOURCE_MERGED_SET.has(branch.merged)
    && nullableText(branch.into)
    && nullableBoolean(branch.needs_review)
    && (probe
      ? typeof branch.needs_review === 'boolean'
        && branch.merged !== 'skipped'
        && coherentResourcePreservedReview(branch)
      : branch.needs_review === null && branch.merged === 'skipped');
}

/**
 * El productor construye cada `target` desde el mismo grupo que emite una entrada de `repos`.
 * Aunque ese repo sea `unavailable`, solo vale la referencia con la misma ruta, máquina y Project.
 */
function resourceRepoForTarget(target, repos) {
  return repos.find((repo) => repo.path === target.repo
    && repo.machine === target.machine
    && repo.project_id === target.project_id);
}

function matchesResourceTargetRepo(target, repos) {
  const repo = resourceRepoForTarget(target, repos);
  return repo !== undefined && repo.scan !== 'other_machine';
}

/** La disponibilidad del repo determina qué hechos de registro y rama pueden venir de git. */
function coherentResourceWorktreeRepo(worktree, repo) {
  const { registered, branch, detached, locked, prunable } = worktree.git;
  if (repo.scan === 'unavailable') {
    return worktree.origin === 'task'
      && registered === null
      && branch === null
      && detached === null
      && locked === null
      && prunable === null
      && worktree.merged !== 'unmerged'
      && worktree.needs_review !== true;
  }
  if (repo.scan !== 'ok' || registered === null) return false;
  if (registered === true) {
    return typeof detached === 'boolean'
      && typeof locked === 'boolean'
      && typeof prunable === 'boolean';
  }
  return branch === null && detached === null && locked === null && prunable === null;
}

function coherentResourcePreservedRepo(branch, repo) {
  return repo.scan !== 'unavailable'
    || (branch.branch_exists === null && branch.merged !== 'unmerged');
}

/**
 * Los avisos del Core se cuentan sobre las propias entradas (invariante 7 de docs/core/RESOURCES.md):
 * aquí se comprueba, no se recalcula para mostrarlo.
 *
 *  · Con sondeo (`probe=true`) el contador es un NÚMERO: si falta o no es un entero, el aviso no
 *    cuadra con el inventario y la respuesta se rechaza.
 *  · Sin sondeo (`probe=false`) no hay contador: es `null`, nunca un número.
 */
function validResourceWarnings(warnings, probe, worktrees, preserved) {
  if (!isPlainObject(warnings)) return false;
  const toReview = warnings.branches_to_review;
  if (probe) {
    if (!Number.isInteger(toReview) || toReview < 0) return false;
    const marked = [...worktrees, ...preserved].filter((entry) => entry.needs_review === true).length;
    if (toReview !== marked) return false;
  } else if (toReview !== null) {
    return false;
  }
  const byState = warnings.worktrees_by_state;
  if (!isPlainObject(byState)) return false;
  for (const state of RESOURCE_WORKTREE_STATES) {
    const count = byState[state];
    if (!Number.isInteger(count) || count < 0) return false;
    // Los contadores por estado salen de las propias entradas: se comprueban, no se recalculan.
    const real = worktrees.filter((worktree) => worktree.state === state).length;
    if (count !== real) return false;
  }
  return true;
}

/**
 * Valida el DTO de `resource_inventory` contra el contrato y los filtros pedidos. Devuelve el DTO
 * tal cual o lanza `ade_query_invalid_response`.
 *
 * @param {object} response DTO del Core.
 * @param {{project_id?: string|null, probe: boolean}} args filtros de la petición (los mismos que
 *   el Core hace eco).
 */
export function validateResourceInventory(response, args) {
  const invalid = (detail) => new Error(`ade_query_invalid_response: resource_inventory: ${detail}`);
  const probe = args.probe === true;

  // El Core dice a qué Project y con qué sondeo respondió: la respuesta tiene que ser la que se
  // pidió.
  // `filters.project_id` es obligatorio en el eco (aunque sea null): un eco sin la clave no dice
  // a qué alcance respondió el Core y se rechaza.
  if (!isPlainObject(response.filters) || !Object.hasOwn(response.filters, 'project_id')) {
    throw invalid('el eco de filtros no incluye project_id');
  }
  const echoedProject = response.filters.project_id ?? null;
  const askedProject = args.project_id ?? null;
  if (response.filters.probe !== probe
    || echoedProject !== askedProject || !nullableText(response.machine)) {
    throw invalid('el inventario no corresponde al Project y al sondeo solicitados');
  }
  if (!Array.isArray(response.repos) || !Array.isArray(response.worktrees) || !Array.isArray(response.preserved_branches)) {
    throw invalid('falta la lista contractual de repos, worktrees o ramas conservadas');
  }
  const coreMachine = response.machine;
  if (response.repos.some((repo) => !validResourceRepo(repo, coreMachine, askedProject))) {
    throw invalid('la lista contiene un repo fuera del contrato');
  }
  if (response.worktrees.some((worktree) => !validResourceWorktree(worktree, probe, askedProject))) {
    throw invalid('la lista contiene un worktree fuera del contrato');
  }
  if (response.preserved_branches.some((branch) => !validResourcePreserved(branch, probe, askedProject))) {
    throw invalid('la lista contiene una rama conservada fuera del contrato');
  }
  const targets = [
    ...response.worktrees.map((worktree) => worktree.target),
    ...response.preserved_branches.map((branch) => branch.target),
  ];
  if (targets.some((target) => !matchesResourceTargetRepo(target, response.repos)
    || target.machine !== coreMachine)) {
    throw invalid('un destino no corresponde al repo, la máquina y el Project de la lista de repos');
  }
  for (const worktree of response.worktrees) {
    const repo = resourceRepoForTarget(worktree.target, response.repos);
    if (!repo || !coherentResourceWorktreeRepo(worktree, repo)) {
      throw invalid('los hechos de registro Git no corresponden al estado del repo');
    }
  }
  for (const branch of response.preserved_branches) {
    const repo = resourceRepoForTarget(branch.target, response.repos);
    if (!repo || !coherentResourcePreservedRepo(branch, repo)) {
      throw invalid('la existencia de rama no corresponde al estado del repo');
    }
  }
  if (!validResourceWarnings(response.warnings, probe, response.worktrees, response.preserved_branches)) {
    throw invalid('los avisos no coinciden con el inventario');
  }
  return response;
}
