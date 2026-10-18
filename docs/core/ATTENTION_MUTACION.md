# Inventario de mutation testing manual de LXO-88

No hay `cargo-mutants` en el repo ni en la CI. La disciplina es la histórica del repositorio (`proctable.rs`, mutantes
`m0N`): cada mutante se aplica a mano sobre el código de producción **uno a uno**, se ejecuta
`cargo test --locked --lib -- attention spawn_blocked proyector cada_bloqueo`, se registra si alguna prueba falla (muerto) o no
(superviviente) y el archivo se **restaura byte a byte** antes del siguiente. Un mutante cuyo texto original ya no existe en el
código es **no aplicable** y se cuenta aparte: nunca como muerto. Este inventario es de la ronda FINAL sobre el árbol estable;
cubre el motor (create/resolve/dedupe/orden), los writers, el camino de `spawn` y las reglas y productores nuevos de
`review_ready` y `environment_blocked`. No hereda ni atribuye resultados de rondas anteriores.

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

## Nota posterior: causas simultáneas y prueba del sandbox (P1 de revisión de LXO-88)

Cambios posteriores a la ronda FINAL, sin mutación manual re-ejecutada sobre ellos (este inventario no los cuenta):

* `Tx::environment_blocked` ya no emite `environment.cleared` al cambiar la causa de un alcance: `State.env_blocks` guarda un
  CONJUNTO de causas por `proveedor/perfil` y una causa nueva se suma. El mutante `e02` («un cambio de causa no emite cleared de la
  anterior») dejó de describir un comportamiento que exista; su protección es ahora la inversa: ninguna causa cae sin prueba
  positiva (`un_sandbox_elevado_activo_no_lo_levanta_un_cli_flags_unsupported_posterior`,
  `una_causa_nueva_sin_prueba_de_la_anterior_no_emite_cleared_y_el_replay_reproduce_el_estado`,
  `con_la_sonda_real_de_codex_flags_que_faltan_no_levantan_el_sandbox_elevado_aun_si_sigue_elevado`).
* Candidatos de mutación para la próxima ronda: volver a reemplazar la causa del alcance en `set_env_block`; que una policy
  bloqueada por flags lleve `sandbox_not_elevated: true`; volver a `s != "elevated"` en `EnvProof.sandbox_not_elevated`
  (`solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado`, `un_valor_ausente_o_desconocido_del_sandbox_nunca_emite_environment_cleared`).
