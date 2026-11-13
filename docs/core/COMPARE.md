# Compare (LXO-146, épica F5)

`attempt_compare` da datos **comparables** entre 2–4 Attempts, cada uno con su procedencia. Es una lectura: no escribe, no puntúa, no
elige ganador, no integra y no devuelve el diff. El cliente no agrega worktrees, pruebas ni artefactos por su cuenta.

## Qué se puede comparar

| `relation.kind` | Cuándo | `relation.root` |
|---|---|---|
| `same_task` | todos son de la misma Task | la Task |
| `fork_family` | el origen y los Forks que nacieron de él, o Forks hermanos ([FORK.md](FORK.md)) | el Attempt origen |

Cualquier otra combinación es `compare_not_comparable`. **Desvío respecto del texto de la issue** («solo Attempts de la misma Task»): un
Fork es una Task nueva ([FORK.md](FORK.md) § decisiones), así que sin `fork_family` un Fork nunca se podría comparar con su origen. Se
acepta por la procedencia registrada en el log (`attempt.forked`), no por nombres ni fechas; nada más se mezcla.

## Petición y respuesta

```text
attempt_compare { attempt_ids: [2–4 ids, sin repetir] }          // solo una Person de Desktop; ningún otro campo
→ { v: 1,
    relation: { kind, root },
    attempts: [ …en el orden pedido… ],
    overlaps: { complete, total, items: [ { path, attempt_ids } ] },
    limits: { max_attempts: 4, max_files_per_attempt: 200, max_overlaps: 100 } }
```

Cada Attempt trae `attempt_id`, `task_id`, `n`, `project_id`, `is_current`, `forked_from` y estos datos, todos con la forma
`{ value, provenance, reason? }`:

| Dato | Procedencia | Notas |
|---|---|---|
| `selection` (proveedor, modelo, esfuerzo, rol, perfil, external) | `verified` | lo que el Core registró al crear el Attempt |
| `status` (`status`, `failure_reason`) | `verified` | |
| `timing` (`created_at`, `started_at`, `ended_at`, `duration_ms`) | `verified` | reloj del Core; `duration_ms` es `null` si falta alguna marca |
| `host`, `worktree` (rama, base, estado) | `verified` / `unknown` (`no_worktree`) | |
| `revision` (`base_commit`, `head_commit`, `source`) | `verified` / `unknown` | `source`: `review` (commits de la revisión) · `live_branch` (HEAD de ahora) · `live_branch_merge_base` |
| `changes` (`files`, `additions`, `deletions`, `list`, `total_files`, `truncated`) | `verified` / `unknown` | git lo ejecuta el Core sobre commits que no cambian |
| `summary` | `agent_reported` / `unknown` (`no_summary`) | lo escribió el agente |
| `artifacts` (`items`) | `agent_reported` / `unknown` (`none_recorded`) | lo que el agente registró; el Core no lo comprobó |
| `tests` | `unknown` (`not_collected`) | el Core todavía no recoge resultados de pruebas |
| `review` | `verified` / `unknown` (`not_reviewed`) | veredicto, estado, commits y vigencia |

## Procedencia

* **`verified`**: el Core lo observó o lo calculó él mismo (su reloj, sus registros, git ejecutado por él).
* **`agent_reported`**: lo declaró el agente. **Nunca sube a `verified` por sí solo.**
* **`unknown`**: no hay dato; `value` es `null` y `reason` dice por qué (`no_worktree` · `not_current_attempt` · `branch_unavailable` ·
  `no_base` · `repo_unavailable` · `git_unavailable` · `truncated` · `binary_files` · `not_reviewed` · `no_summary` · `none_recorded` ·
  `not_collected`). **Nunca un cero, un `false` ni una lista vacía que parezca un resultado.**

Un cero **calculado** sí es un dato: un Attempt cuya rama no cambió nada tiene `changes.files = 0` `verified`; se distingue de «no se sabe».

## De dónde salen los cambios

Los cambios de un Attempt se calculan entre su base y su HEAD (`git diff --numstat`):

