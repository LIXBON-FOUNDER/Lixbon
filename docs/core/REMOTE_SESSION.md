# Sesión remota (LXO-184)

Estado: **contrato del Core implementado y probado contra un relay simulado; sin transporte todavía.** El relay Python (`core/gateway`) y el
conector de Desktop (`remoteCore.js`) son PRs siguientes; el daemon (rebanada 5 de `ADR_RUNTIME_PERSISTENTE.md`) será quien se conecte.

## Qué resuelve

Que un cliente remoto (CLI, Mobile, otro Desktop) observe y controle trabajo autorizado **sin que el relay sea una segunda fuente de verdad**:
el relay solo reenvía; toda decisión, mutación e idempotencia ocurre en el Core del host.

```text
cliente ──► relay (gateway) ──► Core del host
               │                   ├─ remote_hello  apretón de manos: versión + capacidades; credencial del DISPOSITIVO → sesión
               │ reenvía y acota   ├─ remote_call   sobre {session_id, session_secret, seq, request_id, cmd, args}
               ▼                   └─ remote_close
          cola acotada · host offline = offline (no failed) · reconexión = hello nuevo + cursor de eventos
```

## `remote_hello`

Entrada: el token del dispositivo (el mismo que autentica a `lxo`/Desktop/Mobile en el almacén de clientes) y
`{protocol_min, protocol_max, capabilities?}`. Solo una **Person**: un Agent nunca abre una sesión remota.

Salida: `session_id`, `session_secret` (**la única vez que viaja**), `protocol` (la mayor versión común), `host_id`, `runtime_instance`,
`capabilities`, `shared_capabilities` (lo que el cliente pidió y el Core ofrece; lo demás no se promete), `event_head` y los límites.

| Código | Cuándo |
|---|---|
| `remote_unauthorized` | Token desconocido, o credencial de un Agent. |
| `remote_credential_revoked` / `remote_credential_expired` | El dispositivo está revocado o su credencial caducó. |
| `remote_version_unsupported` | Ninguna versión común: **falla explícito**, no se degrada. |
| `remote_invalid_request` | Campos que faltan, rango invertido o campos desconocidos. |
| `remote_too_many_sessions` | El dispositivo ya tiene 4 sesiones o el Core 64. |

## `remote_call`

Cada sobre se comprueba en este orden, y lo que falla no ejecuta nada:

1. Tamaño (256 KiB) y forma: sin campos desconocidos, `request_id` de hasta 80 caracteres, `seq` entero desde 1, `args` un objeto.
2. Sesión y secreto: «no existe» y «secreto equivocado» dan el **mismo** error (`remote_session_invalid`); no se revela qué sesiones hay.
3. **Credencial viva**: se vuelve a comprobar en cada llamada. Un dispositivo revocado deja de funcionar en la siguiente, con la sesión
   abierta (`remote_credential_revoked`, y la sesión se cierra).
4. **Repetición:** `seq` estrictamente creciente por sesión (`remote_replay`).
5. **Comando permitido:** solo los de `REMOTE_COMMANDS` (lecturas más `task_create`, `attempt_approve` y `attempt_stop`).
   Ampliar esa lista es una decisión de producto y de seguridad. El resto, `remote_command_forbidden`.
6. **Reintento seguro:** ver abajo.
7. **Backpressure:** hasta 8 llamadas en vuelo por sesión (`remote_backpressure`).
8. Ejecución por `rpc_authenticated_via`, con la política de la superficie y del principal del dispositivo, igual que una llamada local.

### Reintento seguro

Si el cliente no vio la respuesta, reenvía con **otro `seq` y el mismo `request_id`**. Un `request_id` ya atendido por ese dispositivo
devuelve la misma respuesta con `replayed: true` y **no se ejecuta otra vez**; con otro comando o argumentos es `remote_request_conflict`; mientras
se está ejecutando, `remote_request_in_progress`. Solo un **éxito** se recuerda (10 minutos, 512 entradas): un fallo se puede reintentar.

### Eventos y reconexión

`events {cursor, limit}` es un comando más. Tras una caída el cliente abre otra sesión (`remote_hello`) y pide `events` desde su último
`next_cursor`: no se repite ni se pierde nada, porque el Event Log del Core es la única fuente y el cursor es suyo.

## Qué NO está resuelto (queda dicho)

* **El relay ve en claro** el secreto de sesión y el contenido: TLS protege el tránsito, no al relay. Mitigación: el secreto de sesión es de vida corta
  (15 minutos sin uso), de un solo dispositivo y revocable con él, y el relay no puede elevar permisos ni decidir estado. **No hay cifrado extremo a
  extremo del contenido**: es el punto principal para la revisión de seguridad.
* Sesiones y memoria de reintentos viven en memoria: un reinicio del Core las pierde (el cliente reconecta). La idempotencia **durable** de
  `task_create` sigue evitando duplicados.
* Un host sin conexión al relay es **offline** (lo representa el relay, no el Core); el Core no sabe que el relay lo perdió.
* No hay transporte, ni enrutado por `host_id` en el gateway, ni emparejado de dispositivos: los PRs siguientes. Las pruebas usan un relay
  simulado (cola acotada, host offline, respuesta perdida).
* No se probó carga real (muchos clientes a la vez), solo los límites.
