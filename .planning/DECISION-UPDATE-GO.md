# Investigación: instalación y actualización del CLI Go

Fecha: 2026-10-06 · Issues #18 y #20 · Requisitos REL-01 a REL-04 · Estado: investigación; falta que el usuario elija las decisiones abiertas del final.

## Qué existe hoy en Python

| Pieza | Dónde | Qué hace |
|---|---|---|
| Descarga del CLI | `core/gateway/routers/installer.py` → `GET /install/client_cli.py` | Sirve `apps/cli/client_cli.py` (artefacto generado por `build.py`). El `Dockerfile` lo copia a la imagen: cada versión nueva del CLI exige desplegar el gateway (merge a `master`). |
| Instaladores | `installer.py` → `GET /install.sh` y `GET /install.ps1` | Scripts generados en una cadena de Python. Bajan `client_cli.py` a `~/.lixbon/`, ejecutan `init --base-url`, crean el lanzador (`~/.local/bin/lixbon` que llama a `python3`, o `~/.lixbon/lixbon.cmd` que llama a `python`) y editan el PATH. **Exigen Python instalado, no verifican ningún hash.** |
| `lixbon update` | `apps/cli/lixbon_cli/cli.py` (`download_update`) | Descarga `/install/client_cli.py?ts=…` (solo HTTPS, salvo localhost), comprueba que `compile()` funcione y que el texto contenga «lixbon», compara el SHA-256 con el archivo instalado, sobrescribe y se relanza. **No compara números de versión, no verifica firma, no hace rollback.** |
| Manifest del CLI | `core/gateway/routers/versions.py` → `GET /api/updates/cli/{channel}` | **Nadie lo consume** (ni `client_cli.py` ni la web) y devuelve la última versión del producto `desktop`, no la de un CLI: `VALID_PRODUCTS` no tiene un producto CLI. Su docstring («consumido por `client_cli.py --update`») y `docs/ESTADO_ACTUAL.md` línea 421 lo describen mal. |
| Almacenamiento de releases | `versions.py`, `core/storage/r2.py`, tabla `app_versions` | Binarios en un bucket privado de Cloudflare R2; la BD guarda `r2:<key>` y `checksum_sha256`; `GET /api/updates/download/{version}/{channel}` redirige a una URL prefirmada. Subida con token admin (`POST /api/versions/upload`), que usan `tauri.yml` y `mobile.yml`. Clave única `(product, version)`. |
| Web y documentación | `DownloadsPage.jsx`, `docsContent.*.jsx`, `guiasContent.*.jsx`, `README.md`, `apps/cli/README.md` | Publican `curl -fsSL …/install.sh \| bash` e `irm …/install.ps1 \| iex`, y la descarga manual de `client_cli.py`. |

Lo que ya hay del lado Go: `.github/workflows/release-cli.yml` (commit 13a2fb9). Con una etiqueta `cli-v<versión>` compila seis destinos (linux, darwin y windows en amd64 y arm64) con `CGO_ENABLED=0`, comprueba que la etiqueta coincida con `config.Version`, empaqueta (`lixbon-<versión>-<os>-<arch>.tar.gz`, `.zip` en Windows), genera `SHA256SUMS` y crea una release marcada como *prerelease*. **No se ha ejecutado nunca**: no hay ninguna release `cli-v*` en GitHub (la etiqueta `cli-v2.2.0` es del CLI Python y no tiene release).

## Restricciones que se desprenden

1. **Un cliente Python solo puede recibir código por `/install/client_cli.py`** y solo lo acepta si es Python válido. Para pasar a un usuario de Python a Go hace falta publicar una última versión «puente» de `client_cli.py` cuyo `update` descargue el binario, lo verifique, lo instale y reescriba el lanzador. Ninguna de las dos opciones evita esto: el gateway se toca igualmente.
2. **`client_cli.py` no se puede borrar del gateway al retirar Python**: los clientes antiguos seguirán consultándolo. Lo que se retira es el código fuente (`lixbon_cli/`, `build.py`, pruebas); el artefacto congelado (o un puente mínimo) debe seguir sirviéndose durante un periodo largo. Esto corrige el paso 6 de «Retirada de Python» del ROADMAP.
3. **`install.sh` e `install.ps1` están dentro de `installer.py`**: cambiar lo que instalan es un despliegue del gateway, igual que hoy. La URL pública (`lixbon.com/install.sh`) no cambia.
4. **GitHub `releases/latest` no sirve**: ignora borradores y *prereleases*, y el repositorio ya tiene releases de `desktop-v*` y `mobile-v*` (borradores). El cliente tiene que listar las releases y filtrar por el prefijo de etiqueta `cli-v`, o resolver la etiqueta por otro medio.
5. El repositorio `LIXBON-FOUNDER/Lixbon` es **público** (`gh repo view`), así que no hace falta autenticación para descargar de las releases; si se hiciera privado habría que reabrir la opción.
6. **`SHA256SUMS` dentro de la misma release solo protege de corrupción**: quien pueda reemplazar el archivo puede reemplazar también la suma. REL-02 pide «firma o digest esperado autenticado», así que el digest o la firma tienen que venir de otro origen o de una clave que el cliente ya conozca.
7. **Windows con el ejecutable en uso**: Windows permite renombrar un `.exe` en ejecución pero no borrarlo ni sobrescribirlo. El reemplazo es: renombrar `lixbon.exe` a `lixbon.exe.old`, escribir el nuevo, y borrar `.old` en el siguiente arranque; si falla, volver a renombrar.
8. **Configuración y sesiones**: Go ya lee y escribe `~/.lixbon/config.json` y `~/.lixbon/sessions/` con el formato de Python, así que el cambio de cliente no migra datos.

