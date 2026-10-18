# Inventario de mutation testing manual de LXO-88

No hay `cargo-mutants` en el repo ni en la CI. La disciplina es la histórica del repositorio (`proctable.rs`, mutantes
`m0N`): cada mutante se aplica a mano sobre el código de producción **uno a uno**, se ejecuta un subconjunto de pruebas, se
registra si alguna falla (muerto) o no (superviviente) y el archivo se **restaura byte a byte** antes del siguiente. Un mutante
cuyo texto original ya no existe en el código es **no aplicable** y se cuenta aparte: nunca como muerto.

Este documento tiene DOS rondas con evidencia distinta; no se mezclan ni se heredan resultados entre ellas:

| Ronda | Árbol sobre el que se ejecutó | Mutantes | Dónde |
|---|---|---|---|
| **1** | contenido idéntico al commit `1480b9d` (verificado en la ronda 2; **no** `cee685b`) | 71 | secciones «Resumen», «Supervivientes»… y «Muertos» |
| **2** | HEAD exacto `cee685b76d5a2787bb5ad662fb274999a25c899b` | 35 nuevos + re-ejecución de los 71 | «Ronda 2» al final |

## Ronda 1 (árbol de `1480b9d`)

Cubre el motor (create/resolve/dedupe/orden), los writers, el camino de `spawn` y las reglas y productores de `review_ready` y
`environment_blocked` **tal como eran en `1480b9d`**. Comando por mutante:
`cargo test --locked --lib -- attention spawn_blocked proyector cada_bloqueo`.

## Resumen

| Resultado | Cantidad |
|---|---|
| Muertos | 71 |
| Supervivientes | 0 |
| No aplicables (el texto original ya no existe) | 0 |
| Errores de compilación | 0 |
| **Total** | **71** |

**Restauración:** tras cada mutante el archivo se reescribe con su contenido original; al terminar la ronda el árbol `src/` es idéntico (`diff -rq`) a la copia tomada antes de empezar, y el diff estable no contiene ningún mutante.

## Supervivientes

Ninguno.

## No aplicables

Ninguno.

## Errores de compilación

Ninguno.

## Muertos

