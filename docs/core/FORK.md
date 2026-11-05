# Fork (LXO-145, épica F5)

`attempt_fork` crea un Attempt **nuevo** a partir de otro, sin tocarlo. Es la única forma de tener dos ejecuciones del mismo trabajo a la
vez, y es explícita: un Fork repetido a mano no es un Race (LXO-215), ni elige ganador ni compara.

## Qué es un Fork en el modelo

Un Fork es una **Task nueva** con su primer Attempt, en su propio Run, rama y worktree, que lleva la procedencia al Attempt origen
(`attempt.forked`). No es un segundo Attempt activo de la misma Task: el modelo mantiene «a lo sumo un Attempt activo por Task»
([ATTEMPTS.md](ATTEMPTS.md) D19) y el runtime guarda proveedor, sesión y worktree en la Task, así que lo que corre a la vez son
**Tasks distintas**. Comparar sus resultados es trabajo de Compare (LXO-146), que agrupa por la procedencia.

| Decisión | Por qué |
|---|---|
| **Task hija, no `n + 1`** | Cambiar «un solo Attempt activo por Task» obliga a reescribir el estado en memoria, el despachador y las credenciales por Attempt (CORTE_TASK_ATTEMPT D11/D19). Un Fork como Task nueva da paralelismo real hoy con el camino de `task_create` |
| **Nace `pending_approval`** | Como cualquier primer Attempt: ninguna selección exime de la decisión humana. Rechazarlo no lanza nada ni crea worktree |
| **Worktree propio siempre** | Compartirlo exige policy (LXO-209, no existe): el RPC ni siquiera acepta pedirlo |
| **Perfil heredado** | Un Fork nunca amplía lo que el agente puede hacer; el cliente no puede pedir otro |
| **Sin reanudar la sesión del origen** | Ningún adapter ofrece `fork` y una ProviderSession no se comparte. El contexto viaja como ContextPackage |

## Petición

```text
attempt_fork { request_id, source_attempt_id, provider?, model?, effort?, role?, title?, package? }
```

* `request_id`: clave de idempotencia (1–64 de `A-Za-z0-9_.-`), por Person. Repetirla con lo mismo devuelve `Replayed` con los mismos
  ids y no crea nada; con otra cosa es un error (no gasta la clave).
* `source_attempt_id`: `<task>-a<n>` de un Attempt que existe y es de una Task con Project. Puede estar en cualquier estado, también
  corriendo: el origen no recibe ni un evento.
* `provider`, `model`, `effort`, `role`: lo que se quiere distinto. Sin valor se hereda; el modelo y el esfuerzo **solo se heredan
  dentro del mismo proveedor** (son del proveedor).
* `title`: por defecto `Fork de <título del origen>`.
* `package`: el ContextPackage v1 (JSON, como texto) que la persona revisó con `context_package_preview`. El Core lo parsea (identidad
  y secretos) y comprueba que sale **de este Attempt y de este Project**; si no, se rechaza antes de crear nada. Sin él, el Fork
  arranca limpio con el encargo de la Task origen.

No acepta `profile`, `worktree`, `host`, `external` ni `approved` (`deny_unknown_fields`). Solo una **Person de Desktop**.

Respuesta: `{ status: Requested|Replayed, source_attempt_id, run_id, task_id, attempt_id, strategy, package_id? }`.

## Orden

1. Person autenticada, lanzador instalado, `request_id` y selección válidos.
2. El origen existe; su selección (proveedor, modelo, esfuerzo, rol, perfil) es la que se hereda.
3. Project lanzable, proveedor con `start` disponible, ContextPackage válido y del origen. **Todo antes de escribir.**
4. ¿Ya se atendió la clave? → `Replayed`.
5. Una sola mutación: Run + Task + Attempt (`pending_approval`) + `attempt.requested` + `attempt.forked`. O están todos o ninguno.

El resto es el camino de siempre: la persona aprueba (`attempt_approve`), el despachador reserva el claim, el lanzador crea el worktree
y llama al adapter. Si el worktree no se puede crear, el Fork queda `failed` (`launch_failed`) sin llamar al proveedor y el origen no
cambia.

## Evento `attempt.forked` (v1, state, entidad `attempt` del Fork)

`task`, `n` (siempre 1), `source` (id del origen), `source_task`, `source_n`, `strategy` ∈ `clean` `context_package`, `package_id?`,
`overrides?` ⊆ `provider` `model` `effort` (solo lo que se **pidió** distinto). Nunca el encargo ni el contenido del paquete. Va
justo después de `attempt.requested`. Activity: `activity.attempt.forked` ([ACTIVITY.md](ACTIVITY.md)).

## Query `attempt_lineage { attempt_id }`

De dónde salió un Attempt y qué Forks nacieron de él, leído del log:

```text
{ v: 1, attempt_id,
  forked_from: null | { attempt_id, task_id, n, strategy, package_id|null, overrides[] },
  forks: [ { attempt_id, task_id, strategy, provider, model|null, status, created_at } ] }   // en el orden en que nacieron
```

Solo una Person de Desktop. El estado y el proveedor de cada Fork son los de ahora; la procedencia es la que se registró.

## Invariantes de la issue y cómo se prueban (`fork_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | Fork nunca reusa la identidad del origen | `un_fork_limpio_crea_una_task_nueva_…` |
| 2 | La fuente permanece inmutable | `un_fork_limpio_…` (filas, eventos y Attention del origen idénticos), `rechazar_el_fork_…` |
| 3 | Worktree propio; compartido no se puede pedir | `el_fork_aprobado_corre_en_su_propio_worktree_…`, `solo_una_persona_de_desktop_…` |
| 4 | Procedencia del ContextPackage verificable | `un_fork_con_context_package_del_origen_…`, `un_paquete_que_no_es_del_origen_o_esta_alterado_…` |
| 5 | Un reintento del command no crea Forks duplicados | `repetir_el_fork_no_lo_duplica_…` |
| — | Mismo proveedor / otro proveedor | `un_fork_con_otro_proveedor_cambia_solo_lo_pedido_…` |
| — | Con / sin ContextPackage | las dos anteriores de paquete y `un_fork_limpio_…` |
| — | Fallo al crear el worktree | `si_el_worktree_del_fork_no_se_puede_crear_…` |
| — | Aprobación rechazada | `rechazar_el_fork_no_lanza_nada_…` |
| — | Ejecución simultánea | `bifurcar_un_origen_en_marcha_corre_los_dos_a_la_vez_…` |
| — | Procedencia en los dos sentidos | `la_procedencia_sale_del_log_…` |

## Límites conocidos

* El Fork y su origen son Tasks distintas: la UI de la Task origen no los agrupa sola; se ven por `attempt_lineage`.
* La idempotencia vive en el ledger de `task_create` (por Person y clave): una clave de Fork y una de `task_create` no se confunden
  porque el hash lleva `kind: attempt.fork`.
* Sin policy (LXO-209) nada filtra quién puede bifurcar más allá de «una Person de Desktop».
* No se probó con un proveedor real; las pruebas usan adapters falsos.
* Un Fork de un origen que ya terminó solo hereda el **encargo** (título y `spec`) de la Task, no el trabajo hecho: para llevar ese
  trabajo hay que pasar un ContextPackage.
