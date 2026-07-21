# lixbon — Estado actual del proyecto

> Actualizado: 2026-07-11 (CLI v2 reescrito: terminal pura estilo Claude Code, sin TUI). Documento para retomar el trabajo.
> Referencias: `docs/PLAN_MAESTRO.md` (plan por fases) · `docs/DISENO_WEB.md` (diseño de la web) · `docs/INFORME_Y_PLAN.md` (diagnóstico original).

---

## 1. Resumen en una línea

**F0–F7 implementadas (backend, web, planes/límites, panel admin, releases R2, pagos Stripe). Pendiente: conectar credenciales de Stripe en Railway, y F8 (calidad/tests).**

---

## 0.a Control remoto `/remote` (2026-07-20) — IDE/CLI controlables desde la app móvil

Diseño completo en `docs/PLAN_REMOTE.md` (fases R0–R6; **R0–R5 implementadas**). El IDE o el CLI actúan de host (solo conexiones salientes: SSE de comandos + POST de eventos, sin WS porque el CLI es stdlib puro), el gateway releva con `core/gateway/remote_hub.py` (memoria, 1 réplica) y la app móvil / web son el mando: transcript en vivo, prompts, interrupción y **aprobaciones de herramientas en el teléfono**.

- **Backend**: tablas `remote_sessions` (share token hasheado, 24 h, revocable) y `device_tokens` (push Expo); router `core/gateway/routers/remote.py` (11 rutas `/api/remote/*`, QR con `segno` en png/svg/txt, claim con rate-limit + audit); sweep cada 5 min en `app.py`. Tests: `core/gateway/test_remote_hub.py`.
- **CLI 2.1.0**: `/remote` imprime link + QR unicode y entra en **takeover** (teclado local en pausa, Ctrl+C termina y recupera); `lixbon_cli/remote.py` (hilos lector/flusher), aprobaciones remotas en `agent.py` vía `session["remote"]`.
- **IDE**: `/remote` en el chat o paleta → modal con QR; `src/store/remoteStore.js` deriva los eventos **suscribiéndose a chatStore** (sin tocar `send`); las `pendingApproval` se resuelven también desde el móvil; indicador "Remote" en la status bar.
- **Móvil 0.3.0**: sección **Remote** en el drawer (lista en vivo vía `/api/remote/subscribe` — la sesión aparece al instante al ejecutar `/remote`), detalle con transcript/composer/aprobaciones, deep link `lixbon.com/remote/*`, push best-effort (`expo-notifications`).
- **Web**: `/remote/:token` (llegada por QR/link; **exige login con la cuenta dueña** — sin sesión redirige a `/auth?next=…` y vuelve) y `/remote` (lista con sesión web). El token del link solo identifica la sesión, nunca es credencial.
- **Pendiente operativo**: `/.well-known/assetlinks.json` para App Links verificados y `google-services.json` (FCM) en el build Android para que lleguen los push; sin eso todo lo demás funciona igual.

---

## 0.b CLI v2 (2026-07-11) — reescritura completa, terminal pura

- **Textual (TUI) eliminado.** Interfaz estilo Claude Code: transcript inline, streaming SSE en vivo, thinking del modelo en gris (`delta.reasoning_content` + tags `<think>` inline), selectores con flechas/mouse (nunca números), menú de slash-commands al escribir `/`, barra de estado inferior (modelo | sesión | % contexto | tokens | UTF-8).
- **Código fuente modular** en `apps/cli/lixbon_cli/` (term/theme/config/sse/api/ui/diffs/agent/commands/app/cli); `apps/cli/build.py` lo concatena en el `client_cli.py` de siempre (la distribución `/install/client_cli.py`, install.sh/ps1 y el self-update NO cambian). Test anti-drift: `apps/cli/tests/test_build_fresh.py`. **No editar client_cli.py a mano: editar módulos + `python apps/cli/build.py`.**
- Deps de la interfaz (`prompt_toolkit` + `rich`) se autoinstalan solo para `chat`; `init/status/models/usage/update` siguen siendo stdlib puro.
- **Login interactivo**: Credenciales (email+password → `issue_api_key:true`, mismo flujo que la desktop), Crear cuenta, o pegar `lixbon_sk_...` (valida con `/api/key/info`).
- **Modo agent**: diffs colapsados `● Update(archivo) +N -M` con aprobación de 3 vías (Sí / Sí y no preguntar más / No); herramientas de solo lectura no piden confirmación. `/compact` (resumen client-side), `/image ruta` y `@ruta.png` inline (imágenes base64).
- **Gateway (cambios aditivos)**: `ChatMessage.images` passthrough a Ollama (multimodal), `delta.reasoning_content` desde `message.thinking`, y `usage` en el último chunk SSE antes de `[DONE]`.
- Paleta del ícono: acento `#B4C13A`, crema `#F6F7ED`, beige `#CBC7A9`, oliva, grises `#8A8A80`/`#5C5C55`; glifos con fallback ASCII para conhost legacy.
- Verificado: build/frescura, selector y confirm3 con input simulado, SSE completo (sources/reasoning/content/usage) contra server fake, turno agent E2E (aprobar/rechazar/always), `/compact`, login real contra gateway local (usuario de prueba `cli_test_*@test.local` quedó en staging), self-update E2E. **Pendiente manual**: probar mouse/colores en Windows Terminal real y chat con inferencia real (requiere Ollama local o túnel GPU).

### 0.b.1 Agente por defecto + workspace automático + agente en el IDE (2026-07-11, misma tarde)

Feedback del usuario: "llama3.2 no crea archivos y no tiene en cuenta el workspace". Causas: el modo por defecto del CLI era `ask` (sin herramientas), el system prompt del agente no incluía los archivos del proyecto, y el chat del IDE no tenía soporte de agente en absoluto.

- **CLI**: modo por defecto ahora `agent` (instalaciones viejas con `"mode":"ask"` persistido ven un aviso al arrancar sugiriendo `/mode agent`). `build_agent_system_prompt()` incluye el **árbol del workspace** (máx. 150 entradas, ignora `.git/node_modules/…`) + ejemplo few-shot para modelos pequeños. Fix: `strip_tool_calls` ahora corta por spans (antes re-serializaba con `json.dumps` y el `replace` casi nunca coincidía → el JSON quedaba visible en el transcript).
- **IDE desktop**: el chat ganó **modo agente completo** (toggle "Agente" junto al selector de modelo, activo por defecto con carpeta abierta). Mismo protocolo JSON del CLI: `apps/desktop/src/lib/agentProtocol.js` (parte pura: parseo de tool calls tolerante a saltos de línea de LLMs, diff barato — testeada con Node) + `agent.js` (herramientas sobre los comandos Rust existentes: list/read/write/append/mkdir/search/delete/rename; **sin run_command** — no hay primitivo de exec con captura). Loop en `chatStore.send` (máx. 8 pasos) con **tarjeta de aprobación** (Aplicar / Aplicar todo / Rechazar + mini-diff), filas de herramienta `● write_file ruta +N −M` en el feed, árbol del workspace en el system prompt, refresco del FileTree (evento `lixbon:fs-changed`) y `editorStore.reloadFromDisk` para pestañas abiertas. Rust NO se tocó (compila solo en CI).
- **Pendiente manual**: probar con Ollama real (llama3.2) en CLI e IDE; los modelos de 1-3B pueden fallar el formato JSON a veces — el prompt con ejemplo lo mitiga pero no lo garantiza. En una GPU de 6 GB (RTX 3050) el modelo recomendado para agente es `qwen2.5-coder:7b` (q4, cabe justo) con fallback `qwen2.5-coder:3b`.

