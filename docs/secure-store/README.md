# Almacén seguro (J1 y autenticación CLI)

Módulo Rust `apps/desktop/src-tauri/src/secure_store/`. Guarda, lee y borra
secretos (claves de API, tokens, claves de dispositivo) en el almacén del
sistema operativo. LXO-86 ya lo usa Core y el sidecar `lxo` para la credencial
Person del CLI; los comandos `secret_*` de `lib.rs` y `config.json` conservan su
comportamiento actual.

## API

```rust
let store = secure_store::default_store();            // Box<dyn SecretStore>
let key = SecretKey::parse("lixbon:provider/openai/api-key")?;
store.set(&key, &SecretValue::new(valor)?)?;           // reemplaza si existe
let v = store.get(&key)?;                               // Err(NotFound) si no hay
v.expose();                                             // único punto de acceso al texto
store.delete(&key)?;                                    // idempotente
store.exists(&key)?;
```

| Pieza | Papel |
|---|---|
| `SecretStore` (trait) | Contrato: `set`, `get`, `delete`, `exists`, `backend`. |
| `OsStore` | Adaptador real, crate `keyring`: Windows Credential Manager, macOS Keychain, Linux Secret Service. |
| `MemoryStore` | Falso en memoria para pruebas, con `fail_with(Some(kind))` para simular almacén caído o denegado. |
| `UnavailableStore` | SO sin adaptador: todo falla con `Unavailable`. `default_store()` lo devuelve en esos SO. |
| `SecretKey` | `(servicio, cuenta)` validada; la referencia textual es `servicio:cuenta`. |
| `SecretValue` | UTF-8, 1..=2560 bytes, sin NUL. `Debug` imprime `SecretValue(<redactado>)` (ni valor ni longitud) y la memoria se borra al soltarlo (`zeroize`). |
| `SecretError` / `ErrorKind` | Errores tipados: `NotFound`, `Unavailable`, `Denied`, `TooLarge`, `InvalidKey`, `InvalidValue`, `Corrupt`, `Other`. |

## Garantías de no fuga

* El valor solo sale por `SecretValue::expose()`; no implementa `Display`,
  `PartialEq` ni serialización.
* Ningún `SecretError` contiene el valor: los errores de `keyring` se traducen
  sin arrastrar `BadEncoding(bytes)` ni `Ambiguous(..)`, y los mensajes de la
  plataforma se recortan a 200 caracteres. Hay pruebas que formatean todos los
  errores con `{}` y `{:?}` y comprueban que el secreto no aparece.
* `MemoryStore` y `SecretKey` imprimen solo nombres/recuentos, nunca valores.

## Reglas de nombres (vectores dorados)

`docs/secure-store/vectors.json` fija las reglas y lo leen las pruebas de Rust;
cualquier otro cliente (p. ej. el CLI en Go) debe pasar los mismos casos.

* servicio: `[a-z0-9][a-z0-9._-]{0,63}`. Producción: `lixbon`. Pruebas contra
  un almacén real: `lixbon-test-…` (obligatorio).
* cuenta: 1..=128 caracteres, segmentos separados por `/`, cada uno
  `[A-Za-z0-9][A-Za-z0-9._@+-]*`.
* Solo ASCII y sin `:` en ambos: en Windows el `TargetName` es
  `servicio:cuenta` y no es ambiguo (por defecto `keyring` usaría
  `cuenta.servicio`).

## Decisiones

* **Bytes UTF-8 en los tres SO** (`set_secret`/`get_secret`), no `set_password`:
  en Windows `set_password` guarda UTF-16 y el tope de 2560 bytes del
  Credential Manager quedaría en 1280 caracteres. Con bytes, un secreto de
  2560 bytes cabe en los tres.
* **Servicio nuevo (`lixbon`)**, distinto del `com.usuario.app-lixbon` que usan
  hoy los comandos `secret_*` de `lib.rs`. No hay colisión ni migración
  implícita; migrar es el slice J2.