| Id | Grupo | Archivo | Mutante | Pruebas que lo matan |
|---|---|---|---|---|
| `m01` | create/dedupe | `store/attention_projection.rs` | create/update: la señal con el mismo seq ya no es antigua | `duplicados_y_reintentos_no_duplican_items`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_replay_desde_cero_de_estas_dos_categorias_es_el_estado_incremental` (+3 más) |
| `m02` | resolve | `store/attention_projection.rs` | resolve: la señal con el mismo seq ya no es antigua | `una_resolucion_con_el_mismo_seq_que_la_ultima_senal_del_hecho_se_descarta_y_una_posterior_resuelve` |
| `m03` | create/dedupe | `store/attention_projection.rs` | dedupe: una activa se trata como una resuelta (no actualiza) | `conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar`, `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad`, `failed_recurre_como_otra_ocurrencia_y_el_task_removed_resuelve` (+4 más) |
| `m04` | create/dedupe | `store/attention_projection.rs` | create: no emite attention.created | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar` (+17 más) |
| `m05` | resolve | `store/attention_projection.rs` | resolve: no emite attention.resolved | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event` (+5 más) |
| `m06` | resolve | `store/attention_projection.rs` | resolve: una resuelta ya no es no-op | `resolver_es_idempotente_y_no_reescribe_la_resolucion`, `review_ready_y_environment_blocked_son_idempotentes_y_deduplican` |
| `m07` | orden | `store/attention_projection.rs` | orden: acepta seq repetido | `un_tramo_fuera_de_orden_se_rechaza_entero_y_no_escribe` |
| `m08` | orden | `store/attention_projection.rs` | marca de agua: reaplica el seq de la marca | `duplicados_y_reintentos_no_duplican_items` |
| `m09` | resolve | `store/attention_projection.rs` | resolve: at sin proteger de created_at | `un_tramo_fuera_de_orden_se_rechaza_entero_y_no_escribe` |
| `m10` | create/dedupe | `store/attention_projection.rs` | update: no actualiza la severidad | `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad` |
| `m11` | orden | `store/attention_projection.rs` | no guarda event_seq | `duplicados_y_reintentos_no_duplican_items`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad` (+7 más) |
| `m12` | resolve | `store/attention_projection.rs` | resolve: fingerprint sin subject | `approval_en_terminal_failed_y_conflict_salen_de_los_mutadores_reales`, `approval_en_terminal_se_resuelve_segun_como_se_sale_de_la_espera`, `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids` (+12 más) |
| `m13` | writers | `store/attention_projection.rs` | proyector: marca de agua máxima (no aplica nada) | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+21 más) |
| `m14` | resolve | `orch/attention_rules.rs` | task.reply: resuelve otro hecho | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event`, `question_se_levanta_con_la_pregunta_y_se_resuelve_con_la_respuesta` (+3 más) |
| `m15` | risk | `orch/attention_rules.rs` | risk también desde unverified | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `approval_de_un_lanzamiento_pendiente_se_resuelve_al_decidirlo`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+5 más) |
| `m16` | resolve | `orch/attention_rules.rs` | spawn.resolved timeout: acted | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `el_writer_de_resoluciones_standalone_resuelve_el_approval` |
| `m17` | create/dedupe | `orch/attention_rules.rs` | failed: levanta con otro estado | `approval_en_terminal_failed_y_conflict_salen_de_los_mutadores_reales`, `environment_blocked_es_distinto_de_failed_y_solo_lo_levanta_su_event`, `failed_recurre_como_otra_ocurrencia_y_el_task_removed_resuelve` (+5 más) |
| `m18` | resolve | `orch/attention_rules.rs` | merged no resuelve el conflicto | `conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar` |
| `m19` | create/dedupe | `orch/attention_rules.rs` | unverified no levanta approval | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `approval_de_un_lanzamiento_pendiente_se_resuelve_al_decidirlo`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+2 más) |
| `m20` | spawn | `orch/spawn_approval.rs` | persist-before-deny: ignora el fallo de persistencia | `si_la_proyeccion_falla_record_facts_deshace_el_event_y_no_se_devuelve_denegacion`, `sin_persistencia_la_respuesta_es_el_fallo_de_persistencia_y_no_una_denegacion` |
| `m21` | spawn | `orch/spawn_approval.rs` | la denegación crea pendiente y efectos | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+6 más) |
| `m22` | spawn | `orch/agents.rs` | explicit_denial: cualquier bloqueo es explícito | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_replay_desde_cero_de_estas_dos_categorias_es_el_estado_incremental` (+13 más) |
| `m23` | spawn | `orch/agents.rs` | explicit_denial: no exige solicitud válida | `explicit_denial_respeta_la_precedencia_de_evaluate_sin_leer_el_motivo`, `solo_el_perfil_deshabilitado_es_una_denegacion_explicita_y_se_decide_por_tipos` |
| `m24` | spawn | `orch/agents.rs` | check_request: no valida el rol | `check_request_conserva_la_validacion_de_entrada_que_hacia_launch` |
| `m25` | spawn | `orch/agents.rs` | check_request: no valida proveedor x perfil | `check_request_conserva_la_validacion_de_entrada_que_hacia_launch`, `una_entrada_invalida_es_un_error_y_no_se_registra_como_denegada_por_policy` |
| `m26` | writers | `store/events.rs` | writer: no proyecta | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+27 más) |
| `m27` | writers | `store/events.rs` | append_events sin proyector | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_replay_desde_cero_de_estas_dos_categorias_es_el_estado_incremental` (+10 más) |
| `m28` | writers | `store/authority.rs` | commit_authoritative sin proyector | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log` (+17 más) |
| `m29` | writers | `store/projects.rs` | project_register sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m30` | writers | `store/projects.rs` | project_join sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m31` | writers | `store/projects.rs` | project_relocate sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m32` | writers | `store/projects.rs` | project_archive sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector`, `los_tres_writers_pasan_por_el_proyector_y_el_de_projects_no_levanta_nada`, `si_la_proyeccion_falla_el_writer_de_projects_deshace_el_cambio` |
| `m33` | writers | `store/events.rs` | los attention.* no heredan el state_rev del commit origen | `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event`, `solo_una_comprobacion_positiva_y_verificada_levanta_el_bloqueo`, `un_bloqueo_tipado_del_entorno_levanta_environment_blocked_sin_ser_un_fallo_ni_un_riesgo` |
| `r01` | review_ready · productor | `orch/tx_ops.rs` | review_requested también con entrega fallida (guarda failed) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r02` | review_ready · productor | `orch/tx_ops.rs` | review_requested también para la raíz (guarda root) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r03` | review_ready · productor | `orch/tx_ops.rs` | review_requested sin exigir rama propia (guarda shared) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r04` | review_ready · productor | `orch/tx_ops.rs` | la entrega correcta no emite review_requested | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `retirar_la_task_resuelve_su_review_ready` (+1 más) |
| `r05` | review_ready · productor | `orch/tx_ops.rs` | la entrega no emite task.status_changed (orden/causalidad) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done`, `una_entrega_correcta_con_padre_y_rama_emite_review_requested_y_levanta_review_ready` |
| `r06` | review_ready · productor | `orch/event_kinds.rs` | review_requested con otra entidad | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `retirar_la_task_resuelve_su_review_ready` (+1 más) |
| `r07` | review_ready · regla | `orch/attention_rules.rs` | review_requested levanta otra categoría | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` (+3 más) |
| `r08` | review_ready · regla | `orch/attention_rules.rs` | review_requested con otro destino | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_senales_fuente_fuera_de_orden_se_descartan_por_seq` (+2 más) |
| `r09` | review_ready · resolución | `orch/attention_rules.rs` | rechazar la revisión no resuelve | `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas`, `review_ready_y_environment_blocked_son_idempotentes_y_deduplican` |
| `r10` | review_ready · resolución | `orch/attention_rules.rs` | aceptar la revisión no resuelve | `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas`, `las_senales_fuente_fuera_de_orden_se_descartan_por_seq` (+1 más) |
| `r11` | review_ready · resolución | `orch/attention_rules.rs` | reabrir no supera la revisión | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `r12` | review_ready · resolución | `orch/attention_rules.rs` | merged no resuelve review_ready | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `r13` | review_ready · resolución | `orch/attention_rules.rs` | task.removed no resuelve review_ready | `retirar_la_task_resuelve_su_review_ready` |
| `r14` | review_ready · resolución | `orch/attention_rules.rs` | reabrir resuelve como acted | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `e01` | environment · dedupe | `orch/state.rs` | environment.blocked se re-emite con la misma causa | `repetir_la_misma_comprobacion_no_emite_y_una_causa_que_demuestra_la_anterior_son_dos_hechos`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior` |
| `e02` | environment · causa | `orch/tx_ops.rs` | un cambio de causa no emite cleared de la anterior | `repetir_la_misma_comprobacion_no_emite_y_una_causa_que_demuestra_la_anterior_son_dos_hechos` (ver la nota posterior: ya no hay `cleared` por cambio de causa, solo por prueba positiva) |
| `e03` | environment · clear | `orch/tx_ops.rs` | la verificación positiva no emite cleared | `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `la_aprobacion_vuelve_a_comprobar_el_entorno_y_deja_constancia`, `solo_una_comprobacion_positiva_y_verificada_levanta_el_bloqueo` (+1 más) |
| `e04` | environment · alcance | `orch/state.rs` | verificar un perfil levanta los bloqueos de todos los perfiles | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` |
| `e05` | environment · alcance | `orch/state.rs` | cli_missing deja de ser de todo el proveedor | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` |
| `e06` | environment · clear | `orch/spawn_approval.rs` | una policy no verificada levanta el bloqueo | `solo_una_comprobacion_positiva_y_verificada_levanta_el_bloqueo` |
| `e07` | environment · legacy | `orch/spawn_approval.rs` | se marca un bloqueo sin Event Log | `sin_event_log_no_se_marca_ningun_bloqueo_de_entorno` |
| `e08` | environment · alcance | `orch/spawn_approval.rs` | el bloqueo se registra en otro perfil | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` |
| `e09` | environment · carrera | `orch/spawn_approval.rs` | resolver+observar sin serializar (carrera de frescura) | `una_observacion_vieja_no_se_aplica_despues_de_una_mas_nueva` |
| `e10` | environment · callsite | `orch/spawn_approval.rs` | spawn_request no observa el entorno | `con_el_core_en_solo_lectura_no_se_muta_env_blocks`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+7 más) |
| `e11` | environment · callsite | `orch/spawn_approval.rs` | approve_spawn no observa el entorno | `la_aprobacion_vuelve_a_comprobar_el_entorno_y_deja_constancia`, `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e12` | environment · callsite | `orch/spawn_approval.rs` | el recheck de lanzamiento (fake_launch) no observa el entorno | `el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo`, `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e13` | environment · callsite | `orch/spawn.rs` | el recheck de launch real no observa el entorno | `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e14` | environment · causa | `orch/agents.rs` | CLI ausente sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada` |
| `e15` | environment · causa | `orch/agents.rs` | la ruta inservible cuenta como entorno del proveedor | `cada_bloqueo_lleva_su_causa_tipada`, `un_perfil_deshabilitado_en_una_ruta_inservible_es_un_bloqueo_del_entorno_y_no_deja_event_ni_risk` |
| `e16` | environment · causa | `orch/agents.rs` | flags no soportados sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada` |
| `e17` | environment · causa | `orch/agents.rs` | sandbox elevado sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada` |
| `e18` | environment · regla | `orch/attention_rules.rs` | environment.blocked sin perfil en su identidad | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `environment_blocked_es_distinto_de_failed_y_solo_lo_levanta_su_event` (+7 más) |
| `e19` | environment · regla | `orch/attention_rules.rs` | cleared resuelve otro hecho | `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `environment_blocked_es_distinto_de_failed_y_solo_lo_levanta_su_event`, `la_aprobacion_vuelve_a_comprobar_el_entorno_y_deja_constancia` (+5 más) |
| `e20` | environment · regla | `orch/attention_rules.rs` | perfil desconocido aceptado | `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` |
| `e21` | environment · regla | `orch/attention_rules.rs` | código fuera del conjunto cerrado aceptado | `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` |
| `e22` | environment · regla | `orch/attention_rules.rs` | environment.blocked con otra entidad | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo` (+9 más) |
| `e23` | environment · productor | `orch/event_kinds.rs` | environment.blocked con otra entidad (productor) | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo` (+5 más) |
| `e24` | environment · regla | `orch/attention_rules.rs` | environment.blocked levanta failed | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo` (+8 más) |

