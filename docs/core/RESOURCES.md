# Inventario de recursos del Core: worktrees, ramas y huérfanos (LXO-93)

Estado: **`resource_inventory` implementado**. Es una query de **solo lectura** que cruza tres fuentes: lo que el
Core cree (Tasks), lo que dice git (`worktree list`, ramas) y lo que hay en disco. Sirve al Resource Manager y al
aviso «N ramas por revisar» sin que Desktop ejecute git por su cuenta. F2 solo observa: limpiar, archivar o
adoptar es F5 y no existe en esta API.

## Invariantes y cómo se prueban

Pruebas en `orch/resource_tests.rs`, con repositorios git reales en directorios temporales.

| # | Invariante | Mecanismo | Prueba |
|---|---|---|---|
| 1 | Detectar no equivale a adoptar ni borrar | la query no tiene acciones; un worktree que ninguna Task reclama sale con `owner: null` | `la_matriz_estado_fisico_estado_mostrado_con_git_real` |
| 2 | Un worktree externo nunca recibe dueño | `owner` solo sale de una Task que declara esa ruta | idem |
| 3 | Una rama sin fusionar conservada no es un error de integridad | va en `preserved_branches` con `needs_review`, sin campo de error | `la_rama_conservada_sin_fusionar_se_lista_y_no_es_un_error` |
| 4 | Un git que falla es `unknown`/`unavailable`, no `missing` | «falta» solo lo dice el sistema de archivos; un fallo de git da `unknown` y un motivo | `un_fallo_de_git_es_unknown_no_missing_y_no_dispara_ninguna_limpieza` |
| 5 | Host y ubicación forman parte del destino | `target = {machine, project_id, repo, path/branch}` | `host_y_ubicacion_son_parte_del_destino_y_otras_maquinas_no_se_escanean` |
| 6 | La query no muta el repositorio | solo comandos de lectura, `--no-optional-locks`, sin `prune` | `la_query_no_muta_el_repositorio_ni_los_worktrees` |
| 7 | El aviso coincide con el inventario | `branches_to_review` se cuenta sobre las propias entradas | `el_aviso_de_ramas_por_revisar_coincide_con_el_inventario` |
| 8 | Un fallo de git no dispara limpieza | no hay ninguna ruta de escritura; el estado, el Event Log y el disco no cambian | idem que 4 |

## Decisiones

| # | Decisión |
|---|---|
| 1 | **«Ramas por revisar»** son las ramas que existen, no están fusionadas y son (a) conservadas tras liberar el worktree o (b) de un worktree cuya Task ya terminó. No cuentan las Tasks en marcha ni los worktrees externos o huérfanos. |
| 2 | **`merged`** es `Task.merged` (Lixbon integró; cubre el squash) **o** la rama es ancestro de su destino (`Task.base` o, sin él, la rama por defecto del repo). Lo que no se puede verificar es `unknown`, nunca `unmerged`. |
| 3 | **Huérfano o externo:** un worktree que git lista y ninguna Task reclama es `orphan_candidate` si está bajo `<repo>.lixbon-wt/` y `external` si está en cualquier otro sitio. |
| 4 | **Solo esta máquina:** el Core no ejecuta git en otro host. Las ubicaciones de otras máquinas salen en `repos` con `scan: "other_machine"` y sin worktrees. |
| 5 | **Solo Person autenticada** (Desktop, CLI y Mobile). Las rutas locales viajan como metadato, igual que en `projects_overview`. |
| 6 | **Coste:** `probe` (por defecto `true`) decide si se calculan `dirty` y `merged`. Sin tamaños ni recorridos profundos. |

## Contrato

Comando `resource_inventory`, clasificado `ClientAction::Read`. El mismo comando por el RPC de Tauri y por
`POST /rpc`.

| Parámetro | Valores | Por defecto |
|---|---|---|
| `project_id` | acota los repos del inventario a ese Project y las entradas anidadas conservan ese mismo ID en su `target` | todos |
| `probe` | `true`: calcula `dirty` y `merged` (un `git` por worktree). `false`: solo registro de git y disco | `true` |

