# lixbon CLI

Cliente de terminal para el gateway: chat con streaming, modo agente con
herramientas sobre el código local, MCP por stdio, sesiones y control remoto
desde el móvil. Python 3 estándar, **sin dependencias externas**: se distribuye
como un único archivo (`client_cli.py`) que el propio gateway sirve.

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
lixbon update    # actualizar desde el servidor
```

Dentro del chat: `/help` lista los comandos. Los principales: `/mode ask|agent|plan`,
`/model`, `/workspace`, `/approve`, `/allow`, `/diff`, `/undo`, `/commit`,
`/run`, `/mcp`, `/remote`, `/compact`, `/nodes`, `/usage`, `/update`.

## Estructura

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
# desde la raíz del repo
(cd apps/cli && python -m lixbon_cli chat)   # ejecutar la fuente modular
python -m pytest apps/cli/tests             # 133 tests, ~7 s
python apps/cli/build.py                    # regenerar client_cli.py tras cualquier cambio
```

Reglas de `build.py` para que la concatenación funcione: imports internos
siempre `from lixbon_cli.x import y` (sin alias) y nombres top-level únicos
entre módulos; el script valida ambas cosas con `ast`.

## Release

1. Subir `CLI_VERSION` en `lixbon_cli/config.py`.
2. `python apps/cli/build.py` y confirmar con `python -m pytest apps/cli/tests`.
3. PR de `cli` a `master`. El siguiente deploy del gateway sirve la versión
   nueva en `GET /install/client_cli.py`; los clientes la reciben con
   `lixbon update` o `/update`.

Contrato con el gateway: el nombre de la API key (`"lixbon CLI"`) debe
coincidir con `CLI_KEY_NAME` en `core/gateway/routers/auth.py`.