## Historia de las rondas intermedias (explicada, no contada)

Durante el desarrollo hubo rondas intermedias sobre árboles anteriores; se explican para que nadie las cuente como evidencia
del árbol final:

* **No aplicables por patrón obsoleto del arnés:** en una ronda intermedia `m18` («merged no resuelve el conflicto»), `m23`
  («explicit_denial: no exige solicitud válida») y `m26` («writer: no proyecta») aparecieron como *no aplicables* (0
  coincidencias) porque el código ya había cambiado (`merged` resuelve ahora también `review_ready`; `explicit_denial` recibe
  el worktree; el writer propaga `state_rev`). No son muertos ni revelan una aceptación sin cubrir: el sitio de mutación
  existe, y en esta ronda sus patrones están actualizados y mueren (`m18`, `m23`, `m26`).
* **Superviviente `n01` (guarda `if ok` de `Tx::done`):** era un mutante *equivalente*, no un defecto del productor. `done(ok =
  false)` deja la Task en `Failed`, así que la guarda `if ok` era redundante con `status == Done`. Se eliminó la guarda
  redundante (el estado `Done` es la guarda) y el mutante equivalente pasó a ser `r01` (quitar el filtro `Done`), que muere con
  `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` (entrega fallida: no hay
  `task.review_requested`).
* **Superviviente `m02` (guarda de resolución con el mismo `seq`):** equivalente con las reglas actuales; se mató con una prueba de
  reglas inyectadas (`una_resolucion_con_el_mismo_seq_que_la_ultima_senal_del_hecho…`).

## Ronda 2 — delta posterior a `cee685b` (evidencia NUEVA, no heredada de la ronda 1)