Los parámetros desconocidos o inválidos se rechazan con `resource_inventory_invalid_request`.

```json
{
  "v": 1,
  "machine": "<machine_id de este Core>",
  "filters": {"project_id": null, "probe": true},
  "repos": [
    {"project_id": "p-1", "machine": "m-1", "path": "/home/ana/app", "scan": "ok"},
    {"project_id": "p-2", "machine": "m-1", "path": "/home/ana/roto", "scan": "unavailable", "reason": "not_a_repository"},
    {"project_id": "p-3", "machine": "otro-equipo", "path": "/srv/remoto", "scan": "other_machine", "reason": "other_machine"}
  ],
  "worktrees": [{
    "target": {"machine": "m-1", "project_id": "p-1", "repo": "/home/ana/app", "path": "/home/ana/app.lixbon-wt/wt-c"},
    "state": "tracked", "origin": "task", "physical": "present",
    "git": {"registered": true, "branch": "lx/r/c", "detached": false, "locked": false, "prunable": false},
    "owner": {"task_id": "t-9", "run_id": "r-1", "status": "done"},
    "dirty": "clean", "merged": "unmerged", "into": "main", "needs_review": true
  }],
  "preserved_branches": [{
    "target": {"machine": "m-1", "project_id": "p-1", "repo": "/home/ana/app", "branch": "lx/r/g"},
    "branch_exists": true, "owner": {"task_id": "t-4", "run_id": "r-1", "status": "stopped"},
    "merged": "unmerged", "into": "main", "needs_review": true
  }],
  "warnings": {
    "branches_to_review": 2,
    "worktrees_by_state": {"tracked": 4, "missing_on_disk": 1, "not_registered": 1, "orphan_candidate": 1, "external": 1, "unknown": 0}
  }
}
```

Con `project_id` explícito, `repos[].project_id` y `target.project_id` de cada worktree o rama conservada
corresponden al Project pedido. Sin filtro, un candidato cuyo repo no está asociado a un Project puede
llevar `project_id: null`; los worktrees externos o huérfanos también conservan el ID del repo cuando
ese repo sí pertenece a un Project.

Cada `target` de `worktrees` o `preserved_branches` referencia la entrada de `repos` del mismo grupo:
`target.repo` coincide con `repos[].path`, y `target.machine` y `target.project_id` coinciden con los
campos homónimos de esa entrada. El cliente comprueba esa tupla incluso si el repo tiene `scan: "unavailable"`;
una entrada de otro Project o máquina no legitima el destino, y un target nunca puede apuntar a una entrada
`scan: "other_machine"`. Cada repo `scan: "ok"` o `"unavailable"` y cada target lleva exactamente el valor
de `machine` del Core, incluso cuando es `null`; los repos `other_machine` conservan una máquina remota y el
`project_id` string de la ubicación.

La disponibilidad del repo limita los hechos de git que acompañan al target: `scan: "ok"` produce
`git.registered` booleano; `registered: false` deja `branch`, `detached`, `locked` y `prunable` en `null`.
Con `scan: "unavailable"`, las filas de worktrees conocidas por una Task llevan esos cinco datos nulos,
y una rama conservada lleva `branch_exists: null`.

### Valores

| Campo | Valores |
|---|---|
| `repos[].scan` | `ok` · `unavailable` (git no respondió; `reason` dice por qué) · `other_machine` |
| `repos[].reason` | `path_missing` · `not_a_repository` · `git_not_installed` · `timeout` · `git_failed` · `other_machine` |
| `worktrees[].state` | `tracked` · `missing_on_disk` · `not_registered` · `orphan_candidate` · `external` · `unknown` |
| `worktrees[].origin` | `task` (una Task lo declara) · `lixbon_dir` (bajo `<repo>.lixbon-wt/`, sin Task) · `external` |
| `physical` | `present` · `missing` · `unknown` (el sistema de archivos no pudo responder) |
| `git.registered` | `true` · `false` · `null` (no se pudo preguntar a git) |
| `dirty` | `clean` · `dirty` · `unknown` · `skipped` (no se evaluó: `probe=false` o no hay carpeta que mirar) |
| `merged` | `merged` · `unmerged` · `unknown` · `skipped` |
| `needs_review` | `true` · `false` · `null` (con `probe=false` no se puede decir) |

