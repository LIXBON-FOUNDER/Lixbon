# Queries de lectura del Core para clientes observacionales (F2)

Estado: **`projects_overview` implementado (LXO-90)**; **`tasks_by_project` y `task_detail` implementados
(LXO-98, lectura de Tasks por Project prevista en LXO-91)**; **`compact_snapshot` implementado (LXO-94)**. Activity
(LXO-92) e inventario de worktrees (LXO-93) se documentan aquí cuando se implementen.

F2 es observacional: Desktop, CLI y Mobile muestran lo que el Core dice, sin agrupar por rutas ni reconstruir
autoridad desde `state.json`. Todas las queries son de **solo lectura** y no crean Tasks, no reintentan ni
reanudan nada.

## `projects_overview`

Resumen multiproyecto: los Projects conocidos con su trabajo activo, fallos y Attention, y un estado agregado.

* **Clave:** `project_id`. La ubicación (`machine`, `path`) es metadato; nunca agrupa ni identifica.
* **Solo Person autenticada.** Un Agent solo ve su Task y el token legacy del servidor no autentica esta
  query: ambos reciben `projects_overview_auth_required`. Desktop entra como Person por su canal.
* **Transporte:** el mismo comando por el RPC de Tauri y por `POST /rpc`, clasificado como `ClientAction::Read`.
* **No toca el disco ni escribe.** A diferencia de `projects`, no comprueba si las carpetas existen ni persiste
  marcas `missing`: lee el estado guardado. Mismos datos, misma respuesta.

### Petición

```json
{"cmd":"projects_overview","args":{"archived":"exclude","machine":"<machine>"}}
```

| Parámetro | Valores | Por defecto |
|---|---|---|
| `archived` | `exclude` · `include` · `only` | `exclude` |
| `machine` | id de máquina de una ubicación (1–200 caracteres) | sin filtro |

