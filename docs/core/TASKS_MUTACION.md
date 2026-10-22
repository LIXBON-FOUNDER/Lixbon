# Inventario de mutation testing manual de LXO-113

No hay `cargo-mutants` en el repo ni en la CI. Se sigue la disciplina de [`ATTENTION_MUTACION.md`](ATTENTION_MUTACION.md):
cada mutante se aplica **uno a uno** sobre el código de producción, se ejecutan las pruebas, se anota si alguna falla
(muerto) o no (superviviente) y el archivo se **restaura byte a byte** antes del siguiente.

* **Árbol:** el de la rama de LXO-113 antes de su commit, con estos SHA-256 de los archivos mutados (comprobados
  tras cada mutante y al final):

  | Archivo | SHA-256 |
  |---|---|
  | `store/tasks.rs` | `5114ca55c508c0f678d496c6f8f62c1f25383f3037cb472b45999cfd6e60af38` |
  | `orch/task_ops.rs` | `129fc8a9881054c0257bd32d5731df21855bd65fd017b4b5dbc48c8ba03fcd99` |
  | `orch/event_kinds.rs` | `adfbca85ed2cd5c8a7ac0fc48c58b163d7c56f1dcfa33891410b5c54a7a61981` |
  | `orch/activity_format.rs` | `f9677b3a76c8a27109ec527fee654daaa78a968ef0dd5716b95ae79f962a4938` |
  | `store/migrations/007_tasks.sql` | `74316df6e4b6369baf9243ea2af52c11570e0a413226f21b8015495535f01f2c` |

* **Comando por mutante:** `cargo test --locked --lib -- tasks_tests task_ops_tests activity_tests`.
* **Restauración:** además de los hashes, al terminar la ronda `diff -rq` entre `src/` y una copia tomada antes de
  empezar no muestra diferencias.

## Resumen

| Resultado | Ronda 1 | Tras cerrar el superviviente |
|---|---|---|
| Muertos | 38 | 39 |
| Supervivientes | 1 (`m20`) | 0 |
| No aplicables | 0 | 0 |
| Errores de compilación | 0 | 0 |
| **Total** | **39** | **39** |

## El superviviente y cómo se cerró

`m20` (`discarded_at` con la hora cruda en lugar de la misma marca que `updated_at`) sobrevivió porque ninguna prueba
descartaba con el reloj hacia atrás: era un **hueco de cobertura**, no un mutante equivalente (con el reloj atrás, el
descarte quedaba antes de la última actualización). Se añadió
`con_el_reloj_hacia_atras_el_descarte_no_queda_antes_de_la_ultima_actualizacion` y, re-ejecutado sobre el mismo árbol,
`m20` muere.

## Mutantes

Grupos: **inerte** (antes del corte nada escribe), **crear**, **editar**, **descartar**, **borrar**, **ids**, **leer**,
**evento** (fila + hecho), **permisos** (`task_ops`), **activity** y **sql** (restricciones y triggers de la 007).

