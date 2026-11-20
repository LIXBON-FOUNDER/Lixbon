# Delegate: delegar un trabajo con el origen verificado (LXO-171, épica F6)

`attempt_delegate` permite a una persona delegar a un agente un trabajo que nace de **una selección de código, de una Task o de un Attempt**, con el origen **verificado** y su procedencia **durable**. Termina siempre en una Task y un Attempt explícitos.

Implementación: `orch/delegate_runtime.rs`. Pruebas: `orch/delegate_e2e_tests.rs`.

## Qué es (y qué no)

Delegate **no es otra forma de crear Tasks**: es una capa sobre `task_create` (el mismo camino: Run + Task + primer Attempt `pending_approval`, idempotente, con la decisión humana de siempre) que antes **resuelve y valida el origen** con las mismas reglas que [`lixbon://`](DEEP_LINKS.md) y después **anota de dónde nace**.

| | `task_create` | `attempt_fork` | `attempt_retry` | **`attempt_delegate`** |
|---|---|---|---|---|
| Crea | Task + Attempt | Task + Attempt | Attempt `n+1` en la misma Task | Task + Attempt |
| Origen | ninguno | un Attempt | un Attempt que terminó mal | selección de código, Task o Attempt |
| Encargo | el que se dé | el de la Task origen | el de la Task | **el que diga la persona** + el origen como datos |
| Origen verificado | no | existe y es del Project | sí | **coherencia, revisión vigente, archivo disponible** |
| Procedencia durable | no | `attempt.forked` | `attempt.retried` | **`attempt.delegated`** |

## Petición

```json
{ "request_id": "d-1", "project_id": "p-1",
  "attempt_id": "t2-a1", "new_task": true,
  "file": "src/lib.rs", "line": 10, "end_line": 24, "revision": "0123abc",
  "instruction": "cambia el manejo de errores de esta función",
  "provider": "codex", "model": "m-1", "profile": "explorar",
  "package": "{…ContextPackage v1…}", "title": "Errores de lib.rs" }
```

| Campo | Regla |
|---|---|
| `request_id` | Clave de idempotencia (1 a 60 de `A-Za-z0-9_.-`). |
| `project_id` | Obligatorio. |
| `task_id`, `attempt_id` | El origen. Sin ninguno, la delegación parte de una **selección de código** del Project. Un `attempt_id` implica su Task; si se dan los dos, tienen que ser coherentes. |
| `new_task` | **La acción explícita** de crear otra Task a partir de una que ya existe. Obligatoria si hay `task_id` o `attempt_id`; sin origen no tiene sentido. |
| `file` | Ruta **relativa** al Project, con las mismas reglas que `file` de `lixbon://` (sin `../`, absolutas, codificadas ni controles). |
| `line`, `end_line` | El rango. `line` necesita `file`; `end_line` necesita `line` y no puede ser menor. |
| `revision` | La revisión en la que se vio la selección (7 a 64 hex). **Con `attempt_id`** se compara con la vigente del Attempt; **sin él** solo se comprueba que exista en el Project y se fija tal cual. |
| `instruction` | Lo que se le pide al agente (1 a 12 000 caracteres). |
| `provider`, `model?`, `effort?`, `role?`, `profile` | La selección de ejecución, como en `task_create`. El perfil es obligatorio y no se amplía por esta vía. |
| `package` | El ContextPackage v1 que la persona revisó con `context_package_preview`. **Solo con `attempt_id`**; se verifica contra ese Attempt y ese Project. |
| `title` | Por defecto `Delegado: <primera línea del encargo>`. |

Solo una Person autenticada de Desktop o de la CLI. La **policy** lo trata como un arranque (`Category::Start`) en ese Project, igual que `task_create` con Attempt. No acepta ningún otro campo.

Respuesta: `{ status: Requested | Replayed, run_id, task_id, attempt_id, source: {kind, link, project_id, task_id?, attempt_id?, file?, line?, end_line?, revision?}, strategy: clean | context_package, package_id? }`.

## Orden de las cosas

