# Identidad de host (LXO-182)

Estado: **implementado y probado; vive tras el corte Task/Attempt.** La tabla `hosts` es la migración 027, posterior al corte
(`CORTE_EJECUCION.md`): antes del corte no existe y todo lo de aquí responde `core_model_inactive`, sin romper nada.
Decisión de arquitectura: la ADR del runtime persistente (`ADR_RUNTIME_PERSISTENTE.md`, LXO-181).

## Qué resuelve

Una «máquina» era un texto suelto (`meta.machine_id`) copiado en `project_locations.machine` y `worktrees.machine`. Cualquiera podía
declarar otro. Ahora cada Core sabe **quién es** y solo acepta a otro host si este prueba que posee su clave.

* `project_id` identifica el proyecto entre hosts. `host_id` identifica la máquina. Una ruta solo tiene sentido **dentro** de su
  `host_id`: la misma ruta en dos hosts son dos ubicaciones (la clave de `project_locations` ya es `(machine, path)`).
* El `host_id` **propio** es el `machine_id` que ya existía: ninguna ubicación ni worktree existente cambia. Sale siempre del
  almacén, nunca de un cliente.
* Un host nunca se borra. Parado o sin conexión es `last_seen` viejo (`availability: stale`), no una fila que desaparece.

## Tabla `hosts` (migración 027)

| Columna | Qué es |
|---|---|
| `host_id` | Identidad. Para el host propio, el `machine_id`. |
| `label`, `os`, `arch`, `app_version`, `capabilities` | Lo que el host cuenta de sí mismo. No es secreto ni identifica. |
| `is_self` | Exactamente un host es el propio (índice único parcial). No cambia nunca (trigger). |
| `public_key` | Ed25519 en hexadecimal (64 caracteres). Una vez fijada **no cambia** (trigger) y no puede ser de dos hosts (índice único). |
| `first_seen`, `last_seen` | ms epoch del alta y de la última señal verificada. |
| `verified_at` | ms epoch de la última prueba de posesión aceptada. `NULL`: nunca verificado. |

La migración rellena lo que ya había: el host propio desde `meta.machine_id` y, **sin verificar**, las máquinas que ya aparecían en
`project_locations`. Ninguna clave privada está en la base: vive en el almacén seguro del SO (`lixbon:host/<host_id>/ed25519`).
Sin almacén seguro el host existe pero no puede probar quién es (`verified: false`); no se guarda la clave en otro sitio.

## La prueba de posesión

Un par se presenta con `{host_id, public_key, label, os, arch, app_version, capabilities, issued_at, signature}`. La firma
(Ed25519) cubre exactamente `lixbon-host-proof-v1`, el `host_id`, la clave, esos datos y la hora, uno por línea (por eso ningún campo
admite saltos de línea ni caracteres de control).

`Core::host_peer_register` rechaza, y no escribe nada (sin fila ni evento):

| Código | Cuándo |
|---|---|
| `host_proof_invalid` | Firma que no cuadra con la clave y los datos, clave o firma que no son hexadecimal del tamaño exacto, campos fuera de rango. |
| `host_proof_expired` | `issued_at` a más de 10 minutos de la hora de este Core, hacia atrás o hacia delante. |
| `host_conflict` | El `host_id` o la clave son los de **este** host; otra clave para un `host_id` ya fijado (suplantación); una clave que ya es de otro host; una prueba que no es **estrictamente más reciente** que la ya aceptada (repetir una prueba no hace nada). |
| `core_model_inactive` | Antes del corte. |

Quien llama a `host_peer_register` tiene que haber autenticado ya el canal: hoy no hay transporte (lo abre el gateway, LXO-184), así
que solo lo ejercitan las pruebas con dos Cores.

## Evento `host.registered`

`state` · entidad `host` (id = `host_id`) · sin Project ni run · sin `idem_key` · `payload {is_self, verified}`. Lo escribe el propio
Core (`system/core`) en la misma transacción que la fila. Se emite cuando **nace** un host o cuando uno antes sin verificar **fija su
clave**; refrescar `last_seen` o las capacidades no emite nada. Nunca lleva la clave, el nombre ni rutas.

## Query `hosts_list`

Solo lectura, sin argumentos, solo para una **Person** autenticada (un Agent o el token legacy reciben `hosts_list_auth_required`).

```json
{"self": "<host_id>", "hosts": [{
  "host_id": "…", "label": "…", "self": true, "verified": true, "public_key": "<hex>",
  "os": "windows", "arch": "x86_64", "app_version": "0.1.0", "capabilities": ["core", "projects"],
  "first_seen": 1760000000000, "last_seen": 1760000000000, "verified_at": 1760000000000,
  "availability": "online",
  "locations": [{"project_id": "…", "path": "/ruta/local", "primary": true, "state": "ok", "last_seen": 1760000000000}]
}]}
```

* Orden: primero el propio, luego por nombre y `host_id`.
* `availability`: el propio siempre `online`; un par es `online` si su última señal tiene menos de 15 minutos y `stale` si no.
  Nunca desaparece.
* `locations` agrupa las de cada host: la ruta de un host no se mezcla con la de otro. Parámetros desconocidos:
  `hosts_list_invalid_request`.

## Qué NO cubre (y dónde sigue)

* **Transporte y emparejado:** cómo llega la prueba de un par y quién autentica el canal es LXO-184 (gateway).
* **Ubicaciones de un par:** hoy `project_locations` solo se escribe para el host propio (`join`, `project_locate`). Que un par
  informe las suyas con firma llega con el gateway; las pruebas las insertan directamente en el almacén.
* **Revocar un host o rotar su clave:** no existe todavía; un host no se borra y su clave no cambia. Si la clave propia se pierde
  del almacén seguro, el host **falla cerrado**: no genera otra en silencio (`host_conflict: … otra clave fijada`), no puede
  volver a probar quién es y arrancar lo deja registrado en el log. Recuperarlo es trabajo de la rotación de claves.
* **Clave propia en entornos sin almacén seguro (Linux sin Secret Service):** el host queda sin verificar y se ve en `hosts_list`.
