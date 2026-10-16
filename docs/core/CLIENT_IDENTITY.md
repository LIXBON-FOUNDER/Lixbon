# Identidad de cliente en Core (F1)

## Contrato

`client_id` identifica una instalación y superficie; no identifica a la persona ni reemplaza al actor. La identidad estable se recupera por `(surface, installation_id)`. `device_id` es separado y opcional. Una instalación puede registrar credenciales de distintos principals que comparten el mismo `client_id`.

Una credencial autenticada tiene principal `Person(id)` o `Agent(task_id)`. `System` no puede registrarse como cliente externo. El Core usa la identidad reservada `core-system`, sin token. Las superficies registrables son Desktop, CLI, Mobile y Automation; `core` queda reservada al Core.

Tras `Store::authenticate_client`, `AuthenticatedClient` es la fuente de actor, scope y `client_id`. `MutationContext::authenticated` fija el canal desde el transporte y deriva el actor desde la credencial. Los claims opcionales de actor, cliente, superficie, scope y canal solo se aceptan si coinciden con la identidad autenticada. Los Events y el journal reciben el `client_id` del contexto; nunca reciben credenciales.

## Matriz de identidad y permisos

Los permisos se evalúan después de clasificar el comando como `ClientAction`. La superficie también limita acciones de Person.

| Identidad autenticada | Actor derivado | Scope | Acciones permitidas por la frontera autenticada |
| --- | --- | --- | --- |
| Person + Desktop | `person`, actor_id de la persona | `Person(id)` | Lecturas, comandos de agente/Desktop, Event Log, comandos UI y decisiones humanas; nunca comandos reservados al Core. |
| Person + CLI | `person`, actor_id de la persona | `Person(id)` | Lecturas y comandos clasificados como `AgentCommand`. Los comandos `list`, `show` y `projects` conservan alcance global en esta fase. Event Log, comandos UI, decisiones humanas y comandos de agente/Desktop quedan rechazados. |
| Agent + CLI | `agent`, actor_id=`task_id` | `AgentTask(task_id)` | Lecturas, Event Log y comandos de agente/Agent-or-Desktop admitidos por la política actual. Los métodos de comando aplican sus comprobaciones de relación con la Task; `show` y `projects` siguen siendo lecturas globales. |
| Core interno | `system`, sin actor_id externo | `System` | Lecturas y comandos internos del Core; no decisiones humanas ni comandos de agente. No existe una credencial externa System. |

La clasificación de comandos debe ser explícita al añadir RPCs. En esta implementación, comandos no clasificados caen en `AgentCommand`; por tanto, esa ruta no es fail-closed para Person/CLI y requiere revisión al extender el dispatcher.

## Amenazas y controles

| Amenaza | Control en la ruta autenticada |
| --- | --- |
| El request declara otro actor o cambia de Agent | El actor se deriva del principal autenticado; claims discrepantes se rechazan. |
| El request declara otro `client_id` | Se valida contra la identidad recuperada; el Event recibe el valor de la credencial, nunca el del body. |
| El request eleva superficie, canal o scope | La superficie y el scope se validan contra Store; el canal lo fija el transporte. |
| Una credencial registrada de Agent se usa como Person o Core | `AgentTask(task_id)` no puede ejecutar acciones UI ni decisiones humanas; System/Core no se registra como cliente externo. |
| Una credencial se filtra a SQLite, Event, journal o `Debug` | Store conserva SHA-256 del secreto; `ClientCredential` lo redacta en `Debug` y no se serializa. |

`ClientCredential::new` exige al menos 32 bytes, pero esa comprobación de longitud no demuestra entropía. El token de identidad Desktop se genera hoy mediante `random_token()` y solo se mantiene en memoria; el código no acredita que ese generador sea CSPRNG. No tratarlo como un mecanismo de emisión para credenciales remotas. El bearer legacy de `lxo` es un mecanismo distinto y sigue descrito abajo como deuda de seguridad.

## Fronteras autenticadas de LXO-85

