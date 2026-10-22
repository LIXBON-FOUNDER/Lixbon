# lixbon CLI (Go)

CLI de Lixbon en Go. Decisión y plan en `.planning/DECISION-CLI-GO.md`. El cliente Python anterior se retiró del repositorio; la etiqueta `python-cli-final` conserva su último estado como rollback.

**Estado a 2026-10-06:** 20 de 31 requisitos v1 implementados con pruebas (CI en Linux, macOS y Windows), 9 parciales y 2 pendientes; detalle en `.planning/REQUIREMENTS.md`. Versión `2.3.0-go.0`, publicada como beta (`cli-v2.3.0-go.0`): `.github/workflows/release-cli.yml` compila los seis destinos y los registra en el gateway, y `lixbon.com/install.sh` e `install.ps1` ya instalan el binario (diseño en `.planning/DECISION-UPDATE-GO.md`). Backlog: issues abiertas de LIXBON-FOUNDER/Lixbon (#18, #20–#22, #25 y #27–#36).

## Estado

| Paquete | Qué hace | Contrato |
|---|---|---|
| `internal/sse` | Stream SSE → eventos tipados, filtro `<think>` | `../validation/fixtures/sse_corpus.json` |
| `internal/config` | `~/.lixbon/config.json` compatible con Python | BOM, campos desconocidos preservados, escritura atómica 0600 |
| `internal/api` | Cliente del gateway, stream cancelable, canje del login por navegador, control remoto, imágenes en formato de visión de OpenAI para proveedores genéricos | sin reintentos del POST, inactividad 300 s, sin gzip |
| `internal/weblogin` | Login por navegador: PKCE (S256) con un servidor de un solo uso en `127.0.0.1` contra `/ide/connect?client=cli`, apertura del navegador y lectura de la dirección pegada a mano | pruebas del state, la cancelación, el timeout y la dirección pegada |
| `internal/cli` | `init`, `status`, `models`, `usage`, `setup`, `profile`, `chat --once` | pruebas contra un gateway falso; `usage` contrastado con la salida de Python |
| `internal/events` | Lectura paginada y seguimiento del Event Log del Core (`GET /events`, contrato v=1) | exige `LXO_TASK_ID` + `LXO_CLIENT_TOKEN`; valida `/handshake` antes de cada lectura y conserva el cursor solo en estado local del cliente |
| `internal/documents` | Adjuntos `@ruta` (texto, imágenes, PDF), marcadores `[IMG#n]`, extracción de PDF y de `.docx` | `validation/fixtures/documents_corpus.json` |
| `internal/clipboard` | `/paste` y Alt+V: imagen del portapapeles como PNG en `~/.lixbon/pastes` (DIB→PNG a mano, Win32 sin CGO, `wl-paste`/`xclip`/`pngpaste`) | casos DIB del mismo corpus, helpers simulados y una prueba con el portapapeles real de Windows |
| `internal/remote` | Host de `/remote`: sesión en el relay, lotes de eventos cada 250 ms, SSE de comandos con reconexión, aprobaciones, snapshot | relay simulado en memoria y por HTTP |
| `internal/toolspec` | Catálogo de las 31 herramientas (schemas, conjuntos, claves) | `catalog.json` (contrato congelado) |
| `internal/browser` | Navegador del agente: lanza el navegador predeterminado (o Chrome/Brave/Chromium/Edge instalado) con un perfil propio y lo controla por CDP (cliente propio sobre `coder/websocket`); snapshot con refs `[eN]` desde un mundo aislado, clics y teclado reales, capturas JPEG | pruebas unitarias del formato, URLs, teclas y descubrimiento; prueba real con `LIXBON_BROWSER_LIVE=1` (Shadow DOM, iframes, diálogos, pestañas nuevas, adjuntarse desde otra sesión) |
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
| `internal/mcp` | Cliente MCP por stdio y Streamable HTTP: `mcp.json` de usuario y proyecto, herramientas `mcp__<servidor>__<herramienta>`, paginación, cancelación, cierre que mata el árbol de procesos | `validation/fixtures/mcp_corpus.json` + servidor stdio de mentira (el propio binario de pruebas) + servidor HTTP falso |
| `internal/tui` | Interfaz interactiva con **Bubble Tea v2** a pantalla completa (limpia la terminal al entrar; transcript y scroll propios, caja y barra fijas al pie; la rueda siempre desplaza y arrastrar con el ratón selecciona y copia; Ctrl+T abre un visor del transcript): caja de entrada multilínea, menú `/`, aprobaciones con diff, `/undo`, `/plan`, `/history`, `/provider`… | pruebas del modelo y de un programa real con E/S inyectada; catálogo de comandos contrastado con `state_corpus.json` |
| `internal/update` | `lixbon update [--check]` y `/update`: manifest del gateway, descarga de la release de GitHub, verificación contra el digest del gateway **y** `SHA256SUMS`, comprobación del binario nuevo y reemplazo atómico (en Windows renombra el `.exe` en uso a `.old` y restaura si falla) | pruebas con un servidor de releases falso (digests y archivos manipulados, corte de red, binario roto) y una prueba real en Windows con el `.exe` en uso; diseño en `.planning/DECISION-UPDATE-GO.md` |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `setup`, `status`, `models`, `usage`, `update`, `auth`, `profile`, `chat`/`run`/`start`, `chat --once "texto"` (según `mode` de la config: `agent` con herramientas y aprobaciones, `ask` conversa y lee el proyecto sin modificarlo, `delegate` usa el enrutador del gateway) y `chat` interactivo con Bubble Tea (requiere terminal). `!comando` en la caja ejecuta un comando en el workspace sin pasar por el modelo y deja su salida en el historial (el control remoto lo ignora). Comandos `/` disponibles (los 42 del catálogo, más `/provider`, `/effort`, `/branch`, `/orquestar` y `/orquestador`): `help model mode new clear compact history web copy paste image save approve plan todo tools diff undo ps check allow workspace run mcp browser commit init status cost usage nodes context-window key login logout config bar doctor visual remote exit` y los personalizados de `.lixbon/commands/`.

`lixbon events` se ejecuta dentro de una tarea del orquestador y necesita `LXO_TASK_ID` y `LXO_CLIENT_TOKEN`, que entrega el entorno del agente. Solo lee puerto y versión de `orch.json`; nunca obtiene la credencial de ese archivo. Antes de cada página valida `/handshake` y sus capacidades. Consulta `lixbon events --help` para filtros, paginación y seguimiento.

Pendiente, con su issue: publicar la primera release e imagen Docker (#20); `ui-demo` no se porta (es una demo interna y oculta de la interfaz Python). Falta validar con modelos, terminales y un gateway reales (#21, #22). Los paquetes de este módulo no dependen de la UI.

## Proveedores de modelos

El CLI puede hablar con cualquier servidor compatible con OpenAI además de con un gateway Lixbon. Cada proveedor es un perfil; los campos de nivel superior de `config.json` (`base_url`, `api_key`, `model`…) son los del perfil activo, así que el CLI Python sigue funcionando con el mismo archivo.

La forma más corta de conectar uno es `lixbon auth`, como `opencode auth`:

```bash
lixbon auth login                              # elegir de una lista (presets, guardados u «otro»)
lixbon auth login openrouter                   # pide la clave sin mostrarla y activa el proveedor
lixbon auth login kilo --api-key <clave>       # presets: openrouter, openai, kilo, groq, deepseek, mistral, gemini, xiaomi, lmstudio, ollama
lixbon auth login nube --base-url https://mi-servidor/v1
lixbon auth login lixbon                       # volver a iniciar sesión en lixbon.com
lixbon auth list                               # qué proveedor tiene clave (enmascarada)
lixbon auth logout nube                        # quita la clave, conserva el proveedor
```

`lixbon` arranca aunque no haya sesión en lixbon.com (o aunque la clave haya dejado de valer): abre el chat con un aviso y `/provider` conecta otro proveedor desde dentro, `/login` vuelve a lixbon.com. Enviar un mensaje sin proveedor conectado explica qué hacer en lugar de fallar.

Los mismos perfiles se pueden gestionar con `lixbon profile`:

```bash
lixbon profile add lmstudio --use              # http://localhost:1234/v1, sin clave
lixbon profile add ollama --model llama3
lixbon profile add openrouter --api-key <clave> --model <modelo>
lixbon profile add nube --base-url https://mi-servidor/v1 --api-key <clave>
lixbon profile                                 # listar
lixbon profile use lixbon                      # volver al gateway
lixbon profile set nube --api-key <clave>      # cambiar solo la clave (también --base-url, --model, --context-window)
```

Cada proveedor guarda su propia URL, clave y modelo, y el perfil guardado es la fuente de verdad: si los campos de nivel superior de `config.json` no coinciden con los del perfil activo, al cargar manda el perfil. Eso significa que editar a mano `base_url` o `api_key` fuera del bloque `profiles` ya no tiene efecto cuando hay perfiles (el CLI Python, que solo toca los campos de nivel superior, deja de ser compatible con un archivo que use varios proveedores). `lixbon init`, `/model` y `/key` modifican siempre el proveedor activo; para tocar otro, `profile set` o `auth login`. Al cambiar de proveedor el CLI lo consulta y muestra cuántos modelos ofrece; si el modelo guardado no está en su lista o no hay ninguno, abre el selector. Un error HTTP al listar los modelos se muestra tal cual (una URL sin `/v1` responde 404) y una clave rechazada pide la nueva en el momento.

En el chat, `/provider` abre el selector (también permite añadir uno eligiendo un preset y pegando solo la clave), `/provider nombre` cambia directamente y `/provider key nombre` cambia la clave de un proveedor sin activarlo.

Un perfil sin `--gateway` es genérico: solo se envían `model`, `messages`, `stream`, `stream_options` y `tools` (OpenAI rechaza los parámetros desconocidos), la clave es opcional y no se consultan los endpoints `/api` de Lixbon (plan, uso, nodos, búsqueda web, título automático). `/usage /nodes /login /logout /key /web` lo avisan y el modo `delegate` pasa a `ask`. La ventana de contexto por defecto es de 8192 tokens (128000 en Xiaomi MiMo); ajústala a la que cargaste en el servidor con `--context-window`.

Xiaomi MiMo: el preset `xiaomi` es la API de pago por uso (`api.xiaomimimo.com`). Una clave del Token Plan (`tp-…`) va con la URL de tu Token Plan, por ejemplo `lixbon auth login xiaomi --base-url https://token-plan-sgp.xiaomimimo.com/v1`. Con MiMo el CLI devuelve el razonamiento como `reasoning_content` en los pasos con herramientas y `/effort off` lo apaga con `thinking: {"type": "disabled"}`.

Una suscripción de ChatGPT o Claude no es una API key y no sirve aquí: hace falta una clave de API del proveedor (o un enrutador como OpenRouter).

## Navegador del agente

En modo agent (y en ask, solo para abrir y leer), el agente controla un navegador real con las herramientas `browser_*`: `navigate`, `snapshot`, `click`, `type`, `press_key`, `scroll`, `screenshot` (solo con modelos que ven imágenes), `get_text`, `tabs`, `wait` y `back`. Usa tu navegador predeterminado si es Chrome, Brave, Chromium o Edge; si no, el primero instalado en ese orden (Edge el último: viene con Windows aunque no se use). Cada navegador tiene su perfil propio en `~/.lixbon/browser-profile` (Chrome) o `~/.lixbon/browser-profile-<brave|chromium|edge>`: las sesiones que inicies ahí (`/browser open <url>`) quedan guardadas para el agente, separadas de tu navegador personal. El navegador se abre con la primera página que pida el agente y se cierra al salir; si hay otro `lixbon` abierto, se comparte.

Permisos: leer no pregunta; navegar o actuar en un sitio nuevo pide permiso por origen («sí», «siempre en este sitio», «no preguntar más en el navegador»), salvo `localhost`. `auto_approve_tools` no lo cubre. Escribir en contraseñas, tarjetas o códigos pregunta siempre. Solo se abren `http`, `https` y `about:blank`. Lo que devuelve la página va delimitado como contenido de terceros y el prompt prohíbe seguir sus instrucciones.

| Clave de `config.json` / variable | Efecto |
|---|---|
| `browser`: `auto` (defecto), `on`, `off` | En `auto` las herramientas solo se ofrecen con una ventana de contexto de 32k o más (cuestan ~1.5k tokens). `/browser on\|off\|auto` lo cambia |
| `browser_path` o `LIXBON_BROWSER` | Ejecutable a usar en lugar de buscarlo |
| `browser_headless` o `LIXBON_BROWSER_HEADLESS=1` | Sin ventana (automático en Linux sin `DISPLAY`) |
| `browser_auto_approve` | No preguntar en ningún sitio (`--once` lo necesita para actuar) |
| `browser_keep_open` | Dejar el navegador abierto al salir |

`/browser` muestra el estado, las pestañas y los sitios aprobados; `/browser close` lo cierra.

**Vista previa del proyecto:** `browser_navigate` acepta la ruta de un archivo o carpeta del workspace (`index.html`, `web/`, `logo.svg`, `file:///…`) y la abre desde un servidor estático en `127.0.0.1` con puerto aleatorio. Así funcionan los módulos ES y `fetch` (con `file://` no) y no pide permiso, como `localhost`. Solo sirve el workspace, nunca archivos ocultos (`.env`, `.git`), y responde únicamente a su `Host` exacto (sin rebinding de DNS). Se apaga al cerrar la sesión. Un nombre sin barra que parece un dominio (`lixbon.com`) se abre como web; para una carpeta con ese nombre se escribe `./lixbon.com`. En páginas locales (la vista previa o tu `localhost`) se activa la consola: los errores de JavaScript, `console.error` y los recursos que no cargan llegan en el resultado, sin repetir y como mucho 6. En webs ajenas la consola sigue apagada, porque `Runtime.enable` delata la automatización.

Mientras el agente usa el navegador, la pestaña lleva un borde verde pulsante, una barra animada arriba y el aviso «Lixbon está usando este navegador», y su cursor se desliza hasta cada clic. Al acabar el turno el aviso se apaga (tampoco vuelve si navegas tú) y se apunta la pestaña en la que quedó: el prompt del turno siguiente se la indica al modelo, y otra sesión del CLI que se adjunte la retoma (`tab` en `lixbon-browser.json`). En el transcript, las acciones seguidas en el navegador comparten una fila «Navegador · <acción actual>» que cambia con cada paso, igual que las lecturas seguidas («Explorando …» → «Exploró …»); lo pensado entre pasos queda dentro del grupo y Ctrl+O lo despliega.

## Diferencias deliberadas con el cliente Python retirado

- `chat --once` respeta `mode` (por defecto `agent`). Carga `LIXBON.md`, guarda la sesión en `~/.lixbon/sessions/` y resuelve los adjuntos `@ruta` igual que el chat.
- En `--once` no hay nadie al teclado: las ediciones se aprueban según `auto_approve_tools` y los comandos solo si están en `allowed_commands`, `auto_run_commands` o se pasa `--auto-run` (opción propia del CLI Go); lo rechazado se explica en stderr y el modelo recibe «Ejecución cancelada por el usuario».
- El registro de acciones del agente va a stderr y la respuesta final a stdout, para poder encadenar el comando.
- Los errores de `chat` van a stderr; `status` y `models` siguen imprimiendo a stdout como Python.
- Si no hay modelo y el servidor no define uno para `chat`, falla con un mensaje en vez de abrir un selector.
- Ctrl+C durante `--once` termina con código 0 (igual que Python) y escribe `— interrumpido —` en stderr.
- La versión la inyecta `release-cli.yml` desde la etiqueta; se ve con `lixbon --version`, en `status` y en el `User-Agent` (una compilación local informa `0.0.0-dev`).
- `lixbon update` (alias `lixbon --update`; `--check` solo comprueba) y `/update` instalan la última versión. Al abrir el chat se avisa en segundo plano, como mucho una vez al día (marca en `~/.lixbon/update_check`, sin enviar datos del usuario), si hay una versión nueva; se desactiva con `"update_check": false` en `config.json` o con `LIXBON_NO_UPDATE_CHECK=1`, y no corre con proveedores genéricos ni en `chat --once`.
- Con Lixbon Desktop abierto, al abrir el chat una nota resume el trabajo activo y lo que pide atención según el Core (`lxo summary`: solo cuenta, sin nombres ni títulos). No espera más de 1,5 s ni bloquea la entrada; con Desktop cerrado no dice nada. Va aparte del aviso de versión nueva. Se desactiva con `"startup_summary": false` en `config.json` o con `LIXBON_NO_STARTUP_SUMMARY=1`.
- En el chat, `! lxo …` funciona aunque `lxo` no esté en el `PATH`: el CLI usa el que publica Lixbon Desktop. `! lxo attention`, `! lxo tasks`, `! lxo task show <id>`, `! lxo projects` y `! lxo summary` se pintan con los estilos del chat (a partir de su `--json`). El resto de órdenes de `lxo`, o con `--json`, `--help` o `--follow`, salen tal cual. El modelo recibe el resultado como con cualquier `!`.

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
- **Orquestador (Lixbon Desktop):** `/orquestar <objetivo>` convierte al agente en coordinador de un equipo de agentes que corre en Lixbon Desktop (cada lanzamiento y cada integración las aprueba una persona allí) y `/orquestador` muestra los runs con `lxo list`. El CLI busca `lxo` en `LXO_BIN`, en la ruta que publica el desktop en `~/.lixbon/orch.json` o en el `PATH`, y comprueba que el servidor local responde; si falta algo, lo dice. Una llamada suelta a `lxo` se ejecuta sin pedir permiso (encadenada con `&&`, `;` o `|` sigue preguntando); el resto de comandos mantiene su política.
- **Agente hijo (`lixbon worker`):** el orquestador de Lixbon Desktop puede lanzar al CLI como un agente más, con cualquier proveedor de `lixbon profile` (Ollama, LM Studio, Kilo, OpenAI…). `lixbon worker --profile explorar|proponer|delegar_con_revision [--provider PERFIL] [--model MODELO] "encargo"` solo corre dentro de una tarea del orquestador (necesita `LXO_TASK_ID`), sin interfaz ni MCP, y entrega su respuesta final como informe con `lxo report`. En `explorar` y `proponer` corre en modo plan (no edita ni ejecuta); en `delegar_con_revision` edita dentro de su worktree y solo ejecuta los comandos de `allowed_commands` y las llamadas a `lxo` (los demás se rechazan porque nadie responde en la terminal). No toca `config.json` ni guarda conversaciones, así que el proveedor y el modelo del rol no cambian los tuyos. `lixbon profile list --json` lista los proveedores (nunca las claves) para que el desktop los ofrezca como modelos del rol.
- **MCP:** los servidores de `~/.lixbon/mcp.json` y `<proyecto>/.lixbon/mcp.json` (`servers` o `mcpServers`; `command`/`args`/`env`/`cwd` o `url`/`headers`) arrancan en segundo plano y en paralelo; sus herramientas llegan al modelo según responden, con `[MCP servidor]` en la descripción, y cada llamada pide aprobación como una escritura (salvo auto-aprobar; bloqueadas en `/plan`). `/mcp` los lista (elegir uno enseña sus herramientas) y «Añadir servidor MCP…» abre un formulario (nombre, comando o URL, variables o cabeceras, y si va al `mcp.json` del usuario o del proyecto) que escribe el archivo sin tocar el resto y arranca el servidor sin reiniciar. El servidor `lixbon` (Visuals) se añade solo con cuenta Lixbon (no en proveedores genéricos) y se desactiva con `"lixbon_mcp": false`. Diferencias con Python: límite de arranque de 60 s en vez de 30 (la primera ejecución de `npx` descarga el paquete), `structuredContent` como respaldo de un resultado vacío, nombres repetidos desambiguados con sufijo y limitados a 64 caracteres, `type: object` añadido a schemas sin tipo, respuesta `ping` a los servidores, y las redirecciones HTTP a otro host se rechazan para no filtrar cabeceras de autenticación. `--once` espera hasta 75 s a que arranquen.
- **Adjuntos:** `@ruta` y `@"ruta con espacios"` (la puntuación pegada, como `@logo.png,`, no entra en la ruta) adjuntan archivos de texto (hasta 64 kB, UTF-8, `\r\n` → `\n`), PDF (texto extraído) e imágenes png/jpg/jpeg/webp (hasta 8 MB, base64). Un `@token` que no apunta a nada del disco se deja tal cual. `/image <ruta>`, `/paste` y Alt+V escriben un marcador `[IMG#n]` en la caja: la imagen viaja solo si el marcador sigue en el mensaje, y Retroceso lo borra de un golpe. Un mensaje cuyo único adjunto falla no se envía. Con un proveedor genérico las imágenes van en el formato de visión de OpenAI (`image_url` con `data:`); con el gateway Lixbon, en el campo `images`. El corpus compara contra Python 27 casos de `@ruta`, los límites y los marcadores.
- **PDF y Word:** `read_file` y los adjuntos extraen el texto en local, sin helpers ni subida. PDF con `github.com/ledongthuc/pdf` (BSD-3, Go puro; elección en `.planning/DECISION-PDF-GO.md`): hasta 200 páginas con el aviso `…[N páginas más no extraídas]`, un PDF escaneado avisa de que no tiene texto (sin OCR), cifrado o dañado da un error claro y la extracción se abandona a los 30 s. `.docx` con `archive/zip` y `encoding/xml`: los párrafos primero y las tablas después, con las celdas combinadas repetidas, igual que python-docx. Diferencias: el texto de un PDF no es idéntico al de pypdf (los saltos de línea y los espacios salen de las posiciones, así que el corpus compara palabra a palabra salvo en los casos simples) y un PDF cuyo `ToUnicode` está roto, como los que genera PyMuPDF al incrustar una fuente, no se lee (error claro). El corpus incluye un PDF real generado con Edge (fuentes TrueType subconjunto) que se lee bien; los de Word y LaTeX no se han probado todavía.
- **`/paste`:** guarda la imagen en `~/.lixbon/pastes` (conserva las 20 últimas). Windows lee un archivo copiado, el formato `PNG` o el DIB (24 y 32 bits, alfa descartado, como Python); Linux y macOS usan `wl-paste`, `xclip` o `pngpaste` si están instalados.
- **Inicio de sesión:** el CLI nunca pide correo ni contraseña. `lixbon setup`, `lixbon auth login lixbon`, `/login` y el arranque sin sesión abren una pantalla con dos caminos: **lixbon.com** (se abre el navegador; con la sesión de la web iniciada basta con autorizar, y si no, se entra allí —también con Google, GitHub o creando la cuenta— y se vuelve sola a la terminal) o **API key** (enmascarada). El navegador vuelve a un servidor de un solo uso en `127.0.0.1` (5 min); si no puede llegar, por ejemplo en SSH, se pega la dirección final con `p`. La clave que se emite se llama «lixbon CLI» y no rota la de la app de escritorio (necesita el gateway con `client`/`key_name` en `/api/auth/ide/exchange`). Sin terminal, `lixbon setup` imprime la dirección y espera, o usa `lixbon setup --api-key lixbon_sk_…`. Después se usa el modelo de chat que fije el servidor; si no fija ninguno, se elige con `/model`. `/key` sin argumento abre la pantalla en el paso de la clave.
- **`lixbon usage`:** misma salida y mismos códigos de salida que Python (barras `#`/`.` con su redondeo, «Sesion (4h)» sin tilde). Con un proveedor genérico lo avisa.
- **`/visual`:** pide el prompt `visual` al servidor MCP de Lixbon, pasa a modo agent y lanza el turno con él; necesita cuenta y gateway Lixbon.
- **`/remote`:** el teclado local queda en pausa (solo Ctrl+C y el desplazamiento), las aprobaciones se piden en el móvil y interrumpir desde la app cancela el turno sin esperar al SSE del modelo. Los eventos viajan en lotes cada 250 ms (máximo 200 por lote); si el servidor no responde, la cola se acota a 1 MiB descartando primero deltas, luego avisos de herramientas, y al volver se reenvía un `snapshot`; no se promete entrega exactamente una vez. `ask_user` no está disponible mientras dura. Un prompt remoto adjunto (imágenes, documentos) se ignora, como en Python.
- **`lixbon update`:** sigue la etapa de tu versión (estable o beta); consulta `<gateway>/api/updates/cli/{stable|beta}` (con un proveedor genérico, `lixbon.com`; `LIXBON_UPDATE_URL` lo sustituye). Exige HTTPS salvo localhost y no instala si cualquiera de los dos digests no coincide. No hay firma de binarios del sistema operativo todavía. El CLI Python no se actualiza a Go por sí solo: se reinstala con el comando de la página.
- **Aspecto:** tema claro u oscuro según el fondo de la terminal (se pregunta una vez al arrancar, con `COLORFGBG` como pista). Se fija con `LIXBON_THEME=dark|light|auto`, con `/config` → Tema o con `"theme"` en `config.json`; `GLAMOUR_STYLE` sigue mandando sobre el markdown. Los glifos tienen tres juegos: el normal, uno seguro para la consola clásica de Windows y ASCII con `LIXBON_ASCII=1`. `LIXBON_REDUCED_MOTION=1` quita el destello animado y el brillo de la zona viva. Lo largo (pensamiento, salida de comandos, diff) se pliega: Ctrl+O despliega todo y un clic en la cabecera de un bloque solo ese.
- La UI es de pantalla completa: el modo inline de Bubble Tea 2.0.10 duplicaba la caja de entrada al encogerse la vista y no deja anclada la barra abajo. Con la rueda siempre capturada la terminal ya no selecciona, así que la selección es de la app: arrastrar copia al soltar (al portapapeles del sistema y por OSC 52, que también sirve en SSH). Ctrl+T abre un visor con la conversación, las herramientas y lo que el modelo escribe en ese momento. `/new` y `/clear` vacían el transcript y vuelven a dibujar la cabecera, y reabrir una conversación desde `/history` la muestra sola: cada conversación ocupa la pantalla entera. Lo que se da de alta o se configura (un proveedor, una clave, un servidor MCP, los ajustes de `/config`, el nombre de una rama o el mensaje de un commit) se pide en un formulario modal, no en la caja del chat ni en el transcript. En la consola heredada de Windows (conhost) el *mouse reporting* VT no está garantizado: si la rueda no responde, prueba en Windows Terminal.
- `/provider`, `/orquestar`, `/orquestador` y `lixbon profile` solo existen en Go (no están en el catálogo contrastado con Python).
- Verificado solo con servidores falsos: aún no contra LM Studio, Ollama, OpenAI ni un gateway autenticado (issue #21).

## Desarrollo

```bash
cd apps/cli
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Los JSON de `validation/fixtures/` son el contrato congelado; los generadores que los produjeron con el código Python están en la etiqueta `python-cli-final`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