| Id | Grupo | Archivo | Mutante | Resultado | Pruebas que lo matan |
|---|---|---|---|---|---|
| `m01` | inerte | `store/tasks.rs` | require_active: siempre activo | muerto | `antes_del_corte_task_ops_no_escribe_nada`, `antes_del_corte_ningun_mutador_escribe_y_no_queda_rastro` |
| `m02` | inerte | `store/tasks.rs` | active_in: activo aunque falte la clave | muerto | `antes_del_corte_task_ops_no_escribe_nada`, `antes_del_corte_ningun_mutador_escribe_y_no_queda_rastro`, `un_core_real_aplica_la_007_y_sus_tablas_quedan_inertes_mientras_el_legacy_sigue_mandando` |
| `m03` | crear | `store/tasks.rs` | run_create: no comprueba que el Project exista | muerto | `project_es_obligatorio_en_toda_task_del_core` |
| `m04` | evento | `store/tasks.rs` | run_create: no comprueba el evento del Run | muerto | `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio` |
| `m05` | evento | `store/tasks.rs` | check_task_event: no compara el Project | muerto | `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio` |
| `m06` | evento | `store/tasks.rs` | check_task_event: no compara el Run | muerto | `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio` |
| `m07` | evento | `store/tasks.rs` | check_task_event: no compara la entidad | muerto | `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio` |
| `m08` | evento | `store/tasks.rs` | insert_all: acepta un cambio sin eventos | muerto | `sin_su_hecho_no_hay_cambio` |
| `m09` | evento | `store/tasks.rs` | insert_all: ignora duplicados | muerto | `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio` |
| `m10` | crear | `store/tasks.rs` | hija: admite un padre descartado | muerto | `una_hija_no_se_cuelga_de_lo_que_no_admite_trabajo_nuevo` |
| `m11` | crear | `store/tasks.rs` | hija: admite un Run cerrado | muerto | `una_hija_no_se_cuelga_de_lo_que_no_admite_trabajo_nuevo` |
| `m12` | crear | `store/tasks.rs` | hija: misma profundidad que el padre | muerto | `cambiar_la_intencion_lo_hace_una_persona_o_el_agente_que_la_coordina_y_el_encargo_no_viaja`, `activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1`, `descartar_restaurar_y_borrar_son_decisiones_de_una_persona` (+10 más) |
| `m13` | editar | `store/tasks.rs` | editar: admite una Task descartada | muerto | `descartar_y_restaurar_no_actuan_en_cascada` |
| `m14` | editar | `store/tasks.rs` | editar: sin Unchanged (emite aunque nada cambie) | muerto | `cambiar_la_intencion_solo_registra_lo_que_cambio_de_verdad` |
| `m15` | editar | `store/tasks.rs` | editar: el título cuenta como cambiado siempre | muerto | `cambiar_la_intencion_solo_registra_lo_que_cambio_de_verdad` |
| `m16` | editar | `store/tasks.rs` | editar: updated_at retrocede con el reloj | muerto | `cambiar_la_intencion_solo_registra_lo_que_cambio_de_verdad` |
| `m17` | descartar | `store/tasks.rs` | descartar: con hijas abiertas (cascada implícita) | muerto | `descartar_y_restaurar_no_actuan_en_cascada` |
| `m18` | descartar | `store/tasks.rs` | restaurar: con el padre descartado | muerto | `descartar_y_restaurar_no_actuan_en_cascada` |
| `m19` | descartar | `store/tasks.rs` | descartar: sin Unchanged | muerto | `descartar_y_restaurar_no_actuan_en_cascada` |
| `m20` | descartar | `store/tasks.rs` | descartar: discarded_at con la hora cruda | superviviente → muerto en ronda 2 | `con_el_reloj_hacia_atras_el_descarte_no_queda_antes_de_la_ultima_actualizacion` (añadida tras la ronda 1) |
| `m21` | borrar | `store/tasks.rs` | borrar: admite la raíz | muerto | `solo_se_borra_una_task_sin_uso_y_su_historia_se_queda` |
| `m22` | borrar | `store/tasks.rs` | borrar: admite una Task con hijas | muerto | `solo_se_borra_una_task_sin_uso_y_su_historia_se_queda` |
| `m23` | ids | `store/tasks.rs` | contador: salta ids | muerto | `un_run_nace_con_su_raiz_y_sus_dos_hechos_y_los_ids_siguen_el_contador_del_legado` |
| `m24` | crear | `store/tasks.rs` | título: acepta solo espacios | muerto | `cambiar_la_intencion_solo_registra_lo_que_cambio_de_verdad`, `una_hija_no_se_cuelga_de_lo_que_no_admite_trabajo_nuevo` |
| `m25` | leer | `store/tasks.rs` | tasks_of_project: invierte include_discarded | muerto | `descartar_y_restaurar_no_actuan_en_cascada` |
| `m26` | permisos | `orch/task_ops.rs` | manages: todo agente coordina todo | muerto | `cambiar_la_intencion_lo_hace_una_persona_o_el_agente_que_la_coordina_y_el_encargo_no_viaja`, `un_agente_solo_crea_hijas_bajo_su_propia_task` |
| `m27` | permisos | `orch/task_ops.rs` | editar: cualquier agente | muerto | `cambiar_la_intencion_lo_hace_una_persona_o_el_agente_que_la_coordina_y_el_encargo_no_viaja` |
| `m28` | permisos | `orch/task_ops.rs` | decisiones: cualquiera descarta/restaura/borra | muerto | `descartar_restaurar_y_borrar_son_decisiones_de_una_persona` |
| `m29` | permisos | `orch/task_ops.rs` | hija: un agente crea bajo cualquier Task | muerto | `un_agente_solo_crea_hijas_bajo_su_propia_task` |
| `m30` | evento | `orch/task_ops.rs` | descartar/restaurar: hecho cambiado | muerto | `activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1`, `descartar_restaurar_y_borrar_son_decisiones_de_una_persona` |
| `m31` | evento | `orch/task_ops.rs` | borrar: causa equivocada | muerto | `activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1`, `descartar_restaurar_y_borrar_son_decisiones_de_una_persona` |
| `m32` | evento | `orch/event_kinds.rs` | task.updated: el título viaja aunque no cambie | muerto | `cambiar_la_intencion_lo_hace_una_persona_o_el_agente_que_la_coordina_y_el_encargo_no_viaja` |
| `m33` | evento | `orch/event_kinds.rs` | task.created de intención con v1 | muerto | `activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1`, `un_agente_solo_crea_hijas_bajo_su_propia_task`, `un_run_nace_con_run_created_v1_y_task_created_v2_de_solo_intencion` |
| `m34` | activity | `orch/activity_format.rs` | activity: v2 para cualquier kind | muerto | `version_no_soportada_y_payload_ilegible_caen_al_respaldo_con_su_motivo`, `activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1` |
| `m35` | sql | `store/migrations/007_tasks.sql` | 007: INSERT en tasks antes del corte | muerto | `antes_del_corte_la_base_rechaza_escribir_aunque_se_salte_el_almacen` |
| `m36` | sql | `store/migrations/007_tasks.sql` | 007: sin árbol coherente | muerto | `la_base_impone_el_arbol_y_que_la_pertenencia_no_cambie` |
| `m37` | sql | `store/migrations/007_tasks.sql` | 007: la pertenencia puede cambiar | muerto | `la_base_impone_el_arbol_y_que_la_pertenencia_no_cambie` |
| `m38` | sql | `store/migrations/007_tasks.sql` | 007: Task del Core sin Project | muerto | `project_es_obligatorio_en_toda_task_del_core` |
| `m39` | sql | `store/migrations/007_tasks.sql` | 007: DELETE en runs antes del corte | muerto | `antes_del_corte_la_base_rechaza_escribir_aunque_se_salte_el_almacen` |

Los mutantes de la 007 se aplican al texto de la migración: los mata el comportamiento de la base, no el checksum (la
prueba que congela el checksum de la 007 se añadió después de la ronda).