## Matriz estado físico ↔ estado mostrado

`state` se decide con la primera regla que se cumple:

| # | Disco | Git lo registra | El Core lo conoce | `state` mostrado |
|---|---|---|---|---|
| 1 | **no existe** | cualquiera, incluso git caído | una Task lo declara | `missing_on_disk` |
| 2 | no se pudo comprobar | cualquiera | una Task lo declara | `unknown` |
| 2b | no se pudo comprobar | sí | nadie lo declara | `unknown` |
| 3 | existe | **no se pudo preguntar** | una Task lo declara | `unknown` |
| 4 | existe | no | una Task lo declara | `not_registered` |
| 5 | existe | sí | una Task lo declara | `tracked` |
| 6 | existe | sí | nadie, bajo `<repo>.lixbon-wt/` | `orphan_candidate` |
| 7 | existe | sí | nadie, en otra ruta | `external` |
| 8 | **no existe** | sí (Git lo lista) | nadie | `missing_on_disk` |

* **«Falta» (`missing_on_disk`) es un hecho del sistema de archivos**, nunca una conclusión de un git que falló
  (filas 1 y 8 frente a 3). Si el repositorio entero no responde, el worktree se muestra `unknown` mientras la
  carpeta exista, y `repos[].reason` explica el fallo.
* Si el sistema de archivos no puede responder, un worktree `unknown` puede tener `origin: task` y dueño, o
  `origin: lixbon_dir`/`external` y `owner: null` si git lo listó y ninguna Task lo reclama. Un recurso que una
  Task declara conserva siempre su dueño, incluso en `unknown`.
* `git.prunable` es una marca informativa suministrada por Git: refleja si su salida incluyó la etiqueta `prunable`.
  El DTO no informa la versión de Git ni garantiza que la etiqueta aparezca; `false` no permite inferir una relación
  con `locked`. Este campo no determina `state` ni hace que la query pode el worktree.
* `dirty` solo se mira con `probe=true`, carpeta presente y `git.registered=true`; en los demás casos es
  `skipped`. `merged` necesita la rama y un destino conocidos.

## Ramas conservadas (`preserved_branches`)

Una Task con `worktree = null`, `branch` y `base`: Lixbon creó esa rama (`lx/<run>/<id>-<slug>`), liberó el worktree
y la rama se quedó por no estar fusionada. Una Task raíz también guarda `branch`, pero es la del propio checkout
y no tiene `base`: **no** es una rama conservada. `branch_exists` es `false` si git confirma que ya no existe y
`null` si no se pudo preguntar. Una rama sin fusionar conservada es normal: no es un error de integridad.
Cada entrada conservada viene de una Task y siempre lleva un `owner` no nulo. `owner: null` solo aparece en
worktrees que git lista y ninguna Task declara; nunca identifica una rama de `preserved_branches`.

Si el repo asociado tiene `scan: "unavailable"`, Git no pudo responder: `branch_exists` debe ser `null` y
`merged` no puede ser `unmerged`. Con `probe=true`, el productor conserva `merged` si la Task ya lo declara;
si no, devuelve `unknown`. Con `probe=false`, devuelve `skipped`. Desktop rechaza una rama conservada de un repo
`unavailable` si trae `branch_exists` distinto de `null` o `merged: "unmerged"`.