## Opciones

| | A. GitHub Releases como fuente | B. El gateway como intermediario | C. Híbrida (recomendada) |
|---|---|---|---|
| Binarios | Assets de la release `cli-v*` | R2 (o redirección a GitHub) detrás de `/api/updates/cli/...` | Assets de GitHub |
| Metadatos y digest | `SHA256SUMS` de la misma release | Manifest del gateway con digest por plataforma | Manifest del gateway (`version`, URL por `os-arch`, `sha256`) **y** URL de descarga en GitHub |
| Backend | Solo `installer.py` y el puente de `client_cli.py` | Producto CLI nuevo, manifest por plataforma, endpoint de registro desde CI, firma de URLs | `installer.py`, el puente, un manifest por plataforma y un endpoint que registre el digest desde CI |
| Control de acceso por plan, cambio de almacén | No | Sí | Posible más adelante |
| Autenticidad (restricción 6) | No cubierta con solo `SHA256SUMS` | Digest servido por TLS desde el gateway | Digest del gateway + bytes de GitHub: hay que comprometer los dos orígenes |
| Se puede probar sin backend | Sí, entero | No | El cliente sí (fuente intercambiable); el manifest, con el gateway local |
| Riesgo | Depende de GitHub; la suma no autentica | Más trabajo; el gateway sirve binarios o redirige | Dos piezas que mantener coherentes |

La corrección más importante a lo planteado antes: la opción A no es «sin backend» (restricciones 1 y 3), y la B es menos costosa de lo que parecía porque R2, `checksum_sha256`, la subida con token admin desde CI y la redirección prefirmada ya existen para el desktop y el móvil.

## Recomendación: C, por fases, con la fuente detrás de una interfaz

1. **Cliente Go (`internal/update`)**, probable con un servidor de releases falso, sin depender del backend: `Source` intercambiable (GitHub Releases filtrando `cli-v`; manifest del gateway después), selección por `runtime.GOOS`/`GOARCH`, comparación semver (`2.3.0-go.0` es anterior a `2.3.0`), descarga a temporal, verificación del SHA-256 esperado, extracción, reemplazo atómico con rollback y la mecánica de Windows de la restricción 7. Comandos `lixbon update` y `/update`. Cubre las casillas de #18 que no dependen del gateway.
2. **Primera release real** de `release-cli.yml` con una etiqueta de prueba, para comprobar la matriz de seis destinos y los nombres de los assets antes de escribir los instaladores.
3. **Gateway**: manifest por plataforma en `/api/updates/cli/{channel}` (corrigiendo que hoy devuelva el desktop) y un endpoint de registro que `release-cli.yml` llame con el token admin tras publicar. Fuera de este paso, el cliente funciona con la opción A.
4. **Instaladores** `install.sh` y `install.ps1` nuevos en `installer.py`: detectan SO y arquitectura, descargan el archivo, verifican el digest (`sha256sum`/`shasum -a 256`, `Get-FileHash`), instalan en `~/.lixbon/bin`, enlazan `~/.local/bin/lixbon` o añaden el directorio al PATH de usuario, y retiran el lanzador de Python. Mismas URL públicas.
5. **Puente Python** (`client_cli.py` final): su `update` detecta plataforma, descarga y verifica el binario, lo instala, reescribe el lanzador y conserva `client_cli.py` como respaldo para volver atrás.
6. **Docker**: una imagen que incluya el binario es independiente del update; se decide en #20.

Pruebas necesarias (de #18): digest incorrecto, plataforma errónea, corte de red a mitad de descarga, archivo truncado, Windows con el ejecutable en uso, y comprobar que tras cada fallo el binario anterior sigue funcionando.

## Decisiones abiertas para el usuario

1. **Autenticidad**: (a) quedarse con `SHA256SUMS` de la release (integridad, no autenticidad), (b) digest servido por el gateway (opción C), o (c) además firmar con una clave cuya parte pública va dentro del binario. Recomendación: (b); (c) solo si se quiere sobrevivir al compromiso de ambos orígenes.
2. **Canales**: `release-cli.yml` publica siempre como *prerelease*. Hay que decidir cuándo deja de serlo y si habrá canal `beta`/`stable` como en el desktop (`-beta`/`-rc` en la versión).
3. **Puente Python**: cuánto tiempo se sigue sirviendo `/install/client_cli.py` después de que Go sea el cliente por defecto, y si el instalador nuevo se activa para todos a la vez o con una variable (`LIXBON_CLIENT=go`) durante la coexistencia.
4. **Firma de los binarios del sistema operativo**: macOS (Gatekeeper, notarización) y Windows (SmartScreen) no están probados. Los binarios descargados por `curl` o por el propio cliente no llevan la marca de cuarentena, pero hay que confirmarlo en máquinas reales (#22); firmar para el sistema operativo se decide aparte.

## Consecuencias

- Se actualizan #18 y #20 con este reparto, y REL-02/03/04 apuntan a este documento.
- El paso 6 de «Retirada de Python» pasa a conservar el artefacto congelado de `client_cli.py` en el gateway.
- Nada de esto cambia la lógica de inferencia, y no se publica ni se sustituye Python sin la aceptación de REL-05.
