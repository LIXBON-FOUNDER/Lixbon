# Proof Pack y revisión por Attempt (LXO-147, épica F5)

Dos comandos para que una persona verifique la evidencia **antes** del diff y acepte o rechace **el HEAD exacto que vio**.

| | `attempt_proof_pack { attempt_id }` | `attempt_review { attempt_id, decision, head_commit, comment?, confirm }` |
|---|---|---|
| Qué es | lectura | decisión humana |
| Quién | Person autenticada | Person autenticada de Desktop o CLI (ni agentes) |
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
* La lectura del HEAD de Git y el registro en SQLite no son atómicos frente a un cambio externo concurrente. Si la rama avanza justo después
  de comprobarse, la decisión queda asociada al commit exacto recibido y el Proof Pack la marcará `stale` frente al HEAD nuevo.
* Un Attempt anterior de la Task no se decide (su rama es la del actual).
* No se probó con un proveedor real.

## Cliente de terminal: `lxo review` (LXO-162)

`lxo review <attempt_id> [--accept | --reject] [--comment TEXTO] [--open] [--json]` consulta
`attempt_proof_pack` por el RPC autenticado. Solo `--accept` o `--reject` envía una decisión; el
cliente no lee el diff local ni decide por la persona.

La Person CLI puede decidir únicamente mediante la capacidad RPC específica de `attempt_review`.
La base `cli_person.review` exige `confirm`; cada llamada vuelve a evaluar los overrides efectivos,
y `deny` o `elevated` bloquean la decisión. Las demás acciones `HumanDecision` continúan reservadas
a Desktop; no se amplía esa autorización genérica.

* Toda decisión queda precedida por una lectura nueva del Proof Pack. Si `decision.can_decide` es
  falso, se muestra el motivo y no se llama a `attempt_review`.
* El cliente pasa a `attempt_review.head_commit` exactamente
  `attempt_proof_pack.decision.head_commit`, junto a `confirm: true`. Si el Core responde
  `head_moved`, no reintenta: imprime el HEAD esperado y el encontrado, incluye el resultado
  estructurado y sale con `stale` (7). La persona vuelve a consultar y examina el nuevo Proof Pack.
* La salida humana etiqueta `verified`, `agent_reported` y `unknown`; incluye estado, objetivo,
  revisión, cambios y archivos, pruebas, artefactos, aceptación previa y lagunas. Los artefactos
  se identifican por tipo e id; su URI no se ejecuta ni se abre.
* `--json` usa el sobre estable `{ v: 1, proof_pack, review }`: `proof_pack` es la respuesta v1
  completa del Core y `review` es `null` en lectura o la respuesta completa de `attempt_review`.
  En `head_moved`, stdout contiene `{ ok: false, code: "stale", error, result }` y `result` es ese
  sobre. Los errores de validación/uso y autorización conservan el formato común de lxo por stderr.
* `--comment` se recorta y limita a 2000 caracteres; no se puede pasar sin una decisión. El Core
  no incluye el texto del comentario en el Event Log, pero la respuesta JSON de la decisión sí
  puede devolverlo.
* `--open` solo muestra el id del Attempt para abrirlo manualmente en Desktop. Esta versión no
  inicia la aplicación ni depende de un enlace profundo.
* Salidas: 0 correcto, 1 error interno, 2 uso/decisión no válida, 3 autenticación/permiso,
  4 versión/contrato, 5 Core no disponible, 6 Attempt inexistente, 7 HEAD movido.


LXO-237 añade el campo opcional compatible `coverage`: reparto, partes y archivos cubiertos/sin cubrir/solapados sobre un HEAD exacto. La aceptación con huecos exige `coverage_override_reason` explícito de una Person. Ver [REVIEW_SCOPE.md](REVIEW_SCOPE.md).
