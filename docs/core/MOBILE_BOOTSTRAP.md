# Bootstrap observacional de Mobile (LXO-107)

Estado: **implementado**. Mobile arranca su vista observacional desde la [snapshot compacta del
Core](QUERIES.md#compact_snapshot) (LXO-94) y sigue los cambios por el Event Log desde su cursor, sin el
webview ni la interfaz de Desktop. Solo lectura: no hay comandos operacionales, push ni cola offline.

## Ruta e identidad

```
App móvil ──(cuenta Lixbon + sesión /remote)──► gateway /remote ──► IDE (host) ──(Person + Desktop, F1)──► Core
```

* **El Core no recibe al móvil directamente.** Solo escucha en `127.0.0.1`. Además, según F1
  ([CLIENT_IDENTITY.md](CLIENT_IDENTITY.md)), una Person de superficie Mobile no lee el Event Log
  (`EventLogRead` es solo de Desktop y CLI). LXO-107 **no cambia F1**.
* **El móvil se autentica ante el gateway** con su cuenta: la API key de la app vive en `SecureStore`
  (`apps/mobile/src/state.js`) y la sesión `/remote` tiene que ser suya (el gateway lo comprueba).
* **El IDE hace las lecturas con su identidad Desktop de F1** (`orch_call` → `Core::rpc_via(Channel::Ui)`):
  `compact_snapshot` (`ClientAction::Read`) y `events` (`ClientAction::EventLogRead`). Son lecturas, así que
  no generan Events atribuidos.
* **Deuda explícita:** el Core ve estas lecturas como del cliente Desktop. Una identidad Mobile propia ante
  el Core (credencial Person + Mobile y su permiso sobre el Event Log) es un cambio de F1 que queda fuera de
  LXO-107.

## Protocolo del relé (v1)

El móvil manda un comando `orch` con un `rid` y el IDE responde con un evento **efímero** con el mismo `rid`.
El gateway reparte esos eventos en vivo, pero no los guarda en el replay ni en la base de datos.

| Petición (`orch` + `action`) | `args` | Respuesta (evento) |
|---|---|---|
| `core_snapshot` | `rid`, `attention_items?` (0–20) | `orch_core_snapshot` · `{rid, ok, protocol: 1, snapshot}` |
| `core_events` | `rid`, `cursor` (entero ≥ 0), `limit?` (1–200, por defecto 100) | `orch_core_events` · `{rid, ok, protocol: 1, events, next_cursor, has_more, head_seq}` |

* `rid`: 1–64 caracteres `[A-Za-z0-9_-]`. Sin `rid` válido, la petición no llega al Core.
* `events[]` va **reducido**: `seq`, `kind`, `ts`, `project_id`, `run_id` y `entity {kind, id}`. No lleva
  `payload`, actor, cliente ni correlación (`apps/desktop/src/lib/remoteCore.js`).
* Si falla, la respuesta es `{rid, ok: false, code, protocol: 1}`. `code` es el código estable del Core
  (`cursor_ahead`, `compact_snapshot_unavailable`…), `forbidden` o `core_error`. **El mensaje del error no
  viaja**: puede llevar rutas.
* El IDE anuncia la capability `core_snapshot` en su `hello`. El gateway admite las dos acciones en
  `ORCH_ACTIONS` y trata las dos respuestas como `EPHEMERAL_EVENTS`.

## Estados en el móvil

`apps/mobile/src/observe/bootstrap.js` (sin React Native; se prueba con `node --test`).

| Estado | Cuándo |
|---|---|
| `connecting` | Todavía no hay datos y se pide la primera snapshot |
| `online` | La última sincronización tiene menos de 60 s |
| `stale` | Hay datos, pero vienen de la caché o de una sincronización vieja (también al volver de segundo plano) |
| `offline` | Sin socket con el gateway, sin el IDE conectado o el Core no responde. Los datos se conservan |
| `unauthorized` | El gateway responde 401/403, o el Core `*_auth_required`/`forbidden`. No reintenta solo |
| `version_mismatch` | El IDE no anuncia `core_snapshot`, el gateway no conoce la acción (422), el IDE responde «acción no soportada», otro protocolo de relé u otra `snapshot_version`. No reintenta solo |

* **Offline no es un fallo:** nada se borra, y lo que había se muestra como desactualizado.
* **Backoff acotado:** reintentos a 1, 2, 4, 8 y 16 s, hasta 6 intentos seguidos. Después espera a que
  vuelva la conexión, a volver a primer plano o a un «Reintentar».
* **Segundo plano:** no sondea ni deja temporizadores. Al volver, si la sincronización es vieja, pasa a
  `stale` y refresca enseguida.
* **Seguimiento:** con la app delante y en línea, `core_events` cada 5 s desde el cursor. Si llega algo
  nuevo se pide otra snapshot (la snapshot pinta; el Event Log dice cuándo cambió algo). Más de 5 páginas
  seguidas se resuelven también con otra snapshot.
* **Reconectar no duplica:** solo cuenta un evento con `seq` mayor que el cursor, aunque el relé repita
  páginas. La Attention viene siempre de la snapshot, que se sustituye entera.
* **Cursor ajeno** (`invalid_cursor`, `cursor_ahead`, por ejemplo una base nueva): se borra la caché y se
  pide otra snapshot.

## Caché

`apps/mobile/src/observe/cache.js`: la última snapshot y su cursor, en AsyncStorage
(`lixbon.observe.cache.v1:<sesión>`).

* **Nunca es autoridad.** Al abrir se pinta como `stale` y se pide la snapshot real enseguida. Al primer
  arranque siempre se pide una snapshot nueva antes de seguir eventos.
* No lleva secretos: la snapshot del Core no incluye spec, rutas ni credenciales, y el token sigue en
  `SecureStore`. Más de 192 K caracteres no se guarda. Otra versión u otra sesión se ignoran.

## Logs

Solo códigos y contadores (`core_bootstrap_snapshot {projects, tasks, truncated}`,
`core_bootstrap_retry {code, attempts}`…), y solo en desarrollo. Nunca títulos, nombres, ids ni la clave de
la caché. Hay una prueba con centinelas.

## Pruebas

* `apps/mobile/src/observe/observe.test.js`: arranque en frío y con caché; caché vieja o inválida;
  seguimiento del cursor y snapshot al cambiar; reconexión sin duplicados; cursor ajeno; offline con backoff
  acotado; sin IDE conectado; segundo plano y vuelta; token inválido; versión (capability, acción, protocolo,
  `snapshot_version`); logs sin contenido; bootstrap con la snapshot más grande del Core; enlace por `rid`;
  indicador.
* `apps/desktop/src/lib/remoteCore.test.js`: validación de la petición, eventos reducidos sin `payload` y
  errores como código.
* `core/gateway/test_remote_core_bootstrap.py`: el relé admite las dos acciones y no guarda ni repite las
  respuestas.
* **Validación manual** en dispositivo o emulador: pendiente (`needs:manual-validation`).
