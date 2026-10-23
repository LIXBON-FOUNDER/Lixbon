# Review targeting (LXO-118)

Estado: **esquema, mutadores y puerta implementados, inertes hasta el corte**. Épica `[CORE][F3]`
([ADR](CORTE_TASK_ATTEMPT.md) §7 y D8).

Hoy una revisión (`Decision.kind = review`) apunta a la **Task** y a un commit. Tras el corte apunta a una ejecución y
a una revisión concretas: **`(attempt_id, head_commit)`**, más la base observada.

Piezas:

* Migración: [`011_reviews.sql`](../../apps/desktop/src-tauri/src/store/migrations/011_reviews.sql). Crea `decisions`,
  que sale del SQL del corte con la misma forma, y `reviews`.
* Almacén: `store/reviews.rs`. Pruebas: `store/reviews_tests.rs`.
* Hechos y permisos: `orch/review_ops.rs`. Pruebas: `orch/review_ops_tests.rs`.

## Invariantes y cómo se prueban

| # | Invariante (LXO-118) | Mecanismo | Prueba |
|---|---|---|---|
| 1 | Aceptar una revisión distinta está prohibido | la puerta `review_gate(attempt, head)` exige el mismo `head_commit` que la revisión aceptada | `un_head_movido_invalida_…` (`HeadMoved`) |
| 2 | La revisión del Attempt A nunca afecta al B | el target es el Attempt. Revisar, sustituir o invalidar solo toca las de ese Attempt. La puerta solo vale para el Attempt actual de la Task (D8), aunque el commit coincida | `dos_attempts_de_una_task_tienen_revisiones_independientes`, `invalidar_un_attempt_no_toca_…` |
| 3 | Cambiar el HEAD invalida la aceptación previa | `review_invalidate(attempt, observed_head)`: si la activa es de otro HEAD, pasa a `stale` con el HEAD visto. Una `stale` no autoriza ni sobre su propio HEAD | `un_head_movido_invalida_la_aceptacion_y_revisar_otra_vez_la_reabre` |
| 4 | La historia de decisiones es inmutable | `decisions` no admite `UPDATE` ni `DELETE`. De `reviews` solo cambia el estado, una vez (`active` → `stale` o `superseded`). Reabrir es revisar de nuevo | `el_comentario_vive_en_la_decision_y_la_historia_no_se_reescribe` |

## Modelo

**`reviews`** (una fila por decisión `review`):

| Columna | Para qué |
|---|---|
| `decision_id` | la decisión, que guarda quién, cuándo y el comentario en `detail_json` |
| `attempt_id`, `head_commit`, `base_commit` | el target. `base_commit` es la base observada al revisar |
| `verdict` | `accepted` · `rejected` |
| `status` | `active` (la vigente del Attempt; a lo sumo una, índice único) · `stale` (cambió el HEAD) · `superseded` (hubo otra después) |
| `observed_head`, `closed_at` | el HEAD que la dejó `stale`, y cuándo dejó de ser activa |

Las decisiones nuevas toman `max(id) + 1`, así siguen la numeración de las legacy. Una decisión con Attempt es de un
Attempt de su Task, y una revisión es una decisión `review` sobre el mismo Attempt (triggers).

## La puerta de integrar (`review_gate`)

Responde si se puede integrar el Attempt en un HEAD dado. Devuelve la revisión que lo autoriza, o el motivo:

| Motivo | Cuándo |
|---|---|
| `missing` | el Attempt no existe |
| `not_current_attempt` | hay un Attempt más reciente en la Task: hay que revisar ese (D8) |
| `no_review` | este Attempt no tiene revisión vigente |
| `rejected` | la última lo rechazó |
| `stale` | el HEAD cambió desde la aceptación |
| `head_moved` | se pide integrar un HEAD distinto del revisado |

Es la regla de hoy (`review::accepted_for`: la última revisión, aceptada y sobre el HEAD), pero por Attempt. La usará
la integración cuando el runtime use las tablas. No hay comando de merge nuevo.

## Quién puede

| Operación | Persona | Agente | Sistema |
|---|---|---|---|
| revisar (aceptar o rechazar) | sí | no | no |
| invalidar por HEAD movido | sí | no | sí |

## Events

Contrato en [`EVENTOS.md`](EVENTOS.md#review-targeting-lxo-118) y Activity en [`ACTIVITY.md`](ACTIVITY.md):

* `review.completed` (decision): `task`, `attempt`, `n`, `verdict`, `head_commit`, `base_commit?`, `supersedes?` y
  `has_comment`.
* `review.invalidated` (state): `task`, `attempt`, `n`, `head_commit` y `observed_head`.

La entidad es `review` (`entity_id` = id de la decisión) y el payload nombra el Attempt. Así la proyección de Attention
ve el target correcto (`la_proyeccion_de_attention_ve_cada_hecho_con_su_attempt`). Las reglas de Attention sobre el
modelo nuevo llegan con el runtime, como las de `attempt.*` (LXO-114). El comentario nunca viaja.

## Revisiones legacy migradas

El corte (LXO-117) mapea cada `Decision.kind = review` del documento a:

* **Attempt**: `<task>-a1`, porque en el legado cada Task tuvo un intento en el modelo.
* **HEAD y base**: `head_commit` y `base_commit` de su `detail_json`.
* **Estado**: la última revisión válida de cada Attempt queda `active`; las anteriores, `superseded`, con `closed_at`
  igual a la hora de la siguiente. Es el mismo criterio de hoy: integrar mira la última.
* **Ninguna `stale`**: el legado no registra cuándo cambió el HEAD. La invalidación la hará el runtime al observar la
  rama.

Sin `head_commit` o con un veredicto desconocido, la revisión va a `legacy_residue` (`review_without_target`). La
fixture grande del corte comprueba la sustitución.

## Decisiones (LXO-118)

| # | Decisión | Alternativa descartada |
|---|---|---|
| D34 | **A lo sumo una revisión activa por Attempt**: la nueva sustituye a la anterior, que queda en la historia | varias activas con «la última gana»: la puerta tendría que adivinar cuál vale |
| D35 | **`stale` es final**: reabrir es revisar otra vez sobre el HEAD nuevo | reactivar la vieja si el HEAD vuelve: una aceptación sobre un HEAD que se movió y volvió no es la misma revisión |
| D36 | **La puerta exige el Attempt actual** de la Task (ADR D8) | aceptar la de un intento anterior con el mismo commit |

## Fuera de este slice

UI de Review, Proof Pack, comando de merge nuevo, conectar la puerta a `integration.rs` y las reglas de Attention del
modelo nuevo (con el runtime).
