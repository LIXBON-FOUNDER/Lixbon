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
| `internal/agent` | Bucle del turno (pasos, reintentos, rescate del razonamiento, repeticiones), aprobaciones, vista previa y diff, checkpoints/undo, verificadores, política de comandos y prompts | `agent_corpus.json` (política, prompts byte a byte, árbol, diff con `SequenceMatcher`, vista previa, resúmenes) + 50 pruebas del bucle con un modelo falso |
| `internal/session` | Historial persistente en `~/.lixbon/sessions/` (mismo formato que Python), retención de 200, índice con candado y auto-reparación | `state_corpus.json`: Go lee lo que escribió Python y reproduce sus archivos con el mismo reloj |
| `internal/workspace` | `LIXBON.md` / `lixbon.md` y comandos propios (`.lixbon/commands/*.md`, `$ARGUMENTS`) | `state_corpus.json` |
| `internal/chat` | Estado de la conversación sin interfaz: modelo, modo, sesión, compactación, título automático, contexto de workspace | pruebas contra un gateway falso |
| `internal/tui` | Interfaz interactiva con **Bubble Tea v2** (inline): caja de entrada multilínea, menú `/`, aprobaciones con diff, `/undo`, `/plan`, `/history`… | pruebas del modelo y de un programa real con E/S inyectada; catálogo de comandos contrastado con `state_corpus.json` |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `status`, `models`, `chat --once "texto"` (según `mode` de la config: `agent` con herramientas y aprobaciones, `ask` solo conversa, `delegate` usa el enrutador del gateway) y `chat` interactivo con Bubble Tea (requiere terminal). Comandos `/` ya disponibles: `help model mode compact history web copy save approve plan todo tools diff undo ps check allow workspace run commit init status cost usage nodes context key logout config doctor` y los personalizados de `.lixbon/commands/`. Pendiente: `/image /paste /visual /mcp /remote /update`, adjuntos `@ruta`, MCP, remoto, `setup`, `update`. Los paquetes de este módulo no dependen de la UI.

## Diferencias deliberadas con Python

- `chat --once` respeta `mode` (por defecto `agent`). Carga `LIXBON.md` y guarda la sesión en `~/.lixbon/sessions/`; aún sin adjuntos `@ruta`.
- En `--once` no hay nadie al teclado: las ediciones se aprueban según `auto_approve_tools` y los comandos solo si están en `allowed_commands`, `auto_run_commands` o se pasa `--auto-run` (opción propia del CLI Go); lo rechazado se explica en stderr y el modelo recibe «Ejecución cancelada por el usuario».
- El registro de acciones del agente va a stderr y la respuesta final a stdout, para poder encadenar el comando.
- Los errores de `chat` van a stderr; `status` y `models` siguen imprimiendo a stdout como Python.
- Si no hay modelo y el servidor no define uno para `chat`, falla con un mensaje en vez de abrir un selector.
- Ctrl+C durante `--once` termina con código 0 (igual que Python) y escribe `— interrumpido —` en stderr.
- Versión `2.3.0-go.0` en `status` y en el `User-Agent`.

- `search` usa un recorrido propio en Go (poda carpetas ignoradas, lee por líneas, respeta cancelación) en lugar de ripgrep; el orden de salida es el léxico del recorrido.
- Las lecturas están acotadas: líneas de más de 1 MiB se recortan, un rango de más de 120.000 caracteres se corta con aviso, y `end_line` negativo se trata como ausente.
- Las escrituras son atómicas (temporal + renombrado) y conservan los bytes y el modo del archivo: `write_file` no convierte `\n` en `\r\n` en Windows como hace Python.
- `edit_file` e `insert_at_line` se niegan a editar archivos que no son UTF-8 válido (Python los reescribía con U+FFFD); `delete_file` se niega a borrar la raíz del workspace; `multi_edit` sobre un archivo inexistente dice «no encontrado» en vez de contarlo como éxito.
- `run_command`: la salida se captura con memoria acotada (inicio y final, nunca el total); el timeout y la cancelación matan el árbol entero (`taskkill /T` en Windows, grupo de procesos en Unix). En Windows la salida que no es UTF-8 se decodifica con la página OEM de la consola en vez de la ANSI. `cmd` se lanza con `/d`.
- `fetch_url` admite los juegos de caracteres UTF-8, ISO-8859-1 y Windows-1252; otros se leen como UTF-8 con sustitución. Sigue sin bloquear direcciones locales o internas (igual que Python): las aprobaciones del agente son la defensa.
- `todo` y `ask_user` viven en el `Toolbox` y avisan a la interfaz por callbacks (`OnTodo`, `AskUser`): la capa Bubble Tea los conectará.
- Política de comandos: un prefijo vacío o solo de espacios no permite nada (en Python actuaba de comodín).
- La firma de repetición de llamadas (`MAX_REPEATED_CALLS`) usará un hash del JSON canónico completo en vez de los primeros 400 caracteres.
- La vista previa de aprobación se calcula con las mismas funciones puras que la herramienta (`ApplyEdit`, `ApplyMultiEdit`, `ApplyInsert`): el diff que se aprueba es lo que se escribe. Python mostraba un diff distinto en inserciones, ediciones ambiguas o tolerantes y `multi_edit` con un fallo intermedio.
- Los verificadores no escriben nada junto al archivo (Python creaba `__pycache__` con `py_compile`), un verificador que no puede ejecutarse cuenta como «sin errores», y los `.go` se comprueban con `go/parser` en proceso.
- El prompt de herramientas MCP en protocolo de texto sí llega al modelo (en Python se añadía después de crear el mensaje y se perdía).
- Los diffs de más de 5.000 líneas por lado se muestran como sustitución completa para acotar el coste.
- `LIXBON.md` entra también en el prompt del agente (en Python solo llegaba en modo `ask`).
- `config.json` se guarda de forma atómica y, si el existente está corrupto, se conserva una copia `config.json.corrupt-<fecha>` antes de reemplazarlo.
- El índice de sesiones se actualiza bajo un candado (`.index.lock`, caduca a los 30 s) y `List` rehace el índice si falta alguna sesión en disco: dos CLI (o el CLI Python) guardando a la vez no pierden entradas.
- `read_file` de PDF y Word devuelve «aún no disponible» hasta decidir la biblioteca de extracción.

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
