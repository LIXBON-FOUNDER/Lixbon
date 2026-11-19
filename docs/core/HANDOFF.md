# Agent Handoff (LXO-172)

Estado: **implementado en el Core**, conectado al despachador. `[CORE][F6]`, Trabajo 5 del epic [LXO-24](https://linear.app/lixbon/issue/LXO-24).

`attempt_handoff` traspasa el trabajo de un Attempt **terminado** a otro agente (u otra sesión del mismo), llevando el contexto en un
[ContextPackage](CONTEXT_PACKAGE.md) verificado. Es el camino explícito para lo que [CONTINUIDAD.md](CONTINUIDAD.md) dejó fuera del puente:
`attempt_resume` solo reanuda la ProviderSession del mismo proveedor y no cambia de agente.

| Comando | Qué hace | Proveedor | Sesión del proveedor |
|---|---|---|---|
| `attempt_retry` | Attempt limpio, desde el encargo | puede cambiar | nueva |
| `attempt_resume` | continúa la conversación | el mismo | **la misma** |
| `attempt_fork` | Task nueva a partir de un Attempt | puede cambiar | nueva |
| **`attempt_handoff`** | Attempt `n + 1` de **la misma Task**, con el contexto del `n` | el que se elija | nueva (nunca se copia) |

Lo hace el Core ([`orch/handoff_runtime.rs`](../../apps/desktop/src-tauri/src/orch/handoff_runtime.rs)). La CLI ya lo pide (`lxo attempt handoff`, [LXO-179](https://linear.app/lixbon/issue/LXO-179); ver más abajo); la selección de receptor en Desktop sigue pendiente ([LXO-177](https://linear.app/lixbon/issue/LXO-177)).

## Petición

```json
{ "task_id": "t2", "from_attempt_id": "t2-a1", "provider": "codex",
  "model": "…", "effort": "…", "instruction": "termina los tests que faltan",
  "package_id": "sha256:…" }
```

| Campo | |
|---|---|
| `task_id`, `from_attempt_id` | el Attempt fuente, que tiene que ser **el último** de la Task y estar **terminado** (`done`, `failed`, `stopped`, `exited`). Nombrarlo es lo que hace la petición exacta y permite el `Replayed` |
| `provider` | **obligatorio**: el Core nunca elige el receptor. Puede ser el mismo del fuente (sesión nueva, motivo `requested`) |
| `model`, `effort` | opcionales. Son del proveedor: con otro receptor no se heredan; con el mismo, sí |
| `instruction` | opcional: qué quiere la persona que haga el receptor con ese contexto. Va detrás del paquete |
| `package_id` | opcional: un paquete **ya guardado** (`context_package_build` / `context_package_import`) que la persona revisó. Sin él, el Core construye uno del worktree del fuente con las mismas reglas que `context_package_build` |

**No acepta** `profile`, `worktree`, `host` ni `session` (`deny_unknown_fields`): el perfil se hereda (un traspaso nunca amplía lo que el agente
puede hacer), el worktree lo decide el lanzador como en cualquier Attempt, y la sesión nunca se comparte.

## Flujo

```
1. Person autenticada (Desktop o CLI; un agente no)           ← antes de tocar nada
2. el fuente es el último de la Task y está terminado
3. ¿ya existe el siguiente?  si nació de un traspaso con esta intención → Replayed (no escribe nada)
4. lanzador instalado, Project con ubicación, preflight del RECEPTOR
5. el paquete: el guardado o uno construido ahora → parse (identidad + secretos) y `source` == este Attempt y este Project
6. UNA mutación: la Task vuelve a `starting` (Desktop) o `pending_approval` (CLI), nace el Attempt n+1 y `attempt.continued`
7. el despachador lo lanza por el adapter receptor
```

Todo lo de 1 a 5 falla **antes de escribir**: el Attempt fuente, la Task y el almacén quedan como estaban. Con la CLI el Attempt nace
`pending_approval` y no se lanza hasta que una Person de Desktop lo aprueba (como `attempt_retry` y `attempt_resume`).

### Respuesta

```json
{ "status": "Requested | Replayed", "task_id": "t2", "attempt_id": "t2-a2", "source_attempt_id": "t2-a1",
  "attempt_status": "starting", "strategy": "context_package", "reason": "provider_changed | requested",
  "package_id": "sha256:…", "transfer": { … } }
```

`transfer` (solo en `Requested`; en un replay se consulta el paquete con `context_package_get` + `context_package_preview`) dice qué viajó y qué se
quedó fuera, calculado **sobre el paquete** sin reinterpretarlo:

* `carried`: objetivo, nº de decisiones y restricciones, resumen del hilo, revisión, cambios sin commit, pruebas, artefactos y adjuntos.
* `left_out`: códigos cerrados, siempre en este orden: `provider_session` (siempre), `revision_absent`, `truncated` (campo y tamaño original),
  `attachment_omitted`, `redacted` (cuántos valores), `test_results_absent`.
* `summary`: el mismo resumen que `context_package_preview`.

## Lo que ve el receptor

El encargo de la Task gana un bloque delimitado (`HANDOFF_MARKER` … `HANDOFF_END`) que el despachador entrega como prompt, tras el encargo original:

1. el prompt de continuación del paquete (dice que es contexto de otro agente, que se verifique `head_tree`/`diff_sha256` y que `[redactado]` es a propósito);
2. **QUÉ TE LLEGA** y **QUÉ SE QUEDÓ FUERA** (lo mismo que `transfer`, en texto);
3. la instrucción de la persona, si la hubo.

Un traspaso posterior **sustituye** el bloque anterior (el paquete nuevo ya lo contiene) y el paquete se construye con el encargo **sin** los
traspasos anteriores: así los paquetes no se anidan unos dentro de otros. Los bloques «Seguimiento» que haya fuera del bloque se conservan.

## Procedencia

Un solo hecho por Attempt, **`attempt.continued`** con `strategy: "context_package"` (ya existía; no hay evento nuevo):

```json
{ "task": "t2", "n": 2, "from_n": 1, "strategy": "context_package", "reason": "provider_changed", "package_id": "sha256:…" }
```

Va en la misma mutación que el Attempt. Nunca lleva el encargo ni el contenido del paquete: solo su identidad, que se verifica contra el paquete
guardado. Resuelve el `failed` del Attempt anterior en Attention, como `attempt.retried`. Activity ya sabe mostrarlo
([ACTIVITY.md](ACTIVITY.md)). La procedencia se reconoce por ese hecho y no por el estado actual de la Task (`Store::attempt_follow_up_kind` →
`Handoff`), así que un replay no confunde un traspaso con un retry ni con un resume.

## CLI: `lxo attempt handoff` (LXO-179)

```text
lxo attempt handoff <attempt_id> --provider P [--model M] [--effort E] [--instruction "…"] [--context-package sha256:…] [--dry-run] [--json]
```

Traduce a `attempt_handoff` sin inventar nada. `--provider` es obligatorio (lxo no elige receptor). Antes de pedirlo al Core comprueba que el Attempt esté terminado (si no, remite a `lxo attempt stop`) y, con `--context-package`, que el paquete guardado salga de ese Attempt y de ese Project; que sea el último de la Task y la intención de un traspaso ya hecho los decide el Core.

* `--context-package` es el **id** (`sha256:…`) de un paquete ya guardado, no un archivo: lo que se transfiere es lo que la persona revisó (`lxo context export` / `lxo context import` / `lxo context show`). Sin él, el Core construye uno del worktree del origen.
* `--dry-run` no escribe: enseña el origen, el receptor, el estado del worktree, la policy (`start`) y, con paquete, el **resumen** de lo que viajaría (`context.summary`), para confirmar antes de traspasar. Sin paquete dice que lo construirá el Core.
* El Attempt nuevo nace `pending_approval` hasta que Desktop lo apruebe. Repetir el comando devuelve `Replayed` con el Attempt existente (y sin `transfer`: el Core solo lo calcula al crearlo).
* No acepta `--profile`, `--session`, host ni estrategia de worktree, ni `--confirm` (`start` no lo pide), ni `--request-id` (el traspaso es idempotente por su Attempt origen).

`--json` (v1): `{v, command: "handoff", status: Requested | Replayed | dry_run, task_id, project_id, source_attempt_id, attempt_id, attempt_status, approval_required, approval_surface, target, strategy: "context_package", reason: provider_changed | requested, package_id, transfer, provenance, link}`. `transfer` es el de [la respuesta del Core](#respuesta): `carried` y `left_out` (qué viajó y qué no). Los códigos de salida son los de `lxo delegate` (2 uso, 3 autenticación o policy, 4 contrato, 5 no disponible, 6 inexistente).

## Qué NO hace

* **No copia la ProviderSession** entre proveedores (ni dentro del mismo): `session_ref` se borra y el receptor solo tiene lo que dice el paquete.
* No toca el Attempt fuente ni su worktree: es inmutable y sigue accesible (otra fila, otro worktree).
* No elige el proveedor, no amplía permisos y no integra ni hace merge.
* **No traspasa un Attempt en marcha**: primero `attempt_stop` y luego se traspasa el resultado. «Pausado» (en espera de una respuesta) queda fuera de esta primera versión.
* No elige host ni estrategia de worktree: usa el Project de la Task en esta máquina y el worktree nuevo de cualquier Attempt.
* **El paquete que construye el Core no trae pruebas ni decisiones** (el constructor deja `test_results` y `decisions` vacíos): el receptor lo lee como
  `test_results_absent`. Un paquete importado con esas secciones sí las lleva.

## Policy y errores

Categoría **`start`** (es lanzar un Attempt nuevo de la Task, como `attempt_retry`). Sin lanzador instalado: `traspasar un Attempt requiere el lifecycle de
lanzamiento verificado`. Los rechazos síncronos (paquete ajeno, proveedor sin entorno, Attempt en marcha…) devuelven el error a quien lo pidió y **no
crean nada**; si el receptor falla **al lanzar**, el Attempt nuevo queda `failed` con su Attention `failed` activa, el fuente y el paquete se conservan, y
la persona puede volver a traspasar desde el que falló.

| Código | Cuándo |
|---|---|
| `attempt_handoff_conflict` | repetir la petición con otro receptor, modelo o paquete, o el siguiente Attempt no nació de un traspaso |
| `context_package_source_mismatch` | el paquete no es de este Attempt o de este Project |
| `context_package_invalid` | el paquete no pasa `parse` (versión, identidad, secretos) |
| `context_store_not_found` | no hay un paquete guardado con ese `package_id` |

## Decisiones a revisar

1. **Misma Task, Attempt `n + 1`**, no una Task nueva (eso es `attempt_fork`). Encaja con «a lo sumo un Attempt activo por Task» y con la historia lineal del Attempt.
2. **Sin evento nuevo**: se reutiliza `attempt.continued` con estrategia `context_package`. Evita registrar un evento más en Desktop, CLI y Mobile.
3. **El paquete viaja en el encargo** (como en Fork). Es lo que el despachador entrega al proveedor; el límite es el del paquete (64 KiB).
