# Adapters de proveedor y capabilities (LXO-128)

El Core no habla con Claude ni con Codex: habla con un **adapter** que cumple un contrato común y declara, en una
**matriz de capabilities**, lo que de verdad ofrece. Los clientes (Desktop, CLI, Mobile) pintan esa matriz; **nunca**
deciden por el nombre o la versión del proveedor. Código en `apps/desktop/src-tauri/src/orch/adapter/`.

Fuera de este contrato (otras issues): los adapters reales de Claude y Codex (LXO-129/130), el payload de ContextPackage
(LXO-133), el comando de resume y su fallback (LXO-134) y Usage (LXO-205).

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
| `environment_blocked` `{block}` | el entorno lo impide (`cli_missing`, `cli_flags_unsupported`, `windows_sandbox_elevated`) | `environment_blocked` | muestra el bloqueo; **no** es un Attempt fallido |

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
`invalid_request`, `unknown_provider`, `unknown_run`, `provider`, `internal`. Conjunto cerrado: añadir uno es un cambio de
contrato.

## Registro y snapshot

`AdapterRegistry` registra adapters y guarda la última `ProbeResult` de cada uno. `snapshot()` es lo que leen los
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

El fake (`adapter/fake.rs`, solo en pruebas) cubre las seis capabilities y apunta cada llamada que **llega** al adapter,
de modo que una prueba demuestra que `Gated` no la dejó pasar. Cobertura: `el_fake_cubre_las_seis_capabilities_a_traves_de_gated`.

## Compatibilidad

* Añadir un estado, una capability o un código de error **cambia el contrato**: sube `MATRIX_VERSION`/`SNAPSHOT_VERSION`
  y regenera la fixture (`LXO_WRITE_API_FIXTURES=1 cargo test --lib orch::adapter`; revísala a mano).
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