Los parámetros desconocidos o inválidos se rechazan con `projects_overview_invalid_request`. No hay paginación
ni cursor: el overview devuelve todos los Projects que cumplen el filtro (el cursor de snapshot está en
[`compact_snapshot`](#compact_snapshot)).

### Respuesta

```json
{
  "v": 1,
  "filters": {"archived": "exclude", "machine": null},
  "total": 1,
  "projects": [{
    "id": "<project_id>",
    "name": "lixbon",
    "state": "active",
    "status": "failed",
    "counts": {
      "tasks": 4,
      "active": 2,
      "failed": 1,
      "attention": {
        "total": 3,
        "by_category": {"question": 1, "approval": 0, "review_ready": 1, "conflict": 0,
                        "failed": 1, "environment_blocked": 0, "risk": 0}
      }
    },
    "locations": [{"machine": "<machine>", "path": "/ruta/local", "primary": true, "state": "ok", "last_seen": 1760000000000}]
  }],
  "unassigned": {"tasks": 0, "active": 0, "failed": 0, "attention": {"total": 0, "by_category": {"…": 0}}}
}
```

(`by_category` lleva siempre las siete categorías, también en `unassigned`, con 0 cuando no hay: la forma no
depende de los datos.)

### Contadores

| Campo | Fuente | Definición |
|---|---|---|
| `counts.tasks` | `State` | Tasks cuyo `project_id` es este Project |
| `counts.active` | `State` | de ellas, las que **no** están en un estado final (`done`, `failed`, `stopped`, `exited`) |
| `counts.failed` | `State` | de ellas, las que están en `failed` ahora mismo |
| `counts.attention` | SQLite (`attention_items`) | filas **activas** de ese `project_id`, por categoría: las mismas que lista `attention_list` con ese filtro |

* **Attention y `failed` son señales distintas.** `counts.failed` cuenta Tasks; `attention.by_category.failed`
  cuenta Attention. Fallar una Task levanta también una Attention `failed` (LXO-88), pero una Attention
  `failed` sin Task fallida no sube `counts.failed`.
* **Coherencia con el detalle:** los contadores salen de las mismas fuentes que las consultas de detalle
  (`attention_list` con `project_id`, y la lista de Tasks por Project de LXO-91). Hay una prueba que lo verifica.
* **Lo que no tiene `project_id`** va a `unassigned`, nunca a un Project inventado. Las filas de Attention con
  un `project_id` que no está en el registro no aparecen en ninguna parte del overview.
* Sin "completadas recientes" en esta versión: se añadirá después sin romper el contrato.

### Estado agregado (`status`)

Un código estable (la interfaz lo traduce; el Core no devuelve textos). Primera regla que se cumple:

| Código | Cuando |
|---|---|
| `failed` | `counts.failed > 0` |
| `attention` | `counts.attention.total > 0` |
| `active` | `counts.active > 0` |
| `idle` | ninguna de las anteriores |

### Archivados y orden

* `state` es `active` o `archived`. Archivar **no borra** nada: sus Tasks y su Attention siguen contando; solo
  sale de la vista por defecto (`archived = exclude`). `include` los muestra junto a los demás y `only` muestra
  solo los archivados.
* El filtro `machine` conserva los Projects con **al menos una** ubicación en esa máquina y devuelve todas sus
  ubicaciones (el filtro elige Projects, no recorta su metadato).
* **Orden determinista:** nombre en minúsculas (Unicode) y, a igualdad, `project_id`.

### Consistencia entre fuentes

Las Tasks viven en `State` y la Attention y el registro en SQLite. La query toma el guard del estado y, **con
él tomado**, lee SQLite en una sola pasada. `mutate` hace lo mismo al persistir (estado -> almacén), así que no
puede haber una mutación a medias entre los dos conteos: Tasks y Attention son de la misma versión del Core.
El orden de bloqueo `estado -> almacén` es el de todo el Core; esta query no lo invierte.

### Errores

| Código | Cuándo |
|---|---|
| `projects_overview_auth_required` | sin cliente autenticado, o un Agent / token legacy |
| `projects_overview_invalid_request` | parámetro desconocido o con valor inválido |
| `projects_overview_unavailable` | el Core no tiene almacén abierto |
| `projects_overview_read_failed` | falló la lectura de SQLite |

### Cliente de terminal: `lxo projects` (LXO-103)

* `lxo projects [--archived exclude|include|only] [--all] [--machine ID] [--json]` pide `projects_overview` con la
  credencial Person del CLI (almacén seguro). `--all` es `--archived include`. Sustituye al `lxo projects` anterior,
  que leía `projects` (registro con comprobación de disco).
* Salida humana por Project: nombre y estado traducido, `id`, contadores de Tasks y Attention (por categoría) y sus
  ubicaciones como metadato; al final, lo que va a `unassigned`. Cada dato en su línea para terminales estrechas.
* `--json` imprime el documento del Core sin tocar (`{v, filters, total, projects, unassigned}`): ids, contadores y
  códigos, sin textos traducidos.
* Es solo para personas: con credencial Agent responde con código 3. Salidas: 0 correcto, 1 error interno, 2 uso o
  filtro inválido, 3 autenticación o sin permiso, 4 versión o contrato, 5 Lixbon cerrado o Core no disponible.

### Cliente de terminal: `lxo tasks` y `lxo task show` (LXO-104)

* Tasks del **modelo legacy**, presentadas como tales (`task_model: "legacy"`), nunca como Attempts.
* **Fuente provisional:** la lectura `list` del Core por el RPC autenticado (no `state.json`), mientras la query de
  Tasks por Project de LXO-91 no esté en master. `list_tasks` en `lxo/src/tasks.rs` es el único punto que la usa; al
  publicarse LXO-91 se sustituye ahí sin cambiar el `--json` de lxo.
* `lxo tasks [--project ID|NOMBRE] [--active|--final] [--status S] [--run ID] [--json]`: en árbol (raíz y sus hijas).
  `--project` acepta el id o el nombre, que se resuelve con `projects_overview`.
* `lxo task show <task_id> [--json]`: Project, run, raíz y padre, hijas, estado y fase, proveedor y modelo, rama,
  worktree o checkout compartido, origen, fechas, motivo de fallo y PR, con `lxo events --task` y
  `lxo attention --task` para seguirla.
* `--json` es una allowlist de lxo: `{v, task_model, tasks}` y `{v, task_model, task, children}`. No copia el encargo
  (`spec`), el argv ni otros campos internos; lo que el modelo legacy no registra (`host`) va como `null`.
* Salidas: 0 correcto, 1 interno, 2 uso, 3 autenticación, 4 versión, 5 Core no disponible, 6 tarea o proyecto
  inexistente.

### Pruebas

`orch/projects_overview_tests.rs` (0/1/N Projects, orden, activo+fallido+Attention, estado agregado, Attention
vs `failed`, relocalización, archivados, filtro `machine`, `unassigned`, coherencia con `attention_list` y con
el snapshot, solo Person, parámetros inválidos, solo lectura) y
`orch/server.rs::http_rpc_projects_overview_es_solo_para_person_autenticada` (E2E por `POST /rpc`).

## `tasks_by_project`

Lista paginada de las Tasks de un Project. Implementación: `orch/tasks_read.rs` (`list`).

* **Clave:** `project_id`, obligatorio. Solo salen Tasks cuyo `project_id` es exactamente ese; las Tasks sin
  Project no aparecen. La ruta o la rama nunca identifican una Task.
* **Solo Person autenticada.** Sin cliente autenticado, o con un Agent, la query se rechaza
  (`tasks_auth_required` cuando llega a la query).
* **Transporte:** el mismo comando por el RPC de Tauri (`orch_query`, allowlist `ADE_READ_QUERIES`) y por
  `POST /rpc`, clasificado como `ClientAction::Read`.
* **No escribe.** Lee las Tasks del `State` y comprueba el Project en el registro de SQLite.

### Petición

```json
{"cmd":"tasks_by_project","args":{"project_id":"<project_id>","status":"active","limit":50,"cursor":"<next_cursor>"}}
```

| Parámetro | Valores | Por defecto |
|---|---|---|
| `project_id` | texto, 1–200 caracteres tras recortar espacios | **obligatorio** |
| `status` | `active` · `final` · `all` | `active` |
| `limit` | entero JSON de 1 a 100 | 50 |
| `cursor` | el `next_cursor` de la página anterior | primera página |

* Un parámetro con valor `null` cuenta como ausente.
* Los parámetros desconocidos, un `project_id` ausente, vacío, demasiado largo o que no sea texto, un `status`
  fuera de los tres valores y un `limit` que no sea un entero en rango se rechazan con `tasks_invalid_request`.
  El `limit` no se recorta: fuera de rango es un error.
* `active` son las Tasks que **no** están en un estado final; `final`, las que están en `done`, `failed`,
  `stopped` o `exited`; `all`, todas.
* Si el `project_id` no está en el registro de proyectos, la respuesta es `tasks_project_not_found`.

### Respuesta

```json
{
  "v": 1,
  "project_id": "<project_id>",
  "filters": {"status": "active"},
  "limit": 50,
  "tasks": [{
    "id": "<task_id>",
    "run_id": "<run_id>",
    "parent_id": null,
    "root_id": "<task_id>",
    "status": "running",
    "title": "…",
    "provider": "claude",
    "model": null,
    "branch": null,
    "worktree": null,
    "created_at": 1760000000000,
    "updated_at": 1760000000000
  }],
  "has_more": false,
  "next_cursor": null
}
```

| Campo | Origen en la Task |
|---|---|
| `run_id` | `run` |
| `parent_id` | `parent` (`null` en la raíz) |
| `root_id` | `root` del Run de la Task; `null` si el Run no está en el estado |
| `status` | `starting` · `running` · `waiting` · `awaiting_terminal_approval` · `done` · `failed` · `stopped` · `exited` |
| `provider` | `agent` |
| `model` | `model` tal como se pidió (no el modelo efectivo) |
| `created_at` / `updated_at` | `created` / `updated` (ms epoch) |

`project_id`, `filters.status` y `limit` repiten los valores ya validados de la petición.

### Orden y paginación

* **Orden determinista:** `created_at` descendente (lo creado más reciente primero) y, a igualdad, `id` ascendente.
  Se ordena por `created_at` y no por `updated_at` porque es inmutable y el cursor se apoya en él.
* El cursor es **opaco** para el cliente: solo vale el `next_cursor` de la página anterior, con el mismo
  `project_id`, `status` y `limit`. Un cursor con otro formato es `tasks_invalid_request`.
* `has_more` es `true` si quedan Tasks después de la página; entonces `next_cursor` es texto. Si no quedan,
  `next_cursor` es `null`.
* El cursor es por clave (`created_at` e `id` de la última Task entregada), no por posición: una Task creada
  entre páginas no repite ni salta las que ya existían; aparece al volver a pedir la primera página. Una Task
  que cambia de `status` entre páginas puede entrar o salir del filtro, porque no es una instantánea.

### Errores

| Código | Cuándo |
|---|---|
| `tasks_auth_required` | sin cliente autenticado, o la identidad no es una Person |
| `tasks_invalid_request` | parámetro desconocido, falta `project_id` o un valor inválido (incluido el cursor) |
| `tasks_project_not_found` | el `project_id` no está en el registro |
| `tasks_unavailable` | el Core no tiene almacén abierto |
| `tasks_read_failed` | falló la lectura del registro en SQLite |

## `task_detail`

Detalle de una Task dentro de su Project, para el Task Workspace y el Inspector. Implementación:
`orch/tasks_read.rs` (`detail`). Misma autenticación, transporte y clasificación (`ClientAction::Read`) que
`tasks_by_project`, y tampoco escribe.

### Petición

```json
{"cmd":"task_detail","args":{"project_id":"<project_id>","task_id":"<task_id>"}}
```

| Parámetro | Valores | Por defecto |
|---|---|---|
| `project_id` | texto, 1–200 caracteres tras recortar espacios | **obligatorio** |
| `task_id` | texto, 1–200 caracteres tras recortar espacios | **obligatorio** |

* Los parámetros desconocidos y un `project_id` o `task_id` ausente o inválido se rechazan con
  `tasks_invalid_request`.
* Primero se comprueba el Project (`tasks_project_not_found` si no está en el registro). Después, la Task tiene
  que existir **y** pertenecer a ese Project; si no existe o es de otro Project, la respuesta es
  `tasks_not_found`. Una Task nunca se devuelve bajo un Project que no es el suyo.

### Respuesta

```json
{
  "v": 1,
  "task": {
    "id": "<task_id>", "run_id": "<run_id>", "parent_id": null, "root_id": "<task_id>",
    "status": "running", "title": "…", "provider": "claude", "model": null,
    "branch": null, "worktree": null, "created_at": 1760000000000, "updated_at": 1760000000000,
    "project_id": "<project_id>",
    "child_ids": [],
    "phase": {"name": "…", "done": false, "note": "", "at": 1760000000000},
    "messages": [{"id": 1, "kind": "question", "from": "<task_id>", "to": "<task_id>", "body": "…", "reply_to": null, "at": 1760000000000}],
    "cwd": "…",
    "merged": false,
    "review": {"decision": "accepted", "head_commit": "<sha>", "at": 1760000000000},
    "integration": {"outcome": "merged", "decision_id": 2, "at": 1760000000000}
  }
}
```

Lleva los mismos campos que un elemento de `tasks_by_project`, más:

| Campo | Definición |
|---|---|
| `project_id` | el Project pedido, que es el de la Task |
| `child_ids` | ids de las Tasks cuyo `parent` es esta, ordenados |
| `phase` | la **última** fase registrada; `null` si no hay ninguna |
| `messages` | mensajes del buzón cuyo `from` o `to` es esta Task, en el orden del estado |
| `cwd` / `merged` | los de la Task |
| `review` | la última decisión `review` de la Task (`decision` y `head_commit` salen de su detalle, `null` si faltan); `null` si no hay |
| `integration` | la última decisión `merge` de la Task (`outcome` de su detalle, `decision_id` es el id de la decisión); `null` si no hay |

"Última" decisión es la de `id` más alto. El Core no añade host ni origen: el DTO no los incluye.

### Errores

| Código | Cuándo |
|---|---|
| `tasks_auth_required` | sin cliente autenticado, o la identidad no es una Person |
| `tasks_invalid_request` | parámetro desconocido, falta `project_id` o `task_id`, o un valor inválido |
| `tasks_project_not_found` | el `project_id` no está en el registro |
| `tasks_not_found` | la Task no existe o no pertenece a ese Project |
| `tasks_unavailable` | el Core no tiene almacén abierto |
| `tasks_read_failed` | falló la lectura del registro en SQLite |

### Consistencia y pruebas (`tasks_by_project` y `task_detail`)

Las dos queries toman el guard del estado y, **con él tomado**, comprueban el Project en SQLite: el mismo orden
`estado -> almacén` que `projects_overview` y que `mutate`.

`orch/tasks_read_tests.rs` cubre la clasificación como `Read`, el filtrado por Project y por `status`, la
paginación con cursor y el cursor inválido, la falta de `project_id` y los parámetros desconocidos, Project
inexistente, Task inexistente o de otro Project, el DTO del detalle y el rechazo de un Agent.
`orch/server.rs::tasks_http_tests::consultas_de_tasks_por_post_rpc` lo repite de punta a punta por `POST /rpc` con
credencial de Person registrada: `limit` en 0, 1, 100 y 101, paginación con una Task creada entre páginas, cursor
inválido, `status`, Project inexistente, `task_detail` propio, inexistente y de otro Project, y rechazo de un Agent.

## `compact_snapshot`

Snapshot compacta para arrancar un cliente ligero (Mobile, el resumen al abrir el CLI, una rehidratación
rápida) con **una sola query**: Projects con su resumen, Tasks activas mínimas, Attention (contadores y los
elementos más urgentes), los metadatos del Core y el cursor del Event Log desde el que seguir.
Implementación: `orch/compact_snapshot.rs`.

* **Es una vista derivada, no una autoridad.** Sale de las mismas fuentes que `projects_overview`,
  `tasks_by_project` y `attention_list`. El cliente no la guarda como verdad: la usa para pintar y sigue con
  `events` desde `cursor.events`. Para cambios posteriores manda el Event Log.
* **Solo Person autenticada.** Un Agent, o una petición sin cliente autenticado (token legacy), reciben
  `compact_snapshot_auth_required`.
* **Transporte:** el mismo comando por el RPC de Tauri y por `POST /rpc`, clasificado como `ClientAction::Read`.
* **No escribe.** No crea eventos, no persiste estado y no crea `meta.machine_id` si aún no existe.

### Petición

```json
{"cmd":"compact_snapshot","args":{"attention_items":5}}
```

| Parámetro | Valores | Por defecto |
|---|---|---|
| `attention_items` | entero JSON de 0 a 20: cuántas Attention destacadas incluir | 5 |

Un `null` cuenta como ausente. Los parámetros desconocidos y un `attention_items` que no sea un entero en rango
se rechazan con `compact_snapshot_invalid_request` (no se recorta).

### Respuesta

Ejemplo real (un Project con una Task en marcha y otra fallida, y una pregunta pendiente):

```json
{
  "snapshot_version": 1,
  "generated_at": 1792644871974,
  "core": {"version": "2.2.0", "health": "ok", "machine_id": "<machine_id>"},
  "cursor": {"events": 42},
  "projects": {
    "total": 1,
    "truncated": false,
    "items": [{"id": "<project_id>", "name": "lixbon", "status": "failed", "active": 1, "failed": 1, "attention": 2}]
  },
  "active_tasks": {
    "total": 1,
    "truncated": false,
    "items": [{
      "id": "t3", "project_id": "<project_id>", "run_id": "r2", "parent_id": null, "root_id": "t3",
      "status": "running", "title": "Arreglar la reconexión", "provider": "claude", "origin": "lixbon",
      "updated_at": 1792644870000
    }]
  },
  "attention": {
    "total": 2,
    "by_category": {"question": 1, "approval": 0, "review_ready": 0, "conflict": 0, "failed": 1,
                    "environment_blocked": 0, "risk": 0},
    "truncated": false,
    "items": [{"id": "<attention_id>", "category": "question", "severity": "high", "target_kind": "task",
               "target_id": "t3", "project_id": "<project_id>", "created_at": 1792644860000}]
  },
  "unassigned": {"active": 0, "failed": 0, "attention": 0},
  "limits": {"projects": 50, "active_tasks": 50, "attention_items": 5, "text_chars": 120}
}
```

| Campo | Definición |
|---|---|
| `snapshot_version` | versión del esquema; sube solo si se rompe la forma (los campos nuevos no la suben) |
| `generated_at` | hora del Core al generarla (ms epoch); solo informativa |
| `core.version` | versión de Lixbon que sirve la snapshot |
| `core.health` | `ok`, o `read_only` si el Core está degradado (lecturas sí, mutaciones no). El motivo interno no viaja |
| `core.machine_id` | máquina del Core que responde (`meta.machine_id`); `null` si aún no se ha creado |
| `cursor.events` | `head_seq` del Event Log en el punto de la snapshot: el `cursor` con el que pedir `events` después |
| `projects.items[]` | Projects **no archivados**: `id`, `name`, `status` (el mismo código agregado que `projects_overview`), `active`, `failed` y `attention` (total activo) |
| `active_tasks.items[]` | Tasks que **no** están en un estado final, de cualquier Project o sin Project |
| `active_tasks.items[].origin` | `lixbon` si la lanzó Lixbon, `external` si es un coordinador externo (una terminal cualquiera) |
| `attention` | `total` y `by_category` (las siete siempre, con 0) de **toda** la Attention activa; `items`, las más urgentes |
| `unassigned` | Tasks activas y fallidas sin `project_id`, y su Attention activa |
| `limits` | los topes aplicados en esta respuesta |

Lo que **no** lleva, a propósito: el encargo (`spec`), `cwd`, repo, rama y worktree, rutas de las ubicaciones,
`subject` y `facts` de la Attention, ids de correlación, argv ni transcript. Hay una prueba con centinelas.

### Orden, topes y recorte

| Lista | Orden | Tope |
|---|---|---|
| `projects.items` | estado (`failed` > `attention` > `active` > `idle`), nombre en minúsculas, `project_id` | 50 |
| `active_tasks.items` | `updated_at` descendente, `id` | 50 |
| `attention.items` | severidad (`critical` > `high` > `medium` > `low`), `created_at` descendente, `id` | `attention_items` (≤ 20) |

* El orden es también el orden de recorte: lo que pide algo sale primero.
* **Nunca aparenta completitud.** Cada lista lleva `total` (cuántas hay de verdad) y `truncated` (`true` si
  `total` es mayor que los elementos devueltos). Con `attention_items: 0` y Attention activa, `truncated` es
  `true`. El detalle completo está en `projects_overview`, `tasks_by_project` y `attention_list`.
* **Textos libres** (`name` de Project, `title` de Task): los caracteres de control pasan a espacio y se recortan
  a 120 caracteres; si se recortan, acaban en `…`.

### Presupuesto de tamaño

**128 KiB** de JSON como máximo con los topes de arriba. Medido en `workspace_grande_recorta_marca_y_cabe_en_el_presupuesto`
con 150 Projects, 150 Tasks activas y 40 Attention (`attention_items: 20`):

| Caso | Tamaño |
|---|---|
| Workspace grande típico (títulos de una línea) | ~26 KB |
| Peor caso que permiten los topes (todos los textos de 120 caracteres de 4 bytes) | ~67 KB |

### Consistencia con el Event Log

La query toma el guard del estado y, **con él tomado**, lee en **una sola transacción de lectura** de SQLite el
registro de Projects, la Attention activa y el `head_seq` del Event Log (`Store::read_snapshot`). `mutate` persiste
estado y eventos con el mismo guard tomado, y los hechos que se añaden sin él (`record_facts`) solo tocan SQLite,
que se lee en una única instantánea. Por eso Tasks, Attention y `cursor.events` son del mismo punto:

* todo lo que refleja la snapshot tiene su evento con `seq <= cursor.events`;
* todo lo posterior llega con `events` y `cursor = cursor.events`, sin huecos ni repetidos;
* tras reiniciar el Core, el mismo cursor sigue valiendo (el Event Log es durable) y la snapshot del mismo
  estado es la misma salvo `generated_at`.

Un cliente que reconecta puede seguir desde su último cursor o pedir otra snapshot; la snapshot no sustituye al
Event Log para lo que pase después.

Mobile la consume por la sesión `/remote` a través del IDE: ver [MOBILE_BOOTSTRAP.md](MOBILE_BOOTSTRAP.md) (LXO-107).

### Errores

| Código | Cuándo |
|---|---|
| `compact_snapshot_auth_required` | sin cliente autenticado, o un Agent / token legacy |
| `compact_snapshot_invalid_request` | parámetro desconocido o `attention_items` inválido |
| `compact_snapshot_unavailable` | el Core no tiene almacén abierto |
| `compact_snapshot_read_failed` | falló la lectura de SQLite |

### Pruebas

`orch/compact_snapshot_tests.rs`: bootstrap vacío y forma estable; coherencia con `projects_overview` y orden
por estado; workspace grande con recorte, `truncated` y presupuesto de tamaño (típico y peor caso); recorte de
textos y `attention_items: 0`; cursor que continúa `events` sin huecos ni repetidos; snapshot y cursor del mismo
punto con escrituras concurrentes; reinicio y reconexión con el cursor anterior; centinela de secretos; solo
Person y parámetros inválidos; solo lectura y Core degradado.
`orch/server.rs::compact_snapshot_http_tests::bootstrap_por_post_rpc_y_continuacion_por_events` lo repite de punta
a punta: `POST /rpc` y `GET /events?cursor=` antes y después de reiniciar el Core.