**Refinamientos tras la primera prueba real del usuario (mismo día, noche):**
- **Guard anti-alucinación** (`truncate_fabricated` en CLI / `truncateFabricated` en IDE): los LLMs pequeños fabrican "TOOL_RESULT …" y siguen conversando solos imitando el ejemplo del prompt; se corta la salida en el primer TOOL_RESULT que emita el propio modelo (todo lo posterior es inventado y NO debe ejecutarse ni mostrarse).
- **Fix del "undefined" en el chat del IDE**: al extraer el JSON de un bloque ```json quedaba una valla vacía y react-markdown renderizaba `undefined`; `clean_prose`/`cleanProse` eliminan vallas vacías (y `displayableText` oculta la valla abierta durante el stream).
- **Auto-aplicar por defecto** (petición del usuario): el agente escribe directo sin botón "Aplicar"; el diff rojo/verde queda en el transcript (CLI: `auto_approve_tools: true` por defecto, `/approve off` para confirmaciones; IDE: `lixbon_agent_auto` ON, toggle "Aplicar cambios sin preguntar" en Ajustes → Agente del chat).
- **Pensamiento y herramientas plegados en el IDE**: `splitThinking` (tags `<think>` inline, tolera sin cerrar en streaming) + `delta.reasoning_content` del gateway (stream.js ganó `onReasoning`) → `<details>` "✻ Pensamiento" colapsado; las filas de herramienta también son `<details>` con el diff coloreado dentro (verde añadir / rojo eliminar).
- **Nudge "sugiere→actúa"** (segunda prueba real, con qwen2.5-coder:7b en v0.5.5): el modelo explicaba y mostraba el código en bloques ``` en vez de usar write_file (hasta decía "puedes usar la herramienta delete_file"). Fix doble: (a) prompt endurecido — regla "PROHIBIDO responder a una petición de cambio mostrando código en bloques", segundo ejemplo few-shot de edición (read_file→write_file) y sección "=== RECUERDA ===" al final; (b) recordatorio de runtime (1 por turno, CLI `NUDGE_PROMPT` en run_agent_turn / IDE flag `nudged` en chatStore): si la respuesta trae ``` sin tool calls, se le pide aplicar con write_file o responder "OK" (el "OK" no entra en bucle; en el IDE esa burbuja se descarta). Verificado con modelo simulado en ambos.
- **La solución de fondo sigue pendiente**: tool-calling NATIVO (passthrough de `tools`/`tool_calls` OpenAI en el gateway → Ollama, que qwen2.5 y llama3.2 soportan de fábrica) — mucho más fiable que el protocolo JSON embebido; beneficiaría también al BYOK de Copilot (`toolCalling: true`).

**Nivel Cursor (tercera ronda, misma noche) — herramientas nuevas en CLI e IDE:**
- **`edit_file`** (la clave): reemplazo EXACTO de un fragmento (`old_text`→`new_text`, `"all":true` para múltiples). Errores pedagógicos ("no se encontró… debe coincidir EXACTO", "aparece N veces… añade contexto"). El prompt ahora la prefiere sobre write_file para ediciones (regla 4 + ejemplo 2 reescrito) — evita que los modelos trunquen archivos al reescribirlos enteros.
- **`read_file` por rangos** (`start_line`/`end_line`); los archivos >120k chars avisan "pide rangos".
- **`run_command` en el IDE**: comando Rust NUEVO `run_command` (lib.rs — cmd /C | sh -c en el workspace, pipes drenados en hilos, timeout duro con kill, cola de 20k chars, CREATE_NO_WINDOW) + `runCommand()` en tauri.js. **Rust sin compilar localmente — validar en CI al taggear.** Regla 7 del prompt: verificar con tests/build tras cambiar código.
- **Checkpoints estilo Cursor**: `captureSnapshot` antes de cada mutación (contenido previo ≤300k, o null si el archivo no existía) + botón "Revertir este cambio" en la fila de herramienta (`chatStore.revertTool`; write/append/edit/delete/rename; deshace en disco y marca "Revertido ✓").
- **Archivo activo en el prompt** del IDE: "Archivo abierto en el editor ahora mismo: X (si el usuario dice \"este archivo\", es este)".
- CLI: preview de diff de edit_file en `diffs.compute_change`. Verificado: edit_file (único/ambiguo/no encontrado/all), rangos, diff +2/−1, build de archivo único y Vite.

**Bug "el 2º mensaje no usa herramientas" (IDE, reportado con qwen2.5-coder:7b) — dos causas combinadas, ambas corregidas:**
1. **Historial envenenado**: al mostrar la respuesta del agente se le quita el JSON (cleanProse) y las burbujas solo-herramienta se eliminan, así que en el turno 2 el modelo veía su turno 1 como PURA PROSA ("Hecho: creé…") y aprendía "aquí se responde con texto". Fix: `buildModelHistory(messages, agentActive)` (agentProtocol.js) reconstruye la conversación real turno a turno — cada fila `tool` vuelve como llamada del asistente (`{"tool":...}`) + su `TOOL_RESULT` (con `full` = salida hasta 4000 chars guardada en el mensaje). El CLI NO tenía este bug (run_agent_turn ya devuelve el `working` completo con JSON+TOOL_RESULT a self.history).
2. **Bloque cercado en el contexto**: adjuntar el archivo abierto lo inyectaba como ```html…```; un 7B, al ver un bloque de código y pedirle "modifícalo", devuelve otro bloque en vez de usar la tool. Fix: en modo agente el adjunto ya NO se indenta como bloque — se da la referencia (`El usuario tiene abierto index.html; usa read_file…`) y el agente lee/edita con herramientas (como Cursor). En modo chat normal se mantiene el bloque inline.
- Nudge reforzado ("NO repitas el código; responde ÚNICAMENTE con el/los JSON…"). La función "Insertar" del bloque de código NO era el problema (es manual e independiente); una vez el modelo usa la tool, el bloque no aparece y sí se ven las filas de diff. Verificado: 13 grupos de tests JS (nuevo: buildModelHistory replaya el write_file del turno 1 como uso de herramienta) + build.

**Sexta ronda — imágenes en el IDE con sub-agente de visión (2026-07-12):** qwen no ve imágenes → un modelo multimodal (llava/moondream/qwen2.5vl…) DESCRIBE la imagen en texto y esa descripción se inyecta al modelo de texto. Gateway: `POST /api/vision/describe` {model, images[b64], prompt?} → `_routed_chat` con el modelo de visión (multimodal por el passthrough `images` de F1), NO persiste historial, se cobra como cualquier inferencia (plan/créditos). IDE: `lib/vision.js` (`describeImages` + `detectVisionModel` por patrones llava/moondream/minicpm-v/qwen2-vl/…), `appStore.visionModel`+`effectiveVisionModel()` (autodetecta de availableModels), ChatInputBar adjunta por botón (input file) y **Ctrl+V** (onPaste lee clipboardData image blobs → base64), chips con miniatura; `chatStore.send(text, ctx, images)` corre el sub-agente ANTES (burbuja "👁 Analizando la imagen…"), inyecta la descripción y sigue el flujo normal con qwen; ChatMessage muestra miniaturas en la burbuja del usuario; selector "Modelo de visión" en Ajustes. Sin modelo de visión disponible → error que sugiere `ollama pull llava`. Verificado: endpoint montado + detectVisionModel; **falta prueba real (el usuario no tiene modelo de visión instalado aún)**. Requiere deploy del gateway + un modelo multimodal en Ollama.

**Quinta ronda (con modelo thinking qwen3.5:9b) — 2 bugs reportados:**
1. **Salida truncada al reescribir archivos grandes**: el modelo intentaba `write_file` con el HTML entero, la salida se cortaba a mitad del JSON (límite de tokens del modelo) → el JSON incompleto se filtraba como texto crudo al chat y el modelo se atascaba reintentando. Fix triple: (a) `cutUnclosedCall`/`cut_unclosed_call` (IDE+CLI) oculta un tool-call iniciado sin cerrar (integrado en cleanProse/displayableText) — el JSON crudo ya no se ve; (b) nudge de truncación (`hasUnclosedCall`/TRUNCATED_PROMPT): si la salida se cortó, se le pide usar edit_file en pasos pequeños; (c) prompt reforzado — "NUNCA reescribas un archivo grande con write_file; usa edit_file por secciones; write_file es SOLO para archivos nuevos". Tests: 18 grupos JS + Python.
2. **Historiales mezclados entre superficies**: los chats de IDE/CLI aparecían en la web. Fix: columna `source` (web/ide/cli) en `conversations` (migración `ALTER TABLE … ADD COLUMN IF NOT EXISTS source`); `ensure_conversation(source=…)` la fija al crear; `list_conversations(source=…)` filtra ('web' incluye legacy NULL). Gateway: `ChatCompletionRequest.source`; los 3 sitios de `ensure_conversation` la pasan (web dashboard='web', /v1/chat='web' si sesión / declarada por cliente, /v1/completions='api'); endpoint `GET /api/conversations?source=` (infiere 'web' si sesión). Clientes: IDE envía `source:'ide'` (stream.js) y lista con `?source=ide` (HistoryList); CLI envía `source:'cli'` (api.py); la web va por inferencia de sesión (sin cambio de front). **OJO legacy: convs viejas con source NULL siguen viéndose en la web; la separación es limpia de aquí en adelante.** Requiere DEPLOY del gateway a Railway + actualizar IDE/CLI.

**Cuarta ronda "nivel Cursor/Antigravity" (el usuario eligió las 4):**
1. **Diff inline en el editor** (`@codemirror/merge` NUEVO dep): cuando el agente edita, las líneas cambian verde/rojo EN el editor con Aceptar/Rechazar por bloque (`unifiedMergeView` en `mergeCompartment`; `showAgentDiff`/`clearAgentDiff`/`applyPendingMerge` en editorStore; `pendingMerge` Map resuelve el timing del montaje asíncrono vía CodeMirrorHost). CSS de colores en editor.css. Disparado desde `agent.js::revealEdit` en write/edit/append. Revertir limpia el diff en vez de crear otro.
2. **Abrir + saltar al archivo editado**: `showAgentDiff` abre la pestaña y salta a la primera línea cambiada (`firstChangedLine`).
3. **VALIDACIÓN REAL (Ollama local del usuario, qwen2.5-coder:7b, 2026-07-12):** (a) el modelo **NO emite `tool_calls` nativos** — con `tools` en el payload escribe la llamada como TEXTO en `content`, y en formato función OpenAI `{"name":...,"arguments":...}` (no nuestro `{"tool":...,"args":...}`). ⇒ las herramientas nativas deben quedar OFF para este modelo (menos mal que son opt-in). (b) Por eso el extractor (IDE `normalizeCall` + CLI `_validate_tool_dict`, regex `\{\s*"(tool|name)"`) ahora acepta AMBOS formatos, normalizando {name,arguments}→{tool,args} (con guard: solo si trae `arguments`, evita falsos positivos de cualquier {name}). (c) **El flujo POR DEFECTO (texto, sin tools) funciona end-to-end con el qwen real**: con nuestro system prompt emite `{"tool":"write_file",...}`, el extractor lo capta y crea el archivo (probado). Tests: 17 grupos JS + Python con el output literal de qwen.
3b. **Tool-calling nativo** (opt-in, Ajustes → "Herramientas nativas", default OFF): gateway ADITIVO — `ChatCompletionRequest.tools/tool_choice`, `ChatMessage.tool_calls/tool_call_id/name`, `_normalize_for_ollama` (arguments string↔objeto), `stream_chat_openai(tools=…)` emite `delta.tool_calls` (`_ollama_tool_calls_to_openai`); la web nunca envía tools ⇒ cero cambio para ella. Cliente IDE: `agentSchemas.js` (10 funciones), `stream.js` acumula `delta.tool_calls` (onToolCalls), chatStore prefiere nativos con FALLBACK al texto. **Requiere validación runtime contra Ollama con un modelo que soporte tools; por eso es opt-in y el texto (ya arreglado) sigue siendo el default.** CLI: pendiente wire (misma base de gateway lista).
4. **Bucle de auto-corrección**: regla 7 del prompt (CLI+IDE) — tras run_command con EXIT≠0, corregir y re-ejecutar hasta que pase (el loop ya reenvía TOOL_RESULT). Verificado: 16 grupos JS + tests Python (edit_file, pretty-json, native tools round-trip) + builds Vite/archivo único. **Rust `run_command` (ronda 3) sigue pendiente de CI.**

**Bug "aplica los cambios muy rara vez" (causa raíz definitiva, hallada en un chat compartido real) — el extractor era ciego al JSON indentado.** qwen2.5-coder emite JSON *pretty-printed* (`{\n  "tool": "write_file",\n  "args": {…`), pero `_iter_tool_call_spans`/`iterToolCallSpans` solo buscaban `{"tool"` (pegado) o `{ "tool"` (un espacio) con `str.find`/`indexOf` → la 1ª respuesta de cada turno NO se detectaba, saltaba el nudge, y solo tras el nudge (que exige "sin ```") el modelo emitía JSON compacto que sí matcheaba. Fix (IDE + CLI): buscar el inicio con regex `\{\s*"tool"` (`{` + cualquier espacio + `"tool"`), conservando el conteo de llaves con estado de string para los `{`/`}` dentro de content (p.ej. template literals `${x}`). Ahora el JSON indentado dentro de ```json fences se detecta y aplica al primer intento. Verificado con el caso exacto del chat (16 grupos JS + test Python) + build de archivo único + Vite. Nota menor pendiente: los mensajes de nudge y TOOL_RESULT se persisten en la conversación del backend (se ven en la vista compartida); no rompe nada pero ensucia el historial visible.

### 0.b.2 Identidad y jerarquía visual del CLI (2026-07-21)

Feedback del usuario: la pestaña seguía llamándose `cmd`, el arranque y el chat se mezclaban sin división, y las acciones del agente no destacaban como en el IDE.

- **Pestaña de la terminal**: `term.set_title()` (OSC 2, solo si `is_interactive()`) → la pestaña pasa a `✦ Lixbon · <carpeta>`; se actualiza con `/workspace`. El **ícono** de la pestaña no es cambiable desde el proceso (lo define el perfil de la terminal).
- **Cabecera de identidad** (`ui.render_header`), impresa una vez al arrancar y tras `/clear`, arriba a la izquierda y sin recuadros — **sube con el transcript**, no ocupa espacio fijo: `██ Lixbon CLI vX.Y.Z` (oliva `#8C9A3C` + versión en `dim2`), debajo `modelo · Lixbon <plan>`, debajo el workspace (`short_path`, `~` y elisión). **El ícono son 2×2 celdas de `█` con los 4 colores del favicon (`_logo_rows`): la primera versión usaba los triángulos ◢◣/◥◤ y en Cascadia Mono salían rotos y desalineados (verificado en captura del usuario) — `█` se renderiza igual en toda fuente monoespaciada.** Se construye con `Text.assemble`, no con markup (el fallback ASCII `[]` abriría etiqueta en rich).
- **División de zonas**: el orden de arranque es cabecera → consejos (`render_tips`, ya sin `Panel`) → `rule("conversación")`; con sesión activa no hay preámbulo de marca (solo un spinner "conectando"), la intro de una línea queda para el login. `/new` imprime `rule("conversación nueva")`. Cada turno abre con `render_speaker` (`✦ Lixbon`).
- **Acciones del agente como en el IDE**: mismos verbos que `ToolGroup.jsx` (`TOOL_VERB`/`KIND_VERB` en ui.py), cabecera `⚙ acciones` una vez por turno, filas `● editó   ruta  +N -M` (solo lectura en gris, escrituras en acento) y resultado colgando (`└ …`, rojo si falla). `diffs.render_change` usa las mismas filas.
- **Stream más limpio**: en modo agent la vista en vivo pasa por `clean_prose` (ya no se ve el JSON crudo mientras se escribe) y el pie usa `StatusBar.rich_line(compact=True)` (modelo · contexto · tokens) para no desbordar a dos líneas. Los pasos intermedios sin prosa ya no imprimen `[herramientas solicitadas …]`.
- **Plan en la cabecera**: `GET /api/key/info` devuelve ahora `plan: {id, name}` (cambio aditivo en `core/gateway/routers/keys.py`); el CLI lo pide al arrancar y lo cachea en `~/.lixbon/config.json` (`plan_name`), degradando en silencio con servidores viejos. **Requiere deploy del gateway** para que deje de mostrarse sin plan.

---

## 0. Cómo ACTIVAR Stripe (F7 — pagos) 🔴

La integración está completa y verificada en modo degradado + lógica de webhook (20 checks). Para encender los pagos reales:
1. **Cuenta Stripe** (modo test primero): crea 2 **Productos** con precio recurrente mensual — Pro ($9.90) y Advance ($24.90). Copia sus `price_...`.
2. **Conecta los precios**: en el panel admin → tab **Modelos** → "Precios de Stripe", pega cada `price_...` en su plan. (O `PATCH /api/admin/plans/{id}` con `{"stripe_price_id": "price_..."}`.)
3. **Variables de entorno** (`.env` local y Railway): `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`, y `PUBLIC_BASE_URL=https://tu-dominio` (para las URLs de retorno del checkout).
4. **Webhook en Stripe**: apunta un endpoint a `https://tu-dominio/api/billing/webhook` y suscríbelo a `customer.subscription.created/updated/deleted`, `invoice.payment_failed` y **`checkout.session.completed`** (este último acredita los packs de créditos de API). Copia el signing secret a `STRIPE_WEBHOOK_SECRET`.
5. **Probar**: en modo test, tarjeta `4242 4242 4242 4242`. Suscríbete desde `/planes` → checkout → vuelve a `/account/facturacion`. El webhook activa el plan solo.
6. Cuando funcione en test, repite con las claves **live**.

Con `STRIPE_SECRET_KEY` vacío, todo degrada: `/planes` y Facturación muestran "Próximamente"; `/api/billing/*` responde 503.

---

## 2. Lo que YA está hecho y verificado

### ✅ F0 — Seguridad (completada)
- Clave de firma Tauri **rotada** (privada nueva en `C:\Users\Usuario\.tauri\lixbon_update.key`, fuera del repo; pubkey nueva en `apps/desktop/src-tauri/tauri.conf.json`).
- GitHub Secrets creados: `TAURI_SIGNING_PRIVATE_KEY`, `lixbon_ADMIN_TOKEN` (no existe `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — la clave no tiene contraseña, el workflow lo tolera).
- `POST /api/versions/upload` autenticado con `X-Admin-Token`.
- Historial de git purgado (`.env`, `.venv`, `cloudflared.exe`, MSIs, clave vieja) — repo pasó de 72 MB a <1 MB. Backup completo en `Desktop\LLM-DataCent-BACKUP\` (bundle + .env viejo).

### ✅ F1 — Fundaciones (completada)
- **Monorepo screaming architecture**: `core/` (gateway, persistence, security, orchestration, delegation, inference, node_agent) · `apps/` (web, desktop, cli) · `BD/` · `infra/` · `docs/`.
- **Postgres únicamente** (SQLAlchemy 2.0): `core/persistence/{database,models,queries}.py`. `db_sqlite`/`db_mysql` eliminados. Dos BDs en Railway: staging (la usa tu PC vía `DATABASE_URL` del `.env`) y prod (enlazada al servicio).
- **Redis** en Railway para rate limiting (`core/security/ratelimit.py`, fallback en memoria sin `REDIS_URL`).
- `Dockerfile` multi-stage (build de la web + gateway) + `railway.toml` (healthcheck `/health`).
- Desplegado y online: `https://llm-datacent-production.up.railway.app`.
- Entry point: `uvicorn core.gateway.app:app`. Lifespan + logging JSON (`LOG_FORMAT=plain` para dev).

### ✅ F2 — GPU vía tunnel + bugs del core (completada, validada EN PRODUCCIÓN)
- **node_agent** (`core/node_agent/agent.py`): FastAPI, exige `X-Node-Token` == `NODE_SHARED_SECRET` (env, se lee también del `.env`), proxy allowlist a Ollama (`/ollama/api/{chat,tags,embed}`) con streaming. Ollama nunca se expone directo. Arranque: `python -m core.node_agent.agent`.
- **Nodos en BD** (tabla `nodes`, token por nodo). CRUD: `/api/admin/nodes` con `X-Admin-Token`. `nodes.json` eliminado.
- **Nodo registrado en PROD**: `gpu-01` → `https://gpu-01.lixbon.com`. Su token está como `NODE_SHARED_SECRET` en el `.env` local.
- **Cloudflare Tunnel**: `folax-gpu-01` (ID `cb1067aa-...`, nombre real del recurso en Cloudflare — no se renombra editando docs; en migración a un túnel gestionado en el dashboard para `gpu-01.lixbon.com`), config en `C:\Users\Usuario\.cloudflared\config.yml` → `localhost:8765`.
- **Bugs corregidos**: agente muerto = offline (antes score perfecto); `/api/chat` y `/api/delegate` enrutan por el orquestador; streaming persiste mensaje+tokens; keep-alive SSE real por tiempo (`core/inference/ollama.py` — única implementación de streaming); watchdog sin duplicados; `packaging.version` para updates.
- **E2E validado**: chat desde la URL de producción → tunnel → GPU (respuesta real, `node: gpu-01`).

### ✅ F3 — Auth nuevo (completada, verificada en staging)
- **Login por email**; registro con `first_name`/`last_name` (lo que exige el diseño). Username sigue funcionando para CLI/desktop legacy.
- **Sesiones web** en tabla `sessions` (cookie `lixbon_session`, HttpOnly, SameSite=Lax, `COOKIE_SECURE=1` para prod) — separadas de las API keys.
- **API keys solo-hash**: `raw_key` ya no se persiste; prefijo `lixbon_sk_`; se muestran UNA vez al crearse/regenerarse.
- **Roles** `user`/`admin`: seed automático vía env `ADMIN_EMAILS`; dependencia `admin_required` en `core/security/auth.py`.
- **Verificación de email + reset de contraseña**: `core/gateway/email.py` (Resend; sin `RESEND_API_KEY` los links se imprimen en el log — modo dev). Reset rotan las API keys.
- **IDOR corregido**: borrar keys ajenas → 404.
- Migración de columnas idempotente en `init_db()` (se aplica sola al arrancar en cualquier entorno).

---

## 3. Pendientes INMEDIATOS (antes o durante F4)

### Variables de Railway que faltan definir (servicio gateway) 🔴
| Variable | Valor | Por qué |
|---|---|---|
| `ADMIN_EMAILS` | `durangogabriel8@gmail.com` | Tu cuenta será admin (necesario para el panel admin F6). El seed te promueve en cada arranque |
| `COOKIE_SECURE` | `1` | Cookies solo por HTTPS |
| `PUBLIC_BASE_URL` | `https://llm-datacent-production.up.railway.app` (o el dominio final) | Links de los emails |
| `RESEND_API_KEY` | (opcional) crear cuenta en resend.com | Sin ella, los emails solo se loguean |
| `R2_ACCOUNT_ID` | `071d1172730bf91c22924d149b67f95d` | Releases privados (F6.5); sin las 4 vars R2, prod cae al disco efímero |
| `R2_BUCKET` | `releases-lixbon` | Bucket de instaladores |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | (están en el `.env` local) | Credenciales R2 |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | (de tu cuenta Stripe) | Pagos F7; sin ellas todo degrada a "Próximamente" |

### Operativos (tu PC)
- [x] **node_agent y tunnel al iniciar sesión** (2026-07-04): tareas programadas de usuario "lixbon Node Agent (usuario)" y "lixbon Tunnel (usuario)" (ONLOGON, sin límite de tiempo, PowerShell oculto — el alias pythonw de la Store no funciona en Task Scheduler). Arrancan al iniciar sesión de Windows; no requieren admin.
- [ ] (Opcional, más robusto) **Servicio cloudflared sin config**: el servicio Windows corre pero sin config → no conecta (fue la causa del "No hay modelos" del 2026-07-04). Fix en PowerShell **admin** para que el tunnel viva sin sesión iniciada: `Copy-Item "$env:USERPROFILE\.cloudflared\*" "C:\Windows\System32\config\systemprofile\.cloudflared\" -Force; Restart-Service Cloudflared` (luego se puede borrar la tarea de usuario del tunnel).
- [ ] (Opcional) `python -m core.node_agent.agent --install` como admin (corre como SYSTEM sin sesión) — reemplazaría la tarea de usuario.
- [x] **Dominio final `lixbon.com`** (2026-07-06): dominio principal (reemplaza `datacentgbx.online`). Gestionado en Cloudflare (nameservers cambiados en Hostinger). Web+API en el **apex** `lixbon.com` (+ `www` redirige), custom domain en Railway, CNAME en Cloudflare **DNS only** (nube gris — el proxy naranja bufferea el SSE del chat y corta a ~100 s), SSL Full (strict). Referencias de dominio migradas en el repo (CLI, desktop, updater, correos). **Pendiente operativo**: migrar el túnel GPU a `gpu-01.lixbon.com` (`cloudflared tunnel route dns folax-gpu-01 gpu-01.lixbon.com` + editar `~/.cloudflared/config.yml` + actualizar `agent_url` del nodo en el panel admin), verificar dominio `lixbon.com` en Resend (DKIM/SPF), y en Railway poner `PUBLIC_BASE_URL=https://lixbon.com` y `EMAIL_FROM=Lixbon <no-reply@lixbon.com>`. Mantener `datacentgbx.online` apuntando al gateway hasta que migren los CLI/desktop ya distribuidos con ese dominio embebido.
- [ ] **Rebranding de nombre FOLAX → Lixbon** (el SaaS cambió de nombre por conflicto de marca): sustituir el nombre visible "FOLAX" en UI/docs/correos/títulos de release. Trabajo aparte del dominio. **NO tocar** `productName`/`identifier` de Tauri ni `folax.settings.json`/`folax_sk_` (romperían updater y sesiones/keys existentes).

### Datos de prueba a limpiar (cuando exista el panel admin)
- Prod: usuarios `smoke_e2e`, `f4tunnel_*@test.local`. Staging: `smoke_test_f1`, `f3admin@test.local`, usuarios `f4smoke_*`/`f4idor_*`/`f4ui_*`/`f4dbg_*@test.local` (E2E de F4), nodo `gpu-01` apuntando a `http://127.0.0.1:8765` (localhost — coherente para dev).

---

## 4. ✅ F4 — La web nueva (completada 2026-07-04, verificada E2E con Playwright)

**El dashboard oscuro viejo fue reemplazado** por la web del diseño nuevo (docs/DISENO_WEB.md): chat tipo Claude/GPT con streaming.

**Frontend (`apps/web/src` reescrito)** — estructura `components/ pages/ styles/ lib/ hooks/`:
- Fuentes self-hosted en `public/fonts/` (Bruno Ace SC + Bricolage Grotesque variable, woff2 latin y latin-ext); tokens CSS en `styles/base.css` (`--bg`, `--bg-secondary #F6F7ED`, `--ink #171717`, `--accent` verde-amarillo, todo pill).
- Iconos SVG inline de trazo fino en `components/Icons.jsx`.
- **Auth** (`pages/AuthPage.jsx`): crema, toggle segmentado, labels flotantes outlined, modo "olvidé mi contraseña" + `pages/ResetPasswordPage.jsx` (`/reset-password?token=`). OAuth oculto (decisión).
- **Chat** (`pages/ChatPage.jsx` + `components/{Sidebar,ChatInput,Markdown}.jsx`): sidebar colapsable con búsqueda (filtro cliente), historial con renombrar/eliminar (updates optimistas — la BD remota es lenta), footer de perfil con inicial + "Plan Gratuito" (real en F5); streaming SSE vía fetch a `/v1/chat/completions` con cookie; memoria = ventana de 20 mensajes enviada por el cliente; markdown con react-markdown (títulos Semibold); botón "más ↓"; selector de modelos (`/v1/models`); auto-título tras el primer intercambio; visitante anónimo ve "¿Qué investigaremos hoy?" y al enviar → `/auth?mode=register`.
- Rutas: `/` y `/c/:id` (chat), `/auth`, `/reset-password`; `/login`→`/auth` legacy. Dev: proxy Vite `/api` y `/v1` → :8000.

**Backend añadido en F4**:
- `core/gateway/routers/conversations.py`: `GET /api/conversations` (paginado + `?q=` búsqueda), `GET /api/conversations/{id}/messages`, `PATCH/DELETE /api/conversations/{id}`, `POST /api/conversations/{id}/generate-title` (modelo pequeño vía orquestador; limpia markdown residual). Todo con check de pertenencia.
- `web_or_api_key_auth` en `core/security/auth.py`: `/v1/models` y `/v1/chat/completions` aceptan cookie de sesión **o** API key (el rate limit por token se mantiene para keys).
- Fix IDOR: `ensure_conversation` ahora rechaza escribir en conversaciones de otro usuario (404 en `/api/chat`, `/v1/chat/completions`, `/v1/completions`).

**Pendiente que quedó fuera de F4** (decidido): botón "Compartir" visible pero muestra "disponible pronto" (link público = feature posterior); micrófono oculto; adjuntar/web deshabilitados; "Aplicaciones" placeholder.

---

## 5. ✅ F5 — Planes y límites (completada 2026-07-04, verificada E2E: 20/20 API + 14/14 UI)

**Los límites viven en la BD (tabla `plans`), no en el código.** Postgres es la fuente de verdad de los contadores; Redis es pre-check barato.

**BD y backend**:
- Tablas `plans` / `subscriptions` (única por usuario) / `usage_quotas` (contador atómico por período, `pg_insert ON CONFLICT ... RETURNING`). Seed idempotente en `init_db()` + `BD/seeds/plans.sql`: **Gratuito** (30 msg/día, 150k tokens/mes, 1 key, 10 rpm, solo modelos pequeños por prefijo), **Pro** ($9.90: 500/día, 5M/mes, 5 keys, 60 rpm, todos), **Advance** ($24.90: ilimitados/día, 20M/mes, 20 keys, 120 rpm).
- `core/billing/quota.py`: `ensure_can_chat()` antes de toda inferencia — modelo permitido (403 `model_not_allowed`), rate limit por plan, mensajes/día y tokens/mes (429 con detail estructurado `{code, scope, message, reset_at}` en español con tiempo de reinicio humano); `record_tokens()` al terminar; `usage_snapshot()` para Mi cuenta. Contar ANTES de inferir evita pasarse en paralelo.
- Endpoints (`core/gateway/routers/billing.py`): `GET /api/plans` (público), `GET /api/account/usage` (plan + uso + serie 30 días), `GET /api/admin/users?q=` y `POST /api/admin/users/{id}/plan` (por ROL admin, con audit log) — **asignación manual de planes hasta que lleguen los pagos (F7)**.
- `GET /api/keys` nuevo; `POST /api/keys` respeta `max_api_keys` (403 `keys_quota`). Registro asigna plan free; `/api/auth/me` devuelve `plan_id`/`plan_name`.

**Web**:
- **Mi cuenta** (`/account`): plan actual, barras de cuota (mensajes hoy / tokens mes, roja al llenarse), gráfica SVG de tokens 30 días con tooltip, gestión de API keys (crear con reveal único, desactivar). `pages/AccountPage.jsx` + `components/UsageChart.jsx` + `styles/account.css`.
- **Planes** (`/planes`): 3 tarjetas, Pro destacada; CTA "Próximamente" (pagos F7). Sidebar: pill del plan real (`user.plan_name`) → `/planes`; menú del perfil con "Mi cuenta".
- 429/403 de cuota se ven amigables en el chat (burbuja `⚠️ Alcanzaste los N mensajes diarios... Se reinicia en X h`).

**E2E verificado** (scripts efímeros, gateway local + BD staging): free choca modelo vetado, límite diario y límite de keys; admin busca usuario y asigna Pro; límites se levantan al instante; UI refleja todo. Usuarios de prueba en staging: `f5user_*`, `f5admin_*`, `f5ui_*`, `f5uiadmin_*`, `f5models_*@test.local`.

---

## 6. ✅ F6 — Panel de administración (completada 2026-07-04, verificada E2E: 31/31 API + 15/15 UI)

**Todo lo del dueño, protegido por ROL admin (backend valida cada endpoint).** Falta solo releases en R2 (F6.5, bloqueado por credenciales).

**BD y backend**:
- Columna `users.is_active` (migración idempotente en `init_db`): bloquear a un usuario invalida su sesión y sus API keys **al instante** (`verify_user`, `validate_web_session`, `validate_api_key` lo checan). Bloquear = 403/401 inmediato, sin esperar expiración.
- `core/gateway/routers/admin_panel.py` (NUEVO, prefijo `/api/admin`, `admin_required`): `GET /metrics` (dashboard global: usuarios/activos/bloqueados/conversaciones/mensajes/nodos + serie diaria + suscripciones por plan), `GET /users` + `GET /users/{id}` (detalle con plan/uso/keys/eventos), `POST /users/{id}/plan`, `POST /users/{id}/active` (bloqueo; no puedes bloquearte a ti mismo), `GET /plans` + `PATCH /plans/{id}` (editar límites/allowed_models sin tocar la BD), `GET /models` (modelos del cluster: en qué nodos, en qué planes), `GET /audit` (log global paginado con filtro por `event_type`/`user_id`).
- `nodes_admin.py`: **migrado de `X-Admin-Token` a `admin_required`** (salda la deuda de F3) + audit log de `node_upserted`/`node_deleted`. `/api/nodes*` de `admin.py` ahora exige rol admin (eran métricas internas expuestas a cualquier usuario).
- Queries nuevas: `set_user_active`, `update_plan`, `get_global_stats`; `list_audit_events` con offset/event_type; `list_users_admin` y `_user_to_dict` exponen `is_active`/`created_at`.

**Web** (`pages/AdminPage.jsx` + `styles/admin.css`, ruta `/admin`):
- Tabs: **Resumen** (stat tiles + gráfica global reusando `UsageChart` + suscripciones por plan), **Usuarios** (buscar, cambiar plan por `<select>`, bloquear/desbloquear con badge, detalle expandible con uso y eventos), **Nodos** (CRUD + estado en vivo del orquestador: online/circuit-breaker, score, CPU/RAM, modelos como chips; alta muestra el token una vez), **Modelos** (tabla del cluster + editor de `allowed_models` por plan), **Auditoría** (log paginado "cargar más" + filtro por tipo).
- Acceso: entrada "Panel admin" en el menú del perfil (solo `role=admin`); `/admin` redirige al chat si no eres admin. `/api/auth/me` ya exponía `role`.

**E2E verificado**: user normal recibe 403 en todo `/api/admin` y la SPA lo expulsa de `/admin`; admin ve dashboard, bloquea (login del bloqueado → 401) y desbloquea, cambia plan, edita `allowed_models` (se refleja en `/api/plans` público y se revierte), gestiona nodos, ve modelos y filtra auditoría. Usuarios de prueba en staging: `f6admin_*`, `f6user_*`, `f6uiadmin_*`, `f6uiuser_*@test.local`.

**F6.5 — Releases privado en R2 (completada 2026-07-04, verificada E2E contra R2 real 12/12)**:
- `core/storage/r2.py` (NUEVO): cliente boto3 S3 apuntando a R2 (endpoint `https://<account>.r2.cloudflarestorage.com`, firma v4), perezoso y thread-safe. `upload_release()`, `presigned_get_url()` (URLs de descarga temporales), `object_exists`, `delete_object`. `boto3` añadido a `requirements.txt`.
- Config (`core/config.py`): `R2_ACCOUNT_ID/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_PRESIGN_TTL_MIN`, helpers `r2_configured()`/`r2_endpoint()`. **Las credenciales viven solo en `.env` local (gitignored) y deben definirse en Railway.**
- `versions.py` reescrito: la subida (`POST /api/versions/upload`, sigue con `X-Admin-Token`) sube a R2 con key `releases/<archivo>` y guarda en la BD `download_url = "r2:<key>"` (sin cambiar el esquema). **Si R2 no está configurado, cae al disco local** (efímero, solo dev). Toda descarga pasa por `GET /api/updates/download/{version}/{channel}`, que genera una URL prefirmada al vuelo y redirige (302) — el binario nunca se expone y la URL pública es estable. Los manifests (`/api/updates/manifest/{channel}` Tauri, `/api/updates/cli/{channel}` nuevo, `/api/updates/check`) devuelven esa URL del gateway, nunca la key ni el binario. Audit log `release_uploaded`.
- **Eliminada la página pública `/releases-info`** (era dark-theme viejo con fuentes de Google externas).
- Bucket **privado**: R2 nunca queda expuesto; el gateway es el único que firma URLs. El CLI se auto-actualiza descargando su fuente desde `/install/client_cli.py` (mecanismo aparte, sin cambios); el nuevo `/api/updates/cli/{channel}` queda para consultar versión.
- Verificado E2E contra R2 real (bucket `releases-lixbon`, account `071d1172…`): subida a R2, metadata pública apunta al gateway, descarga redirige a URL prefirmada de `r2.cloudflarestorage.com` que entrega el binario exacto, `/releases-info` eliminada.
- **PENDIENTE OPERATIVO (Railway)** 🔴: definir en el servicio gateway las 4 vars R2 (`R2_ACCOUNT_ID=071d1172730bf91c22924d149b67f95d`, `R2_BUCKET=releases-lixbon`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — están en el `.env` local). Sin ellas, prod cae al disco efímero. `boto3` ya está en requirements (Docker lo instala).

**F6.6 — UI de releases + Descargas + lixbon Docs (completada 2026-07-04, verificada E2E 13/13)**:
- **Tab "Releases" en el panel admin** (`AdminPage.jsx`): formulario de publicación (versión, canal, título, changelog, checksum, archivo) + tabla de versiones. Sube con la **cookie de sesión** (nueva dependencia `admin_or_token` en `core/security/auth.py`: acepta sesión con rol admin O `X-Admin-Token`, para que el panel funcione sin exponer el token y el CI siga con token). Endpoint `POST /api/versions/upload` migrado a `admin_or_token`.
- **Página pública de Descargas** (`/descargas`, `pages/DownloadsPage.jsx`): card de la app de escritorio (botón a la última stable vía `GET /api/updates/latest/{channel}`, endpoint nuevo que nunca da 404) y card del CLI con comandos copiables por SO — Windows `irm <base>/install.ps1 | iex`, Linux/macOS `curl -fsSL <base>/install.sh | bash` — más instalación manual del fuente. Los scripts ya los generaba `installer.py`.
- **lixbon Docs** (`/docs` y `/docs/:section`, `pages/DocsPage.jsx` + `pages/docsContent.jsx`): estilo code.claude.com, índice lateral por grupos + contenido central redactado (Introducción, Primeros pasos, CLI, App de escritorio, API, Planes y límites), pager anterior/siguiente. Pública.
- **Componentes**: `components/PublicNav.jsx` (barra común Docs/Descargas/Planes), `components/CodeBlock.jsx` (bloque con botón copiar), iconos nuevos en `Icons.jsx`. Estilos en `styles/public.css`. Enlaces "Documentación" y "Descargas" en el menú del perfil del sidebar.
- **Conflicto de ruta resuelto**: `/docs` colisionaba con la Swagger UI de FastAPI → Swagger movida a `/api/docs`, ReDoc a `/api/redoc`, OpenAPI a `/api/openapi.json` (en `app.py`), liberando `/docs` para la web.
- E2E: admin publica una versión desde el panel y aparece en la tabla; Descargas muestra el Desktop y los comandos del CLI (Windows/Unix); Docs navega entre secciones (SPA) con el código visible; enlaces del sidebar funcionan.

**F6.7 — Navegación del sidebar + rediseño de Ajustes (completada 2026-07-04, E2E 14/14)**:
- **Sidebar**: "Aplicaciones" ahora navega a `/descargas` (ya no es placeholder); botón destacado **"Mejorar plan"** (accent) → `/planes`, visible salvo plan advance; menú del engranaje reorganizado: **Planes** (→/planes), **Lenguaje** (deshabilitado, "Pronto"), **Ajustes** (→/account), Documentación, Panel admin (si admin), Cerrar sesión.
- **Ajustes** (`/account` y `/account/:section`, `pages/AccountPage.jsx` reescrito): la vista plana de "Mi cuenta" se convirtió en una sección con **sidebar interno** (estilo settings de Claude, con nuestro diseño crema/ink) y 5 secciones: **General** (perfil editable: nombre/apellido vía `PATCH /api/account/profile`; correo readonly; apariencia/idioma "Próximamente"), **Cuenta** (correo+verificación, cambiar contraseña por enlace usando `request-password-reset`, gestión de API keys movida aquí, cerrar sesión, eliminar cuenta "Próximamente"), **Privacidad** (texto + toggles y exportar "Próximamente"), **Facturación** (plan actual + "Ajustar plan"→/planes; método de pago/facturas/cancelar "Próximamente", F7), **Uso** (barras de cuota + gráfica 30 días). Estilos `.settings*`/`.set-*` en `account.css`.
- Backend: `PATCH /api/account/profile` (billing.py) + query `update_user_profile`.

**F6.9 — Pulido de UI: tabs animadas, logo, skeleton loading (2026-07-04, E2E 8/8)**:
- **Indicador deslizante** en las tabs del panel admin (`admin-tabs__indicator`): mide `offsetLeft/offsetWidth` de la tab activa con refs y anima `left/width`; el texto activo pasa a blanco con transición (ya no hay salto de fondo).
- **Logo a 30px** en los headers de página (AdminPage, AccountPage) y en `PublicNav`.
- **Skeleton loading** (`components/Skeleton.jsx` + shimmer en `base.css`, respeta `prefers-reduced-motion`) en las cargas reales: **historial del sidebar** (`HistorySkeleton`, mientras carga `/api/conversations`), **hilo de mensajes** al abrir `/c/:id` (`ThreadSkeleton`, mientras carga `/api/conversations/:id/messages`) y **contenido de Docs** (`DocsSkeleton`, transición breve al montar/cambiar sección). El resto sigue con la pantalla `app-loading`.

**F6.8 — Identidad de planes + header público + "Aplicaciones" (2026-07-04, E2E 11/11)**:
- **Color por plan** (`lib/planColors.js`): Gratuito `#676767`, Pro `#CE7F25`, Advance `#98A61F`. Aplicado al nombre del plan en `/planes` y al badge/pill del plan (fondo del color + texto blanco) en Ajustes y en el footer del sidebar.
- **"Descargas" renombrado a "Aplicaciones"**: ruta `/aplicaciones` (con redirect de `/descargas`), título de la página, enlaces del nav, botón del sidebar y textos de Docs.
- **Header público rediseñado** (`PublicNav.jsx`, usado en Planes/Aplicaciones/Docs): enlaces Documentación, Aplicaciones, Planes; a la derecha botón **Soporte** (`mailto:soporte@datacentgbx.online` — placeholder, ajustar el correo), enlace **Iniciar sesión** (→/auth, solo si no hay sesión) y botón **Probar lixbon** (→ chat). Condicional a `useAuth`.

**Releases automáticos por CI — YA EXISTÍA** (`.github/workflows/tauri.yml`): al pushear un tag `v*`, compila el `.msi` de Tauri firmado (`tauri-action`, `TAURI_SIGNING_PRIVATE_KEY`) y lo sube solo a `POST /api/versions/upload` con `X-Admin-Token: lixbon_ADMIN_TOKEN`; el gateway lo guarda en R2. Compatible con el backend reescrito. **Mejorado 2026-07-04**: deriva versión y canal del tag (`v1.2.3` → stable, `v1.2.3-beta`/`-rc` → beta), y la URL del server sale de la variable de repo `lixbon_SERVER_URL` (default `remote.datacentgbx.online`). Requisitos operativos: que `ADMIN_TOKEN` del gateway de prod == secret `lixbon_ADMIN_TOKEN`, y las vars R2 en Railway (si no, el .msi cae al disco efímero). Para publicar: `git tag v0.3.0 && git push --tags`.

---

## 6.10 ✅ F7 — Pagos con Stripe (implementada 2026-07-04; falta conectar credenciales)

**Proveedor: Stripe** (elegido por el usuario). Integración completa lista por variables de entorno (como R2). Verificada en modo degradado (10/10) + lógica de webhook con eventos simulados (10/10).

**BD**: `plans.stripe_price_id`; `subscriptions.{stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end}` (migración idempotente en `init_db`). Queries nuevas en `queries.py`: `get_plan_by_stripe_price`, `get_subscription`, `get_user_by_stripe_customer`, `set_stripe_customer`, `apply_stripe_subscription`, `downgrade_to_free`; `update_plan` admite `stripe_price_id`.

**Backend**: `core/billing/stripe_gateway.py` (checkout session modo subscription con Customer reusable, customer portal, `list_invoices`, `payment_method_summary`, verificación de firma y `handle_event`: `subscription.created/updated` → `apply_stripe_subscription`/activa plan, `subscription.deleted` → `downgrade_to_free`, `invoice.payment_failed` → audit; resuelve usuario por metadata o `stripe_customer_id`, plan por `stripe_price_id` o metadata). Router `payments.py` (`/api/billing`): `GET /config` (público, `{enabled, publishable_key}`), `POST /checkout`, `POST /portal`, `GET /status` (plan+renovación+método+facturas), `POST /webhook` (público, firma). `stripe` en requirements; `stripe_configured()`/`STRIPE_*`/`PUBLIC_BASE_URL` en `config.py`. Sin `STRIPE_SECRET_KEY` → `enabled:false` y 503.

**Web**: `PlansPage` consulta `/api/billing/config`; si habilitado, CTA "Suscribirme a X" → `POST /checkout` → redirige al checkout de Stripe; si no, "Próximamente". `AccountPage` sección Facturación con `/api/billing/status`: plan real, fecha de renovación/cancelación, método de pago, historial de facturas (enlace a Stripe), botón "Ajustar plan"/"Gestionar" → portal; retorno `?checkout=success` muestra aviso. Panel admin → tab Modelos → "Precios de Stripe" para pegar los `price_...` por plan.

**Cómo activarlo**: ver sección 0 arriba. **Pendiente**: crear productos/precios en Stripe, conectar `price_...`, poner `STRIPE_*` + `PUBLIC_BASE_URL` en Railway, configurar el webhook, probar en modo test (`4242...`).

---

## 6.11 ✅ Funciones de chat: compartir, adjuntar documentos, búsqueda web (2026-07-04)

Tres features de producto sobre el chat, verificadas E2E (12/9/9).

- **Compartir chat** (`conversations.share_token`): enlace público de solo lectura. Endpoints GET/POST/DELETE `/api/conversations/:id/share` (ownership) + `GET /api/shared/:token` (público, sin datos del dueño). Web: botón "Compartir" abre `ShareDialog` (crear/copiar/revocar); página `/s/:token` (`SharedPage`) con branding + CTA de registro.
- **Adjuntar documentos** (`POST /api/attachments`, `routers/attachments.py`): extrae texto de PDF (pypdf) / texto / código, trunca a 12k chars, rechaza binarios e imágenes (415), límite 5 MB. Web: botón de clip en `ChatInput` sube el archivo, muestra chips (con marca "recortado") y antepone el texto del documento al mensaje. `pypdf` en requirements.
- **Búsqueda en internet** ("modo investigar"): toggle del globo en `ChatInput`. Enfoque robusto (no tool-calling nativo, poco fiable en modelos pequeños): el gateway ejecuta la búsqueda e **inyecta los resultados como contexto** antes de responder, pidiendo citar fuentes. `core/inference/websearch.py` con proveedor configurable por env `WEBSEARCH_PROVIDER`: **duckduckgo** (default, sin key, `ddgs` en requirements), tavily (`TAVILY_API_KEY`), brave (`BRAVE_API_KEY`). El request `/v1/chat/completions` gana `web_search: bool`; el stream emite primero un chunk `{"lixbon_sources": [...]}` que el cliente muestra como cajita de "Fuentes". `apps/web/src/lib/stream.js` pasa el flag y captura las fuentes; `ChatPage` muestra el indicador "Buscando en internet…" y el componente `Sources`.

**Multimodal pendiente** (imágenes/audio/vídeo): imágenes requieren un modelo de visión en Ollama (VRAM); audio requiere Whisper aparte; vídeo se pospone. El endpoint de adjuntos ya rechaza esos tipos con un mensaje claro.

---

## 6.12 ✅ Rediseño completo de la app desktop → IDE lixbon (2026-07-05)

`apps/desktop` (Tauri v2 + React 19) reescrita como **IDE ligero** con la identidad de la web (copia sincronizada de `base.css` + fuentes woff2 self-hosted en `apps/desktop/public/fonts/`; solo tema claro). Versión unificada **0.3.0** (package.json, Cargo.toml, tauri.conf.json). `productName`/`identifier` NO se tocaron (cadena del updater intacta).

- **Layout IDE**: ActivityBar 48px + explorador (FileTree) + editor central + chat derecho (paneles colapsables/redimensionables, persistidos) + StatusBar (conexión/modelo/plan con `planColors`/versión). `src/layout/`.
- **Auth dual** (`sections/Auth/AuthScreen.jsx`): login por email (endpoint nuevo; si el usuario ya tiene keys, crea una "lixbon Desktop" vía `POST /api/keys` con la cookie de sesión) **o** pegar `lixbon_sk_` (validada con `GET /api/auth/me` Bearer). Config en **plugin-store** (`lixbon.settings.json`), ya no en localStorage; URL default `https://remote.datacentgbx.online` con opciones avanzadas.
- **Editor CodeMirror 6** (`src/editor/`, `src/store/editorStore.js`): tabs múltiples (un EditorState por pestaña, una sola EditorView), tema lixbon claro, 7 lenguajes, Ctrl+S/W/Tab, confirmación al cerrar con cambios.
- **Chat SSE** (`src/chat/`, `src/store/chatStore.js`, `src/lib/stream.js` adaptado con Bearer): streaming token a token, detener, historial del backend (buscar/renombrar/borrar), markdown con bloques "Copiar"/"Insertar en editor", chip de contexto (archivo activo o selección), errores de cuota 429/403 en español con fecha de reset.
- **Seguridad Rust** (`src-tauri/src/lib.rs`): comandos fs confinados a la carpeta de trabajo (`set_workspace_root` + `ensure_inside_root` con canonicalize), sin fallback hardcodeado, límite 5 MB, CSP no nula en `tauri.conf.json`. Capability `dialog:default` añadida (faltaba).
- **Eliminado**: Terminal/Commands/Services/Workspace.jsx/Onboarding/Sidebar/TopBar legacy, CSS embebido (`dangerouslySetInnerHTML` → 0), CustomEvents, `react-icons` y `recharts` (Metrics ahora usa la gráfica SVG portada de la web + tiles de cuota de `GET /api/account/usage`).
- **Backend**: `core/gateway/app.py` añade orígenes CORS de Tauri (`http://tauri.localhost`, `tauri://localhost`, `localhost:1420`).
- **Pendiente de verificar**: build del MSI (no hay toolchain Rust en esta máquina; compila en CI `tauri.yml`) y prueba E2E de upgrade 0.2.x → 0.3.0 con el updater.

## 6.13 ✅ IDE desktop v0.5.0: titlebar propia, autoguardado, clone Git, herramientas de archivos, iconos (2026-07-09)

Versión unificada **0.5.0** (package.json, Cargo.toml, tauri.conf.json). `productName`/`identifier` intactos.

- **Barra de título personalizada** (`src/layout/TitleBar.jsx`): `decorations: false` + barra propia con logo, menús estilo VSCode (Archivo/Editar/Ver/Terminal), zona de arrastre (`data-tauri-drag-region`), **toggle del chat a la derecha** (salió de la ActivityBar) y controles min/max/cerrar (permisos `core:window:allow-*` añadidos a capabilities). Se muestra en modo `minimal` (solo logo+controles) en carga y login (`App.jsx` envuelve todo en `.app-frame`).
- **Autoguardado** (`editorStore.js`): debounce 1 s tras el último cambio (`markDirty` → `saveAll`), activado por defecto; toggle en Ajustes → Editor y en menú Archivo (`lixbon_auto_save`). Nuevos `saveTab/saveAll` (Ctrl+Mayús+S) con protección contra escrituras durante el tecleo.
- **Clonación Git arreglada**: comando Rust dedicado `git_clone` (async + `spawn_blocking`, progreso de stderr por evento `git:clone:out`, `GIT_TERMINAL_PROMPT=0`, deriva el nombre del repo de la URL y clona en `destino/nombre`); al terminar abre la carpeta clonada como workspace. El flujo anterior por terminal fallaba (dest era una carpeta existente → git rehusaba; cancelar el diálogo abortaba).
- **Workspace compartido**: la carpeta raíz vive en `appStore.workspaceRoot` (`openWorkspace`/`restoreWorkspace`); FileTree y SourceControl reaccionan a los cambios (antes era estado local del FileTree).
- **Herramientas de archivos** (menú contextual del explorador): renombrar (F2-style inline, remapea pestañas abiertas), eliminar (con confirmación; cierra pestañas afectadas), duplicar, copiar ruta/ruta relativa, revelar en el explorador del SO, nuevo archivo/carpeta. Comandos Rust nuevos: `rename_entry`, `delete_entry`, `duplicate_entry`, `reveal_in_os` (todos confinados al workspace; la raíz protegida). `hide_console` (CREATE_NO_WINDOW) aplicado a git/explorer para no parpadear consolas.
- **Iconos**: `lixbon-icon/` integrada — `tauri icon icon-1024.png` regeneró `src-tauri/icons/`; favicon.svg en desktop (`public/` + titlebar + index.html con título LIXBON) y favicons completos en `apps/web` (svg + png 16/32 + apple-touch).
- **Pendiente de verificar**: compilación Rust en CI (sin cargo local) y MSI 0.5.0 + upgrade del updater.

## 6.14 ✅ IDE desktop v0.6.0: búsqueda global, Quick Open y temas de VSCode (2026-07-09)

Versión unificada **0.6.0**. Se apila sobre 6.13 (sin taggear aún).

- **Búsqueda global** (`Ctrl+Mayús+F`, `sections/Search/SearchPanel.jsx`): comando Rust `search_in_files` (walk del workspace en `spawn_blocking`, case-insensitive, salta `SKIP_DIRS`, límites 500 hits / 1 MB por archivo, filtra binarios); resultados agrupados por archivo, clic abre en la línea (`editorStore.openFileAtLine` con `scrollIntoView`).
- **Quick Open** (`Ctrl+P`, `components/QuickOpen.jsx`): comando Rust `list_files` (lista plana, tope 5000) + fuzzy match por subsecuencia en JS; overlay con teclado (↑↓/Enter/Esc).
- **Panel izquierdo conmutable**: `appStore.leftView` ('explorer'|'search'|'extensions') + `openLeftPanel`; ActivityBar ganó botones de búsqueda y extensiones (puzzle); entradas nuevas en menú Ver.
- **Extensiones de VSCode (SOLO temas de color)**: no se puede ejecutar el extension host de VSCode en CodeMirror, así que se soporta lo declarativo: `ext_search` (API de Open VSX vía reqwest de tauri-plugin-http, sin CORS), `ext_install` (descarga el `.vsix` ≤60 MB, lo abre con el crate `zip` **nuevo en Cargo.toml**, parsea `contributes.themes` de package.json con limpiador JSONC propio `clean_jsonc`, guarda los JSON en `app_data_dir/extensions/<id>/`), `ext_read_theme`, `ext_uninstall`. Frontend: `store/extStore.js` (instaladas en localStorage `lixbon_extensions`, tema activo `lixbon_editor_theme`), `editor/vsTheme.js` (mapa scopes TextMate → tags lezer + `colors.editor.*` → `EditorView.theme`), `editorStore` con `themeCompartment` que reconfigura la vista viva y los estados cacheados (`setEditorThemeExts`); panel `sections/Extensions/ExtensionsPanel.jsx` (buscar/instalar/aplicar/quitar, "Volver al tema lixbon"). CSP: `img-src` ahora permite `https:` (iconos de Open VSX).
- **Pendiente de verificar en CI**: crate `zip` y reqwest re-exportado compilan; probar instalar p. ej. "One Dark Pro" o "Dracula" desde Open VSX y aplicar el tema.

---

## 6.15 ✅ IDE desktop v0.5.2: fix del bucle de actualización, temas a toda la app y secciones exclusivas (2026-07-10)

Corrige los 3 bugs reportados sobre la 0.5.1. Versión unificada **0.5.2** (package.json + tauri.conf.json + Cargo.toml — estaban desincronizados: package.json decía 0.6.0).

- **Bug del modal de actualización (causa raíz)**: con `workflow_dispatch` (sin tag), el paso de subida del CI tomaba la versión de `package.json` (0.6.0) mientras el MSI se compila con la de `tauri.conf.json` (0.5.1) → el servidor registró un release "0.6.0" cuyo binario real es 0.5.1 → bucle infinito de "actualización disponible". Arreglos:
  - `.github/workflows/tauri.yml`: la versión que se registra sale SIEMPRE de `tauri.conf.json`; si hay tag y no coincide, el job falla.
  - `core/persistence/queries.py` `get_latest_version`: la "última" es la mayor por **semver** (`packaging.Version`), no la última insertada (`id`), porque el upsert de `add_app_version` conserva el id original.
  - `DELETE /api/versions/{version}` (admin, `versions.py`): borra fila + objeto R2; imprescindible para eliminar el release fantasma 0.6.0 de producción.
  - `useVersion.js`: guard cliente — el modal solo aparece si `latest_version` es realmente mayor que la instalada.
  - **Remediación en prod**: tras el deploy, `curl -X DELETE -H "X-Admin-Token: …" https://lixbon.com/api/versions/0.6.0`.
- **"Las extensiones no se instalan"**: la instalación Rust funciona (verificado: `app_data/extensions/mskelton.one-dark-theme/` existe y el tema quedó activo en localStorage; la lógica pasa contra los 12 temas top de Open VSX). El problema era de percepción: el tema solo re-coloreaba el área CodeMirror. Ahora `vsTheme.js#appColorsFromTheme` mapea los colores de workbench (`editor.background/foreground`, `sideBar.background`…) a los tokens del shell (`--bg`, `--bg-secondary`, `--ink`, `--ink-soft`, `--border`, `--border-soft`) y `extStore` los aplica/retira a `:root` — el tema viste TODA la app. Además: errores del panel en caja visible (`.extpanel__error`) y `clean_jsonc` tolera BOM UTF-8.
- **Secciones exclusivas**: Control de código dejó de ser vista central y pasó al panel izquierdo (`leftView: 'explorer'|'search'|'git'|'extensions'`), como VSCode — ya no puede convivir con Extensiones/Explorador. `.scm` re-estilado para la barra lateral (título uppercase, branch con wrap).
- **Pendiente**: CI valida el Rust (BOM strip) al taggear `v0.5.2`; tras el deploy del gateway ejecutar el DELETE del 0.6.0 fantasma.

---

## 6.16 ✅ Ajustes web completos + créditos prepago de API (2026-07-11)

Implementa todos los "Próximamente" de Ajustes (menos Idioma, pospuesto) y el cobro por tokens de las API keys. Verificado E2E: 29/29 checks de lógica (BD staging) + 18/18 checks HTTP (gateway local).

**Ajustes (web + backend)**:
- `users.settings_json` (migración idempotente) + `GET/PATCH /api/account/settings` (defaults en `queries.SETTINGS_DEFAULTS`: `anonymous_usage`, `save_history`). `/api/auth/me` incluye `settings`.
- **Apariencia** (General): selector claro/oscuro/sistema (`lib/theme.js` ganó `get/setThemePreference`; "sistema" borra la key y sigue `prefers-color-scheme`).
- **Privacidad**: toggles persistidos. `save_history=false` ⇒ los 3 endpoints de inferencia no persisten conversación/mensajes (el uso sí se contabiliza vía `record_model_usage`, extraída de `save_message`); responden `conversation_id: null` y el ChatPage mantiene el hilo solo en memoria (sin `/c/:id` ni sidebar).
- **Exportar datos** (`GET /api/account/export`): JSON descargable con perfil, settings, plan, keys enmascaradas, conversaciones+mensajes, uso diario y ledger de créditos.
- **Borrar historial** (`DELETE /api/account/conversations`): DELETE masivo con `ConfirmDialog` (componente nuevo, patrón ShareDialog).
- **Eliminar cuenta** (`DELETE /api/account` con `{password}`): reauth (`check_user_password`, 403+rate-limit si falla), cancela la suscripción Stripe (best-effort), borra en una transacción messages/conversations/api_keys/task_embeddings (sin CASCADE), anonimiza `audit_events` y el DELETE de users cascada el resto. Audit `account_deleted` con hash del correo (sin PII). Estilos `pill-btn is-danger` añadidos (no existían).

**Créditos prepago (cobro por tokens de las API keys — SOLO tráfico Bearer)**:
- Tablas nuevas: `model_pricing` (tarifas por prefijo de modelo en µ$/Mtok, fila `*` = default, seed $0.20 in / $0.60 out), `credit_accounts` (saldo BIGINT µ$), `credit_ledger` (movimientos; `stripe_ref` UNIQUE = idempotencia de webhooks), `credit_packs` (seed starter $5 / plus $20 / power $50).
- `core/billing/credits.py`: `resolve_pricing` (longest-prefix, cache 60 s, sin tarifa ⇒ 503), `ensure_can_use_api` (rate limit del plan + saldo>0 o **402 insufficient_credits**), `debit_usage` (costo entero al terminar; transacción saldo+ledger; nunca tumba la respuesta). Modelo post-pago por petición: descubierto acotado a céntimos, saldo negativo bloquea la siguiente.
- **El tráfico Bearer se desacopla del plan**: `validate_api_key`/`validate_web_session` marcan `auth_via`; en chat.py, Bearer usa `ensure_can_use_api` (ignora messages/día, tokens/mes y allowed_models — los créditos pagan cualquier modelo) y NO toca `usage_quotas` (que es enforcement del chat con sesión); `_persist_assistant(bill_credits=True)` debita en vez de `record_tokens`. `/v1/completions` (solo key) siempre cobra créditos.
- Stripe: `create_credit_checkout` (mode=payment, price_data inline, sin configurar productos) + rama `checkout.session.completed` del webhook (acredita 1 sola vez por `stripe_ref`).
- Endpoints: `GET /api/pricing` y `GET /api/credits/packs` (públicos), `POST /api/credits/checkout`, `GET /api/credits` (saldo+ledger), `GET /api/credits/usage` (por día/modelo con costo, del ledger). Sin Stripe: packs visibles, checkout 503.
- **Web**: Facturación con bloque "Créditos de API" (saldo, packs, recargas, banner `?credits=success`); Uso con tabla "Consumo de API" (tokens in/out, peticiones, costo por día/modelo). **Admin**: tabs **Tarifas** (CRUD `/api/admin/pricing` en $/Mtok, la fila `*` no se borra, cache invalidada al editar) e **Ingresos** (`/api/admin/credits/summary`: revenue mes, recargas, consumo por modelo, top consumidores).
- **Docs**: secciones nuevas "Usar tu API key" (curl, Python/JS SDK OpenAI, continue.dev, IDE lixbon) y "Precios de la API" (tabla dinámica de `GET /api/pricing`, cálculo del costo, 402); "API" y "Planes y límites" actualizadas al modelo de créditos.
- **Grant manual de créditos (2026-07-11, tarde)**: `POST /api/admin/credits/grant` `{email, amount_usd (±1000, ≠0), note?}` — acredita saldo sin Stripe (reutiliza `credit_purchase` con `kind='grant'`, audit `credits_granted`); formulario "Acreditar saldo de API" en el tab Ingresos del admin. Motivación: sin Stripe conectado ni grant, NADIE (ni el owner) podía usar la API con key — el 402 `insufficient_credits` se manifestaba en clientes externos (VS Code Copilot BYOK lo muestra como "Quota Exceeded"). Requiere role=admin (⇒ `ADMIN_EMAILS` en Railway, aún pendiente).

**Pendiente operativo**: añadir `checkout.session.completed` al webhook de Stripe cuando se activen los pagos (sección 0).

### 6.16.b Cobro de API por plan, con créditos como overflow (2026-07-12)

El usuario detectó una redundancia: un Pro/Advance ya paga su suscripción (incluye todos los modelos y crear API keys), pero el tráfico Bearer se le cobraba SIEMPRE de créditos → doble cobro. Rediseño de `credits.ensure_can_use_api()` → ahora **devuelve el modo de cobro** (`'plan'` | `'credits'`):
- **Gratuito (sin plan de pago)**: prepago por créditos (como antes) — cualquier modelo, tarifa por modelo. (El plan free ya trae `max_api_keys=1`.)
- **Pro/Advance dentro de su cuota mensual de tokens**: modo `'plan'`, NO se cobran créditos (usa `tokens_per_month`; Advance es -1 = ilimitado ⇒ siempre plan). Respeta `allowed_models` (para Pro/Advance = todos).
- **Pro/Advance con la cuota AGOTADA**: si tiene saldo → `'credits'`; si no → 402 `plan_tokens_exhausted` ("Recarga créditos para seguir usando la API este mes").
- Los 3 callers (`/v1/chat/completions`, `/v1/completions`) usan el modo: `_persist_assistant(bill_credits = modo=='credits')` → 'plan' registra en la cuota mensual (`record_tokens`), 'credits' debita del saldo. La web (sesión) sigue por `ensure_can_chat` sin cambios. Decisiones: el tráfico API se limita por **tokens_per_month** (no messages_per_day, que es de la UI). Verificado con test de los 6 caminos. **Pendiente**: actualizar copy de la web (pricing/facturación/docs "usar tu API key") al nuevo modelo; requiere deploy del gateway.

## 6.17 ✅ IDE v0.5.3: sintaxis colorida, extensiones declarativas completas y TextMate (2026-07-11)

Versión unificada **0.5.3** (package.json estaba en 0.5.2 con tauri.conf/Cargo en 0.5.3 — resincronizadas). Rust pendiente de validar en CI (sin cargo local).

- **Sintaxis colorida** (`editor/lixbonTheme.js`): paleta rica en claro (familia One Light: keywords magenta, funciones azul, tipos dorado, strings verde, números naranja, variables coral, operadores cian) y oscuro (familia One Dark), ~30 reglas por tema cubriendo también los tags de los legacy modes (regexp, escape, self, parámetros, diffs, headings…). Chrome del editor intacto.
- **Más lenguajes** (`editor/languages.js`, todos vía `@codemirror/legacy-modes`, 0 deps nuevas): C#, Kotlin, Scala, Dart, Obj-C, Ruby, Lua, Perl, R, Swift, Haskell, Julia, Groovy/gradle, Clojure, Erlang, PowerShell, CMake, Pascal, protobuf (+`CMakeLists.txt` por nombre).
- **Temas VSCode más fieles**: `SCOPE_TO_TAGS` ampliado de ~21 a ~60 scopes y extraído a `editor/scopeMap.js` (compartido con TextMate — los temas pintan igual tokens lezer y TextMate).
- **Extensiones "declarativo máximo"** (`install_vsix` reescrito en lib.rs): desempaqueta TODO `extension/` (guardas: `safe_rel_path` anti-traversal con tests, tope 120 MB descomprimido / 20k entradas) y devuelve manifest `{themes, grammars, languages, snippets, icon_themes, has_code, warnings}`. Ya NO falla sin temas; lo no soportado se explica en `warnings`. Comando nuevo `ext_read_file` (lectura confinada); `ext_read_theme` se mantiene (compat). Los temas siguen re-serializados en la raíz de la carpeta (instalaciones viejas intactas).
- **Snippets** (`editor/snippets.js`): archivos de `contributes.snippets` convertidos a `snippetCompletion` de CM (sintaxis VSCode→CM: `$0`→`${}`, choices y variables TM_ resueltas); fuente de autocompletado dinámica registrada por `languageData` en `openFile` — snippets recién instalados aplican sin reconfigurar estados. Mapa ext→id de lenguaje VSCode + lenguajes contribuidos.
- **Temas de iconos** (`editor/iconTheme.js` + FileTree): parser de `contributes.iconThemes` (fileExtensions compuestas, fileNames, folder/folderExpanded, languageIds), SVG por data-URL con caché y fallback a los iconos propios (solo SVG — cubre Material Icon Theme; los de fuente avisan). Selector en el panel de extensiones (`applyIconTheme` en extStore, localStorage `lixbon_icon_theme`).
- **TextMate real** (`editor/textmate.js`): `vscode-textmate` + `vscode-oniguruma` (WASM ~160 KB gz, carga perezosa al abrir el primer archivo que lo necesita; fallo ⇒ texto plano). Adaptador `StreamParser` (ruleStack por línea + `tokenTable` desde scopeMap). Resolución en `resolveLanguage`: 1º lezer/legacy, 2º gramática de extensión instalada, 3º plano. CSP: `script-src` ganó `'wasm-unsafe-eval'` (WebView2 lo exige para WASM).
- **ExtensionsPanel**: chips de contribuciones por extensión ("2 temas", "sintaxis: elixir", "snippets: python", "iconos") + warnings visibles.
- **Pendiente de verificar en CI/manual**: compilación Rust (tests `safe_rel_path`/`contrib_rel` incluidos), instalar Material Icon Theme y una extensión de gramática (ej. Elixir/Zig) y abrir un archivo suyo.

---

## 7. Fases posteriores (sin iniciar)

- **F8 — Calidad**: tests automatizados (no hay ninguno aún; los scripts E2E de verificación viven en scratchpad, no versionados), ruff/mypy, Sentry, backups verificados, docs de API, ToS/privacidad.

---

## 7. Mapa rápido de dónde está cada cosa

| Cosa | Dónde |
|---|---|
| Gateway (entry) | `core/gateway/app.py` → `uvicorn core.gateway.app:app` |
| Rutas API | `core/gateway/routers/` (auth, chat, conversations, billing, keys, versions, nodes_admin, admin, monitor, ws_status, installer) |
| Cuotas por plan | `core/billing/quota.py` (límites en tabla `plans`; seed en `BD/seeds/plans.sql`) |
| Panel admin (API) | `core/gateway/routers/admin_panel.py` (`/api/admin/*`, rol) + `nodes_admin.py` |
| Panel admin (web) | `apps/web/src/pages/AdminPage.jsx` + `styles/admin.css` (ruta `/admin`) |
| Releases / updates | `core/gateway/routers/versions.py` + `core/storage/r2.py` (R2 privado; descargas prefirmadas) |
| Descargas / Docs (web) | `apps/web/src/pages/{DownloadsPage,DocsPage,docsContent}.jsx` (rutas `/descargas`, `/docs`) |
| Swagger / OpenAPI | `/api/docs`, `/api/redoc`, `/api/openapi.json` (movidos para liberar `/docs`) |
| BD (modelos/queries) | `core/persistence/models.py` · `queries.py` (staging vía `DATABASE_URL` del `.env`) |
| Inferencia/streaming | `core/inference/ollama.py` (única implementación) |
| Orquestador | `core/orchestration/orchestrator.py` (`ollama_target()` decide nodo vs local) |
| Agente GPU | `core/node_agent/agent.py` (puerto 8765, token en `.env` `NODE_SHARED_SECRET`) |
| Web vieja (a reemplazar en F4) | `apps/web/` (React+Vite; mantener organización components/pages/styles) |
| Desktop Tauri | `apps/desktop/` |
| CLI | `apps/cli/client_cli.py` (monolito, se moderniza post-F4) |
| Esquema BD + scripts | `BD/` (schema.sql se regenera con `python BD/scripts/dump_schema.py`) |
| Diseño web (specs) | `docs/DISENO_WEB.md` |
| Plan por fases | `docs/PLAN_MAESTRO.md` |
| Secretos locales | `.env` (staging URL, ADMIN_TOKEN, NODE_SHARED_SECRET) — NUNCA en git |
| Clave firma Tauri | `C:\Users\Usuario\.tauri\lixbon_update.key` (+ GitHub Secrets) |
| Config tunnel | `C:\Users\Usuario\.cloudflared\config.yml` (tunnel `lixbon-gpu-01`) |

## 8. Cómo arrancar el entorno de desarrollo

```powershell
# 1. Gateway local (usa la BD de staging de Railway automáticamente por .env)
python -m uvicorn core.gateway.app:app --reload --port 8000

# 2. Node agent (para probar inferencia local con la GPU)
python -m core.node_agent.agent

# 3. Web en dev (proxy al gateway)
cd apps/web; npm run dev   # http://localhost:5173

# 4. Tunnel (solo si quieres probar el flujo de producción completo)
.\cloudflared.exe tunnel run lixbon-gpu-01
```

Nota: el nodo `gpu-01` en la BD de **staging** apunta a `http://127.0.0.1:8765` (test local) — coherente para desarrollo. El de **prod** apunta al tunnel.
