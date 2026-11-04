# Integración de un Attempt revisado (LXO-148, épica F5)

Integrar es una decisión **distinta** de revisar: aceptar una revisión no es haber integrado. Dos comandos, ambos de una Person de Desktop:

| | `attempt_integration_preview { attempt_id }` | `attempt_integrate { attempt_id, action, head_commit, confirm, squash?, accept_moved_target? }` |
|---|---|---|
| Qué es | lectura | decisión humana con efecto externo |
| `action` | — | `merge` (git merge en el Project) · `publish_pr` (`git push` + `gh pr create`) |

Son una envoltura de `integration::{integrate, publish_pr}` —que ya separan la decisión del efecto y son idempotentes— con las guardas del Attempt.

## Qué se integra

Solo el **Attempt actual** de su Task y **terminado** (`integration_not_current` · `integration_not_final`), con la revisión **aceptada sobre el HEAD exacto**
que la persona ve:

1. `head_commit` tiene que ser el HEAD de la rama de ahora; si no, `outcome: head_moved` (`expected_commit`, `found_commit`) y no se hace nada.
2. La última revisión tiene que ser `accepted` sobre ese HEAD; si no, `outcome: review_required` (también para el PR). No hay salto por policy: LXO-209
   no existe todavía.

## Destino del merge

* Una **hija** se integra en el checkout de su padre, como siempre.
* Una **Task raíz con rama propia** (la que crea `task_create`, o un Fork) se integra en el **checkout del Project**, y solo si está en la **rama base con que
  nació** la Task. Si está en otra, `outcome: target_branch_mismatch` (`expected_branch`, `found_branch`) y no se toca nada.
* Si el destino se movió fuera de Lixbon, `outcome: target_moved` (se registra una decisión, no hay merge); solo se integra si la persona acepta exactamente el
  commit que vio (`accept_moved_target`).
* Con cambios sin commit en el checkout, el merge es un `error` del efecto y no se toca nada.

## Resultados (los del efecto, no excepciones)

`merge`: `merged` · `conflict` (con los archivos; git aborta el merge y el checkout queda limpio) · `error` · `target_moved` · `target_branch_mismatch` ·
`already_merged` (repetir no hace otro merge ni otra decisión). `publish_pr`: `created` · `already_exists` (por el PR registrado o porque `gh` lo dice) · `error`
(repetir no duplica; con un PR registrado ni se ejecuta `push` ni `gh`).

Cada efecto ejecutado deja `effect.observed` y su `decision.recorded` en UNA mutación; sin rutas ni textos de git en el log. Un conflicto levanta Attention
`conflict`; un merge posterior la resuelve. **Ninguna acción limpia el worktree** (eso es el Resource Manager, LXO-149).

## Vista previa

`attempt_integration_preview` devuelve, sin rutas: `revision.head_commit`, `review.state` (`none` · `accepted` · `stale` · `rejected`), `merge` (`merged`,
`result_commit`), `pr` (`url`, `has_remote`), `target` (`kind`, `branch`, `expected_branch`, `branch_matches`, `head`, `expected_head`, `moved`, `clean`) y
`can_merge` / `can_publish_pr` con su motivo (`not_current_attempt` · `not_final` · `no_branch` · `review_required` · `already_merged` · `already_exists` ·
`target_branch_mismatch` · `target_unavailable` · `checkout_dirty` · `no_remote`).

## Invariantes de la issue y cómo se prueban (`integration_attempt_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | No integrar una revisión distinta a la revisada | `sin_revision_aceptada_o_con_una_stale_…` |
| 2 | Conflict/error son efectos observados | `un_conflicto_es_el_resultado_del_efecto_…`, `un_checkout_sucio_…` |
| 3 | Aceptar ≠ integrar | `la_vista_previa_…`, `integrar_la_revision_aceptada_…` |
| 4 | Un reintento no duplica merge ni PR | `integrar_la_revision_aceptada_…`, `publicar_un_pr_…` |
| 5 | El payload del efecto no lleva rutas | `integrar_la_revision_aceptada_…` |
| — | Merge success / conflict / error / target moved | las anteriores y `un_destino_movido_…` |
| — | PR created / already exists / error | `publicar_un_pr_…`, `un_pr_que_gh_dice_que_ya_existe_…` |
| — | Decision + Effect | `integrar_la_revision_aceptada_…` |
| — | Guardas y actor | `solo_una_persona_integra_…` |

## Límites conocidos

* Sin policy: no hay forma de integrar sin revisión aceptada (ni se debe todavía).
* `attempt.integrated` no se emite en este camino (el estado de «integrado» sale de la decisión `merge`); alinear ambos queda para el Resource Manager.
* El PR usa `gh` y el remoto `origin`; no se probó contra GitHub (las pruebas usan un `gh` simulado y un remoto local).
* Un error de `gh` no se reintenta solo; la persona repite la acción.