Con `probe=true`, una rama conservada necesita revisión exactamente cuando `branch_exists=true` y `merged=unmerged`.
Para un worktree `origin: "task"`, el productor emite `needs_review=true` cuando `merged=unmerged`, la rama existe
y el dueño está en estado final. El DTO no expone la existencia de la rama como campo separado ni el Project del
dueño Task; Desktop solo puede comprobar para `true` las condiciones visibles (`merged=unmerged` y dueño final),
conserva el veredicto Core `false` y no infiere la existencia de la rama ni compara el Project del dueño con
`target.project_id`. Los worktrees con otro `origin` siempre llevan `needs_review=false`. Con `probe=false`,
`merged` es `skipped` y `needs_review` es `null`; con `probe=true`, `merged=skipped` no se produce.

## Aviso «N ramas por revisar»

`warnings.branches_to_review` es el número de entradas de `worktrees` y `preserved_branches` con
`needs_review = true`; con `probe=false` es `null`. Por construcción coincide con el inventario. Un worktree
huérfano o externo nunca cuenta: no es trabajo de Lixbon.

## Git de solo lectura

`orch/resource_git.rs` es el único sitio que habla con git en esta query:

* Solo `worktree list --porcelain`, `for-each-ref`, `status --porcelain`, `merge-base --is-ancestor`,
  `symbolic-ref` y `rev-parse`. **Nunca** `worktree prune`, `fetch`, `gc` ni `branch -d`.
* Todo con `--no-optional-locks` (sin refrescar el índice) y `core.fsmonitor=false` (sin arrancar un demonio).
* Cada consulta tiene un tope de 15 s: un repo en un disco de red caído da `reason: "timeout"` y no cuelga el
  inventario.
* El código de salida distingue «no» de «no sé»: `merge-base` devuelve 0 (sí), 1 (no) o un error (`unknown`).

## Consistencia, multiplataforma y límites

* Las Tasks se copian con el guard del estado y se leen los proyectos en el mismo orden que toda mutación
  (estado → almacén); git y el disco se consultan **después y sin ningún bloqueo del Core**. Es una foto: un
  worktree puede crearse o borrarse mientras se escanea, y una nueva consulta lo refleja.
