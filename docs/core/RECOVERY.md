# Recuperación al arrancar (LXO-185)

Qué hace un runtime nuevo con lo que dejó el anterior cuando cayó o se cerró sin terminar. Epic F7 (LXO-25). Código: `apps/desktop/src-tauri/src/orch/recovery.rs`; pruebas: `orch/recovery_tests.rs`.

Cada paso ya existía por separado. Lo que añade este contrato es **un orden fijo, un desenlace por paso, una salud explícita y la garantía de que repetirlo converge al mismo estado**.

## Orden

```text
arranque ─► 1 processes        procesos de un runtime anterior            (LXO-183: identidad pid + hora de creación)
         ─► 2 attempts         Attempts que dejó en marcha                (huérfanos; los de una persona se conservan)
         ─► 3 dispatch_claims  claims de despacho en vuelo                (se asientan con evidencia o quedan `ambiguous`)
         ─► 4 queue            instrucciones de la Pending Queue          (`delivering` → `interrupted`; lo encolado de un Attempt acabado falla)
         ─► 5 effects          journal de efectos externos                (solo AÑADE `effect.observed`; nunca repite el efecto)
```

Por qué ese orden:

* `processes` antes que nada: para decidir sobre un Attempt hay que saber si su proceso sigue ahí.
* `attempts` antes que `dispatch_claims`: un claim cuyo Attempt acabó con evidencia canónica se asienta; sin cerrar antes las huérfanas se confundiría con una ejecución viva.
* `queue` tras cerrar los Attempts: lo pendiente de un Attempt que ya no corre falla con motivo.
* `effects` al final: el Event Log ya refleja el estado cerrado y los hechos recuperados se añaden sobre él.

Los pasos 1 a 4 corren al terminar de cargar el estado autoritativo (`finish_authoritative`); el 5, ya con el Core operativo (necesita el Event Log instalado). En modo legacy (almacén degradado) solo corre el 5, y no tiene Event Log donde recuperar: las líneas del journal se conservan.

## Desenlace de cada paso y salud

| Estado | Significa | Efecto |
|---|---|---|
| `done` | Reconciliado. `changed` dice cuántas cosas cambió. | Ninguno. |
| `attention` | Hay algo que una persona debe mirar (líneas v1 o ilegibles del journal, ids conflictivos, compactación pendiente). | Ninguno: es seguro operar. |
| `blocked` | No se pudo reconciliar **con seguridad** (un proceso de otro runtime que no se pudo identificar ni cerrar; el almacén falló al cerrar huérfanos, conciliar claims o recuperar la cola; el journal no se puede leer). | **No se lanzan Attempts nuevos** hasta resolverlo. |
| `skipped` | No aplica en este modo (estado promovido ya cerrado, antes del corte Task/Attempt). | Ninguno. |

Mientras algún paso esté `blocked` la recuperación está **incompleta**:

* `dispatch_attempt` rechaza lanzar (`la recuperación del arranque está incompleta: …`) y el barrido del despachador no lo intenta.
* Se avisa a la persona **una vez por arranque** (`Lixbon: recuperación incompleta`) con el motivo.
* El Core **no** pasa a solo lectura por esto: las lecturas y los comandos de una persona (parar, aprobar, revisar) siguen funcionando. Un Core en solo lectura es otra condición (`Health::DegradedReadOnly`), la del almacenamiento.
* El estado y los artefactos se conservan: nada se borra para «arreglar» un bloqueo.

El barrido periódico **reintenta lo que se puede repetir sin riesgo**: los procesos de **otros** runtimes y el journal. No reintenta `attempts`, `dispatch_claims` ni `queue`: con el runtime en marcha, volver a «cerrar huérfanos» mataría trabajo vivo. Esos tres se resuelven en el siguiente arranque.

## Query `recovery_report`

Solo lectura, sin argumentos, solo para una **Person** autenticada (un Agent recibe `recovery_report_auth_required`; un argumento da `recovery_report_invalid_request`).

```json
{
  "runtime_instance": "…",
  "health": "complete" | "incomplete" | "unknown",
  "launch_allowed": true,
  "blocking": ["processes: 1 proceso(s) de un runtime anterior no se pudieron probar ni cerrar (Attempts: …)"],
  "started_at": 0, "finished_at": 0,
  "phases": [{ "phase": "processes", "status": "done", "changed": 0, "note": null }, …]
}
```

`unknown` solo antes de que el arranque haya terminado. No incluye pids ni rutas: los ids de Attempt bastan para localizar el trabajo. No está en la lista de comandos permitidos de la sesión remota (`REMOTE_COMMANDS`): exponer la salud del host a un relay es una decisión de producto aparte.

## Invariantes

