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
| Person + CLI | `person`, actor_id de la persona | `Person(id)` | Operador humano local con alcance global en esta fase. Puede leer el Event Log y usar operaciones normales del coordinador CLI (`AgentCommand` y `AgentOrDesktopCommand`), además de lecturas globales. No tiene una relación de Task: `root_task` es solo un selector de contexto local, se valida como raíz existente y nunca cambia la identidad Person. `spawn`, `spawn_status`, `wait`, `check`, `inbox` y los defaults de `status`, `list` y `show` usan la raíz guardada localmente. `run_create` no reemplaza una sesión cuyo run siga abierto; primero se debe cerrar. `run_close` exige esa raíz y valida que sea una raíz existente. Comandos UI, decisiones humanas, Core y acciones desconocidas quedan rechazados. |
| Agent + CLI | `agent`, actor_id=`task_id` | `AgentTask(task_id)` | Lecturas, Event Log y comandos de agente/Agent-or-Desktop admitidos por la política actual. Las mutaciones sobre Task validan que el destino sea la Task autenticada o un descendiente suyo; el Agent no puede actuar sobre otra rama. `run_close` deriva el run de la Task raíz autenticada y rechaza un selector distinto. `show` y `projects` siguen siendo lecturas globales. |
| Core interno | `system`, sin actor_id externo | `System` | Lecturas y comandos internos del Core; no decisiones humanas ni comandos de agente. No existe una credencial externa System. |

La clasificación de comandos debe ser explícita al añadir RPCs. Los comandos no clasificados son `Unknown` y se rechazan para todas las credenciales externas.

## Amenazas y controles

| Amenaza | Control en la ruta autenticada |
| --- | --- |
| El request declara otro actor o cambia de Agent | El actor se deriva del principal autenticado; claims discrepantes se rechazan. |
| El request declara otro `client_id` | Se valida contra la identidad recuperada; el Event recibe el valor de la credencial, nunca el del body. |
| El request eleva superficie, canal o scope | La superficie y el scope se validan contra Store; el canal lo fija el transporte. |
| Una credencial registrada de Agent se usa como Person o Core | `AgentTask(task_id)` no puede ejecutar acciones UI ni decisiones humanas; System/Core no se registra como cliente externo. |
| El token Agent declara otra Task por `caller` | El actor y el alcance se resuelven desde la credencial; `X-Lixbon-Caller` se ignora en HTTP y claims distintos en RPC se rechazan. |
| Se reutiliza una credencial vieja | Credenciales CLI vencidas tras 90 días; las expiradas, revocadas e inválidas reciben errores de autenticación distintos y no autorizan RPC. |
| Una credencial se filtra a SQLite, Event, journal o `Debug` | Store conserva SHA-256 del secreto; `ClientCredential` lo redacta en `Debug` y no se serializa. |

`ClientCredential::new` exige al menos 32 bytes, pero esa comprobación de longitud no demuestra entropía. Las credenciales Person CLI y Agent usan `getrandom`; el secreto Person se conserva en el almacén seguro del SO y el token Agent solo vive durante el proceso que lo recibe. La identidad temporal interna de Desktop no se expone como credencial remota.

## Fronteras autenticadas de LXO-85

Tauri fija `Channel::Ui` y usa una credencial local registrada en Store con principal `Person("user")`, superficie Desktop e instalación `desktop-local`. Store recupera el `client_id` estable por `(surface, installation_id)`. El secreto se usa al registrar la credencial y luego se descarta; Core conserva la identidad autenticada en caché y SQLite guarda el hash. Los argumentos de la interfaz no pueden cambiar actor, canal ni `client_id`.

`GET /handshake`, `POST /rpc` y `GET /events` exigen bearer registrado y autenticado por Store. `/handshake` admite solo superficie CLI y entrega versión de Core, protocolo, esquema, capabilities y el `client_id` autenticado. El protocolo actual es `1`, el esquema mínimo para `lxo` es `6` y las capabilities publicadas son `rpc` y `events.read`. El sidecar rechaza versiones incompatibles antes de enviar RPC. HTTP distingue credencial inválida, vencida o revocada (401), scope/superficie prohibidos (403) y almacén/Core no disponible (503). La ruta ya no acepta el token compartido legacy.

