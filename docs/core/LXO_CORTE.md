# `lxo` ante el corte Task/Attempt (LXO-125)

Qué cambia en cada orden de `lxo` cuando el Core pasa al modelo Task/Attempt (ADR
[CORTE_TASK_ATTEMPT.md](CORTE_TASK_ATTEMPT.md) §11), cómo pasa un script de la forma legacy a la nueva y cuándo se
retira lo legacy. Principio: **un script no cambia de semántica sin una versión que pueda detectar**. Hasta que se
cumpla el criterio de retirada, `--json` sin `--schema` da exactamente lo que daba antes del corte.

## Matriz de órdenes

| Orden | Antes del corte | Tras el corte (C1/C2) | En el modelo nuevo | Aviso |
|---|---|---|---|---|
| `lxo projects`, `lxo summary` | — | misma forma; los contadores son del Attempt actual (§11.2) | — | no |
| `lxo tasks` | forma 1 | forma 1 (vista `legacy_task_v1`). Agente, rama y worktree son los del **Attempt actual**; `--status`, `--active` y `--final` filtran por su estado | `--json --schema 2` (estado derivado, filtro `--state`); cada ejecución con `lxo attempts --task` | sí, en stderr |
| `lxo task show <id o nombre>` | forma 1 | forma 1, más la línea «Intentos: N». Agente, rama, worktree, fallo y PR son los del Attempt actual | `--json --schema 2` (por id): nombra **todos** los Attempts sin elegir ninguno; la ejecución, con `lxo attempt show <attempt_id>` | sí, en stderr |
| `lxo events --task <id>` | eventos de la Task | solo los `task.*`; los cambios de estado de ejecución nuevos van en `attempt.*` (§11.2, sin doble emisión) | `--attempt <attempt_id>` (= `--entity-kind attempt --entity-id`) | no (lo dice su ayuda) |
| `lxo attention --task <id>` | Attention de la Task | la de ejecución apunta al Attempt (D10) | `--attempt <attempt_id>` (= `--target-kind attempt --target-id`) | no (lo dice su ayuda) |
| `lxo attempts --task`, `lxo attempt show` | salen con 4 | forma 1 (LXO-124) | — | — |
| `lxo core restore` | — | sin cambio | — | — |
| Órdenes de agente: `list`, `show`, `status`, `check`, `inbox`, `continue`, `stop`, `release`, `diff`, `done`, `phase`, `ask`, `report`, `spawn`, `wait`… | por id de Task | por id de Task: **el Core resuelve el Attempt actual**, que es único (§11.2, D11). `continue` crea el Attempt `n + 1` (D7) | — | no |
| `lxo run create`, `lxo run close`, `--run` | — | sin cambio: `Run` se conserva como agrupación y no se retira en F3 | — | no |

**Ninguna orden elige un Attempt cuando hay varios.** Las órdenes de persona que muestran una ejecución piden su id
(`lxo attempt show` rechaza el id de una Task con código 2 y remite a `lxo attempts --task`). La forma 1 de
`lxo tasks` y `lxo task show` enseña el Attempt **actual**, el que nombra la Task, y lo avisa. Las de agente trabajan
siempre sobre el actual.

## Formas del `--json`

Cada documento lleva su versión en `v` y el modelo en `task_model` (tareas) o `core_model` (intentos). Las formas
publicadas están en [`fixtures/lxo/`](fixtures/lxo/). Las genera `apps/desktop/lxo` y sus pruebas fallan si cambian
(`LXO_WRITE_LXO_FIXTURES=1` las regenera). Cambiar una forma publicada exige subir su `v` y anotarlo aquí.

| Orden | Forma | Snapshot | Disponible |
|---|---|---|---|
| `lxo tasks --json` | `{v: 1, task_model: "legacy", tasks, unassigned_tasks}` | [`tasks.v1.json`](fixtures/lxo/tasks.v1.json) | siempre (por defecto) |
| `lxo tasks --json --schema 2` | `{v: 2, task_model: "task_attempt_v1", tasks, unassigned_tasks}` | [`tasks.v2.json`](fixtures/lxo/tasks.v2.json) | tras el corte |
| `lxo task show --json` | `{v: 1, task_model: "legacy", task, children, activity}` | [`task_show.v1.json`](fixtures/lxo/task_show.v1.json) | siempre (por defecto) |
| `lxo task show <task_id> --json --schema 2` | `{v: 2, task_model: "task_attempt_v1", task, activity}` | [`task_show.v2.json`](fixtures/lxo/task_show.v2.json) | tras el corte |
| `lxo attempts --task --json` | `{v: 1, core_model, task, filters, total, attempts}` | [`attempts.v1.json`](fixtures/lxo/attempts.v1.json) | tras el corte |
| `lxo attempt show --json` | `{v: 1, core_model, attempt, activity}` | [`attempt_show.v1.json`](fixtures/lxo/attempt_show.v1.json) | tras el corte |