**Procedencia y SHAs.** La ronda 1 de arriba (71 mutantes) se ejecutó sobre un árbol de contenido idéntico al del commit
`1480b9d` (verificado con `git archive 1480b9d` frente a la copia de `src/` tomada entonces; solo difieren finales de línea en
un archivo de pruebas) y **no** sobre `cee685b`. Esta ronda 2 se ejecutó sobre el HEAD exacto
`cee685b76d5a2787bb5ad662fb274999a25c899b` (padre `b3324963e8624fe591d42b47708fe1d87507adb3`), con el árbol limpio al empezar. Entre
`1480b9d` y `cee685b` hay tres commits (`1773eb0`, `b332496`, `cee685b`). Los resultados de la ronda 1 **no se cuentan** como
evidencia de `cee685b`: el inventario completo se volvió a ejecutar aquí.

**Qué cambió desde `1480b9d` (`git diff 1480b9d cee685b`).** Código de producción: `orch/agents.rs` (`EnvProof`,
`sandbox_proves_not_elevated`, la evidencia que lleva cada `Policy` bloqueada o no), `orch/state.rs` (`env_blocks` pasa a un
CONJUNTO de causas por alcance, `set_env_block -> bool`, `verify_env(proof)`, lectura del formato anterior), `orch/tx_ops.rs`
(`environment_blocked` suma sin emitir `cleared`; `environment_verified(proof)`), `orch/spawn_approval.rs` (`observe_environment` por
`Policy.env_proof`, no por `status`) y comentarios en `orch/event_kinds.rs`. **No cambiaron** el driver de la proyección
(`store/attention_projection.rs`), las reglas (`orch/attention_rules.rs`), `store/events.rs`/`authority.rs`/`projects.rs` ni
`Tx::done`: el comportamiento de create/resolve/dedupe de la proyección y de `review_ready` es el mismo. **Sí cambió** el
comportamiento de create/resolve/dedupe de `environment_blocked` en el productor: (create) una causa nueva se suma en lugar de
reemplazar; (resolve) `environment.cleared` solo con prueba positiva de ESA causa; (dedupe) la misma causa en el mismo alcance no
se re-emite. Por eso se re-ejecutó el inventario entero (no solo el subconjunto de `environment`) y se añadió el delta.

**Comandos exactos** (desde `apps/desktop/src-tauri`, un mutante cada vez; el arnés escribe el mutante con los finales de línea
del archivo y restaura los BYTES originales en `finally`):

```text
python mutate3.py <salida>.json check delta        # cada patrón aplica exactamente una vez
python mutate3.py <salida>.json run delta          # 35 mutantes nuevos
python mutate3.py <salida>.json run inventario     # los 71 de la ronda 1, contra cee685b
cargo test --locked --lib -- attention spawn_blocked proyector cada_bloqueo agents::tests events_tests   # por mutante
cargo test --locked --lib -- attention spawn_blocked proyector cada_bloqueo agents::tests events_tests env_proof_any un_alcance_vacio observe_environment_no   # re-ejecución de los 4 supervivientes
```

**Restauración verificada.** Antes de empezar se guardó `sha256sum` de todos los archivos de `src/`; tras cada ronda
`find src -type f | sort | xargs sha256sum | diff - <referencia>` no muestra diferencias y `git status --short` queda vacío salvo
las pruebas de regresión añadidas en esta misma ronda. Una primera ejecución se interrumpió a mano (un patrón multilínea no
casaba con los finales de línea CRLF del repositorio); se detuvo, se restauró `agents.rs` con `git checkout`, se comprobó el hash
y se repitió COMPLETA con el arnés corregido: lo que sigue procede de esa ejecución completa.

### Resumen de la ronda 2

| Grupo | Muertos | Supervivientes | No aplicables | Total |
|---|---|---|---|---|
| Delta nuevo (`d01`–`d35`), primera ejecución | 31 | 4 | 0 | 35 |
| Delta: los 4 supervivientes tras añadir su regresión | 4 | 0 | 0 | 4 |
| Inventario previo (71) re-ejecutado contra `cee685b` | 66 | 0 | 5 | 71 |

**Ningún mutante de esta ronda se cuenta como detectado sin una prueba que falle.** Los no aplicables se cuentan aparte.

### Delta nuevo

Candidatos pedidos: `d01` (reemplazar en vez de acumular una causa activa), `d03` (flags no soportados que prueban `sandbox_not_elevated`) y `d04` (el predicado previo `!= elevated`).

