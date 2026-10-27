# Runtime sobre las tablas Task/Attempt (LXO-232)

Estado: **implementado y probado; se usa en una base ya cortada**. El arranque corta la base con el interruptor de
dogfood `LIXBON_AGENTIC_CUT=1` (LXO-234, [Activación](CORTE_EJECUCION.md#activación)). Sin cortar, el runtime sigue
con `legacy_state` y el espejo `state.json` exactamente como antes.

Mapeo del legado y decisiones: la [ADR de LXO-112](CORTE_TASK_ATTEMPT.md). Ejecución del corte: [CORTE_EJECUCION.md](CORTE_EJECUCION.md).

Piezas:

* Almacén: `store/runtime.rs`.
  * `Store::runtime_commit_recorded`: la transacción de cada mutación.
  * `Store::runtime_load`: el estado reconstruido al arrancar.
  * Las filas las escriben sus módulos dueños con piezas `runtime_*_in` sin evento propio (`tasks.rs`, `attempts.rs`,
    `worktrees.rs`, `sessions.rs` y `reviews.rs`): cada tabla sigue teniendo un solo escritor.
* Migración: [`013_runtime_tables.sql`](../../apps/desktop/src-tauri/src/store/migrations/013_runtime_tables.sql), con
  los huecos que el runtime necesita ([§ La 013](#la-013)).
* Core: `orch/store_boot.rs` (`TablesPersistence`, `load_from_tables`), `orch/boot_authority.rs` (arranque) y
  `orch/agentic_cut.rs` (`verify_runtime_view`).
* Pruebas: `orch/runtime_tables_tests.rs` (E2E con el Core real, caída a mitad y casos del mapeo).

## Enfoque

El `State` en memoria sigue siendo la copia de trabajo: el runtime no se reescribe. Cambia de dónde se escribe y de
dónde se lee.

```text
Core::mutate(candidato)
  TablesPersistence::persist(candidato, eventos)
    documento confirmado (antes)  vs  candidato (después)
    Store::runtime_commit_recorded  ── BEGIN IMMEDIATE
      runs nuevos → Tasks (padres primero) → por Task: fila, Attempt (o seguimiento n + 1), Worktree, sesión, fases,
      transición, Artifacts, integración → Tasks retiradas (se descartan) → runs → mensajes → decisiones y revisiones
      → bloqueos de entorno → meta.id_seq → meta.runtime_rev → eventos (+ Attention)
      verify: la vista legacy (`legacy_task_v1`) de lo que cambió == candidato (salvo D3)
    COMMIT  ── o ROLLBACK de todo
  memoria = candidato
```

* **Escritura:** cada mutación compara el documento confirmado con el candidato y traduce las diferencias a las tablas,
  en la misma transacción que sus eventos. Nada escribe `legacy_state`: está congelado desde el corte.
* **Arranque:** con la base cortada, el estado se reconstruye con la vista `legacy_task_v1` (`CutView`, la misma que
  valida el corte). Las Tasks retiradas, su Run, sus mensajes y sus decisiones no aparecen.
* **Fin del espejo:** `state.json` deja de escribirse (ADR D4). El archivo de antes del corte se queda donde estaba.
* **Huérfanos (paso 6 de la ADR §9):** al arrancar, los Attempts que no son externos ni finales pasan a `exited` con
  `close_orphans`. Es lo que ya hacía `orphan_all`, ahora persistido como transición del Attempt.
* **Revisión:** `meta.runtime_rev` empieza en la `rev` congelada por el corte y sube en cada COMMIT. Los eventos de un
  COMMIT la llevan en `state_rev`, igual que llevaban la `rev` de `legacy_state`.

## Mapeo de cada cambio

| Cambio del runtime | En las tablas |
|---|---|
| `run_create` | `runs` (abierto) + Task raíz + Attempt `n = 1` |
| `spawn` / `create_child` | Task + Attempt `n = 1` `starting`, con la selección (agente, modelo, esfuerzo, rol, perfil) |
| Registro del worktree | `worktrees` (`created`, `active`, máquina = `meta.machine_id`) + `attempts.worktree_id` |
| Estado (`running`, `ask`, `reply`, terminal, `done`, `failed`, `close`) | Transición del Attempt. De una espera a otra pasa por `running` (el ciclo de vida no tiene ese par) |
| `lxo continue` (`reopen`) | Attempt `n + 1`. El anterior no se reabre. `instruction` = el bloque «Seguimiento», reutiliza el Worktree activo (D7) y la misma sesión si el proveedor la vuelve a declarar |
| Sesión declarada (Claude stream-json, Codex `session_id`) | `provider_sessions` `open`, o `idle` si su Attempt ya terminó, + `attempts.provider_session_id`. Al terminar el Attempt pasa a `idle` |
| Sesión por carpeta y hora (`cwd_time`) | No es un vínculo (D3): ni sesión ni referencia, y `model_source = unknown`, como en el corte |
| `report`, `pr_url`, ruta de `codex exec -o` | `artifacts` (`report`, `pull_request`, `last_message`). Uno nuevo sustituye al anterior en la vista; el informe es del Attempt actual, el PR y la ruta son de la Task |
| `phase` | `attempt_phases` del Attempt actual. La vista concatena las de todos los Attempts, como el documento |
| `review` | `decisions` + `reviews` sobre (Attempt actual, `head_commit`). La anterior activa de ese Attempt pasa a `superseded` |
| `integrate` (`merged`) | `decisions` + `attempts.integrated = 1`. Vale también para un final que no es `done` (013) |
| `release` | Worktree `removed` (`integrated` o `discarded`) con la rama si se conserva. Si `git branch -d` la borra después, `branch_kept = 0` (013). La Task vuelve a su repositorio; el Attempt conserva dónde corrió |
| Mensajes | `thread_messages` del Thread de la Task más profunda, con el id del documento. Se atribuyen al Attempt actual del emisor, salvo una nota a sí misma. Marcar leído es lo único que cambia |
| `remove_run`, limpieza de un lanzamiento fallido | La Task se **descarta** (`intent = discarded`) tras parar su Attempt activo (D24). La historia se conserva y no vuelve al cargar |
| Bloqueos de entorno | `env_blocks` |
| `seq` | `meta.id_seq` (nunca retrocede) |

**Decisiones e ids.** Las decisiones son historia: las de una Task retirada se quedan en la tabla. Al cargar,
`State.decision_floor` toma el mayor id de la base y una decisión nueva va por encima, así que no se reutiliza un id.

**Lo que no se representa** se rechaza: la mutación entera, con sus eventos, se deshace (`StoreError::RuntimeMapping`).
El Core recibe `MutateError::Rejected` y **sigue sano**, porque la memoria no cambió. Por ejemplo:

* cambiar la selección o la identidad de un Attempt;
* mover una Task de Run, padre o repositorio;
* cambiar el Project ya fijado o usar uno que no está en el registro;
* modificar una decisión o un mensaje;
* retirar un Artifact;
* reabrir un Run cerrado.

**Origen de las filas.** El runtime escribe filas `core`, con dos excepciones:

* Una Task sin Project o sin título queda `legacy`, como las del corte (ADR D1), porque las reglas de forma del Core no
  se le pueden imponer.
* Una rama y una base sin carpeta conocida se guardan como un Worktree `legacy` ya quitado, igual que lo importa el corte.

**Summary.** El resultado mínimo del Attempt admite como mucho 2000 caracteres. `lxo done --summary` rechaza uno más largo
y pide llevar el detalle al informe.

## La 013

| Hueco | Antes (012) | 013 |
|---|---|---|
| Arranque del proceso | Solo `started_at`, que también es «pasó a `running`» | `attempts.launched_at`. En las filas del corte el arranque sigue en `started_at` |
| Observación tardía | Un final no admitía ningún cambio salvo integrar uno `done` | Un final admite fijar el modelo efectivo, su procedencia y la sesión (una vez): Codex los declara al leer el rollout tras salir. Un `UPDATE` que no cambia nada de eso sigue rechazado |
| Integrar | Solo un `done` | Cualquier final: se integra la rama de una tarea fallida, parada o sin informe. El mutador vNext (`attempt_integrate_recorded`) sigue exigiendo `done` |
| Sesión tardía | Nacía `open`, con su Attempt activo | Nace `idle` si su Attempt ya terminó |
| Rama borrada después | Un Worktree quitado no cambiaba | Puede pasar de conservar la rama a no conservarla |
| `last_message` | Un Artifact exigía un Attempt arrancado | La ruta de `codex exec -o` se declara al lanzar, con el Attempt `starting` |

## Invariantes y cómo se prueban

| # | Invariante (LXO-232) | Cómo | Prueba |
|---|---|---|---|
| 1 | Una sola autoridad: tras el corte nada escribe `legacy_state` ni `state.json` | `TablesPersistence` no tiene espejo; `legacy_state` congelado por triggers | `tras_el_corte_el_runtime_persiste_en_las_tablas_…` (la `rev` y los bytes no cambian) |
| 2 | Estado y evento atómicos | Filas, eventos, su Attention y `runtime_rev` en una transacción | `una_caida_a_mitad_de_una_mutacion_…` (`runtime_in_tx`, `runtime_events_in_tx`) |
| 3 | Las lecturas F2 responden igual | El runtime en memoria es el mismo `State`; tras reiniciar, la vista reconstruye exactamente lo confirmado | `…un_reinicio_carga_lo_mismo` y el resto de `runtime_tables_tests` comparan el estado antes y después del reinicio |
| — | Lo que no se representa no se confirma | `verify_runtime_view` compara la vista con el candidato dentro de la transacción | `una_mutacion_que_las_tablas_no_representan_…` |
| — | Huérfanos a `exited`, los externos no | `close_orphans` al arrancar | `al_arrancar_los_attempts_huerfanos_…` |

**Barrido de la suite.** `LIXBON_AGENTIC_CUT=1 cargo test --lib orch::` (el interruptor de dogfood de LXO-234) corta la
base en cada arranque de las pruebas y pasa la suite del Core por este runtime. Los fallos que deja son esperables en ese modo:

* pruebas que leen `legacy_state` o el espejo, o cuentan el evento `core.agentic_cut`;
* estados fabricados a mano que ningún flujo produce, como un Project inexistente o cambiar el agente de una Task;
* `migration_gate_tests`, que simulan un binario que solo conoce hasta la 003: el corte no corre sobre una base que no
  está en la versión anterior a él y bloquea el arranque, como debe.

No queda ningún error de mapeo en los flujos reales.

## Hechos de ejecución (LXO-233)

Con esta persistencia, el `Tx` emite los cambios de estado de ejecución como `attempt.*` del Attempt actual, en lugar
de `task.status_changed` (ADR D9). `State.attempt_n` lleva el número del Attempt actual de cada Task: lo carga el
arranque desde las tablas y lo avanza un seguimiento. Contrato: [EVENTOS.md](EVENTOS.md#runtime-sobre-las-tablas-lxo-233).
Attention: [ATTENTION.md](ATTENTION.md). Pruebas: `orch/attempt_events_tests.rs`.

## Fuera de este slice

* Activar el corte al arrancar, el interruptor de dogfood y `lxo core restore` (LXO-234).
