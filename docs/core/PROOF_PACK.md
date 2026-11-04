# Proof Pack y revisión por Attempt (LXO-147, épica F5)

Dos comandos para que una persona verifique la evidencia **antes** del diff y acepte o rechace **el HEAD exacto que vio**.

| | `attempt_proof_pack { attempt_id }` | `attempt_review { attempt_id, decision, head_commit, comment?, confirm }` |
|---|---|---|
| Qué es | lectura | decisión humana |
| Quién | Person de Desktop | Person de Desktop (ni agentes ni CLI) |
| Efecto | ninguno | `decision.recorded` (`review`) sobre la Task; nada más |

## Proof Pack

Usa la misma procedencia que Compare ([COMPARE.md](COMPARE.md)): `verified` (lo calculó o registró el Core) · `agent_reported` (lo declaró el
agente) · `unknown` (sin dato, con motivo, nunca un cero). Trae `status`, `objective`, `revision` (base y HEAD), `changes` (archivos y
sumas, acotados a 200), `summary` (agente, recortado), `artifacts` (agente), `tests` (siempre `unknown`: `not_collected`), `acceptance` y
`decision`.

* **El HEAD que se enseña es el vivo** de la rama (si el Attempt es el actual): es sobre el que se decide. Una revisión ya hecha no lo
  congela.
* **`acceptance`**: `none` · `accepted` (de este HEAD) · `stale` (se aceptó otro HEAD y la rama se movió) · `rejected`, con `decided_head`
  y `head_matches`. La decisión más reciente de la Task es la que cuenta, no cualquier `accepted` anterior.
* **`decision`**: `{ can_decide: true, head_commit }` o `{ can_decide: false, reason }` con `pending_approval` · `not_current_attempt` ·
  `not_final` · `no_revision`. El `head_commit` es exactamente el que debe viajar a `attempt_review`.
* **`completeness`**: `complete` si lo imprescindible para decidir (revisión y cambios) está comprobado; `partial` si no. `gaps` lista
  siempre lo que falta, también cuando es `complete` (hoy siempre incluye `tests`).

## Decidir

`attempt_review` solo acepta el **Attempt actual** de su Task (la rama es la suya: `review_not_current`) y **terminado** (`review_not_final`:
aceptar un trabajo en marcha sería aceptar un HEAD que va a cambiar). Exige `confirm: true`. Delega en la revisión de la Task:

* Si la rama sigue en `head_commit`, registra la decisión → `{ outcome: "recorded", … }`.
* Si se movió, **no registra nada** → `{ outcome: "head_moved", expected_commit, found_commit }`. El Proof Pack ofrece entonces el HEAD nuevo.

## Invariantes de la issue y cómo se prueban (`proof_pack_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | Accept solo para la revisión exacta revisada | `si_la_rama_se_mueve_antes_de_aceptar_…`, `aceptar_el_head_exacto_…` |
| 2 | Evidence `verified` solo si comprobada | `un_proof_pack_completo_separa_lo_comprobado_…` (el resumen del agente no verifica las pruebas) |
| 3 | Review ≠ Integration | `aceptar_el_head_exacto_…` (sin `attempt.integrated`) |
| 4 | El comentario no se copia al Event Log | `rechazar_no_borra_…` (el evento solo trae `has_comment`) |
| 5 | Rechazar no borra Attempt ni worktree | `rechazar_no_borra_…` |
| — | Proof Pack completo / parcial | `un_proof_pack_completo_…`, `un_proof_pack_parcial_…` |
| — | Head moved antes de aceptar y aceptación stale | `si_la_rama_se_mueve_antes_de_aceptar_…` |
| — | Guardas | `solo_se_decide_sobre_el_attempt_actual_…`, `un_attempt_en_marcha_…` |

## Attention

`review_ready` se levanta con `task.review_requested`, se resuelve al decidir (`acted`) y se supera con un seguimiento (`condition_cleared`)
([ATTENTION.md](ATTENTION.md)). **No hay reapertura automática cuando la rama se mueve después de aceptar:** no existe un evento que la
origine (la rama la mueve git, no el Core). Lo que sí hay es que el Proof Pack marca la aceptación como `stale` y que `attempt_review` /
la integración exigen el HEAD exacto. Queda como límite conocido.

## Límites conocidos

* Sin resultados de pruebas ni verificación de hashes de artefactos. Sin capturas de pantalla como locators.
* Sin reapertura de Attention por HEAD movido (ver arriba).
* Un Attempt anterior de la Task no se decide (su rama es la del actual).
* No se probó con un proveedor real.
