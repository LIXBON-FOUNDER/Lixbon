# Queries de lectura del Core para clientes observacionales (F2)

Estado: **`projects_overview` implementado (LXO-90)**. Las queries de Tasks por Project (LXO-91), Activity
(LXO-92), inventario de worktrees (LXO-93) y snapshot compacto (LXO-94) se documentan aquí cuando se
implementen.

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
ni cursor: el overview devuelve todos los Projects que cumplen el filtro (el cursor de snapshot es LXO-94).

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

### Pruebas

`orch/projects_overview_tests.rs` (0/1/N Projects, orden, activo+fallido+Attention, estado agregado, Attention
vs `failed`, relocalización, archivados, filtro `machine`, `unassigned`, coherencia con `attention_list` y con
el snapshot, solo Person, parámetros inválidos, solo lectura) y
`orch/server.rs::http_rpc_projects_overview_es_solo_para_person_autenticada` (E2E por `POST /rpc`).
