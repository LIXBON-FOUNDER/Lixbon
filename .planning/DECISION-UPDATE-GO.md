# Decisión: instalación y actualización del CLI Go

Fecha: 2026-10-06 · Issues #18 y #20 · Requisitos REL-01 a REL-04 · Estado: aceptada por el usuario; cliente, gateway e instaladores implementados con pruebas, sin ninguna release publicada todavía.

## Decisiones del usuario

1. **Autenticidad**: `SHA256SUMS` de la release **más** el digest que sirve el gateway. Se instala solo si el archivo coincide con los dos.
2. **Canal**: todo es beta por ahora. El gateway publica el canal `beta` y las releases salen como *prerelease*.
3. **Python**: no habrá puente ni coexistencia. El objetivo es pasar todo a Go y eliminar el código y las dependencias de Python. Quien tenga el CLI Python reinstala con el mismo comando de siempre (`curl … | bash` / `irm … | iex`), que ahora instala el binario.
4. **Firma del sistema operativo**: de momento no hay firmas digitales de binarios. La instalación sigue siendo un comando desde la página. Se resuelve más adelante.

## Qué había en Python (contrato que se sustituye)

| Pieza | Dónde | Qué hacía |
|---|---|---|
| Descarga del CLI | `routers/installer.py` → `GET /install/client_cli.py` | Servía `apps/cli/client_cli.py`; el `Dockerfile` lo copia a la imagen. |
| Instaladores | `installer.py` → `GET /install.sh`, `GET /install.ps1` | Bajaban `client_cli.py`, creaban un lanzador que llama a `python`, sin verificar ningún hash. |
| `lixbon update` (Python) | `lixbon_cli/cli.py` (`download_update`) | Descargaba `/install/client_cli.py`, comprobaba que compilara y sobrescribía. Sin versión, firma ni rollback. |
| Manifest del CLI | `routers/versions.py` → `/api/updates/cli/{channel}` | Nadie lo consumía y devolvía la versión del producto `desktop`. |

## Diseño implementado

**Dónde viven los binarios y los digest.** Los binarios están en GitHub Releases (`cli-v<versión>`, assets `lixbon-<versión>-<os>-<arch>.tar.gz|.zip`, más `SHA256SUMS`), producidos por `release-cli.yml`. El gateway guarda, por plataforma, la URL y el SHA-256 en la tabla `app_versions` con productos `cli-<os>-<arch>` (clave única `(producto, versión)`, canal `beta`). No hay almacenamiento propio: el gateway no sirve binarios.

**Registro.** El job `registrar` de `release-cli.yml` llama a `POST /api/versions/register` (token admin, secreto `LIXBON_ADMIN_TOKEN`) por cada archivo. El gateway valida producto, canal, versión, digest hexadecimal y que la URL empiece por `CLI_RELEASES_URL_PREFIX` (por defecto las releases de `LIXBON-FOUNDER/Lixbon`).

**Manifest.** `GET /api/updates/cli/{channel}` devuelve `{version, channel, title, release_date, changelog, assets: {"<os>-<arch>": {url, sha256}}}`. La versión es la de la fila registrada más reciente y solo incluye los binarios de esa versión.

**Cliente (`apps/cli/go/internal/update`).** `lixbon update [--check]` y `/update`:

1. Pide el manifest (`<gateway>/api/updates/cli/beta`; con un proveedor genérico usa `lixbon.com`; `LIXBON_UPDATE_URL` lo sustituye para pruebas). Solo HTTPS (localhost exento).
2. Compara versiones con semver (`2.3.0-go.0` es anterior a `2.3.0`).
3. Descarga el archivo de la URL del manifest, calcula su SHA-256 y lo contrasta con el del gateway **y** con la línea correspondiente del `SHA256SUMS` de la misma release. Si cualquiera falla, no instala nada.
4. Extrae el binario de la plataforma (`.tar.gz` o `.zip`, con límites de tamaño), lo deja junto al ejecutable actual y comprueba que arranca y que `status` informa la versión esperada.
5. Reemplaza el ejecutable: en Linux y macOS con un `rename` atómico; en Windows renombra el `.exe` en uso a `lixbon.exe.old`, instala el nuevo y restaura el anterior si falla. El arranque siguiente borra el `.old` (`update.CleanupOld`).

**Instaladores.** `routers/installer_go.py` genera `install.sh` e `install.ps1` con la tabla de binarios (URL y digest) embebida por el gateway. Detectan SO y arquitectura, descargan, verifican contra el digest embebido y contra `SHA256SUMS`, instalan en `~/.local/bin/lixbon` (Linux y macOS) o `%USERPROFILE%\.lixbon\lixbon.exe` (Windows, que ya estaba en el PATH), retiran el lanzador y `client_cli.py` antiguos y ejecutan `lixbon init --base-url`. Las URL públicas no cambian.

**Transición hasta la primera release.** Mientras no haya ninguna release del CLI registrada, `install.sh` e `install.ps1` siguen sirviendo el instalador de Python, para no dejar la página sin instalador al desplegar el gateway antes de publicar. Ese camino y `/install/client_cli.py` se borran en la retirada de Python.

## Verificado

- `internal/update`: pruebas con un servidor de releases falso (digest del gateway distinto, `SHA256SUMS` distinto o sin el archivo, archivo alterado, sin binario, corrupto, error HTTP, descarga cortada, verificación fallida, restauración en Windows, HTTP no local); en todos los casos el binario actual queda intacto y sin archivos sobrantes.
- Prueba real en Windows 11: un `lixbon.exe` 2.3.0-go.0 en ejecución se actualiza solo a 2.4.0-go.0 contra un servidor local; queda el `.old` y el arranque siguiente lo borra.
- Gateway: `core/gateway/test_cli_release.py` (registro con y sin permisos, datos inválidos, manifest, instaladores con digest embebido).

## Pendiente

- Ejecutar `release-cli.yml` con una etiqueta real (`cli-v2.3.0-go.0`), comprobar que los seis destinos compilan y se registran, y probar `install.sh`/`install.ps1` y `lixbon update` contra esa release (#22 para Linux y macOS).
- Imagen Docker con el binario (#20).
- Firma de binarios para macOS (Gatekeeper) y Windows (SmartScreen); los archivos descargados por `curl` o por el propio cliente no llevan la marca de cuarentena, pero hay que confirmarlo en máquinas reales.
- Retirada de Python: borrar `/install/client_cli.py`, `CLI_SOURCE_PATH`, la copia del `Dockerfile`, el instalador de respaldo y `apps/cli/lixbon_cli` (ver ROADMAP, «Retirada de Python»). Los clientes Python existentes no pueden actualizarse solos a Go: reinstalan con el comando de la página.