| Id | Grupo | Archivo | Mutante | Resultado | Pruebas que lo matan |
|---|---|---|---|---|---|
| `d01` | causas · acumular | `orch/state.rs` | set_env_block REEMPLAZA las causas activas del alcance en vez de acumular | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior`, `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado` (+1 más) |
| `d02` | causas · dedupe | `orch/state.rs` | set_env_block siempre dice que cambió (la misma causa se re-emite) | MUERTO | `repetir_la_misma_comprobacion_no_emite_y_una_causa_que_demuestra_la_anterior_son_dos_hechos`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior`, `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado` (+1 más) |
| `d03` | prueba · flags no prueban sandbox | `orch/agents.rs` | una policy bloqueada por CliFlagsUnsupported prueba sandbox_not_elevated | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `un_bloqueo_solo_lleva_la_evidencia_que_llego_a_demostrar` |
| `d04` | prueba · predicado sandbox | `orch/agents.rs` | predicado previo: cualquier valor distinto de `elevated` (ausente/desconocido incluidos) prueba sandbox no elevado | MUERTO | `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `sin_ayuda_legible_o_sin_comprobar_ningun_bloqueo_se_levanta`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` (+1 más) |
| `d05` | prueba · predicado sandbox | `orch/agents.rs` | predicado: cualquier valor presente prueba sandbox no elevado | MUERTO | `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado`, `un_valor_ausente_o_desconocido_del_sandbox_nunca_emite_environment_cleared` |
| `d06` | prueba · predicado sandbox | `orch/agents.rs` | predicado: `unelevated` deja de probar | MUERTO | `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado`, `solo_mxc_y_unelevated_levantan_windows_sandbox_elevated` |
| `d07` | prueba · predicado sandbox | `orch/agents.rs` | predicado: `mxc` deja de probar | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado`, `solo_mxc_y_unelevated_levantan_windows_sandbox_elevated` |
| `d08` | prueba · predicado sandbox | `orch/agents.rs` | predicado: `elevated` también prueba | MUERTO | `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` |
| `d09` | prueba · sandbox elevado | `orch/agents.rs` | la policy bloqueada por sandbox elevado prueba sandbox_not_elevated | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` |
| `d10` | prueba · sandbox elevado | `orch/agents.rs` | la policy bloqueada por sandbox elevado deja de probar los flags | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` |
| `d11` | prueba · sandbox elevado | `orch/agents.rs` | la policy bloqueada por sandbox elevado deja de probar la CLI | MUERTO | `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` |
| `d12` | prueba · flags | `orch/agents.rs` | la policy bloqueada por flags deja de probar la CLI | MUERTO | `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `un_bloqueo_solo_lleva_la_evidencia_que_llego_a_demostrar` |
| `d13` | prueba · evaluación final | `orch/agents.rs` | la policy no bloqueada siempre prueba sandbox no elevado | MUERTO | `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `sin_ayuda_legible_o_sin_comprobar_ningun_bloqueo_se_levanta`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` (+1 más) |
| `d14` | prueba · evaluación final | `orch/agents.rs` | la policy no bloqueada deja de probar los flags | MUERTO | `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental`, `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` (+1 más) |
| `d15` | prueba · evaluación final | `orch/agents.rs` | la policy no bloqueada deja de probar la CLI | MUERTO | `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado`, `un_modelo_no_listado_no_impide_levantar_el_bloqueo_de_entorno` (+1 más) |
| `d16` | prueba · demonstrates | `orch/agents.rs` | CliFlagsUnsupported se demuestra con la CLI presente | MUERTO | `la_evidencia_levanta_solo_lo_que_demuestra`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior`, `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado` (+1 más) |
| `d17` | prueba · demonstrates | `orch/agents.rs` | WindowsSandboxElevated se demuestra con los flags | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `sin_ayuda_legible_o_sin_comprobar_ningun_bloqueo_se_levanta`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior` (+1 más) |
| `d18` | prueba · demonstrates | `orch/agents.rs` | CliMissing se demuestra con los flags | MUERTO | `la_evidencia_levanta_solo_lo_que_demuestra`, `repetir_la_misma_comprobacion_no_emite_y_una_causa_que_demuestra_la_anterior_son_dos_hechos`, `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado` |
| `d19` | prueba · any | `orch/agents.rs` | EnvProof::any siempre false | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+10 más) |
| `d20` | prueba · any | `orch/agents.rs` | EnvProof::any siempre true | **SOBREVIVIÓ** → regresión → MUERTO | `env_proof_any_solo_es_cierto_con_alguna_prueba`, `observe_environment_no_intenta_mutar_si_no_hay_prueba_o_no_hay_bloqueos_que_levantar` |
| `d21` | resolve · prueba | `orch/state.rs` | verify_env levanta sin exigir que la prueba demuestre la causa | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `la_evidencia_levanta_solo_lo_que_demuestra` (+7 más) |
| `d22` | resolve · alcance | `orch/state.rs` | verify_env levanta causas de otros perfiles | MUERTO | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` |
| `d23` | resolve · alcance | `orch/state.rs` | verify_env: cli_missing deja de ser de todo el proveedor | MUERTO | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `la_evidencia_levanta_solo_lo_que_demuestra` |
| `d24` | resolve · limpieza | `orch/state.rs` | verify_env deja alcances con conjunto vacío | MUERTO | `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `una_observacion_vieja_no_se_aplica_despues_de_una_mas_nueva` |
| `d25` | dedupe · alcance | `orch/state.rs` | has_env_blocks_of cuenta alcances vacíos | **SOBREVIVIÓ** → regresión → MUERTO | `un_alcance_vacio_no_cuenta_como_bloqueo_vigente_del_proveedor` |
| `d26` | dedupe · Tx | `orch/tx_ops.rs` | Tx::environment_blocked emite aunque la causa ya estuviera | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+18 más) |
| `d27` | resolve · Tx | `orch/tx_ops.rs` | Tx::environment_verified dice que levantó aunque no levantó nada | MUERTO | `la_evidencia_levanta_solo_lo_que_demuestra` |
| `d28` | resolve · observe | `orch/spawn_approval.rs` | una policy bloqueada por flags no levanta cli_missing con su prueba | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `repetir_la_misma_comprobacion_no_emite_y_una_causa_que_demuestra_la_anterior_son_dos_hechos`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior` (+1 más) |
| `d29` | create · observe | `orch/spawn_approval.rs` | no_change() aunque se haya levantado algo en la mutación bloqueada | MUERTO | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior`, `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado` |
| `d30` | resolve · observe | `orch/spawn_approval.rs` | observe levanta sin comprobar que haya prueba | **SOBREVIVIÓ** → regresión → MUERTO | `observe_environment_no_intenta_mutar_si_no_hay_prueba_o_no_hay_bloqueos_que_levantar` |
| `d31` | resolve · observe | `orch/spawn_approval.rs` | observe vuelve a depender de status == Ok | MUERTO | `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental`, `un_modelo_no_listado_no_impide_levantar_el_bloqueo_de_entorno`, `una_cli_funcional_de_version_no_fijada_levanta_cli_missing` (+1 más) |
| `d32` | resolve · observe | `orch/spawn_approval.rs` | observe muta aunque el proveedor no tenga bloqueos | **SOBREVIVIÓ** → regresión → MUERTO | `observe_environment_no_intenta_mutar_si_no_hay_prueba_o_no_hay_bloqueos_que_levantar` |
| `d33` | compat · estado | `orch/state.rs` | el formato anterior (una causa por alcance) se pierde | MUERTO | `varias_causas_por_alcance_se_persisten_y_se_lee_el_formato_de_una_sola_causa` |
| `d34` | compat · estado | `orch/state.rs` | el formato actual (varias causas) se pierde | MUERTO | `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `varias_causas_por_alcance_se_persisten_y_se_lee_el_formato_de_una_sola_causa` |
| `d35` | compat · estado | `orch/state.rs` | alcances vacíos sobreviven a la deserialización | MUERTO | `varias_causas_por_alcance_se_persisten_y_se_lee_el_formato_de_una_sola_causa` |

#### Supervivientes del delta y su regresión

Los cuatro eran **mutantes del mismo defecto de cobertura**, no de un fallo del productor: `EnvProof::any` y la guarda
`has_env_blocks_of` de `observe_environment` solo evitan *intentar* una mutación inútil (con prueba vacía o sin bloqueos que
levantar, `verify_env` no cambia nada y `no_change()` descarta la mutación), de modo que el estado y los Events finales son
idénticos con o sin la guarda. Eran observables, sin embargo, con el Core en solo lectura (cualquier mutación falla) y con
pruebas unitarias directas. Regresiones mínimas y deterministas añadidas (sin tocar código de producción):

* `d20` (`EnvProof::any` siempre `true`) → `env_proof_any_solo_es_cierto_con_alguna_prueba` (`agents.rs`) y
  `observe_environment_no_intenta_mutar_si_no_hay_prueba_o_no_hay_bloqueos_que_levantar` (`spawn_approval.rs`).
* `d30` (`observe` sin comprobar `env_proof.any()`) y `d32` (`observe` sin comprobar `has_env_blocks_of`) → la misma prueba de
  `spawn_approval.rs`: con el Core degradado, sin prueba o sin bloqueos de ese proveedor devuelve `Ok` sin intentar mutar; con
  ambas cosas sí intenta (y el solo lectura lo rechaza).
* `d25` (`has_env_blocks_of` contando alcances vacíos) → `un_alcance_vacio_no_cuenta_como_bloqueo_vigente_del_proveedor`
  (`state.rs`); el invariante se mantiene en producción porque `verify_env` hace `retain` y la deserialización filtra vacíos
  (`d24` y `d35` los matan por su lado).

### Inventario previo re-ejecutado contra `cee685b`

Los 71 mutantes de la ronda 1, con el mismo texto original y mutado. Resultado de ESTA ejecución:

| Id | Grupo | Archivo | Mutante | Pruebas que lo matan |
|---|---|---|---|---|
| `m01` | create/dedupe | `store/attention_projection.rs` | create/update: la señal con el mismo seq ya no es antigua | `duplicados_y_reintentos_no_duplican_items`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_replay_desde_cero_de_estas_dos_categorias_es_el_estado_incremental` (+4 más) |
| `m02` | resolve | `store/attention_projection.rs` | resolve: la señal con el mismo seq ya no es antigua | `una_resolucion_con_el_mismo_seq_que_la_ultima_senal_del_hecho_se_descarta_y_una_posterior_resuelve` |
| `m03` | create/dedupe | `store/attention_projection.rs` | dedupe: una activa se trata como una resuelta (no actualiza) | `conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar`, `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad`, `failed_recurre_como_otra_ocurrencia_y_el_task_removed_resuelve` (+6 más) |
| `m04` | create/dedupe | `store/attention_projection.rs` | create: no emite attention.created | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado` (+22 más) |
| `m05` | resolve | `store/attention_projection.rs` | resolve: no emite attention.resolved | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event` (+8 más) |
| `m06` | resolve | `store/attention_projection.rs` | resolve: una resuelta ya no es no-op | `resolver_es_idempotente_y_no_reescribe_la_resolucion`, `review_ready_y_environment_blocked_son_idempotentes_y_deduplican` |
| `m07` | orden | `store/attention_projection.rs` | orden: acepta seq repetido | `un_tramo_fuera_de_orden_se_rechaza_entero_y_no_escribe` |
| `m08` | orden | `store/attention_projection.rs` | marca de agua: reaplica el seq de la marca | `duplicados_y_reintentos_no_duplican_items` |
| `m09` | resolve | `store/attention_projection.rs` | resolve: at sin proteger de created_at | `un_tramo_fuera_de_orden_se_rechaza_entero_y_no_escribe` |
| `m10` | create/dedupe | `store/attention_projection.rs` | update: no actualiza la severidad | `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad` |
| `m11` | orden | `store/attention_projection.rs` | no guarda event_seq | `duplicados_y_reintentos_no_duplican_items`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad` (+8 más) |
| `m12` | resolve | `store/attention_projection.rs` | resolve: fingerprint sin subject | `approval_en_terminal_failed_y_conflict_salen_de_los_mutadores_reales`, `approval_en_terminal_se_resuelve_segun_como_se_sale_de_la_espera`, `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids` (+19 más) |
| `m13` | writers | `store/attention_projection.rs` | proyector: marca de agua máxima (no aplica nada) | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` (+29 más) |
| `m14` | resolve | `orch/attention_rules.rs` | task.reply: resuelve otro hecho | `attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids`, `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event`, `question_se_levanta_con_la_pregunta_y_se_resuelve_con_la_respuesta` (+3 más) |
| `m15` | risk | `orch/attention_rules.rs` | risk también desde unverified | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `approval_de_un_lanzamiento_pendiente_se_resuelve_al_decidirlo`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+5 más) |
| `m16` | resolve | `orch/attention_rules.rs` | spawn.resolved timeout: acted | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `el_writer_de_resoluciones_standalone_resuelve_el_approval` |
| `m17` | create/dedupe | `orch/attention_rules.rs` | failed: levanta con otro estado | `approval_en_terminal_failed_y_conflict_salen_de_los_mutadores_reales`, `environment_blocked_es_distinto_de_failed_y_solo_lo_levanta_su_event`, `failed_recurre_como_otra_ocurrencia_y_el_task_removed_resuelve` (+5 más) |
| `m18` | resolve | `orch/attention_rules.rs` | merged no resuelve el conflicto | `conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar` |
| `m19` | create/dedupe | `orch/attention_rules.rs` | unverified no levanta approval | `approval_de_spawn_ok_y_unverified_y_sus_resoluciones`, `approval_de_un_lanzamiento_pendiente_se_resuelve_al_decidirlo`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+3 más) |
| `m20` | spawn | `orch/spawn_approval.rs` | persist-before-deny: ignora el fallo de persistencia | `si_la_proyeccion_falla_record_facts_deshace_el_event_y_no_se_devuelve_denegacion`, `sin_persistencia_la_respuesta_es_el_fallo_de_persistencia_y_no_una_denegacion` |
| `m21` | spawn | `orch/spawn_approval.rs` | la denegación crea pendiente y efectos | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn` (+6 más) |
| `m22` | spawn | `orch/agents.rs` | explicit_denial: cualquier bloqueo es explícito | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+27 más) |
| `m23` | spawn | `orch/agents.rs` | explicit_denial: no exige solicitud válida | `explicit_denial_respeta_la_precedencia_de_evaluate_sin_leer_el_motivo`, `solo_el_perfil_deshabilitado_es_una_denegacion_explicita_y_se_decide_por_tipos` |
| `m24` | spawn | `orch/agents.rs` | check_request: no valida el rol | `check_request_conserva_la_validacion_de_entrada_que_hacia_launch` |
| `m25` | spawn | `orch/agents.rs` | check_request: no valida proveedor x perfil | `check_request_conserva_la_validacion_de_entrada_que_hacia_launch`, `una_entrada_invalida_es_un_error_y_no_se_registra_como_denegada_por_policy` |
| `m26` | writers | `store/events.rs` | writer: no proyecta | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` (+37 más) |
| `m27` | writers | `store/events.rs` | append_events sin proyector | `cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad`, `el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log`, `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental` (+12 más) |
| `m28` | writers | `store/authority.rs` | commit_authoritative sin proyector | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+27 más) |
| `m29` | writers | `store/projects.rs` | project_register sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m30` | writers | `store/projects.rs` | project_join sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m31` | writers | `store/projects.rs` | project_relocate sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector` |
| `m32` | writers | `store/projects.rs` | project_archive sin proyector | `el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector`, `los_tres_writers_pasan_por_el_proyector_y_el_de_projects_no_levanta_nada`, `si_la_proyeccion_falla_el_writer_de_projects_deshace_el_cambio` |
| `m33` | writers | `store/events.rs` | los attention.* no heredan el state_rev del commit origen | `el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event`, `solo_una_comprobacion_positiva_y_verificada_levanta_el_bloqueo`, `un_bloqueo_tipado_del_entorno_levanta_environment_blocked_sin_ser_un_fallo_ni_un_riesgo` |
| `r01` | review_ready · productor | `orch/tx_ops.rs` | review_requested también con entrega fallida (guarda failed) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r02` | review_ready · productor | `orch/tx_ops.rs` | review_requested también para la raíz (guarda root) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r03` | review_ready · productor | `orch/tx_ops.rs` | review_requested sin exigir rama propia (guarda shared) | `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done` |
| `r04` | review_ready · productor | `orch/tx_ops.rs` | la entrega correcta no emite review_requested | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `repetir_done_sin_transicion_no_reabre_review_ready_pero_reabrir_y_entregar_de_nuevo_si` (+2 más) |
| `r05` | review_ready · productor | `orch/tx_ops.rs` | la entrega no emite task.status_changed (orden/causalidad) | `repetir_done_sin_transicion_no_reabre_review_ready_pero_reabrir_y_entregar_de_nuevo_si`, `sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done`, `una_entrega_correcta_con_padre_y_rama_emite_review_requested_y_levanta_review_ready` |
| `r06` | review_ready · productor | `orch/event_kinds.rs` | review_requested con otra entidad | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `repetir_done_sin_transicion_no_reabre_review_ready_pero_reabrir_y_entregar_de_nuevo_si` (+2 más) |
| `r07` | review_ready · regla | `orch/attention_rules.rs` | review_requested levanta otra categoría | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` (+4 más) |
| `r08` | review_ready · regla | `orch/attention_rules.rs` | review_requested con otro destino | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia`, `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_senales_fuente_fuera_de_orden_se_descartan_por_seq` (+3 más) |
| `r09` | review_ready · resolución | `orch/attention_rules.rs` | rechazar la revisión no resuelve | `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas`, `review_ready_y_environment_blocked_son_idempotentes_y_deduplican` |
| `r10` | review_ready · resolución | `orch/attention_rules.rs` | aceptar la revisión no resuelve | `la_decision_de_revision_resuelve_review_ready_acepte_o_rechace`, `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas`, `las_senales_fuente_fuera_de_orden_se_descartan_por_seq` (+2 más) |
| `r11` | review_ready · resolución | `orch/attention_rules.rs` | reabrir no supera la revisión | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `r12` | review_ready · resolución | `orch/attention_rules.rs` | merged no resuelve review_ready | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `r13` | review_ready · resolución | `orch/attention_rules.rs` | task.removed no resuelve review_ready | `retirar_la_task_resuelve_su_review_ready` |
| `r14` | review_ready · resolución | `orch/attention_rules.rs` | reabrir resuelve como acted | `integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia` |
| `e03` | environment · clear | `orch/tx_ops.rs` | la verificación positiva no emite cleared | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental` (+11 más) |
| `e07` | environment · legacy | `orch/spawn_approval.rs` | se marca un bloqueo sin Event Log | `sin_event_log_no_se_marca_ningun_bloqueo_de_entorno` |
| `e08` | environment · alcance | `orch/spawn_approval.rs` | el bloqueo se registra en otro perfil | `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental` |
| `e09` | environment · carrera | `orch/spawn_approval.rs` | resolver+observar sin serializar (carrera de frescura) | `una_observacion_vieja_no_se_aplica_despues_de_una_mas_nueva` |
| `e10` | environment · callsite | `orch/spawn_approval.rs` | spawn_request no observa el entorno | `con_el_core_en_solo_lectura_no_se_muta_env_blocks`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor` (+20 más) |
| `e11` | environment · callsite | `orch/spawn_approval.rs` | approve_spawn no observa el entorno | `la_aprobacion_vuelve_a_comprobar_el_entorno_y_deja_constancia`, `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e12` | environment · callsite | `orch/spawn_approval.rs` | el recheck de lanzamiento (fake_launch) no observa el entorno | `el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo`, `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e13` | environment · callsite | `orch/spawn.rs` | el recheck de launch real no observa el entorno | `toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe` |
| `e14` | environment · causa | `orch/agents.rs` | CLI ausente sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada` |
| `e15` | environment · causa | `orch/agents.rs` | la ruta inservible cuenta como entorno del proveedor | `cada_bloqueo_lleva_su_causa_tipada`, `un_perfil_deshabilitado_en_una_ruta_inservible_es_un_bloqueo_del_entorno_y_no_deja_event_ni_risk` |
| `e16` | environment · causa | `orch/agents.rs` | flags no soportados sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo` (+1 más) |
| `e17` | environment · causa | `orch/agents.rs` | sandbox elevado sin causa de entorno | `cada_bloqueo_lleva_su_causa_tipada`, `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado` (+2 más) |
| `e18` | environment · regla | `orch/attention_rules.rs` | environment.blocked sin perfil en su identidad | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+15 más) |
| `e19` | environment · regla | `orch/attention_rules.rs` | cleared resuelve otro hecho | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues`, `el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental` (+12 más) |
| `e20` | environment · regla | `orch/attention_rules.rs` | perfil desconocido aceptado | `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` |
| `e21` | environment · regla | `orch/attention_rules.rs` | código fuera del conjunto cerrado aceptado | `las_reglas_de_las_senales_fuente_son_exactas_y_cerradas` |
| `e22` | environment · regla | `orch/attention_rules.rs` | environment.blocked con otra entidad | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+15 más) |
| `e23` | environment · productor | `orch/event_kinds.rs` | environment.blocked con otra entidad (productor) | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+11 más) |
| `e24` | environment · regla | `orch/attention_rules.rs` | environment.blocked levanta failed | `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`, `el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor`, `el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues` (+14 más) |