1. **No reejecuta nada.** Ni git, ni push, ni el lanzamiento de un proceso. Que falte un Event nunca es motivo para repetir un efecto: el journal solo añade el hecho `effect.observed`, y la clave `(effect.observed, effect_id)` deduplica un replay tras una caída entre el commit y la compactación.
2. **No adivina procesos.** Se actúa por identidad (pid + hora de creación, nunca por nombre); ante la duda queda `unproven`, a la vista y sin matarlo (`PROCESS_OWNERSHIP.md`).
3. **Estado activo + proceso ausente no queda `working` para siempre:** el Attempt se cierra como huérfano (`exited`), salvo los que una persona tiene en sus manos.
4. **Repetir converge.** Una caída en **cualquier** frontera entre pasos, seguida de otro arranque, deja el mismo estado que un arranque sin caída; y arrancar de nuevo no escribe nada más.
5. **Un fallo deja salud explícita** (informe + aviso + bloqueo de lanzamientos) y conserva los artefactos.
6. **Sin eventos nuevos.** No hay un evento «recuperado»: lo que cambia ya deja su hecho (`task.status_changed` con `cause = orphaned`, `attempt.dispatch_ambiguous`, `attempt.queue_failed`, `effect.observed`); un resumen sería un hecho duplicado.

## ProviderSession tras una caída

Al cerrarse el Attempt huérfano, su sesión deja de estar `open`:

* **Resumible** → `idle`: queda en espera, con su referencia, lista para que un seguimiento la reanude.
* **No resumible** → `closed`. Antes el arranque intentaba dejarla `idle`, la restricción de SQLite (`status <> 'idle' OR resumable = 1`) lo rechazaba y **el Core arrancaba en solo lectura**. Hoy ningún camino de producción crea sesiones no resumibles (las del runtime lo son siempre), así que era un defecto latente; lo encontró la prueba de este contrato.

La recuperación **no reengancha** una sesión viva ni un proceso vivo: sus tuberías eran del Core que murió. Adjuntarse a trabajo que sobrevive a Desktop exige el daemon (rebanada 5 de `ADR_RUNTIME_PERSISTENTE.md`); hasta entonces un proceso hallado vivo se **cierra** con identidad verificada, nunca se «adopta».

## Cobertura de los criterios de LXO-185

| Criterio | Dónde se prueba |
|---|---|
| Crash antes/después de cada frontera de estado, evento y journal | `una_caida_en_cualquier_frontera_converge_al_mismo_estado_que_un_arranque_sin_caida` (cinco puntos de caída frente a un arranque sin caída) |
| Proceso vivo / ausente | `process_ownership_tests` (vivo, ausente, pid reutilizado, sin hora de creación, duda) y `un_proceso_que_no_se_puede_probar_bloquea_los_lanzamientos_…` |
| Pending spawn / queue | `dispatch_boot_tests` (claim reservado → `ambiguous`, sin relanzar), `queue_restart_tests`, y el informe en `el_arranque_ejecuta_los_pasos_en_su_orden_…` |
| ProviderSession resumible / no resumible | `una_sesion_resumible_…` y `una_sesion_no_resumible_…` |
| Journal v2 duplicado | `mutation_tests` (`restart_reconcilia_v2_por_effect_id_…`: duplicado y replay tras commit sin ACK) y `la_recuperacion_solo_anade_hechos_y_nunca_repite_un_efecto` |
| Recovery dos veces = mismo resultado | `repetir_la_recuperacion_no_escribe_nada_mas` |
| Fallo → salud explícita | `un_journal_ilegible_…`, `un_proceso_que_no_se_puede_probar_…`, `la_consulta_recovery_report_…` |
| Fault injection | punto de caída por paso (`crash_after`, solo pruebas), sistema operativo falso (`Os`), journal ilegible |

## Lo que NO cubre (y dónde sigue)

* **Un proceso sin ninguna fila de propiedad** (el Core cayó entre lanzarlo y anotarlo, ventana de milisegundos) no se puede encontrar sin adivinar por nombre, y no se adivina. Lo mitigan el Job de Windows (`KILL_ON_JOB_CLOSE`) y que `adapter_launcher` anota la propiedad justo tras el lanzamiento.
* **Reanudar / adjuntar a una ProviderSession viva:** requiere el daemon.
* **Conflictos de filesystem** (worktrees a medias): no se resuelven automáticamente.
* **`attempts`, `dispatch_claims` y `queue` bloqueados** (almacén que falla) solo se resuelven reiniciando; el Core suele estar además en solo lectura.
* **macOS/Linux:** las pruebas de procesos reales se ejecutaron en Windows; la identidad por hora de creación en otras plataformas queda por verificar (como en `PROCESS_OWNERSHIP.md`).
