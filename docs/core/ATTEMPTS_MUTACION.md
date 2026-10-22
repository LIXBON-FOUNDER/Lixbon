# Inventario de mutation testing manual de LXO-114

No hay `cargo-mutants` en el repo ni en la CI. Se sigue la disciplina de [`ATTENTION_MUTACION.md`](ATTENTION_MUTACION.md) y
[`TASKS_MUTACION.md`](TASKS_MUTACION.md): cada mutante se aplica **uno a uno** sobre el código de producción, se
ejecutan las pruebas, se anota si alguna falla (muerto) o no (superviviente) y el archivo se **restaura byte a byte**
antes del siguiente.

* **Árbol:** el de la rama de LXO-114 antes de su commit, con estos SHA-256 de los archivos mutados (comprobados tras
  cada mutante y al final de la ronda):

  | Archivo | SHA-256 |
  |---|---|
  | `store/attempts.rs` | `160ee1a0ef5783ff4f76b5a7beff0f39e3c92f3817c2092c42df7f501dcc0369` |
  | `store/tasks.rs` | `897a27f2a977457448b38f75aefabfc397e6b830d9cb8b38ce79780d78ec7900` |
  | `orch/attempt_ops.rs` | `e75cb735234176c6d83f9b900194dffb8542ccc7a55afebb28a62ec70c9262fa` |
  | `orch/event_kinds.rs` | `389a8c8f1099d899f419508e2be1414c731c03fe01e70d668358aa1ae59e6d5a` |
  | `orch/events.rs` | `f6a3acfd2833191dd398a85e1fe83786257c36e21e920aefa2cd92b6c4d1fb07` |
  | `orch/activity_format.rs` | `2cb0492057a678deba47a431cb80f805fea8003b421ce79f0f1180a53304c621` |
  | `store/migrations/008_attempts.sql` | `4c91800c7ff95eee1f9494e062fc8d1ebaf07261ea030bdbaf71d76f2c10d789` |

* **Comando por mutante:** `cargo test --locked --lib -- attempts_tests attempt_ops_tests tasks_tests task_ops_tests activity_tests --skip la_migracion_008_tiene_el_checksum_congelado`.
  Se **excluye** la prueba del checksum: un mutante del SQL cambia el hash y moriría siempre por eso; así lo mata el
  comportamiento de la base, que es lo que se quiere medir.
* **Restauración:** además de los hashes, al terminar la ronda `diff -rq` entre `src/` y una copia tomada antes de
  empezar no muestra diferencias.
* **Ronda 2** (solo los 2 supervivientes): sobre el **mismo código de producción** (los hashes de arriba no cambian) con
  una prueba ampliada.

## Resumen

| Resultado | Ronda 1 | Tras cerrar los supervivientes |
|---|---|---|
| Muertos | 85 | 87 |
| Supervivientes | 2 (`m11`, `m13`) | 0 |
| No aplicables | 0 | 0 |
| Errores de compilación | 0 | 0 |
| **Total** | **87** | **87** |

## Los supervivientes y cómo se cerraron

Los dos eran **huecos de cobertura**, no mutantes equivalentes:

* `m11` (`attempt_transition_recorded` no comprueba que el evento se refiera al Attempt): solo se probaba el evento ajeno
  al **crear**, no al cambiar de estado. La prueba ahora cubre las cuatro formas de evento ajeno (otro Attempt, otro Run,
  otro Project, otra entidad) también en las transiciones, y que el Attempt sigue como estaba.
* `m13` (`check_attempt_event` no compara el Run): el caso de prueba del Run ajeno cambiaba **también** el Project, de modo
  que otra comprobación lo tapaba. Ahora cambia solo el Run.

Ambos mueren con la prueba ampliada, re-ejecutados sobre el mismo árbol.

## Qué cubre cada grupo

**inerte** (antes del corte nada escribe) · **crear** · **ciclo** (transiciones, marcas de tiempo, tabla cerrada) ·
**validación** (selección, resumen, motivo) · **lectura** (`attempt_current`, `attempts_of_task`, `attempt_active`) ·
**task** (las dos guardas nuevas de `store/tasks.rs`) · **permisos** y **evento** (`attempt_ops`, `event_kinds`) ·
**activity** · **sql** (restricciones y triggers de la 008).

## Mutantes