#### No aplicables (el sitio de mutación ya no existe en `cee685b`)

* `e01` — environment.blocked se re-emite con la misma causa (`orch/state.rs`). Sucesor: `d02` y `d26` (el re-emitir la misma causa vive ahora en `set_env_block -> bool` y en la guarda de `Tx::environment_blocked`).
* `e02` — un cambio de causa no emite cleared de la anterior (`orch/tx_ops.rs`). Sucesor: ninguno: el comportamiento («un cambio de causa emite `cleared` de la anterior») ya no existe; su inversa («ninguna causa cae sin prueba positiva, una causa nueva se suma») la cubren `d01`, `d21` y `d28`.
* `e04` — verificar un perfil levanta los bloqueos de todos los perfiles (`orch/state.rs`). Sucesor: `d22` (`verify_env` levantando causas de otros perfiles).
* `e05` — cli_missing deja de ser de todo el proveedor (`orch/state.rs`). Sucesor: `d23` (`cli_missing` deja de ser de todo el proveedor).
* `e06` — una policy no verificada levanta el bloqueo (`orch/spawn_approval.rs`). Sucesor: `d31` y `d30` (`observe_environment` ya no mira `status == Ok`, mira `Policy.env_proof`).

Ninguno de ellos revela una aceptación sin cubrir: el comportamiento que mutaban fue sustituido por el de causas acumuladas y
prueba positiva (rediseño de `cee685b`), y su sucesor está en el delta. No se cuentan como muertos.

### Qué NO afirma esta ronda

* No es una ejecución de la suite completa por mutante: cada mutante corre el subconjunto
  `attention spawn_blocked proyector cada_bloqueo agents::tests events_tests` (más las tres regresiones en la re-ejecución).
  La suite completa se ejecuta aparte sobre el commit final (`cargo test --locked --lib`).
* No hay `cargo-mutants`: la cobertura mutacional es la de estos mutantes manuales, no exhaustiva.
* No declara terminado LXO-88 ni la CI.