Tauri fija `Channel::Ui` y usa una credencial local registrada en Store con principal `Person("user")`, superficie Desktop e instalación `desktop-local`. Store recupera el `client_id` estable por `(surface, installation_id)`. La credencial Desktop queda en memoria del proceso y SQLite guarda su hash. Los argumentos de la interfaz no pueden cambiar actor, canal ni `client_id`.

`POST /rpc` y `GET /events` aceptan credenciales registradas por cliente. El transporte autentica el bearer en Store; claims opcionales como `caller`, principal, superficie, scope, canal y `client_id` deben coincidir. El servidor deriva `Caller` de la identidad autenticada. La API HTTP usa el canal `lxo`; por ello, una credencial Desktop no puede presentarse por esa frontera.

Todavía no existe un emisor productivo de credenciales CLI/Agent. La ruta HTTP autenticada se valida con credenciales creadas por pruebas; LXO-86 debe implementar su emisión, almacenamiento y ciclo de vida. Las credenciales productivas actuales son las de Desktop in-process. Cada arranque de Desktop registra una credencial nueva para el mismo `client_id`; además, la identidad cacheada no se revalida al revocar esa credencial. Son límites de ciclo de vida pendientes, no propiedades garantizadas por el modelo.

El modelo separa `device_id` de `client_id`, pero Desktop todavía no informa un identificador del dispositivo. Mobile y Automation existen como superficies del modelo, sin transporte nuevo en LXO-85.

## Compatibilidad temporal y deuda de LXO-86

Los clientes CLI `lxo` actuales siguen en una ruta legacy: leen un bearer compartido publicado en `orch.json` y envían `caller`. Esa ruta no crea `AuthenticatedClient`, no prueba el `client_id` del cliente y no ata el bearer a una Task concreta. Un cliente con ese bearer puede declarar el ID de otra Task Agent. No presentar este comportamiento como aislamiento autenticado ni como cumplimiento de los invariantes de Agent.

**LXO-85 acepta esta compatibilidad solo como transición. No satisface estos dos invariantes de seguridad; LXO-86 debe cerrarlos antes de retirar esta deuda:**

1. **Invariante 2 (scope de Agent):** la credencial debe quedar vinculada al Attempt/Task permitido y el Core debe derivar y verificar ese scope desde la credencial en la frontera autenticada. El bearer compartido de `orch.json` y el `caller` declarativo no cumplen este requisito.
2. **Invariante 3 (sin secretos en `orch.json`):** LXO-86 debe retirar de ese archivo el bearer legacy, migrar `lxo` a credenciales almacenadas en el secure store soportado y probar que credenciales inválidas, revocadas o con scope ajeno se rechazan.

Plan de migración de LXO-86:

1. Persistir `client_id` estable por instalación CLI y obtener una credencial por principal/scope.
2. Guardar la credencial en el almacén seguro de la plataforma; no escribirla en `orch.json`, logs ni shell history.
3. Negociar versión/protocolo antes de mutaciones incompatibles y derivar actor/scope exclusivamente desde Store.
4. Migrar los comandos soportados, verificar permisos y retirar el bearer global y el claim legacy `caller`.

Los Events históricos sin identidad verificada conservan `client_id = NULL`; LXO-85 no inventa atribución retroactiva. El journal de efectos v2 conserva el `client_id` opcional para reconciliar mutaciones.

## Migración y rollback

La migración SQLite `005_clients` agrega el registro de clientes sin reescribir Events históricos. El journal v2 anterior a este cambio se sigue leyendo con `client_id = None`.

**No se admite downgrade a un binario anterior después de aplicar `005_clients` o escribir registros nuevos del journal v2.** El binario anterior puede rechazar la base por esquema desconocido y no puede leer ningún registro v2 nuevo: todos incluyen la clave `client_id` (con `null` en la ruta legacy) y `RecordV2` rechaza campos desconocidos. La recuperación debe avanzar con una versión compatible; preservar un backup antes de actualizar.