Los comandos normales de coordinación CLI usan credencial `Person` + superficie `CLI`; la identidad y el actor proceden del bearer registrado. `Caller::User` representa al operador humano local global de esta fase: el CLI Person no conserva una relación de Task, y el campo `caller` del cliente anterior no otorga identidad ni alcance. El coordinador conserva acciones como `run_create`, `spawn`, `spawn_status`, `wait`, `check`, `inbox`, `continue`, `diff`, `stop`, `release`, `run_close` y `events`; las acciones de interfaz y decisiones humanas quedan fuera de la superficie CLI. Para las operaciones ligadas a la sesión, `lxo` envía `root_task` como selector desde su archivo local; Core comprueba que exista y sea raíz, y conserva la atribución Person de los Events. `run_create` aplica la misma protección de sesión que el resto de superficies: un run abierto se cierra antes de crear otro. Un Agent no elige la raíz: Core deriva la tarea de su credencial e ignora cualquier selector Person.

Al iniciar el orquestador, Core conserva un `installation_id` aleatorio en `~/.lixbon/cli-client.json`; el archivo contiene solo ese identificador. El secreto Person de CLI se crea con aleatoriedad criptográfica y vive en el almacén del SO bajo servicio `lixbon`, cuenta `client/cli/<installation_id>`. `orch.json` publica únicamente `port`, `client_id`, `installation_id`, `pid`, `version` y la ruta `lxo`. No incluye el secreto.

Cada Agent lanzado recibe `LXO_CLIENT_TOKEN` en su entorno de proceso. Core registra la credencial con superficie CLI y principal `Agent(task_id)` antes del spawn; el bearer concede únicamente el scope de esa tarea. Core revoca esas credenciales cuando termina la terminal y al siguiente arranque. El transporte no usa `caller` como autoridad: el campo se ignora en cabeceras HTTP y se rechaza si contradice la identidad en un RPC.

La credencial Person CLI se rota automáticamente al vencer su TTL de 90 días. Un secreto inválido o revocado no se autoinscribe: para una recuperación manual, cierra Lixbon, elimina la entrada `lixbon:client/cli/<installation_id>` del almacén del SO y respalda/elimina `~/.lixbon/cli-client.json`; al volver a abrir, Core crea una instalación y credencial nuevas y revoca las credenciales Person CLI previas de esa base. La revocación conserva en memoria los client IDs Agent pendientes y reintenta antes de aceptar cualquier bearer; si SQLite no confirma la revocación, HTTP falla cerrado con Core no disponible. La recuperación Person tras corrupción/revocación es manual; la rotación de Agents es automática por proceso. No se proporciona fallback en texto plano si el almacén seguro no está disponible.

La matriz de adaptadores está en [`docs/secure-store/README.md`](../secure-store/README.md): Windows Credential Manager está verificado; macOS Keychain y Linux Secret Service siguen pendientes de CI/UAT. LXO-86 no declara soporte funcional para esos dos adaptadores hasta validar sus gates. En un SO sin adaptador, el listener no se publica y la interfaz sigue disponible.

El modelo separa `device_id` de `client_id`, pero Desktop todavía no informa un identificador del dispositivo. Mobile y Automation existen como superficies del modelo, sin transporte nuevo en LXO-85.

Los Events históricos sin identidad verificada conservan `client_id = NULL`; LXO-85 no inventa atribución retroactiva. El journal de efectos v2 conserva el `client_id` opcional para reconciliar mutaciones.

## Migración y rollback

La migración SQLite `005_clients` agrega el registro de clientes sin reescribir Events históricos. El journal v2 anterior a este cambio se sigue leyendo con `client_id = None`.

**No se admite downgrade a un binario anterior después de aplicar `005_clients` o escribir registros nuevos del journal v2.** El binario anterior puede rechazar la base por esquema desconocido y no puede leer ningún registro v2 nuevo: todos incluyen la clave `client_id` (con `null` en la ruta legacy) y `RecordV2` rechaza campos desconocidos. La recuperación debe avanzar con una versión compatible; preservar un backup antes de actualizar.
