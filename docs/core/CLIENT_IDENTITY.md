# Identidad de cliente en Core (F1)

## Contrato

`client_id` identifica una instalación y una superficie; no identifica a la persona ni reemplaza al actor. La clave natural de una instalación es `(surface, installation_id)`. `device_id` es un dato separado y, si existe, debe coincidir al recuperar esa instalación. Una instalación puede tener credenciales distintas para principals distintos, pero todas conservan el mismo `client_id`.

El principal de una credencial es `Person(id)` o `Agent(task_id)`. `System` no puede registrarse como cliente externo. El Core usa la identidad reservada en memoria `core-system`, sin token. Los tipos de superficie admitidos por el registro son Desktop, CLI, Mobile y Automation; `core` se reserva para el propio Core.

Después de `Store::authenticate_client`, el resultado `AuthenticatedClient` es la fuente de actor, scope y `client_id`. `MutationContext::authenticated` valida el canal fijado por el transporte y deriva el actor sin leerlo de los argumentos de la mutación. Los claims opcionales de actor, client, superficie, scope y canal solo se aceptan si coinciden con esa identidad autenticada. La finalización del Event Log copia el `client_id` del contexto; no copia credenciales al payload ni al journal.

| Principal de la credencial | Actor del Event Log | Scope derivado | Permitido | Rechazado |
| --- | --- | --- | --- | --- |
| `Person(id)` | `person`, actor_id=`id` | `Person(id)` | Lectura, comandos de agente y decisiones humanas | Comandos reservados del Core |
| `Agent(task_id)` | `agent`, actor_id=`task_id` | `AgentTask(task_id)` | Lectura y comandos de agente | Decisiones humanas y comandos del Core |
| Core interno | `system`, sin actor_id | `System` | Lectura y comandos internos del Core | Decisiones humanas y comandos de agente |

## Amenazas y controles

| Amenaza | Control |
| --- | --- |
| El request declara otro actor o cambia de agente | `ClientClaims` se compara con el principal devuelto por la credencial; el actor se deriva de ese principal. |
| El request declara otro `client_id` | Se compara con la identidad resuelta; Events reciben el valor resuelto, nunca el del cuerpo. |
| El request eleva superficie, canal o scope | La superficie/scope se comparan con la credencial y el canal lo pasa el transporte. Una discrepancia rechaza el contexto. |
| Una credencial de agente se usa como persona o Core | `ClientPrincipal::Agent` solo obtiene `AgentTask`; `authorize` rechaza decisiones humanas y acciones del Core. |
| Un cliente externo intenta registrarse como System/Core | El constructor de credencial rechaza `System`; `ClientSurface::Core` no se registra y tampoco aparece en la tabla SQL. |
| Se filtra un bearer token a SQLite, Event Log, journal o `Debug` | SQLite conserva solo SHA-256 del secreto; `ClientCredential` lo redacta en `Debug` y no implementa serialización. |

Los bearer tokens deben ser de alta entropía: `ClientCredential::new` exige al menos 32 bytes y el emisor debe generarlos con un CSPRNG, nunca a partir de una contraseña elegida por una persona. El hash SHA-256 sirve como índice del token aleatorio. La tabla no guarda el token ni una copia reversible.

## Compatibilidad y migración

La migración `005_clients` agrega el registro sin reescribir Events históricos ni inventar `client_id`. Los contextos autenticados nuevos escriben `client_id`; los eventos anteriores conservan `NULL`.

El journal de efectos v2 también conserva el `client_id` opcional para que una reconciliación tras fallo de persistencia no pierda la atribución. Los registros v2 anteriores, que no tenían ese campo, siguen leyéndose como `None`. El token nunca se copia al journal.

### Fronteras autenticadas de LXO-85

Tauri fija `Channel::Ui` y usa una credencial local registrada por Store con principal `Person("user")`, superficie Desktop e instalación `desktop-local`. El `client_id` lo recupera Store por `(surface, installation_id)` y permanece estable para esa instalación. La credencial aleatoria queda solo en memoria del proceso; SQLite conserva su hash. La interfaz no puede cambiar actor, canal ni `client_id` mediante argumentos.

`POST /rpc` y `GET /events` también aceptan credenciales registradas por cliente. El transporte autentica el bearer en Store; los claims opcionales de `caller`, principal, superficie, scope, canal y `client_id` deben coincidir con la credencial. El servidor deriva `Caller` de la identidad autenticada. Un Agent conserva scope de su Task y las decisiones humanas quedan restringidas al flujo de la interfaz.

`device_id` es opcional en el contrato. La identidad local de Desktop registra su instalación; el Core todavía no consulta un identificador de dispositivo del sistema operativo.

### Ruta legacy y migración pendiente

Los clientes `lxo` actuales siguen usando temporalmente el bearer global del servidor publicado en `orch.json` y el campo `caller`. Esa ruta conserva el comportamiento existente, no produce `AuthenticatedClient` ni atribuye un `client_id` verificado. Como todos esos clientes comparten el bearer, el campo `caller` puede afirmar otro ID de Agent; la ruta legacy no satisface el contrato de identidad verificable y queda como brecha explícita hasta que los clientes migren. En esa ruta el servidor solo construye `Caller::Agent`; el cuerpo no puede seleccionar `Person` o `System`.

Plan para LXO-86:

1. Añadir handshake CLI con negociación de versión y `client_id` estable.
2. Entregar una credencial por instalación/principal y guardarla en el almacén seguro del sistema operativo.
3. Enviar esa credencial en las llamadas RPC/Event Log; derivar actor y scope exclusivamente desde Store.
4. Retirar el bearer global y el claim legacy `caller` después de migrar los clientes soportados.

Las credenciales nuevas no se publican en `orch.json`, no aparecen en shell history ni se registran en logs. El Event Log conserva el vocabulario actual de canal (`ui`, `lxo`, `core`). Mobile y Automation están representados en el modelo, pero no reciben un transporte nuevo dentro de LXO-85.

La migración `005_clients` agrega el registro sin reescribir Events históricos ni inventar `client_id`. Los contextos nuevos autenticados escriben `client_id`; los eventos anteriores conservan `NULL`.

El journal de efectos v2 también conserva el `client_id` opcional para que una reconciliación tras fallo de persistencia no pierda la atribución. Los registros v2 anteriores, que no tenían ese campo, siguen leyéndose como `None`. El token nunca se copia al journal.

Los clientes actuales siguen temporalmente en su ruta legacy hasta LXO-86: Desktop invoca el Core dentro del proceso y `lxo` usa el bearer local publicado por el servidor junto con su campo `caller`. Esa ruta aún no produce un `AuthenticatedClient`, por lo que conserva la semántica anterior y no recibe un `client_id` nuevo por inferencia. No se debe tratar `caller` como una credencial ni permitir que seleccione `Person` o `System`. LXO-86 debe reemplazarla por credenciales CLI guardadas en secure store y handshake; las credenciales de cliente no se publican en `orch.json`, no aparecen en shell history ni se registran en logs.

El Event Log mantiene el vocabulario de canal actual (`ui`, `lxo`, `core`). Desktop y CLI se validan contra `ui` y `lxo`, respectivamente. Mobile y Automation quedan representados en el modelo de superficie, pero no reciben un transporte nuevo en LXO-85.