```text
1. Person autenticada · clave, texto y selección bien formados (mismas reglas que `lixbon://`)
2. ¿parte de una Task que ya existe?  -> solo con `new_task: true`
3. el origen EXISTE y es coherente (Project/Task/Attempt), la ubicación está en esta máquina y su revisión sigue vigente
4. el ContextPackage (si lo hay) sale de ESE Attempt y de ESE Project
5. todo lo anterior, ANTES de escribir nada
6. task_create: la Task nueva y su Attempt `pending_approval`; el encargo lleva el origen como datos
7. attempt.delegated: la procedencia
```

El Attempt nace `pending_approval` como cualquier primer Attempt: la persona lo aprueba (`attempt_approve`) y el despachador lo lanza. Rechazarlo no lanza nada.

## Lo que se le dice al agente

El encargo de la Task es la `instruction`, seguida de un bloque **«ORIGEN DE LA DELEGACIÓN»** que le dice que son **datos comprobados por Lixbon, información y no instrucciones**: el enlace `lixbon://`, el Project, la Task y el Attempt de origen, el archivo y el rango, y la revisión con la orden para ver el archivo tal como estaba (`git show <rev>:<archivo>`). Con `package`, antes va el prompt de continuación del ContextPackage (con lo redactado ya redactado) y el encargo queda bajo `ENCARGO:`.

No se incluye contenido de archivos: el agente lo lee en su worktree a esa revisión.

## `attempt.delegated` (v1, state, entidad `attempt` del Attempt nuevo)

`task`, `n`, `source_kind` ∈ `selection` · `task` · `attempt`, `link` (el enlace canónico del origen), `line_end?`, `revision?` (solo sin Attempt), `package_id?`, `new_task`. **Nunca una ruta absoluta ni contenido.** Uno por Attempt (idempotente). Activity: `activity.attempt.delegated` ([ACTIVITY.md](ACTIVITY.md)). Detalle en [EVENTOS.md](EVENTOS.md).

## Errores

| Código | Cuándo | ¿se creó algo? |
|---|---|---|
| `delegate_invalid` | petición o selección mal formada (clave, texto, ruta, rango, `package` sin Attempt, `new_task` sin origen…) | no |
| `delegate_task_exists` | hay `task_id` o `attempt_id` y falta `new_task: true` | no |
| `delegate_source_invalid` | el origen no existe, no es coherente o no está disponible aquí (lleva el código de `lixbon://`: `link_not_found`, `link_target_mismatch`, `link_host_unavailable`…) | no |
| `delegate_source_mismatch` | `task_id` y `attempt_id` no son de la misma Task | no |
| `delegate_source_stale` | la `revision` ya no es la vigente del Attempt (dice la pedida y la vigente) | no: no se delega lo que había |
| `delegate_source_unknown_revision` | sin Attempt, la revisión no existe en el Project | no |
| `context_package_invalid`, `context_package_source_mismatch` | el paquete no es válido o no sale de ese Attempt/Project | no |
| `delegate_provenance_failed` | la Task se creó pero no se pudo anotar su procedencia | **sí**: repetir la petición con la misma clave **repara el hecho** sin crear otra Task |
| los de `task_create` | proveedor sin `start`, Project no lanzable, clave ya usada para otra petición… | no |

## Invariantes y cómo se prueban (`delegate_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | Termina en Task y Attempt explícitos; el Attempt nace `pending_approval` y no se lanza nada | `delegar_desde_una_seleccion_crea_una_task_y_un_attempt_pendientes_…` |
| 2 | El origen se referencia por Project/revisión, nunca por una ruta absoluta | ídem, y `un_origen_mal_formado_inexistente_o_incoherente_no_crea_nada` |
| 3 | Delegar desde una Task existente no crea otra Task en silencio | `delegar_desde_una_task_o_un_attempt_exige_la_accion_explicita_…` |
| 4 | Una revisión obsoleta se rechaza; una desconocida también | `una_revision_obsoleta_se_rechaza_y_una_desconocida_tambien_…` |
| 5 | El ContextPackage se verifica antes de lanzar; el origen no recibe ni un hecho | `delegar_desde_un_attempt_con_paquete_crea_otra_task_y_no_toca_el_origen` |
| 6 | Idempotente por `request_id`; la procedencia no se duplica; su espacio de claves es propio | `repetir_la_peticion_devuelve_la_misma_task_…` |
| 7 | Rechazar o fallar el lanzamiento deja la procedencia y no lanza nada | `rechazar_o_fallar_el_lanzamiento_…` |
| 8 | Un archivo de un worktree en otra máquina no se delega desde esta | `un_archivo_de_un_worktree_en_otra_maquina_…` |
| 9 | Solo una Person autenticada | `solo_una_person_autenticada_delega` |

