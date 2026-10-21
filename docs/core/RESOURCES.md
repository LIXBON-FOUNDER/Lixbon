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
| `project_id` | acota a los repos de ese Project | todos |
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
| 2 | no se pudo comprobar | — | una Task lo declara | `unknown` |
| 3 | existe | **no se pudo preguntar** | una Task lo declara | `unknown` |
| 4 | existe | no | una Task lo declara | `not_registered` |
| 5 | existe | sí | una Task lo declara | `tracked` |
| 6 | existe | sí | nadie, bajo `<repo>.lixbon-wt/` | `orphan_candidate` |
| 7 | existe | sí | nadie, en otra ruta | `external` |
| 8 | **no existe** | sí (git lo marca `prunable`) | nadie | `missing_on_disk` |

* **«Falta» (`missing_on_disk`) es un hecho del sistema de archivos**, nunca una conclusión de un git que falló
  (filas 1 y 8 frente a 3). Si el repositorio entero no responde, el worktree se muestra `unknown` mientras la
  carpeta exista, y `repos[].reason` explica el fallo.
* Un worktree `missing_on_disk` que git todavía registra aparece con `git.prunable: true`. **La query no lo poda.**
* `dirty` solo se mira si la carpeta existe y git la registra; `merged` necesita la rama y un destino conocidos.

## Ramas conservadas (`preserved_branches`)

Una Task con `worktree = null`, `branch` y `base`: Lixbon creó esa rama (`lx/<run>/<id>-<slug>`), liberó el worktree
y la rama se quedó por no estar fusionada. Una Task raíz también guarda `branch`, pero es la del propio checkout
y no tiene `base`: **no** es una rama conservada. `branch_exists` es `false` si git confirma que ya no existe y
`null` si no se pudo preguntar. Una rama sin fusionar conservada es normal: no es un error de integridad.

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