1. Si el Attempt tiene una **revisión**, con los commits de esa revisión (inmutables).
2. Si no, y es el **Attempt actual de su Task**, con el HEAD vivo de la rama de la Task.
3. Si no (un Attempt anterior sin revisión, o sin worktree), `unknown`: **la rama de la Task es la del Attempt actual**, y un reintento
   trabaja en el mismo worktree, así que de un Attempt anterior no hay una rama propia que leer.

Los archivos van ordenados por ruta y acotados a 200 (`total_files` dice cuántos había, `truncated` si se recortó). Con la lista recortada
las sumas son `unknown` (`truncated`): una cifra parcial engañaría. Un archivo binario no tiene cuentas (`null`) y hace `unknown` las sumas
(`binary_files`). Para el parche está la lectura de revisión de siempre.

## Solapes

Los archivos que tocaron dos o más Attempts, por ruta. `complete` es falso si alguna lista se recortó o no se pudo leer: puede haber más
de los que se ven.

## Determinismo

El mismo estado da la misma respuesta: los Attempts salen en el orden pedido, los archivos y los solapes por ruta. Leer no escribe
eventos ni filas.

## Invariantes de la issue y cómo se prueban (`compare_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | Solo se comparan Attempts relacionados | `dos_forks_hermanos_son_comparables_y_lo_demas_no`, `dos_attempts_de_la_misma_task_…` |
| 2 | `verified` requiere evidencia comprobada por el Core | `un_origen_y_sus_forks_…` (cambios y HEAD de git) |
| 3 | Lo que cuenta el agente nunca es `verified` | `lo_que_cuenta_el_agente_no_es_verified_…` |
| 4 | Lo que falta es `unknown`, no cero | `un_attempt_sin_worktree_…`, `un_archivo_binario_…`, `un_diff_enorme_…` |
| 5 | Compare es read-only | `comparar_es_determinista_y_no_escribe_nada` |
| — | 2/3/4 Attempts con proveedores distintos | `un_origen_y_sus_forks_…` (3) y `la_peticion_se_valida_…` (4) |
| — | Diff grande con total y recorte | `un_diff_enorme_viaja_acotado_…` |
| — | Determinismo | `comparar_es_determinista_…` |

## Límites conocidos

* Las pruebas no se recogen todavía (`tests` siempre `unknown`); tampoco se verifican los hashes de los artefactos.
* Un Attempt anterior de una Task sin revisión no tiene cambios propios que mostrar (ver arriba).
* Sin `host` por proveedor remoto: es la máquina del worktree.
* No se probó con un proveedor real; las pruebas usan adapters falsos con repositorios y worktrees de verdad.

## Cliente de terminal: `lxo compare` (LXO-161)

`lxo compare --task <task_id> [attempt_id ...] [--status S] [--provider P] [--json]` es una lectura autenticada como Person.
El CLI no calcula git, pruebas, solapes ni procedencia: valida la selección contra las lecturas del Core y pasa los ids en el
orden indicado a `attempt_compare`.

* Con ids explícitos se exigen de 2 a 4 Attempts distintos y todos deben pertenecer a `--task`; los filtros, si se pasan,
  deben coincidir con cada id. El cliente no mezcla Tasks aunque el Core también permita comparar una familia de Forks.
* Sin ids, lista todas las páginas de `attempts_by_task`, aplica `--status` y `--provider` (sin distinguir mayúsculas) y solo
  compara si quedan entre 2 y 4. Si quedan más, hay que elegir ids; nunca elige una selección arbitraria.
* La salida humana es vertical (un dato por línea), para evitar una tabla horizontal ilegible en terminales estrechas. Cada
  dato conserva `✓ Verificado`, `⚠ Declarado por el agente` o `? Sin dato (<motivo>)`. Las pruebas desconocidas no se muestran
  como un cero. Cada fila da el id para `lxo review <attempt_id>` y para abrir el Attempt en Desktop.
* `--json` devuelve sin reducir ni reinterpretar la respuesta completa `v: 1` de `attempt_compare`. Las respuestas fuera del
  contrato o en un orden distinto al pedido se rechazan.
* Salidas: 0 correcto, 1 error interno, 2 uso/selección no comparable, 3 autenticación/permiso, 4 versión/contrato,
  5 Core no disponible, 6 Task o Attempt inexistente.