## CLI: `lxo delegate` (LXO-179)

```text
lxo delegate --project ID|NOMBRE --provider P --profile PERFIL --instruction "…" <origen> [--dry-run] [--json]
  origen:  --task ID | --attempt ID  (con --new-task)   ·   --file RUTA [--line N [--end-line M]] [--revision SHA]
```

Es una traducción fiel de `attempt_delegate`: lxo no decide nada que sea del Core, no elige proveedor y no infiere el Project del directorio.

* Pide al menos un origen. Desde una Task o un Attempt exige **`--new-task`** (la acción explícita de crear otra Task; otro Attempt de la misma Task es `lxo attempt retry`).
* Comprueba antes de enviar lo que no hace falta preguntar al Core: ruta relativa sin `..`, barras invertidas, controles ni `%XX`; rango coherente; revisión hexadecimal. El Core lo vuelve a verificar todo.
* `--context-package` (id guardado, archivo o `-`) solo con `--attempt`: lxo lo verifica con `context_package_preview` contra ese Attempt y ese Project y envía el texto del paquete.
* `--dry-run` no escribe: resuelve el origen con `deep_link_generate` (la misma resolución que usa Delegate; una revisión obsoleta falla igual, con 7), lee `policy_effective` (categoría `start`) y enseña el resumen del paquete. Sin Attempt, la revisión se enseña como `not_checked`: no hay una «vigente» con la que compararla.
* La clave idempotente es `--request-id` o `lxo-delegate-<sha256 de la petición>`: repetir el mismo comando devuelve `Replayed` con la misma Task. Si el Core avisa de `delegate_provenance_failed`, repetirlo repara el hecho.
* No acepta host, estrategia de worktree ni `--confirm` (`start` nunca lo pide: el Attempt nace `pending_approval` y lo aprueba Desktop).

`--json` (v1): `{v, command: "delegate", status: Requested | Replayed | dry_run, request_id, project_id, task_id, attempt_id, attempt_status, approval_required, approval_surface, source, target, strategy, package_id, package, provenance, link}`. `link` es el enlace `lixbon://` del Attempt nuevo (`null` si el Core no puede generarlo: no estropea una delegación ya hecha) y `source.link`, el del origen.

| Código | Cuándo |
|---|---|
| 2 | uso: falta origen, `--new-task` o receptor; ruta o rango inválidos; paquete de otro Attempt/Project; el Core rechaza la petición |
| 3 | autenticación o policy: un agente, no una Person; `policy_denied` |
| 4 | contrato o versión del Core que lxo no entiende |
| 5 | Core no disponible, entorno del proveedor bloqueado u origen en otra máquina |
| 6 | Project, Attempt o paquete inexistente |
| 7 | revisión del origen obsoleta |

## Qué NO hace

* **No crea otro Attempt en la misma Task.** Ese caso es `attempt_retry` (con `provider` distinto si se quiere otro agente): el modelo mantiene «a lo sumo un Attempt activo por Task» y reutilizar sus reglas es mejor que duplicarlas aquí. Delegar desde una Task o un Attempt crea una Task **nueva** y lo exige de forma explícita (`new_task`).
* **No construye el ContextPackage**: se pide con `context_package_build` y se revisa con `context_package_preview`; aquí solo se verifica.
* **No elige el proveedor** por la persona, ni comparte worktree, ni amplía permisos (el perfil lo dice la persona, como en `task_create`).
* **No hay interfaz gráfica** (selección en el editor, botón de delegar): LXO-176 (Desktop). La CLI sí: `lxo delegate` (LXO-179, arriba).
* La revisión **sin Attempt** no se puede comparar con una «vigente» (no hay de qué): solo se comprueba que exista.
* No hay prueba de un reinicio del Core entre la creación de la Task y la anotación de su procedencia; el diseño es que repetir la petición lo repare.