| Id | Grupo | Archivo | Mutante | Resultado | Pruebas que lo matan |
|---|---|---|---|---|---|
| `m01` | inerte | `store/attempts.rs` | create: no comprueba el corte | muerto | `antes_del_corte_attempt_ops_no_escribe_nada`, `antes_del_corte_ningun_mutador_escribe_y_la_base_tampoco` |
| `m02` | inerte | `store/attempts.rs` | transition: no comprueba el corte | muerto | `antes_del_corte_ningun_mutador_escribe_y_la_base_tampoco` |
| `m03` | crear | `store/attempts.rs` | create: admite una Task descartada | muerto | `no_se_crea_un_attempt_donde_no_cabe` |
| `m04` | crear | `store/attempts.rs` | create: admite un Run cerrado | muerto | `no_se_crea_un_attempt_donde_no_cabe` |
| `m05` | crear | `store/attempts.rs` | create: admite un segundo Attempt activo | muerto | `a_lo_sumo_un_attempt_activo_por_task` |
| `m06` | crear | `store/attempts.rs` | create: salta números | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+21 más) |
| `m07` | crear | `store/attempts.rs` | create: estado inicial invertido | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+16 más) |
| `m08` | crear | `store/attempts.rs` | create: pierde external | muerto | `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo`, `un_coordinador_externo_se_marca_en_el_attempt` |
| `m09` | crear | `store/attempts.rs` | create: role y profile intercambiados | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `un_attempt_nace_con_su_identidad_y_su_evento` |
| `m10` | evento | `store/attempts.rs` | create: no comprueba el evento | muerto | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` |
| `m11` | evento | `store/attempts.rs` | transition: no comprueba el evento | superviviente → muerto en la ronda 2 | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` (ampliada tras la ronda 1: ahora cubre también las transiciones) |
| `m12` | evento | `store/attempts.rs` | evento: no compara el Project | muerto | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` |
| `m13` | evento | `store/attempts.rs` | evento: no compara el Run | superviviente → muerto en la ronda 2 | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` (ampliada tras la ronda 1: el caso del Run ya no cambia también el Project) |
| `m14` | evento | `store/attempts.rs` | evento: no compara el id del Attempt | muerto | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` |
| `m15` | evento | `store/attempts.rs` | evento duplicado: error del tipo equivocado | muerto | `un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio` |
| `m16` | ciclo | `store/attempts.rs` | transition: sin Unchanged | muerto | `desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro`, `un_final_no_vuelve_a_running_ni_cambia_de_final` |
| `m17` | ciclo | `store/attempts.rs` | transition: no comprueba la tabla | muerto | `desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro`, `un_final_no_vuelve_a_running_ni_cambia_de_final` |
| `m18` | ciclo | `store/attempts.rs` | transition: el reloj retrocede | muerto | `el_reloj_hacia_atras_no_deja_marcas_anteriores_a_las_previas` |
| `m19` | ciclo | `store/attempts.rs` | start: no fija started_at | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+12 más) |
| `m20` | ciclo | `store/attempts.rs` | finish: pierde el resumen | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_ciclo_de_vida_feliz_fija_las_marcas_de_tiempo` (+1 más) |
| `m21` | ciclo | `store/attempts.rs` | fail: motivo fijo | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo`, `varios_attempts_por_task_y_el_retry_conserva_la_historia` |
| `m22` | ciclo | `store/attempts.rs` | cancel: no fija ended_at | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_juego_de_estados_y_de_eventos_cuadra_con_el_vocabulario_reservado` (+6 más) |
| `m23` | ciclo | `store/attempts.rs` | tabla: no se cancela lo pendiente | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_juego_de_estados_y_de_eventos_cuadra_con_el_vocabulario_reservado` (+3 más) |
| `m24` | ciclo | `store/attempts.rs` | tabla: terminar desde starting | muerto | `desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro`, `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones` |
| `m25` | ciclo | `store/attempts.rs` | tabla: fail va a stopped | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+7 más) |
| `m26` | ciclo | `store/attempts.rs` | transition_allowed: || en vez de && | muerto | `desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro`, `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones`, `un_final_no_vuelve_a_running_ni_cambia_de_final` |
| `m27` | ciclo | `store/attempts.rs` | is_final: exited no es final | muerto | `el_juego_de_estados_de_la_base_es_el_de_rust`, `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones` |
| `m28` | ciclo | `store/attempts.rs` | tabla: arrancar sin aprobar | muerto | `desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro`, `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones` |
| `m29` | validación | `store/attempts.rs` | resumen: el límite exacto no cabe | muerto | `el_resumen_y_el_motivo_tienen_limites` |
| `m30` | validación | `store/attempts.rs` | motivo: puede empezar por un dígito | muerto | `el_resumen_y_el_motivo_tienen_limites` |
| `m31` | validación | `store/attempts.rs` | motivo: un carácter de más | muerto | `el_resumen_y_el_motivo_tienen_limites` |
| `m32` | validación | `store/attempts.rs` | etiqueta: admite caracteres de control | muerto | `la_seleccion_se_valida_antes_de_tocar_la_base` |
| `m33` | validación | `store/attempts.rs` | etiqueta: sin límite de longitud | muerto | `la_seleccion_se_valida_antes_de_tocar_la_base` |
| `m34` | validación | `store/attempts.rs` | selección: no valida model/effort/role/profile | muerto | `la_seleccion_se_valida_antes_de_tocar_la_base` |
| `m35` | lectura | `store/attempts.rs` | attempt_current: el más antiguo | muerto | `varios_attempts_por_task_y_el_retry_conserva_la_historia` |
| `m36` | lectura | `store/attempts.rs` | attempts_of_task: orden inverso | muerto | `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `varios_attempts_por_task_y_el_retry_conserva_la_historia` |
| `m37` | lectura | `store/attempts.rs` | attempt_active: un done cuenta como activo | muerto | `el_ciclo_de_vida_feliz_fija_las_marcas_de_tiempo`, `varios_attempts_por_task_y_el_retry_conserva_la_historia` |
| `m38` | task | `store/tasks.rs` | borrar Task: ignora sus Attempts | muerto | `un_attempt_no_se_borra_y_su_task_tampoco_ni_se_descarta_mientras_corre` |
| `m39` | task | `store/tasks.rs` | descartar Task: ignora el Attempt activo | muerto | `un_attempt_no_se_borra_y_su_task_tampoco_ni_se_descarta_mientras_corre` |
| `m40` | permisos | `orch/attempt_ops.rs` | create: cualquiera | muerto | `la_matriz_de_permisos` |
| `m41` | permisos | `orch/attempt_ops.rs` | approve: cualquiera | muerto | `la_matriz_de_permisos` |
| `m42` | permisos | `orch/attempt_ops.rs` | start: cualquiera | muerto | `la_matriz_de_permisos` |
| `m43` | permisos | `orch/attempt_ops.rs` | finish: cualquiera | muerto | `la_matriz_de_permisos` |
| `m44` | permisos | `orch/attempt_ops.rs` | fail: cualquiera | muerto | `la_matriz_de_permisos` |
| `m45` | permisos | `orch/attempt_ops.rs` | cancel: cualquiera | muerto | `la_matriz_de_permisos` |
| `m46` | permisos | `orch/attempt_ops.rs` | person_or_manager: todo agente coordina | muerto | `la_matriz_de_permisos` |
| `m47` | permisos | `orch/attempt_ops.rs` | own_agent: cualquier agente | muerto | `la_matriz_de_permisos` |
| `m48` | permisos | `orch/attempt_ops.rs` | person_or_manager: persona sin credencial | muerto | `la_matriz_de_permisos` |
| `m49` | permisos | `orch/attempt_ops.rs` | is_system: todos | muerto | `la_matriz_de_permisos` |
| `m50` | evento | `orch/attempt_ops.rs` | cancel: rejected y stopped invertidos | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m51` | evento | `orch/attempt_ops.rs` | finish: pierde el resumen | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m52` | evento | `orch/attempt_ops.rs` | fail: motivo fijo en la fila | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` |
| `m53` | evento | `orch/event_kinds.rs` | requested: approval_required siempre falso | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m54` | evento | `orch/event_kinds.rs` | completed: has_summary siempre cierto | muerto | `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` |
| `m55` | evento | `orch/event_kinds.rs` | approved: clase state | muerto | `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m56` | evento | `orch/event_kinds.rs` | rejected: clase state | muerto | `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m57` | evento | `orch/event_kinds.rs` | FailureCode: código equivocado | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m58` | evento | `orch/event_kinds.rs` | attempt_draft: sin Project | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+3 más) |
| `m59` | evento | `orch/events.rs` | EntityKind::Attempt: entidad equivocada | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo` (+3 más) |
| `m60` | evento | `orch/event_kinds.rs` | stopped: from fijo | muerto | `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen` |
| `m61` | activity | `orch/activity_format.rs` | activity: failed sin énfasis de error | muerto | `la_tabla_event_kind_a_clave_cubre_todos_los_casos_y_fija_las_claves`, `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m62` | activity | `orch/activity_format.rs` | activity: run_closed no es una causa | muerto | `la_tabla_event_kind_a_clave_cubre_todos_los_casos_y_fija_las_claves`, `ningun_secreto_del_payload_llega_al_texto_humano`, `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m63` | activity | `orch/activity_format.rs` | activity: falta un motivo de fallo | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m64` | activity | `orch/activity_format.rs` | activity: running no es un origen de stopped | muerto | `la_tabla_event_kind_a_clave_cubre_todos_los_casos_y_fija_las_claves`, `ningun_secreto_del_payload_llega_al_texto_humano`, `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m65` | activity | `orch/activity_format.rs` | activity: approved sin énfasis de éxito | muerto | `la_tabla_event_kind_a_clave_cubre_todos_los_casos_y_fija_las_claves`, `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m66` | activity | `orch/activity_format.rs` | activity: requested pierde approval_required | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo` |
| `m67` | sql | `store/migrations/008_attempts.sql` | 008: INSERT antes del corte | muerto | `antes_del_corte_ningun_mutador_escribe_y_la_base_tampoco` |
| `m68` | sql | `store/migrations/008_attempts.sql` | 008: UPDATE antes del corte | muerto | `si_se_retira_la_marca_del_corte_las_filas_quedan_inertes` |
| `m69` | sql | `store/migrations/008_attempts.sql` | 008: DELETE permitido | muerto | `un_attempt_no_se_borra_y_su_task_tampoco_ni_se_descarta_mientras_corre` |
| `m70` | sql | `store/migrations/008_attempts.sql` | 008: una fila del Core puede nacer en cualquier estado | muerto | `no_se_crea_un_attempt_donde_no_cabe` |
| `m71` | sql | `store/migrations/008_attempts.sql` | 008: n no consecutivo | muerto | `no_se_crea_un_attempt_donde_no_cabe` |
| `m72` | sql | `store/migrations/008_attempts.sql` | 008: Run cerrado admitido | muerto | `la_base_exige_una_task_abierta_en_un_run_abierto_aunque_se_salte_el_almacen` |
| `m73` | sql | `store/migrations/008_attempts.sql` | 008: Task descartada admitida | muerto | `la_base_exige_una_task_abierta_en_un_run_abierto_aunque_se_salte_el_almacen` |
| `m74` | sql | `store/migrations/008_attempts.sql` | 008: un final se modifica | muerto | `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones`, `un_final_no_vuelve_a_running_ni_cambia_de_final` |
| `m75` | sql | `store/migrations/008_attempts.sql` | 008: el proveedor cambia | muerto | `la_identidad_no_cambia_y_el_vinculo_se_fija_una_sola_vez` |
| `m76` | sql | `store/migrations/008_attempts.sql` | 008: external cambia | muerto | `la_identidad_no_cambia_y_el_vinculo_se_fija_una_sola_vez` |
| `m77` | sql | `store/migrations/008_attempts.sql` | 008: el worktree se revincula | muerto | `la_identidad_no_cambia_y_el_vinculo_se_fija_una_sola_vez` |
| `m78` | sql | `store/migrations/008_attempts.sql` | 008: running vuelve a starting | muerto | `la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones` |
| `m79` | sql | `store/migrations/008_attempts.sql` | 008: no se cancela lo pendiente | muerto | `activity_pinta_cada_hecho_del_attempt_sin_respaldo`, `cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen`, `el_juego_de_estados_y_de_eventos_cuadra_con_el_vocabulario_reservado` (+4 más) |
| `m80` | sql | `store/migrations/008_attempts.sql` | 008: se descarta una Task con Attempt activo | muerto | `un_attempt_no_se_borra_y_su_task_tampoco_ni_se_descarta_mientras_corre` |
| `m81` | sql | `store/migrations/008_attempts.sql` | 008: varios activos por Task | muerto | `a_lo_sumo_un_attempt_activo_por_task` |
| `m82` | sql | `store/migrations/008_attempts.sql` | 008: motivo fuera de failed | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |
| `m83` | sql | `store/migrations/008_attempts.sql` | 008: final sin ended_at | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |
| `m84` | sql | `store/migrations/008_attempts.sql` | 008: resumen sin tope | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |
| `m85` | sql | `store/migrations/008_attempts.sql` | 008: updated_at antes de created_at | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |
| `m86` | sql | `store/migrations/008_attempts.sql` | 008: starting con started_at | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |
| `m87` | sql | `store/migrations/008_attempts.sql` | 008: running sin started_at | muerto | `las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado` |

Las pruebas que cierran huecos conocidos de la ronda (antes de lanzarla, por revisión a mano) son
`un_coordinador_externo_se_marca_en_el_attempt`, `si_se_retira_la_marca_del_corte_las_filas_quedan_inertes`,
`la_base_exige_una_task_abierta_en_un_run_abierto_aunque_se_salte_el_almacen` y
`el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo`.