* **Borrado idempotente**: borrar lo que no existe es `Ok` (igual que
  `secret_delete` actual).
* **`config.json` solo guardará referencias** (`servicio:cuenta`), nunca el
  valor. `SecretKey::parse` existe para eso.

## Consumidor CLI de LXO-86

Core y el sidecar Rust `apps/desktop/lxo` usan el mismo backend `keyring` v3 y
la misma clave: servicio `lixbon`, cuenta
`client/cli/<installation_id>`. La instalación estable vive en
`~/.lixbon/cli-client.json`; ese archivo contiene únicamente el
`installation_id`. `orch.json` publica puerto, `client_id`, `installation_id`,
versión y ruta del sidecar, sin token. El secreto no se escribe en archivos,
logs ni argumentos de shell.

La credencial Person CLI vence a los 90 días y Core la rota al iniciar el
orquestador. Credenciales inválidas o revocadas detienen el listener para que
no haya fallback en texto plano. Para recuperación manual de una credencial
perdida o revocada: cierra Lixbon, elimina la entrada
`lixbon:client/cli/<installation_id>` del almacén del SO y respalda/elimina
`~/.lixbon/cli-client.json`; al volver a abrir, Core crea una instalación y
credencial nuevas y revoca las credenciales Person CLI anteriores de esa base.
Core revoca las credenciales Agent cuando termina el proceso y al reiniciar.
Todavía no existe una pantalla o comando de revocación manual; esa operación de
usuario es una brecha conocida.

El soporte de producción se limita a los adaptadores que pasan las pruebas de
la matriz de abajo. Un SO sin backend devuelve `Unavailable`; Core no inicia el
listener autenticado y no guarda el bearer en otro lugar.

## Dependencias

* `zeroize = "1"` (directa; ya estaba en el árbol por `keyring`/RustCrypto).
* `keyring` v3 por SO: Windows `windows-native` (ya estaba), macOS
  `apple-native`, Linux `sync-secret-service` + `crypto-rust`.
* Linux: Secret Service por `libdbus`, que `tao` ya exige (`libdbus-1-dev`), así
  que no añade paquetes del sistema; `crypto-rust` evita depender de OpenSSL.
  Cadena nueva solo en `Cargo.lock` para macOS/Linux (~32 crates: `zbus`,
  `secret-service`, `security-framework`, `aes`, …). En Windows el árbol no
  cambia.

## Pruebas

* `cargo test secure_store` — vectores, validación, errores sin fuga,
  `MemoryStore`, mapeo de errores de `keyring`. Corren en cualquier SO.
* `cargo test secure_store::os -- --ignored` — ciclo real contra el almacén del
  SO (guardar, leer, reemplazar, unicode, multilínea, máximos de 2560 bytes,
  borrado idempotente). Va con `#[ignore]` porque un CI sin sesión gráfica no
  tiene Secret Service; usa un servicio `lixbon-test-<pid>-<nanos>-<n>` y borra
  lo que crea, aunque falle.

## Estado de verificación por plataforma

| Plataforma | Adaptador | Estado |
|---|---|---|
| Windows | Credential Manager (`keyring`, `windows-native`) | **Verificado**: compila y pasa las pruebas, incluidas las `--ignored` contra el almacén real. |
| macOS | Keychain (`apple-native`) | **Pendiente de CI**: no se ha compilado ni ejecutado. |
| Linux | Secret Service (`sync-secret-service` + `crypto-rust`) | **Pendiente de CI**: no se ha compilado ni ejecutado. |

De macOS y Linux solo se comprobó que la resolución de dependencias de
`Cargo.lock` es válida para ambos destinos (`cargo tree --locked --target`). Hay
que pasar CI en esos SO, con las pruebas `--ignored` donde haya sesión de
almacén, antes de que J2 dependa de ellos.

## Alcance

LXO-86 solo consume el almacén para autenticación local del CLI. **No migra
claves de API** de los comandos `secret_*` (J2, bloqueado hasta que se roten las
claves expuestas), y `config.json` sigue como estaba.