Reglas de la forma 2:
* Ids nombrados: `task_id`, `parent_task_id`, `children_ids`, `attempt_id`. Nunca un `id` a secas.
* Sin propiedades de ejecución en la Task. El Attempt actual va como referencia (`current_attempt: {attempt_id, n,
  status}`) y la ficha nombra todos (`attempts`).
* Por id: `lxo task show <nombre> --schema 2` responde 6. El nombre se resuelve con la forma 1.
* Antes del corte, `--schema 2` sale con 4 y pide la forma 1. `--schema` sin `--json` sale con 2.
* Los filtros de la forma 1 por estado de ejecución (`--status`, `--active`, `--final`) salen con 2 en la forma 2,
  que filtra por estado de la Task (`--state open|in_progress|in_review|integrated|discarded`). `--state` en la
  forma 1 también sale con 2.

### De la forma 1 a la 2 (campo a campo)

| Forma 1 (`lxo tasks` / `lxo task show`) | Modelo nuevo |
|---|---|
| `id`, `parent_id` | `task_id`, `parent_task_id` |
| `children` (show) | `task.children_ids` |
| `status`, `final` | `state` (Task) · `current_attempt.status` · `lxo attempt show` → `status`, `final` |
| `phase` | sin campo en la forma 2: la Activity de la Task y del Attempt |
| `provider`, `model`, `role` | `lxo attempt show` → `provider`, `model`, `role` (y `effort`, `profile`) |
| `branch`, `base`, `worktree`, `shared_checkout`, `cwd` | `lxo attempt show` → `worktree` (`path`, `branch`, `base_branch`, `provenance`, `state`); sin Worktree, `null` |
| `host` | `lxo attempt show` → `worktree.machine` (`null` si el Core no la registra) |
| `failure_reason` | `lxo attempt show` → `failure_reason` |
| `merged` | `lxo attempt show` → `integrated` |
| `pr_url` | `lxo attempt show` → `artifacts[]` con `kind: "pull_request"` |
| `origin` | `origin` (Task) · `lxo attempt show` → `origin` |
| `run_id`, `project_id`, `title`, `created_at`, `updated_at`, `depth` | iguales |
| `activity` | igual (`target_kind: task`); la del Attempt, en `lxo attempt show` |

## Deprecación: salida y códigos

* El aviso sale **solo en modo humano** y **por stderr**, en una línea que empieza por
  `Aviso: el Core ya usa el modelo Task/Attempt.` y nombra la orden nueva (`lxo attempts --task …`).
* **No cambia el código de salida** (0 si la orden fue bien), ni el stdout, ni el `--json`: con `--json`, stderr va
  vacío y la deprecación se lee en la forma (`task_model: "legacy"`, `v: 1`).
* Solo avisa cuando `core_model` responde `task_attempt_v1`. Con un Core anterior, o si `core_model` falla, las
  órdenes siguen igual que antes.
* Códigos de las órdenes de tareas e intentos: 0 correcto, 1 interno, 2 uso (también: un id de Task donde se pide
  un Attempt, `--schema` sin `--json` o un filtro de la otra forma), 3 autenticación, 4 versión o contrato (también:
  forma 2 o intentos antes del corte), 5 Core no disponible, 6 Task o Attempt inexistente.

## Ventana de compatibilidad y retirada

1. **C1–C2 (ahora):** `--json` da la forma 1, `--schema 2` está disponible tras el corte y la forma 1 avisa en modo
   humano. Empieza con la release que active el corte por defecto (LXO-235).
2. **Cambio de defecto:** la forma 2 pasa a ser la de `--json` sin `--schema` en la release en que
   `core_model.compat` deja de anunciar `legacy_task_v1`, una release **antes** de `NNN_legacy_drop` (ADR §11.1).
   En esa release `--schema 1` sigue disponible, y el TUI de Go ya debe pintar la forma 2 (ADR §14.1). Hoy pinta la
   forma 1 y, con otra `v`, dice que no la pinta en lugar de leerla a medias.
3. **Retirada:** `--schema 1`, el aviso y los campos de ejecución de la forma 1 se retiran con `NNN_legacy_drop` (C3),
   cuando se cumplan **todos** los criterios del ADR §14: versión publicada de cada cliente que lee el modelo nuevo,
   una release completa en C2 sin rollback y el cierre explícito de la ventana de rollback. No hay fecha fija: manda
   el criterio, y la PR de `NNN_legacy_drop` lo documenta.

`Run` no entra en esta retirada (ADR §11.2).
