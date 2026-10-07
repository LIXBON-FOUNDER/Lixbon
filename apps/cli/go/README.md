# lixbon CLI (Go)

Port gradual del CLI Python (`../lixbon_cli`). Decisión y plan en `.planning/DECISION-CLI-GO.md`. Python sigue siendo la referencia y el rollback hasta aceptar la paridad.

**Estado a 2026-10-06:** 20 de 31 requisitos v1 implementados con pruebas (CI en Linux, macOS y Windows), 9 parciales y 2 pendientes; detalle en `.planning/REQUIREMENTS.md`. Versión `2.3.0-go.0`, publicada como beta (`cli-v2.3.0-go.0`): `.github/workflows/release-cli.yml` compila los seis destinos y los registra en el gateway, y `lixbon.com/install.sh` e `install.ps1` ya instalan el binario (diseño en `.planning/DECISION-UPDATE-GO.md`). Backlog: issues abiertas de LIXBON-FOUNDER/Lixbon (#18, #20–#22, #25 y #27–#36).

## Estado

| Paquete | Qué hace | Contrato |
|---|---|---|
| `internal/sse` | Stream SSE → eventos tipados, filtro `<think>` | `../validation/fixtures/sse_corpus.json` (oráculo: `sse.py`) |
| `internal/config` | `~/.lixbon/config.json` compatible con Python | BOM, campos desconocidos preservados, escritura atómica 0600 |
| `internal/api` | Cliente del gateway, stream cancelable, login/registro, control remoto, imágenes en formato de visión de OpenAI para proveedores genéricos | sin reintentos del POST, inactividad 300 s, sin gzip |
| `internal/cli` | `init`, `status`, `models`, `usage`, `setup`, `profile`, `chat --once` | pruebas contra un gateway falso; `usage` contrastado con la salida de Python |
| `internal/documents` | Adjuntos `@ruta` (texto, imágenes, PDF), marcadores `[IMG#n]`, extracción de PDF y de `.docx` | `validation/fixtures/documents_corpus.json` (oráculo: `commands.py` y `documents.py` con pypdf y python-docx) |
| `internal/clipboard` | `/paste` y Alt+V: imagen del portapapeles como PNG en `~/.lixbon/pastes` (DIB→PNG a mano, Win32 sin CGO, `wl-paste`/`xclip`/`pngpaste`) | casos DIB del mismo corpus, helpers simulados y una prueba con el portapapeles real de Windows |
| `internal/remote` | Host de `/remote`: sesión en el relay, lotes de eventos cada 250 ms, SSE de comandos con reconexión, aprobaciones, snapshot | relay simulado en memoria y por HTTP |
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
| `internal/mcp` | Cliente MCP por stdio y Streamable HTTP: `mcp.json` de usuario y proyecto, herramientas `mcp__<servidor>__<herramienta>`, paginación, cancelación, cierre que mata el árbol de procesos | `validation/fixtures/mcp_corpus.json` (oráculo: `mcp.py`) + servidor stdio de mentira (el propio binario de pruebas) + servidor HTTP falso |
| `internal/tui` | Interfaz interactiva con **Bubble Tea v2** a pantalla completa (transcript y scroll propios, caja y barra fijas al pie): caja de entrada multilínea, menú `/`, aprobaciones con diff, `/undo`, `/plan`, `/history`, `/provider`… | pruebas del modelo y de un programa real con E/S inyectada; catálogo de comandos contrastado con `state_corpus.json` |
| `internal/update` | `lixbon update [--check]` y `/update`: manifest del gateway, descarga de la release de GitHub, verificación contra el digest del gateway **y** `SHA256SUMS`, comprobación del binario nuevo y reemplazo atómico (en Windows renombra el `.exe` en uso a `.old` y restaura si falla) | pruebas con un servidor de releases falso (digests y archivos manipulados, corte de red, binario roto) y una prueba real en Windows con el `.exe` en uso; diseño en `.planning/DECISION-UPDATE-GO.md` |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `setup`, `status`, `models`, `usage`, `update`, `profile`, `chat`/`run`/`start`, `chat --once "texto"` (según `mode` de la config: `agent` con herramientas y aprobaciones, `ask` solo conversa, `delegate` usa el enrutador del gateway) y `chat` interactivo con Bubble Tea (requiere terminal). `!comando` en la caja ejecuta un comando en el workspace sin pasar por el modelo y deja su salida en el historial (el control remoto lo ignora). Comandos `/` disponibles (los 41 del catálogo, más `/provider` y `/mouse`): `help model mode new clear compact history web copy paste image save approve plan todo tools diff undo ps check allow workspace run mcp commit init status cost usage nodes context-window key login logout config bar doctor visual remote exit` y los personalizados de `.lixbon/commands/`.

Pendiente, con su issue: publicar la primera release e imagen Docker (#20); `ui-demo` no se porta (es una demo interna y oculta de la interfaz Python). Falta validar con modelos, terminales y un gateway reales (#21, #22). Los paquetes de este módulo no dependen de la UI.

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

- `chat --once` respeta `mode` (por defecto `agent`). Carga `LIXBON.md`, guarda la sesión en `~/.lixbon/sessions/` y resuelve los adjuntos `@ruta` igual que el chat.
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
- **MCP:** los servidores de `~/.lixbon/mcp.json` y `<proyecto>/.lixbon/mcp.json` (`servers` o `mcpServers`; `command`/`args`/`env`/`cwd` o `url`/`headers`) arrancan en segundo plano y en paralelo; sus herramientas llegan al modelo según responden, con `[MCP servidor]` en la descripción, y cada llamada pide aprobación como una escritura (salvo auto-aprobar; bloqueadas en `/plan`). El servidor `lixbon` (Visuals) se añade solo con cuenta Lixbon (no en proveedores genéricos) y se desactiva con `"lixbon_mcp": false`. Diferencias con Python: límite de arranque de 60 s en vez de 30 (la primera ejecución de `npx` descarga el paquete), `structuredContent` como respaldo de un resultado vacío, nombres repetidos desambiguados con sufijo y limitados a 64 caracteres, `type: object` añadido a schemas sin tipo, respuesta `ping` a los servidores, y las redirecciones HTTP a otro host se rechazan para no filtrar cabeceras de autenticación. `--once` espera hasta 75 s a que arranquen.
- **Adjuntos:** `@ruta` y `@"ruta con espacios"` (la puntuación pegada, como `@logo.png,`, no entra en la ruta) adjuntan archivos de texto (hasta 64 kB, UTF-8, `\r\n` → `\n`), PDF (texto extraído) e imágenes png/jpg/jpeg/webp (hasta 8 MB, base64). Un `@token` que no apunta a nada del disco se deja tal cual. `/image <ruta>`, `/paste` y Alt+V escriben un marcador `[IMG#n]` en la caja: la imagen viaja solo si el marcador sigue en el mensaje, y Retroceso lo borra de un golpe. Un mensaje cuyo único adjunto falla no se envía. Con un proveedor genérico las imágenes van en el formato de visión de OpenAI (`image_url` con `data:`); con el gateway Lixbon, en el campo `images`. El corpus compara contra Python 27 casos de `@ruta`, los límites y los marcadores.
- **PDF y Word:** `read_file` y los adjuntos extraen el texto en local, sin helpers ni subida. PDF con `github.com/ledongthuc/pdf` (BSD-3, Go puro; elección en `.planning/DECISION-PDF-GO.md`): hasta 200 páginas con el aviso `…[N páginas más no extraídas]`, un PDF escaneado avisa de que no tiene texto (sin OCR), cifrado o dañado da un error claro y la extracción se abandona a los 30 s. `.docx` con `archive/zip` y `encoding/xml`: los párrafos primero y las tablas después, con las celdas combinadas repetidas, igual que python-docx. Diferencias: el texto de un PDF no es idéntico al de pypdf (los saltos de línea y los espacios salen de las posiciones, así que el corpus compara palabra a palabra salvo en los casos simples) y un PDF cuyo `ToUnicode` está roto, como los que genera PyMuPDF al incrustar una fuente, no se lee (error claro). El corpus incluye un PDF real generado con Edge (fuentes TrueType subconjunto) que se lee bien; los de Word y LaTeX no se han probado todavía.
- **`/paste`:** guarda la imagen en `~/.lixbon/pastes` (conserva las 20 últimas). Windows lee un archivo copiado, el formato `PNG` o el DIB (24 y 32 bits, alfa descartado, como Python); Linux y macOS usan `wl-paste`, `xclip` o `pngpaste` si están instalados.
- **`lixbon setup`:** menú numerado (correo y contraseña, crear cuenta o clave de API) con `issue_api_key` y `key_name` «lixbon CLI», como Python; la contraseña y la clave no se muestran en una terminal. Después elige el modelo del servidor si no hay uno. En la interfaz, `/login` solo acepta la API key (la contraseña no se enmascara en la caja): para correo y contraseña usa `lixbon setup`.
- **`lixbon usage`:** misma salida y mismos códigos de salida que Python (barras `#`/`.` con su redondeo, «Sesion (4h)» sin tilde). Con un proveedor genérico lo avisa.
- **`/visual`:** pide el prompt `visual` al servidor MCP de Lixbon, pasa a modo agent y lanza el turno con él; necesita cuenta y gateway Lixbon.
- **`/remote`:** el teclado local queda en pausa (solo Ctrl+C y el desplazamiento), las aprobaciones se piden en el móvil y interrumpir desde la app cancela el turno sin esperar al SSE del modelo. Los eventos viajan en lotes cada 250 ms (máximo 200 por lote); si el servidor no responde, la cola se acota a 1 MiB descartando primero deltas, luego avisos de herramientas, y al volver se reenvía un `snapshot`; no se promete entrega exactamente una vez. `ask_user` no está disponible mientras dura. Un prompt remoto adjunto (imágenes, documentos) se ignora, como en Python.
- **`lixbon update`:** solo canal `beta`; consulta `<gateway>/api/updates/cli/beta` (con un proveedor genérico, `lixbon.com`; `LIXBON_UPDATE_URL` lo sustituye). Exige HTTPS salvo localhost y no instala si cualquiera de los dos digests no coincide. No hay firma de binarios del sistema operativo todavía. El CLI Python no se actualiza a Go por sí solo: se reinstala con el comando de la página.
- La UI es de pantalla completa: el modo inline de Bubble Tea 2.0.10 duplicaba la caja de entrada al encogerse la vista. Se pierde el scrollback nativo, el ratón no se captura por defecto (se puede seleccionar y copiar; AvPág/RePág desplazan) y `/mouse` activa la rueda, a costa de que seleccionar exija Mayús; `/copy` copia la última respuesta; al salir se vuelca el transcript.
- `/provider`, `/mouse` y `lixbon profile` solo existen en Go (no están en el catálogo contrastado con Python).
- Verificado solo con servidores falsos: aún no contra LM Studio, Ollama, OpenAI ni un gateway autenticado (issue #21).

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
