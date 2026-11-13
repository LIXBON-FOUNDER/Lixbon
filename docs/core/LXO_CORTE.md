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
| `lxo provider list --json` | `{v: 1, status, refreshing, generation, checked_at_ms, providers}` | [`provider_list.v1.json`](fixtures/lxo/provider_list.v1.json) | siempre (no depende del corte) |
| `lxo provider status --json` | `{v: 1, status, refreshing, generation, checked_at_ms, provider, check, attempt}` | [`provider_status.v1.json`](fixtures/lxo/provider_status.v1.json), [con `--attempt`](fixtures/lxo/provider_status_attempt.v1.json) | siempre; `--attempt` tras el corte |
| `lxo usage --json` | `{v: 1, status, refreshing, generated_at_ms, filters, providers, excluded}` | [`usage.v1.json`](fixtures/lxo/usage.v1.json) | siempre (no depende del corte) |
| `lxo context show --json` | la respuesta `valid` del Core tal cual: `{v: 1, status, verification, package_id, package, summary}` | [`context_show.v1.json`](fixtures/lxo/context_show.v1.json) | siempre |
| `lxo context validate --json` | la misma sin `package` | [`context_validate.v1.json`](fixtures/lxo/context_validate.v1.json) | siempre |
| `lxo context … --json` (rechazado, sale `7`) | `{v: 1, status: "invalid", error: {code, message}, serialized_bytes[, declared_id, recomputed_id]}` | [`context_invalid.v1.json`](fixtures/lxo/context_invalid.v1.json) | siempre |

`lxo provider` (LXO-137) es de solo lectura sobre `provider_capabilities` ([QUERIES.md](QUERIES.md#provider_capabilities-lxo-135)):
lxo no decide soporte por nombre ni versión y enseña las seis capabilities que da el Core. `status` fija el código de salida por lo
que mira (sin `--capability`, el entorno; con ella, esa capability): `0` listo o disponible, `7` `unavailable`, `8`
`environment_blocked` (el entorno lo impide: **no** es un Attempt fallido), `9` `unsupported`. `--attempt` suma la ProviderSession del
intento como hechos, sin veredicto: si reanudar procede lo decide el Core. El canal (`transport`) sale como lo dice el Core; que sea
un respaldo lo dice solo `transport_fallback` (`{reason}` o `null`, LXO-137): lxo escribe «(respaldo)» y el motivo **únicamente** si el Core lo informa, nunca por
el nombre del canal. Es un campo nuevo, siempre presente, de las formas `v1` de `provider` (aún sin consumidores: se publicó en el PR #231 y no se ha lanzado) y
su snapshot con respaldo es [`provider_list_respaldo.v1.json`](fixtures/lxo/provider_list_respaldo.v1.json).

`lxo usage` (LXO-207) es de solo lectura sobre `usage_report` ([QUERIES.md](QUERIES.md#usage_report-lxo-206)): lxo no consulta a ningún proveedor, no estima
y no suma magnitudes de proveedores distintos. **Desconocido no es cero**: lo que el Core no da sale `null` en el `--json` y «sin dato» en el texto, y lo que el
proveedor declara que no informa (`support`) se dice distinto de lo que no llegó. Un proveedor `stale`, `unknown` o con el entorno bloqueado es parte de la
respuesta (sale `0`), no un fallo del comando ni de un Attempt. `--model` y `--account` no descartan en silencio a los proveedores que no informan ese dato:
los nombra en `excluded`. `--refresh` pide la consulta una vez y espera; si el Core la atiende con el dato guardado, `throttled` lo dice.

**Corte con el comando histórico.** El `usage` que ya existía es el `lixbon usage` del CLI de Go (el uso de la cuenta Lixbon del gateway, `apps/cli`): **no
cambia** ni se redirige. `lxo usage` es otro binario sobre otra fuente (el Core y las cuentas de cada proveedor) y no lo sustituye; quien quiera el uso del
gateway sigue con `lixbon usage`. No hay alias entre los dos, así que ninguna semántica cambia en silencio.

`lxo context` (LXO-138) revisa un ContextPackage v1 **de un archivo** (o de la entrada estándar con `-`): `show` lo enseña y `validate` dice si el Core lo
acepta, ambos sobre `context_package_preview` ([QUERIES.md](QUERIES.md#context_package_preview-lxo-136)). La verificación (versión, formato, identidad
`package_id` = sha256 del contenido canónico, secretos) es del Core; lxo no calcula ningún hash. Un paquete rechazado sale con `7`, **no muestra su
contenido** (si la identidad no coincide, da la huella declarada y la recalculada) y el contenido del archivo nunca vuelve en un error. Los adjuntos constan
como «sin comprobar»: sus bytes no viajan con el paquete. Antes de llamar al Core se descartan, con `2`, lo que no es un archivo, lo de más de 128 KiB y lo que
no es UTF-8 (el UTF-16 de PowerShell 5 se dice con su nombre; un BOM UTF-8 se ignora); un archivo inexistente sale con `6`.

**Alcance de F4: solo lectura sobre archivos.** `lxo context export`, `import` y `show <package_id|attempt_id>` (que pedía la issue) **no existen todavía** y lo
dicen (`2`): el Core de F4 no construye un paquete a partir de un Attempt (solo `build()` con datos en memoria, para el *fallback* de resume), no guarda
paquetes (la tabla de continuidades guarda solo el `package_id`) y no hay dónde dejar uno «preparado» para un Attempt futuro. Hacerlo exige una query de
construcción, un almacén con migración posterior al corte y `import`; queda para F6, junto al handoff.

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
