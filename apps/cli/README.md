# lixbon CLI

Cliente de terminal para el gateway: chat con streaming, modo agente con
herramientas sobre el código local, MCP por stdio, sesiones y control remoto
desde el móvil.

**El CLI que se distribuye es el binario en Go (`go/`)**: un solo ejecutable, sin
Python ni dependencias, que instalan `lixbon.com/install.sh` e `install.ps1`.
Está en beta (`2.3.0-go.2`); su estado y sus requisitos están en `go/README.md` y
en `.planning/`, y las notas de cada versión, en `go/CHANGELOG.md`.

Esta carpeta conserva además el **cliente Python anterior** (`lixbon_cli/` y el
artefacto `client_cli.py`), que ya no se instala desde la página y no recibe
releases nuevas. Se mantiene como referencia de comportamiento hasta aceptar la
paridad y se retira según la issue #36.

Rama de trabajo: **`cli`** (ver `docs/RAMAS_Y_RELEASES.md`).

## Instalar

```bash
curl -fsSL https://lixbon.com/install.sh | bash          # Linux / macOS
irm https://lixbon.com/install.ps1 | iex                  # Windows (PowerShell)
```

```bash
lixbon setup     # iniciar sesión (crea la API key "lixbon CLI")
lixbon chat      # chat interactivo
lixbon status    # configuración local
lixbon models    # modelos disponibles
lixbon usage     # consumo del plan
lixbon update    # actualizar a la última versión (también: lixbon --update)
lixbon --version # versión, sistema y arquitectura
```

Los instaladores verifican el SHA-256 del binario contra el gateway y contra el
`SHA256SUMS` de la release. La página [lixbon.com/apps](https://lixbon.com/apps)
muestra la etapa (beta o estable), las novedades y el historial de versiones, y
una instalación manual con enlaces a la release y comandos de verificación. Si
vienes del cliente Python, vuelve a ejecutar el comando de instalación una vez:
su `update` no llega al binario.

Dentro del chat: `/help` lista los comandos. Los principales: `/mode ask|agent|plan`,
`/model`, `/workspace`, `/approve`, `/allow`, `/diff`, `/undo`, `/commit`,
`/run`, `/mcp`, `/remote`, `/compact`, `/nodes`, `/usage`, `/update`.

## Estructura del cliente Python anterior

El CLI Go está en `go/` (paquetes en `go/internal/`, uno por responsabilidad: `chat`,
`tui`, `update`, `tools`, `mcp`, …).

```
lixbon_cli/          fuente modular (esto es lo que se edita)
  cli.py             subcomandos argparse (setup, chat, status, models, usage, update)
  app.py             bucle del chat, slash commands (cmd_*), streaming
  agent.py           herramientas del agente y parsing de tool-calls
  api.py             cliente HTTP del gateway
  sse.py             lectura de Server-Sent Events
  mcp.py             cliente MCP por stdio
  remote.py          sesión /remote (QR + takeover desde el móvil)
  commands.py        comandos personalizados (~/.lixbon/commands, .lixbon/commands)
  sessions.py        guardado y reanudación de sesiones
  ui.py, theme.py, term.py, inputq.py, diffs.py …  terminal y presentación
  config.py          CLI_VERSION y config en ~/.lixbon
build.py             aplana lixbon_cli/ en client_cli.py
client_cli.py        ARTEFACTO GENERADO — no editar a mano
tests/               pytest; test_build_fresh comprueba que el artefacto está al día
```

## Desarrollo

```bash
# desde la raíz del repo — CLI Go (el que se distribuye)
(cd apps/cli/go && go vet ./... && go test -count=1 ./...)
python infra/ci/install_e2e.py              # instaladores reales contra un servidor de releases local

# cliente Python anterior
(cd apps/cli && python -m lixbon_cli chat)   # ejecutar la fuente modular
python -m pytest apps/cli/tests             # 133 tests, ~7 s
python apps/cli/build.py                    # regenerar client_cli.py tras cualquier cambio
```

Una compilación local del CLI Go (`go build`) informa la versión `0.0.0-dev` y
`lixbon update` no la toca.

Reglas de `build.py` para que la concatenación funcione: imports internos
siempre `from lixbon_cli.x import y` (sin alias) y nombres top-level únicos
entre módulos; el script valida ambas cosas con `ast`.

## Release

CLI Go (el que se distribuye):

1. Añadir la sección `## <versión>` con las notas en `go/CHANGELOG.md`.
2. PR de `cli` a `master`.
3. `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`. La versión y la etapa salen
   de la etiqueta (sin sufijo = estable; con sufijo, como `-go.2` o `-beta.1`, = beta).

`.github/workflows/release-cli.yml` compila los seis binarios, publica la release
con las notas, la registra en el gateway y comprueba la instalación desde
`lixbon.com`. Detalle en `docs/RAMAS_Y_RELEASES.md`.

El cliente Python anterior ya no se publica: `GET /install/client_cli.py` sigue
sirviéndose solo hasta su retirada (#36).

Contrato con el gateway: el nombre de la API key (`"lixbon CLI"`) debe
coincidir con `CLI_KEY_NAME` en `core/gateway/routers/auth.py`.