* Las rutas se comparan con la misma normalización que el registro de proyectos: separadores `/`, sin `\\?\` y, en
  Windows, sin distinguir mayúsculas. Git responde con `/` también en Windows; las rutas mostradas usan el separador
  del sistema. Rutas con nombres cortos 8.3 distintos de los que imprime git pueden no emparejar.
* El escaneo es secuencial y sin paginación. Solo se escanean repos que el Core ya conoce (ubicaciones de Projects de
  esta máquina y repos de Tasks); no hay búsqueda global en disco. No se calculan tamaños.

## Errores

| Código | Cuándo |
|---|---|
| `resource_inventory_auth_required` | sin cliente autenticado, o un Agent |
| `resource_inventory_invalid_request` | parámetro desconocido o con valor inválido |
| `resource_inventory_unavailable` | el Core no tiene almacén abierto |
| `resource_inventory_read_failed` | falló la lectura del registro de proyectos |

Un git que falla **no** es un error de la query: el repo sale con `scan: "unavailable"` y su motivo.

## Cliente Desktop (F2)

El ADE de Desktop lee el inventario por la superficie autenticada `orch_query` (`orch_query` solo
admite queries read-only; `resource_inventory` está en esa allowlist junto a `projects_overview`,
`tasks_by_project`, `task_detail` y `attention_list`). El adaptador vive en
`apps/desktop/src/ade/coreQueries.js` y su regla es una: **el DTO del Core llega tal cual**.

| Qué hace el adaptador | Por qué |
|---|---|
| Envía solo `project_id` (ID duradero) y `probe`; `probe` viaja siempre explícito | El Core hace eco de los filtros y el cliente lo comprueba: si el eco no es el de la petición, la respuesta se rechaza |
| Rechaza un valor fuera del vocabulario cerrado (`state`, `origin`, `physical`, `dirty`, `merged`, `scan`, `reason`) | Un valor desconocido no se reinterpreta como otro estado: se rechaza la respuesta |
| Exige `dirty=skipped`, `merged=skipped` y `needs_review=null` cuando `probe` es `false`; con `probe=true` rechaza `merged=skipped` | Sin sondeo el Core no evaluó nada: «no evaluado» (`skipped`) no es «limpio» ni «fusionado», y el cliente no lo reescribe |
| Exige que `warnings.branches_to_review` sea un **número** con `probe=true` y **`null`** con `probe=false` | El aviso es un veredicto del Core: que falte no es «cero ramas por revisar», y sin sondeo no hay contador |
| Comprueba que cada `target` coincida con `repos` por `repo/path`, máquina y Project; rechaza `scan: "other_machine"` como destino y exige que repo y target usen exactamente la máquina del Core, incluso si es `null` | El productor usa el mismo grupo en ambos lugares; con `machine: null`, los destinos locales también llevan `null`; un repo `unavailable` sigue siendo válido para su destino |
| Comprueba la **coherencia** de cada worktree: `state` ↔ `physical` ↔ `git` ↔ `owner` ↔ `origin` ↔ `dirty` | «Falta» (`missing_on_disk`) solo lo afirma el sistema de archivos; `dirty` solo se evalúa con carpeta presente y `registered=true`; `prunable` informa de una etiqueta opcional de Git y no determina el estado; un huérfano o externo puede ser `unknown` si falla la consulta al disco y nunca lleva dueño, y uno que una Task declara sí |
| Comprueba el alcance de `project_id` en `repos` y en cada `target` | Un filtro de Project no acepta candidatos de otro Project ni con `project_id: null`; sin filtro, el DTO conserva candidatos sin Project |
| Comprueba `needs_review` con los campos que expone cada tipo | En ramas conservadas valida `branch_exists`; para `origin: "task"` solo puede comprobar `merged=unmerged` y el estado final del dueño cuando `needs_review=true`, porque el DTO omite la existencia de la rama y el Project del dueño, que el Core no compara |
| Comprueba la coherencia de cada repo: `scan` ↔ `reason` ↔ `machine` ↔ `project_id` | `other_machine` conserva una máquina remota y `project_id` string de la ubicación; los demás repos usan exactamente la máquina del Core, incluso si es `null`; el Core no ejecuta git en otro host |
| Relaciona `scan` con hechos de git | `scan: "ok"` produce `registered` no nulo; `unavailable` deja nulos los datos de registro/branch y `branch_exists` de ramas conservadas; con sondeo, un worktree Task queda `merged` si la Task lo declara o `unknown`, y `needs_review=false` |
| Comprueba que `warnings.branches_to_review` y `worktrees_by_state` cuadran con las propias entradas | El aviso es veredicto del Core; el cliente lo verifica, no lo recalcula para mostrarlo |
| Devuelve `owner: null` como «sin propietario» y `unknown` como «desconocido» | «Desconocido» y «no disponible» no son «falta»: falta solo lo afirma el Core (`state: missing_on_disk`) |

El contrato del inventario vive en `apps/desktop/src/ade/coreInventoryContract.js` (sin dependencias
de React ni de Tauri) y el adaptador de transporte en `apps/desktop/src/ade/coreQueries.js`.

### Plazo del cliente: un umbral visual, no un límite del escaneo

El Core escanea `resource_inventory` **en secuencia y sin paginación**, y acota **cada** consulta de
git a 15 s (un repo en un disco de red caído sale con `reason: "timeout"`); `fs::metadata` no tiene
tope global. Un inventario legítimo puede tardar, por tanto, bastante más que cualquier umbral del
cliente. Por eso el plazo del cliente **no promete cubrir el escaneo total**: es el momento en que
el cliente deja de ESPERAR y empieza a avisar.

| Regla | Qué hace | Por qué |
|---|---|---|
| El plazo es un umbral visual | `resource_inventory` tiene 30 s (dos veces el tope por consulta del Core); las demás queries, 10 s | El plazo dice cuándo se avisa, no cuánto dura el escaneo |
| La petición **no se abandona** al vencerse el plazo | La petición sigue viva en el Core y su respuesta se aplica si llega tarde | Abandonarla era lo que abría escaneos solapados |
| Una sola petición viva por lectura | Un poll, un reintento o un cambio de argumentos no vuelven a preguntar al Core mientras la anterior sigue viva | La lectura se engancha a la petición viva: **una sola llamada** |
| Un escaneo de inventario a la vez **por Project** | `resource_inventory` admite **una** petición viva por `project_id` (hueco `resource_inventory#<project_id>`); lo que no cabe se **aplaza** hasta que se libere hueco | Cada petición es un escaneo secuencial del disco y del git del Core; un Project lento no aplaza la lectura de otro |
| Tope de abandono | Sin respuesta tras 120 s la petición se abandona: libera su hueco, quien esperaba recibe `ade_query_timeout` (stale si hay foto) y el sondeo o el reintento vuelven a preguntar; una respuesta posterior se descarta | Un escaneo colgado no bloquea indefinidamente los reintentos |
| `project_id` obligatorio en el ADE | El hook y `readAdeResources` rechazan la lectura sin `project_id` (`ade_query_invalid_request`) y la respuesta debe traer `filters.project_id` en el eco | El ADE nunca pide un inventario global |
| Estado visible | Project View pasa a Resources el estado de la lectura (`loading`/`refreshing`/`stale`/`error`/`disconnected`/`degraded`) con su mensaje y un botón de reintento | La foto anterior se conserva y el estado se dice, no se oculta |
| Se conserva la última foto | Al agotarse el umbral se muestra la última respuesta **completa** | Nunca un inventario recortado, ni un `skipped` disfrazado de «limpio», ni filas inventadas |
| Se recupera de la respuesta tardía | Si el Core contesta después del umbral, esa respuesta se aplica y la vista vuelve a estar al día | Un escaneo lento no es un escaneo perdido |
| El estado sigue la **evidencia** | `stale` si había foto; `degraded` solo si el Core lo dice; `error` si no; `disconnected` **solo** con evidencia de transporte roto (IPC cerrado, conexión rechazada) | Un plazo agotado **no** es una desconexión: el Core puede estar escaneando |

