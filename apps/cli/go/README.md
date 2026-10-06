# lixbon CLI (Go)

Port gradual del CLI Python (`../lixbon_cli`). Decisión y plan en `.planning/DECISION-CLI-GO.md`. Python sigue siendo la referencia y el rollback hasta aceptar la paridad.

**Estado a 2026-10-06:** 14 de 31 requisitos v1 implementados con pruebas (CI en Linux, macOS y Windows), 7 parciales y 10 pendientes; detalle en `.planning/REQUIREMENTS.md`. Versión `2.3.0-go.0`, aún sin distribuir: los instaladores del gateway siguen sirviendo `client_cli.py`. Backlog: issues #12–#25 de LIXBON-FOUNDER/Lixbon.

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
| `internal/tui` | Interfaz interactiva con **Bubble Tea v2** a pantalla completa (transcript y scroll propios, caja y barra fijas al pie): caja de entrada multilínea, menú `/`, aprobaciones con diff, `/undo`, `/plan`, `/history`, `/provider`… | pruebas del modelo y de un programa real con E/S inyectada; catálogo de comandos contrastado con `state_corpus.json` |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `status`, `models`, `profile`, `chat`/`run`/`start`, `chat --once "texto"` (según `mode` de la config: `agent` con herramientas y aprobaciones, `ask` solo conversa, `delegate` usa el enrutador del gateway) y `chat` interactivo con Bubble Tea (requiere terminal). Comandos `/` disponibles (35 de 41 del catálogo, más `/provider`): `help model mode new clear compact history web copy save approve plan todo tools diff undo ps check allow workspace run commit init status cost usage nodes context-window key login logout config bar doctor exit` y los personalizados de `.lixbon/commands/`.

Pendiente, con su issue: `/image` y adjuntos `@ruta` (#13), `/paste` (#15), `/visual` (#16), `/mcp` y el cliente MCP (#12), `/remote` (#17), `/update` y `update` (#18), y los subcomandos `setup`, `usage` y `ui-demo` (#19). También PDF y Word en `read_file` (#14) y la distribución (#20). Los paquetes de este módulo no dependen de la UI.

## Proveedores de modelos

El CLI puede hablar con cualquier servidor compatible con OpenAI además de con un gateway Lixbon. Cada proveedor es un perfil; los campos de nivel superior de `config.json` (`base_url`, `api_key`, `model`…) son los del perfil activo, así que el CLI Python sigue funcionando con el mismo archivo.

```bash
lixbon profile add lmstudio --use              # http://localhost:1234/v1, sin clave
lixbon profile add ollama --model llama3
lixbon profile add openrouter --api-key <clave> --model <modelo>
lixbon profile add nube --base-url https://mi-servidor/v1 --api-key <clave>
lixbon profile                                 # listar
lixbon profile use lixbon                      # volver al gateway
```

En el chat, `/provider` abre el selector (también permite añadir uno) y `/provider nombre` cambia directamente. Presets: `lmstudio`, `ollama`, `openai`, `openrouter`.

Un perfil sin `--gateway` es genérico: solo se envían `model`, `messages`, `stream`, `stream_options` y `tools` (OpenAI rechaza los parámetros desconocidos), la clave es opcional y no se consultan los endpoints `/api` de Lixbon (plan, uso, nodos, búsqueda web, título automático). `/usage /nodes /login /logout /key /web` lo avisan y el modo `delegate` pasa a `ask`. La ventana de contexto por defecto es de 8192 tokens; ajústala a la que cargaste en el servidor con `--context-window`.

Una suscripción de ChatGPT o Claude no es una API key y no sirve aquí: hace falta una clave de API del proveedor (o un enrutador como OpenRouter).

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
- `read_file` de PDF y Word devuelve «aún no disponible» hasta decidir la biblioteca de extracción (issue #14).
- La UI es de pantalla completa: el modo inline de Bubble Tea 2.0.10 duplicaba la caja de entrada al encogerse la vista. Se pierde el scrollback nativo, la selección con ratón exige Mayús y `/copy` copia la última respuesta; al salir se vuelca el transcript.
- `/provider` y `lixbon profile` solo existen en Go (no están en el catálogo contrastado con Python).
- Verificado solo con servidores falsos: aún no contra LM Studio, Ollama, OpenAI ni un gateway autenticado (issue #21).

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
