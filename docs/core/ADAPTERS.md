# Adapters de proveedor y capabilities (LXO-128)

El Core no habla con Claude ni con Codex: habla con un **adapter** que cumple un contrato común y declara, en una
**matriz de capabilities**, lo que de verdad ofrece. Los clientes (Desktop, CLI, Mobile) pintan esa matriz; **nunca**
deciden por el nombre o la versión del proveedor. Código en `apps/desktop/src-tauri/src/orch/adapter/`.

Fuera de este contrato (otras issues): los adapters reales de Claude y Codex (LXO-129/130) y el payload de ContextPackage
(LXO-133). El comando de resume y su fallback (LXO-134) está en [CONTINUIDAD.md](CONTINUIDAD.md). Usage (LXO-205) está en la
sección [Usage](#usage-lxo-205).

## El adapter

```
trait ProviderAdapter: Send + Sync
  id()                                  id estable del proveedor ([a-z0-9-], hasta 64)
  probe()      -> ProbeResult           qué ofrece y si el entorno lo permite (no arranca nada)
  start(req, cancel)    -> RunHandle
  events(run, cancel, sink) -> RunOutcome   bloquea hasta el final, entregando hechos al sink
  answer(run, answer)            ┐
  interrupt(run)                 │ opcionales: por defecto RECHAZAN con `unsupported_capability`
  steer(run, instruction)        │
  resume(req, cancel) -> RunHandle ┘
```

El Core **no** llama al trait: llama a [`Gated`], que comprueba la matriz antes de cada operación y devuelve el error
estable de su estado sin llegar al adapter (`AdapterRegistry::gated(id)`).

Un adapter **reporta hechos** (`AdapterEvent`, `RunOutcome`); no recibe `Store`, `Tx` ni `State`, así que no puede
escribirlos. Sus tipos de hecho no son `Serialize`: solo llegan a un Event si el Core los mapea a mano.

## Capabilities y estados

Seis capabilities, **todas presentes** en la matriz: `start`, `events`, `answer`, `interrupt`, `steer`, `resume`.
Lo que el proveedor no ofrece consta como `unsupported`; no hay huecos ni "desconocido".

| Estado | Significa | Error de `require` | Qué hace un cliente |
|---|---|---|---|
| `available` | se puede usar | — | habilita la acción |
| `unsupported` | el proveedor no lo ofrece, por diseño | `unsupported_capability` | no muestra botón funcional |
| `unavailable` `{reason}` | lo ofrece, ahora no (sin autenticar, degradado…) | `capability_unavailable` | muestra por qué |
| `environment_blocked` `{block}` | el entorno lo impide (`cli_missing`, `cli_flags_unsupported`, `windows_sandbox_elevated`, `windows_sandbox_setup`) | `environment_blocked` | muestra el bloqueo; **no** es un Attempt fallido |

Forma en JSON (`{ "state": "available" }`, `{ "state": "unavailable", "reason": "…" }`,
`{ "state": "environment_blocked", "block": "cli_missing" }`). La matriz lleva `version` (hoy `1`).

## Entorno ≠ fallo

`probe` devuelve un **resultado de preflight** (`ProbeResult`): `environment` es `ready` o
`blocked { blocks }`, y la matriz queda `environment_blocked` en lo que el bloqueo impide. Un `start` contra un entorno
bloqueado devuelve `environment_blocked`, cuyo `kind()` es `EnvironmentBlocked`: el Core emite `environment.blocked`,
**no** `attempt.failed`. `FailureKind` es la clasificación única: `Rejected` (la petición no se atiende, el Attempt no
cambia), `EnvironmentBlocked`, `Cancelled` y `AttemptFailure` (el proveedor falló ejecutando).

## Errores

Código estable + mensaje + diagnóstico crudo opcional (redactado y acotado a 2048 caracteres, con `…` si se corta).
Códigos: `unknown_capability`, `unsupported_capability`, `capability_unavailable`, `environment_blocked`, `cancelled`,
`invalid_request`, `unknown_provider`, `unknown_run`, `session_not_found`, `provider`, `internal`. Conjunto cerrado: añadir uno
es un cambio de contrato.

`session_not_found` (LXO-134) es el proveedor diciendo que ya no tiene la sesión que se quiso reanudar. Es `Rejected` (no es un
fallo de la ejecución) y el Core lo trata como sesión caducada ([CONTINUIDAD.md](CONTINUIDAD.md#detección-de-la-sesión-caducada)).
Cada adapter lo levanta solo al reanudar y con el texto observado en su CLI real.

## Registro y snapshot

`AdapterRegistry` registra adapters y guarda la última `ProbeResult` de cada uno. El Core lo mantiene vivo (sondeo en segundo plano, sin esperar a las CLIs) y lo expone con la query `provider_capabilities` ([QUERIES.md](QUERIES.md#provider_capabilities-lxo-135)), que es lo que lee Desktop. `snapshot()` es lo que leen los
clientes (`docs/core/fixtures/api/provider_capabilities.v1.json`): por proveedor, `id`, `cli_version`, `environment` y
`matrix`. `generation` sube cuando se registra un proveedor o cuando un `refresh` encuentra una matriz, un entorno o una
versión distintos; un cliente compara `generation` para refrescar su vista **sin reiniciar la app**. Un id inválido o
repetido se rechaza.

## Invariantes

| # | Invariante | Cómo se cumple | Pruebas |
|---|---|---|---|
| 1 | Capability ausente no se simula | la matriz nace `unsupported`; `answer`/`interrupt`/`steer`/`resume` del trait rechazan por defecto; `Gated` no deja pasar lo no disponible | `la_matriz_nueva_declara_las_seis_capabilities_como_unsupported`, `un_adapter_que_no_implementa_una_capability_la_rechaza_sin_fingirla`, `una_capability_no_ofrecida_no_llega_al_adapter` |
| 2 | Los ids del proveedor son opacos | `ProviderRef`: no se imprime (`Debug`), no se serializa, rechaza forma de credencial; solo el Core lo fija en `provider_sessions` | `la_referencia_del_proveedor_es_opaca` |
| 3 | Errores normalizados con diagnóstico seguro | `AdapterError` con código estable; el diagnóstico pasa por `safe_text` (redacta y acota) | `cada_estado_de_la_matriz_da_su_error_estable`, `el_diagnostico_se_acota_marcando_el_corte` |
| 4 | El adapter no escribe State | el trait no recibe `Store`/`Tx`/`State`; los hechos no son `Serialize` | (por construcción del tipo) |
| 5 | Secretos y env sensibles no entran en Events | `StartRequest` no lleva entorno; `Gated::events` redacta todo texto saliente con `looks_secret` | `los_secretos_no_salen_del_adapter` |
| 6 | Entorno bloqueado ≠ Attempt fallido | `ProbeResult::blocked`, `FailureKind::EnvironmentBlocked`; el adapter no arranca con el entorno bloqueado | `entorno_bloqueado_no_es_un_attempt_fallido` |
| 7 | Capability desconocida o no ofrecida: error estable | `unknown_capability` / `unsupported_capability` | `un_nombre_de_capability_que_no_existe_es_unknown_capability_y_uno_no_ofrecido_es_unsupported` |
| 8 | La cancelación llega a la ejecución | `CancelToken` compartido; `Gated` no arranca si ya está cancelado | `cancelar_antes_de_arrancar_no_llega_al_adapter`, `cancelar_durante_events_termina_cancelled`, `interrumpir_termina_interrupted_sin_ser_un_fallo` |
| 9 | Los cambios de capabilities se ven sin reiniciar | `refresh` + `generation` | `refresh_refleja_un_cambio_de_capabilities_sin_reiniciar` |
| 10 | Contrato versionado | `version` de la matriz y del snapshot; la fixture falla si cambia sin subir versión | `la_matriz_serializa_estable_y_hace_roundtrip`, `una_matriz_incompleta_de_otra_version_o_con_nombres_ajenos_no_se_acepta`, `el_snapshot_del_registro_coincide_con_la_fixture_versionada` |
| 11 | Un cierre que no se pudo probar no se declara detenido (LXO-242) | `Process::kill` devuelve `Closure::{Proven, Unproven}` (`#[must_use]`); al terminar `events`, un `Unproven` convierte `Cancelled`/`Interrupted` en un `Failed` de proveedor que lo dice (`outcome_after_close`), y el Core lo ve como un fallo, no como un `stopped` | `un_cierre_sin_probar_no_se_declara_cancelado` (Claude y Codex), `un_exito_no_cambia_aunque_el_cierre_no_se_pudiera_probar`; el supervisor: `un_cierre_sin_probar_queda_en_custodia_con_su_dueno_y_reap_lo_cierra`, `soltar_un_proceso_sin_probar_no_lo_pierde`, `el_apagado_del_core_reintenta_la_custodia_de_los_adapters`, `un_proceso_de_adapter_en_custodia_bloquea_limpiar_y_borrar_hasta_que_se_cierra` |

El fake (`adapter/fake.rs`, solo en pruebas) cubre las seis capabilities y apunta cada llamada que **llega** al adapter,
de modo que una prueba demuestra que `Gated` no la dejó pasar. Cobertura: `el_fake_cubre_las_seis_capabilities_a_traves_de_gated`.

### Cierre de procesos: qué se garantiza y qué no (LXO-242)

* **Garantizado:** el cierre del árbol de un proceso comprueba la identidad de cada proceso antes de matarlo (`proctable::kill_tree`) y nunca termina a uno
  ajeno por reutilización de PID. Si no se puede PROBAR que todo terminó, el cierre es `Unproven` y el árbol se conserva para reintentarlo al soltar el proceso.
* **Un `Unproven` tras `Completed` o `Failed` no cambia ese resultado** (dicen lo que hizo el proveedor, no que el proceso terminó): queda en el log. Solo
  `Cancelled` e `Interrupted`, que afirman que el proceso ya no está, pasan a fallo.
* **Decisión sobre ConPTY (Windows), 2026-11-13:** ConPTY no puede crearse suspendida (`portable-pty` no deja pasar flags de creación), así que su Job se
  adjunta tarde. **Se acepta confirmar su cierre por Job + recorrido del árbol, con residuo documentado**: un proceso que su raíz creó y que escapó ANTES de
  entrar en el Job solo lo cubre el recorrido por `ppid`. No se adopta la regla estricta («un Job tardío nunca confirma»): dejaría todo cierre de ConPTY en
  custodia. Los adapters reales (`claude`, `codex app-server`) no usan ConPTY: nacen suspendidos y dentro del Job.
* **Supervisor (`adapter/supervisor.rs`, LXO-242):** un cierre `Unproven` ya no se reintenta solo en el `Drop` para perderse después. La **familia** del proceso
  (la raíz sin reapear, que ancla su pid, y el árbol con su identidad y su Job) queda en una **custodia global a nombre del Attempt** (`<task>-a<n>`;
  los adapters lo fijan con `Process::set_owner`) hasta que se comprueba el cierre. Antes, soltar el proceso con el cierre sin probar mataba la raíz a ciegas y la
  reapeaba, perdiendo el ancla. Ahora:
  * `Process::kill` y `Drop` registran en el supervisor lo que no se probó (idempotente: la misma familia no se registra dos veces).
  * **Apagado ordenado:** `Core::shutdown` cancela las ejecuciones de los adapters (`kill_all_terms`) y después `supervisor::reap()` reintenta TODA la
    custodia; el barrido periódico (`periodic_sweep`) también.
  * **Visibilidad:** el Resource Manager cuenta un proceso en custodia como «en marcha» (`resource_blocked: running`): no limpia ni borra el worktree de esa Task
    hasta que se cierre (`task_in_custody` compara `<task>-a<dígitos>` exacto: `t9` no es `t90`).
  * La custodia es global al proceso, como la de las terminales: las pruebas que la tocan van de una en una (`pty::pruebas::serie_custodia`).
* **Residuo que sigue:** si el cierre no se puede probar nunca (identidad ilegible permanente), la familia sigue en custodia hasta que el Core se apaga; el
  Core no la descarta ni la mata a ciegas. Un Attempt cuyo cierre no se probó ya terminó como fallo (ver arriba), no como `stopped`. Las rutas de Unix
  (`pidfd`, `setsid`) no se ejercitan en Windows.

## Hechos que reporta un adapter

`AdapterEvent` (no es `Serialize`: el Core decide qué se vuelve un Event) y `RunOutcome`:

| Hecho | Significa |
|---|---|
| `SessionBound { ProviderRef }` | el id de sesión del proveedor, opaco; el Core lo fija en `provider_sessions`, no viaja en ningún Event |
| `Transport { kind, degraded, reason }` | el canal con que corre la ejecución; `degraded` marca un respaldo y `reason` dice por qué se cayó a él |
| `Model { model }` | el modelo EFECTIVO (puede diferir del pedido) |
| `Output { text }` | texto del modelo, redactado y acotado |
| `Question { question_id, text }` | el proveedor pregunta algo a la persona. Claude lo emite al recibir su herramienta `AskUserQuestion` (llega como `can_use_tool`) con una entrada `{questions: […]}`; la respuesta es texto y vuelve en `updatedInput.answers` ([RESPUESTAS.md](RESPUESTAS.md)). Codex no lo emite |
| `Permission { request_id, tool, summary }` | el proveedor pide permiso para una herramienta; el Core decide y responde con `answer` (`allow` o `deny`); el adapter nunca responde por su cuenta |
| `ToolUse { tool, summary }` | usa una herramienta; `summary` es una ruta o un comando de una línea, nunca el contenido |
| `Retry { attempt, max, delay_ms }` | reintento de red del proveedor; informativo |
| `Usage { … }` | uso total al terminar; un campo ausente es `None` (desconocido), nunca 0. `limits` son las ventanas de cuota de la CUENTA que el proveedor declaró durante ese turno (Claude: su `rate_limit_event`, las últimas de ESA ejecución y no las que viera otra; Codex: ninguna), una foto de la cuenta y no lo que gastó el Attempt (LXO-249) |

`ProbeResult.transport` (y el snapshot) dice el canal de un adapter que tiene más de uno (`app_server`, `exec_json`…); falta en los de un solo canal.

`RunOutcome`: `Completed { summary }`, `Interrupted` (la pidió el Core: no es un fallo), `Cancelled`, `Failed(AdapterError)`.
`ResumeRequest` lleva el `profile` (y `model`/`effort`) del Attempt original: reanudar no amplía ni pierde permisos.

## Adapter de Claude (LXO-129)

`claude -p --input-format stream-json --output-format stream-json`, el canal estructurado de la CLI. No lee
`~/.claude/projects`, ni transcripts, ni la TUI. El prompt se envía por stdin (no por el argv). Código en
`orch/adapter/claude/`; capturas reales de Claude Code 2.1.296 saneadas en `orch/testdata/claude-2.1.296-adapter-*.jsonl`.

| Capability | Cómo se declara | Evidencia |
|---|---|---|
| `start`, `events` | flags `--input-format`/`--output-format`/`stream-json` en `--help`; si faltan → `environment_blocked (cli_flags_unsupported)`; sin CLI → `cli_missing` | captura normal |
| `answer` | flag `--permission-prompt-tool` en `--help` (la versión no decide) | con `--permission-prompt-tool stdio`, Claude emite `control_request {subtype: "can_use_tool"}` y acepta `{behavior: "allow", updatedInput}` / `{behavior: "deny", message}`. **Sin ese flag, deniega solo** (`system/permission_denied`) y no pregunta |
| `interrupt` | la sesión debe declarar `interrupt_*` en su `init` (la versión no decide) | `control_request {subtype: "interrupt"}` → `control_response` → `result` con `is_error` |
| `resume` | flag `--resume` en `--help` | solo por `--help`; **no capturado** contra la CLI real |
| `steer` | siempre `unsupported` | observado: un mensaje enviado en mitad de un turno **se encola** y se procesa después (la ejecución de 150 líneas terminó completa antes de "FIN"). Es una cola (LXO-143), no un steer; "Stop & Send" es `interrupt` + mensaje nuevo, lo compone el Core. La cola de verdad es la **Pending Queue del Core** ([COLA.md](COLA.md)): no depende de esta cola del proveedor |

**La versión de la CLI no decide qué ofrece Claude** (LXO-137): las CLI se actualizan solas y una lista de versiones permitidas dejaría
`answer` e `interrupt` fuera en cada release. Decide lo que la CLI ofrece (sus flags en `--help`) y lo que la sesión declara al arrancar. Una
versión que Lixbon no probó (`agents::VERIFIED`) es un **aviso** (`warnings` de la política y del proveedor), no un bloqueo ni una confirmación. Tipos de mensaje que se ignoran a propósito: `hook_*`, `thinking_tokens`,
`rate_limit_event`, resultados de herramientas, y el razonamiento (`thinking`) no se copia nunca.

**Salida acotada (invariante 5 de LXO-129):** un texto del modelo se parte en eventos de hasta 4096 caracteres y la
ejecución tiene un techo de 64 KiB; pasado, solo queda un aviso. Cada línea de stdout se lee con tope de 1 MiB.
**Flujo malformado:** una línea que no es JSON se cuenta y se salta; si el proceso termina sin `result`, la ejecución
**falla** con un diagnóstico (`líneas malformadas: N; stderr: …`, redactado), no se da por completada. El perfil
`autonomia_amplia` (deshabilitado por el producto) no se lanza por esta vía.

### Otros modelos con formato Anthropic

Un `Endpoint { base_url, token_env, model }` apunta la misma CLI a otro servicio compatible (`ANTHROPIC_BASE_URL`).
Cada configuración se registra con su propio id (`claude`, `claude-local`…) y aparece como un proveedor más en el snapshot.

* `base_url` es `https://…`, o `http://` solo hacia `localhost`/`127.0.0.1`/`[::1]`; sin usuario, contraseña, query ni fragmento.
* El **token es obligatorio** y se indica con el NOMBRE de una variable de entorno; se copia a `ANTHROPIC_AUTH_TOKEN` del
  hijo y nunca se guarda ni aparece en un `Debug`. Sin la variable, no se lanza.
* Al hijo se le **quitan** `ANTHROPIC_API_KEY` y `CLAUDE_CODE_OAUTH_TOKEN`: la credencial propia del usuario no viaja a un
  servicio ajeno.
* Comprobado con la CLI real (2.1.296): respeta `ANTHROPIC_BASE_URL`; la CLI avisa de que el token de entorno tiene
  prioridad sobre el login de claude.ai; la única petición observada contra un servidor local (`HEAD /api/hello`) no llevó
  cabeceras de credencial. **Pendiente de validación manual**: qué cabeceras lleva el `POST` de mensajes contra un
  endpoint compatible real.

### Marcadores de las capturas

Las capturas son líneas reales de la CLI. Los marcadores `{"__gate": …}` y `{"__echo": …}` que llevan los `.jsonl`
son SOLO del arnés de pruebas (`claude/fake.rs`): detienen el proceso falso hasta que el adapter escribe lo que la CLI
esperaría. No existen en la salida real de Claude.

### Validación manual

`cargo test --lib orch::adapter::claude::tests::real_claude -- --ignored --nocapture` lanza `claude` de verdad (modelo
haiku, un prompt de una línea, perfil de solo lectura) con el lanzador real. Verificado el 2026-10-26 con Claude Code 2.1.296
en Windows: `probe` listo, `SessionBound`, `Model`, `Output`, `Usage`, `Completed`.

## Adapter de Codex (LXO-130 y LXO-131)

`codex app-server` (JSON por línea sobre stdio, **un proceso por ejecución**) como canal preferido y `codex exec --json`
como respaldo degradado. No lee `~/.codex/sessions`, ni rollouts, ni la TUI. Código en `orch/adapter/codex/`; capturas
reales saneadas de Codex 0.164.0 en `orch/testdata/codex-0.164.0-adapter-*.jsonl`. El esquema del protocolo lo genera la
propia CLI (`codex app-server generate-json-schema`).

| Capability | `app_server` | `exec_json` (degradado) |
|---|---|---|
| `start`, `events` | sí | sí |
| `answer` | sí: `item/commandExecution/requestApproval` y `item/fileChange/requestApproval` → `{decision: accept\|decline}` | no |
| `interrupt` | sí: `turn/interrupt` → el turno acaba `interrupted` | no (solo cancelar) |
| **`steer`** | **sí, de verdad**: `turn/steer` inyecta en el turno EN CURSO (un solo `turn/completed`). En Claude esto es una cola | no |
| `resume` | sí: `thread/resume`, también entre procesos distintos | no: `exec resume` existe pero no admite `-s`/`-C` y no está validado |

**Canal.** Se elige en `probe` **por lo que la CLI ofrece, no por su número de versión** (LXO-137): `app-server` si su `--help` lo incluye; si no,
`exec --json` con el motivo (`esta versión de Codex no incluye app-server`), visible en `ProbeResult.transport`, en `transport_fallback` y en el
evento `Transport`. Una versión nueva puede haber cambiado el protocolo: si `app-server` no arranca (falla el `initialize` o el hilo: errores del
proveedor o del adapter), el lanzamiento **cae a `exec --json`** (sin reanudar: exec no lo ofrece) y el evento `Transport` lo dice con el motivo
(`app-server no arrancó en la versión X (…)`); si exec tampoco puede, vale el error de app-server. Un bloqueo del ENTORNO (el sandbox de Windows), una
petición inválida o una cancelación **no** caen al respaldo: no son un problema del canal. `APP_SERVER_VERIFIED` ya no decide nada: documenta las
versiones contrastadas. Verificado con Codex 0.166.0 (no estaba en esa lista): `start`, `events`, `resume` e `interrupt` por `app-server`.
`app-server` es **experimental**: el protocolo puede cambiar entre versiones. De la 0.163.0 a la 0.164.0 solo se añadió un
método (`feedback/save`) y no se quitó ninguno; los esquemas de `turn/steer`, `turn/interrupt` y de las aprobaciones son
idénticos.

**Flujo.** `initialize` → `initialized` → `windowsSandbox/readiness` → `thread/start` (o `thread/resume`) → `turn/start`. El
hilo es persistente (`ephemeral: false`) para poder reanudarlo. Perfiles: `explorar`/`proponer` → `read-only` y aprobación
`never`; `delegar_con_revision` → `workspace-write` y `on-request` (lo que salga del worktree se pregunta al Core).
`autonomia_amplia` (deshabilitado por el producto) no se lanza. Hechos: el texto del modelo se emite al **completarse** cada
mensaje (los `delta` se ignoran), acotado a 4096 caracteres por evento y 64 KiB por ejecución; `commandExecution`/`fileChange`
→ `ToolUse` con una sola línea; `thread/tokenUsage/updated` → `Usage` (sin coste: Codex no lo informa, `None`, nunca 0). Las
peticiones del servidor que el adapter aún no atiende (`item/tool/requestUserInput`, permisos, MCP…) se **rechazan** con
`-32601` y se avisa con un `Output`, para que Codex no se quede esperando.

**`exec --json`** (observado): `thread.started{thread_id}`, `turn.started`, `item.completed{agent_message}`,
`turn.completed{usage}`. El mensaje va por stdin y hay que **cerrarlo** o `codex exec` se queda esperando. La forma de un
fallo (`turn.failed`, `error`) se lee con tolerancia pero **no tiene captura propia**.

### LXO-131: entorno bloqueado

`is_sandbox_setup_conflict` exige las DOS partes del patrón del piloto (`helper_unknown_error` **y** `setup refresh had
errors`); un texto parecido, o solo una de las partes, es un fallo normal del Attempt. Se comprueba en el mensaje de error de
una petición, en el error de un turno, en el stderr de un proceso cortado y en el preflight `windowsSandbox/readiness`
(`notConfigured`/`updateRequired`). Resultado: `ErrorCode::EnvironmentBlocked` → `FailureKind::EnvironmentBlocked`: **no es
`attempt.failed` y no consume reintentos**, y el mensaje sugiere cerrar la app que lo usa y reintentar (Lixbon nunca mata
procesos ajenos).

La causa es `EnvBlock::WindowsSandboxSetup` (`windows_sandbox_setup`), TIPADA en `AdapterError.env_block`, y recorre el mismo
camino que las demás: el Core la traduce con `Tx::environment_blocked(proveedor, perfil, causa)` → `environment.blocked` +
Attention `environment_blocked` con sujeto `windows_sandbox_setup@<perfil>` (la migración **015** la admite en `env_blocks`;
Activity la muestra en desktop, mobile y CLI con «el sandbox de Windows no está listo o está en uso»).

**Cómo se levanta:** `CodexAdapter::preflight` pregunta a `windowsSandbox/readiness` SIN crear hilos ni gastar cuota, y
`adapter::env_proof(Readiness::Ready)` es la evidencia que se pasa a `Tx::environment_verified`: solo `ready` desmiente la
causa, y solo en el perfil preguntado. `notConfigured`, `updateRequired`, otra prueba de entorno o no haber podido preguntar no
la levantan. En el probe, un sandbox no listo deja la matriz entera en `environment_blocked { windows_sandbox_setup }`.

**Pendiente (no es del adapter):** ningún comando del Core consume todavía los adapters (F5), así que hoy nada llama a
`Tx::environment_blocked` con este error ni lanza el `preflight`: el camino está probado de extremo a extremo
(`el_bloqueo_del_sandbox_de_codex_que_llega_del_adapter_levanta_attention_y_solo_su_preflight_lo_levanta`), pero no cableado a
un comando. Además, el patrón sale de la descripción de la issue: **no hay captura real** de ese error (no se reprodujo la
condición), por lo que falta la validación manual en Windows con la app de escritorio de Codex reteniendo el sandbox.

### Validación manual

`cargo test --lib orch::adapter::codex::tests::real_codex -- --ignored --nocapture --test-threads=1` (modelo `gpt-5.6-luna`,
perfil de solo lectura, lanzador real). Verificado el 2026-10-26 con Codex 0.164.0 en Windows: `probe` con las seis
capabilities y canal `app_server`, `start→events→finish`, `resume` en un proceso nuevo (recordó la palabra) e `interrupt`
→ `Interrupted`. Las ejecuciones con aprobación y `steer` se contrastaron con el `app-server` real en las capturas (0.163.0
y 0.164.0), no con una prueba automática contra la CLI. **No validado:** apuntar Codex a modelos con formato OpenAI de otros
servicios (`model_providers`), y el canal `exec --json` en un fallo real.

## Usage (LXO-205)

Cuánto le queda a la **cuenta** de cada proveedor, normalizado sin fingir lo que el proveedor no da. Código en
`orch/adapter/usage.rs`; informe de ejemplo en `docs/core/fixtures/api/usage_report.v1.json`.

**Qué cuota es.** La de la cuenta de cada proveedor (ventanas de rate limit, plan, créditos), no la de un modelo. El
`UsageService` devuelve **una entrada por proveedor registrado**, en una lista y sin totales: el cliente decide si pinta
todas (vista general) o solo la del proveedor en uso (`AdapterRegistry::usage_target(id)`). El campo `models`
(tokens/coste por modelo) existe en el contrato, pero ningún adapter real lo rellena hoy: consta como `unsupported`.

| Campo (`UsageField`) | Significa |
|---|---|
| `windows` | ventanas de cuota: `id`, `minutes`, `used_percent` (0–100), `resets_at` (Unix s) |
| `tokens` | tokens por modelo (`models[]`) |
| `credits` | `has_credits`, `unlimited`, `balance` (texto con la unidad del proveedor; no son dólares) |
| `plan` | plan de la cuenta |
| `cost` | coste en dólares **informado por el proveedor**; Lixbon nunca lo estima |

`UsageSupport` (por adapter, `usage_support()`) declara el estado de cada campo con los mismos cuatro estados de la
matriz: lo que no se declara es `unsupported`. Un adapter sin soporte no se consulta.

| Proveedor | Qué da | Procedencia |
|---|---|---|
| Codex (`app-server`) | `account/rateLimits/read`: ventanas por `limitId` (`codex.primary`, `codex.secondary`…), plan, créditos, límite alcanzado, cuenta | `provider_query`: se pregunta ahora, sin crear hilo ni gastar cuota |
| Codex (`exec --json`) | nada: `unavailable` (no hay canal para preguntar) | — |
| Claude (nativo, versión verificada) | `claude -p /usage`, el comando local de la CLI (0 turnos, coste 0): ventanas `five_hour` (sesión) y `seven_day` (semana, todos los modelos). La hora de reinicio viene como texto con zona IANA y no se convierte: `resets_at` queda desconocido | `provider_query` |
| Claude (versión sin verificar o `/usage` falla) | ventanas del último `rate_limit_event` de una ejecución, con la hora de reinicio que trae | `run_observation`; sin ninguna ejecución, `unavailable` |
| Claude con endpoint propio | nada: no se atribuyen al servicio de otro los límites de Anthropic | — |

**`claude /usage`.** Solo se lanza en versiones donde se comprobó que es un comando local (2.1.296): en otra podría llegar al modelo y gastar
cuota. Aun así se vigila: si aparece un mensaje del modelo (cualquiera que no sea el sintético `<synthetic>`), se mata el proceso
y no se usa el texto. De su salida solo se leen las líneas `Current session|week (…): N% used`; el resto (skills, servidores
MCP, subagentes que más consumen) es actividad local de la persona y no se copia. Corre en una carpeta vacía propia, no en
el TEMP del sistema (la CLI escanea su `cwd`: 20,7 s frente a 5,3 s), con un tope de 30 s.

**Semántica**
* `snapshot` lleva `provider`, `observed_at_ms`, `provenance` y `account` (huella de 8 hex de un SHA-256; el identificador
  de la cuenta nunca sale). La frescura se mide desde `observed_at_ms`, no desde que se consultó.
* `status`: `fresh` (dentro del TTL), `stale` (más viejo que el TTL, o el último refresco falló: se conserva el dato
  anterior y `error` dice por qué), `unknown` (sin dato: **no es cero**), `unsupported`, `environment_blocked`.
* Un valor ausente es desconocido. Un valor imposible (porcentaje fuera de 0–100, coste negativo o no finito) se
  descarta; no se corrige. Claude da `utilization` como fracción 0–1: fuera de ese rango se descarta.
* `limit_reached`: `Some(true/false)` solo si el proveedor lo dice; si no, ausente.
* Errores (`UsageErrorKind`, conjunto cerrado): `auth_required`, `rate_limited`, `provider_unavailable`, `unsupported`,
  `environment_blocked`, `internal`. Ninguno falla un Attempt: la consulta es una llamada aparte.
* Caché: TTL de 5 min; tras un fallo no se reintenta en 30 s salvo refresco manual; un refresco manual (`Refresh::Force`)
  se atiende con la caché (`throttled: true`) si hay otra consulta de hace menos de 5 s. Cada consulta tiene un tope de
  15 s, tras el cual se cancela y cuenta como `provider_unavailable`; solo hay una consulta en vuelo por proveedor.
* Los textos del proveedor (plan, ids de ventana, modelo, saldo, errores) salen redactados y acotados. Como mucho 8
  ventanas y 16 modelos por proveedor.

**No incluye:** facturación propia, estimación de coste, telemetría remota, ni `account/tokenUsage/read` de Codex
(totales de por vida: no es uso de límites y mezclaría magnitudes).

**Añadir un proveedor:** implementa `usage_support()` y `usage()` (ambos opcionales). Devuelve `Provenance::ProviderQuery`
solo si preguntaste ahora; si reutilizas lo visto en una ejecución, `RunObservation` con el momento real. Pon el
identificador de cuenta en `account_id` (el servicio lo convierte en huella) y no rellenes lo que el proveedor no dio.

## Compatibilidad

* Añadir un estado, una capability o un código de error **cambia el contrato**: sube `MATRIX_VERSION`/`SNAPSHOT_VERSION`
  y regenera la fixture (`LXO_WRITE_API_FIXTURES=1 cargo test --lib orch::adapter`; revísala a mano).
* Añadir un campo de uso, un estado o un tipo de error de Usage cambia el contrato: sube `USAGE_VERSION` y regenera
  `usage_report.v1.json` con `LXO_WRITE_API_FIXTURES=1`.
* Una matriz de versión desconocida, con una capability de menos o con un nombre ajeno **no se acepta** al leerla.
* Un cliente que no conoce un estado nuevo debe tratarlo como "no disponible" y mostrar su `reason`/`block` si lo trae;
  nunca como disponible.

## Añadir un proveedor nuevo

1. Implementa `ProviderAdapter` en un módulo propio. Obligatorios: `id`, `probe`, `start`, `events`. **No** implementes
   `answer`/`interrupt`/`steer`/`resume` si el proveedor no los ofrece: el valor por defecto ya los rechaza.
2. En `probe`, parte de `CapabilityMatrix::new()` (todo `unsupported`) y declara con `.with(...)` solo lo que el
   proveedor ofrece de verdad **en esa máquina**. Si el entorno impide usarlo, devuelve `ProbeResult::blocked` con el
   `EnvBlock` que corresponda (no un error de Attempt).
3. No leas formatos internos privados del proveedor como contrato estable; usa su salida estructurada.
4. Entrega el id de sesión del proveedor con `AdapterEvent::SessionBound { ProviderRef }` y no lo vuelques a ningún texto.
5. Mira `cancel` entre pasos y termina con `RunOutcome::Cancelled`; una interrupción pedida termina con `Interrupted`.
6. Registra el adapter (`AdapterRegistry::register`). Ningún cliente cambia: lee el snapshot.
7. Pruébalo con las mismas piezas que el fake: matriz declarada, ciclo `start`→`events`, cancelación, entorno bloqueado y
   que ninguna salida contiene secretos.