El umbral, el registro de peticiones vivas y la clasificación del fallo viven en
`apps/desktop/src/ade/coreQueryPolicy.js`; `useCoreQuery.js` es un adaptador fino sobre esa política.
Las regresiones (lectura más lenta que el umbral, poll/reintento/cambio de argumentos mientras sigue
viva, una sola llamada y recuperación al resolverse) están en `useCoreQuery.test.js`; la misma
política se puede comprobar sin dependencias con
`node apps/desktop/scripts/check-core-query-contract.mjs`.

`probe: false` es la lectura más barata (solo registro de git y disco, sin `dirty`/`merged` ni
contador de avisos), pero tampoco está garantizada dentro del umbral: el tope de 15 s es por
consulta de git en el Core, y el Core escanea los repos uno a uno.

### Qué ve quien mira la vista

| Situación | Estado del cliente | Qué se muestra |
|---|---|---|
| Lectura en curso | `loading` / `refreshing` | «Conectando con Core…» / «Actualizando desde Core» |
| Respuesta del Core | `ready` | La foto completa del inventario |
| Plazo agotado **con** foto previa | `stale` (motivo `timeout`) | La última foto y «Core no respondió a tiempo»; se conserva la última respuesta |
| Plazo agotado **sin** foto previa | `error` | «El Core no respondió dentro del umbral del cliente»; ningún dato inventado |
| El Core dice que no tiene almacén autoritativo | `degraded` | «Core degradado» |
| Transporte roto con evidencia (IPC cerrado, conexión rechazada) | `disconnected` | «Core desconectado» |
| Respuesta tardía, después del umbral | `ready` | La foto nueva: un escaneo lento no se pierde |

`ade_query_timeout` es el código del cliente para el umbral agotado. **No** significa
«desconectado»: significaba eso antes de LXO-101, y era falso, porque el Core puede estar
escaneando el disco. Solo hay evidencia de desconexión cuando el transporte da esa evidencia.
