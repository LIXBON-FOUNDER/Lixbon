# lixbon CLI (Go)

Port gradual del CLI Python (`../lixbon_cli`). Decisión y plan en `.planning/DECISION-CLI-GO.md`. Python sigue siendo la referencia y el rollback.

## Estado

| Paquete | Qué hace | Contrato |
|---|---|---|
| `internal/sse` | Stream SSE → eventos tipados, filtro `<think>` | `../validation/fixtures/sse_corpus.json` (oráculo: `sse.py`) |
| `internal/config` | `~/.lixbon/config.json` compatible con Python | BOM, campos desconocidos preservados, escritura atómica 0600 |
| `internal/api` | Cliente del gateway, stream cancelable | sin reintentos del POST, inactividad 300 s, sin gzip |
| `internal/cli` | `init`, `status`, `models`, `chat --once` | pruebas contra un gateway falso |
| `internal/toolspec` | Catálogo de las 20 herramientas (schemas, conjuntos, claves) | `catalog.json` generado por `gen_tool_corpus.py` |
| `internal/toolparse` | Extrae tool-calls del texto del modelo y limpia la prosa | `fixtures/tool_parse_corpus.json` (40 casos de texto + 9 nativos) |
| `internal/tools` | `list_files`, `find_files`, `read_file`, `outline`, `search` | `fixtures/workspace_corpus.json` (87 casos sobre un workspace sintético) |
| `internal/tools` (escritura) | `write_file`, `edit_file` (con coincidencia tolerante), `multi_edit`, `insert_at_line`, `append_file`, `mkdir`, `delete_file`, `rename_file` | `fixtures/edit_corpus.json` (61 casos con árbol inicial y final) |
| `internal/process` | Shell con timeout, cancelación, muerte del árbol de procesos, captura acotada y procesos en segundo plano | pruebas con procesos reales (árbol de 2 niveles) |
| `internal/tools` (`Toolbox`) | `run_command`, `read_output`, `stop_command`, `fetch_url`, `web_search`, `todo`, `ask_user` con estado de sesión | `html_cases` del corpus + pruebas con servidores falsos |
| `internal/history` | Ventana de contexto: estimación de tokens, recorte, poda segura y compactación | `fixtures/agent_corpus.json` (sección `history`, incluye la longitud `repr` de Python) |
| `internal/agent` | Política de comandos, prompts del sistema, nudges, saneado de historial | `agent_corpus.json` (política, prompts byte a byte, árbol del workspace) |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `status`, `models`, `chat --once "texto"`. Pendiente: aprobaciones, snapshots y `/undo`, verificadores, bucle del agente, interfaz interactiva con **Bubble Tea**, `setup`, `usage`, `update`, MCP, remoto. Los paquetes de este módulo no dependen de la UI.

## Diferencias deliberadas con Python

- `chat --once` equivale hoy al modo `ask`: sin herramientas, sin `LIXBON.md`, sin adjuntos ni historial persistente. Envía `think` solo cuando se añada el agente.
- Los errores de `chat` van a stderr; `status` y `models` siguen imprimiendo a stdout como Python.
- Si no hay modelo y el servidor no define uno para `chat`, falla con un mensaje en vez de abrir un selector.
- Ctrl+C durante `--once` termina con código 0 (igual que Python) y escribe `— interrumpido —` en stderr.
- Versión `2.3.0-go.0` en `status` y en el `User-Agent`.

- `search` usa un recorrido propio en Go (poda carpetas ignoradas, lee por líneas, respeta cancelación) en lugar de ripgrep; el orden de salida es el léxico del recorrido.
- Las lecturas están acotadas: líneas de más de 1 MiB se recortan, un rango de más de 120.000 caracteres se corta con aviso, y `end_line` negativo se trata como ausente.
- Las escrituras son atómicas (temporal + renombrado) y conservan los bytes y el modo del archivo: `write_file` no convierte `
` en `
` en Windows como hace Python.
- `edit_file` e `insert_at_line` se niegan a editar archivos que no son UTF-8 válido (Python los reescribía con U+FFFD); `delete_file` se niega a borrar la raíz del workspace; `multi_edit` sobre un archivo inexistente dice «no encontrado» en vez de contarlo como éxito.
- `run_command`: la salida se captura con memoria acotada (inicio y final, nunca el total); el timeout y la cancelación matan el árbol entero (`taskkill /T` en Windows, grupo de procesos en Unix). En Windows la salida que no es UTF-8 se decodifica con la página OEM de la consola en vez de la ANSI. `cmd` se lanza con `/d`.
- `fetch_url` admite los juegos de caracteres UTF-8, ISO-8859-1 y Windows-1252; otros se leen como UTF-8 con sustitución. Sigue sin bloquear direcciones locales o internas (igual que Python): las aprobaciones del agente son la defensa.
- `todo` y `ask_user` viven en el `Toolbox` y avisan a la interfaz por callbacks (`OnTodo`, `AskUser`): la capa Bubble Tea los conectará.
- Política de comandos: un prefijo vacío o solo de espacios no permite nada (en Python actuaba de comodín).
- La firma de repetición de llamadas (`MAX_REPEATED_CALLS`) usará un hash del JSON canónico completo en vez de los primeros 400 caracteres.
- `read_file` de PDF y Word devuelve «aún no disponible» hasta decidir la biblioteca de extracción.

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
