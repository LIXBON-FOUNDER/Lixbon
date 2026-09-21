# Plan de evolución del IDE lixbon (todos los ejes)

> Estado base: **v0.6.3**. Editor CodeMirror 6 (tabs, autoguardado, sintaxis rica +
> TextMate, snippets, autocomplete básico y buscar/reemplazar vía `basicSetup`),
> terminal PTY, Git básico, búsqueda global + Quick Open, extensiones VSCode
> declarativas, agente de chat con herramientas + diff inline (merge) + checkpoints
> + visión + tool-calling nativo opt-in, métricas y ajustes.
>
> Este documento planifica **los 4 ejes completos** (A inteligencia de código,
> B IA nativa, C Git, D ergonomía) en milestones ordenados por dependencia y valor.

---

## Reglas transversales (aplican a TODAS las fases)

1. **Rust solo compila en CI.** No hay `cargo` local. Todo cambio en
   `src-tauri/` (comandos nuevos) solo se valida al taggear `vX.Y.Z` o con
   `workflow_dispatch`. → **Agrupar los cambios de Rust por milestone y validar
   con un tag por milestone**, no fase a fase.
2. **Las 3 versiones van siempre iguales**: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`. Cada milestone cierra con un bump sincronizado.
3. **Frontend siempre validado con `npm run build`** antes de commitear.
4. **Endpoints nuevos del gateway** que invoquen modelos (FIM, embeddings) van por
   `deps.orquestador.ollama_target(model)` (mejor nodo + fallback local) y **cobran
   igual que el chat**: `credits.debit_usage` (Bearer/prepago) o `record_model_usage`
   (cuota de plan). Ver plantilla en `core/gateway/routers/chat.py:132` (`_routed_chat`)
   y `:413` (`/api/vision/describe`).
5. **Sandbox Rust**: todo comando de archivos usa el patrón `WorkspaceRoot` +
   `ensure_inside_root` (canonicaliza y rechaza rutas fuera de la carpeta). Los
   comandos LSP/Git/índice deben respetarlo.
6. **CSP**: FIM/embeddings pasan por el gateway (ya permitido). LSP y el índice
   corren en Rust (fuera de CSP). No añadir orígenes salvo que sea imprescindible.

### Habilitadores que se construyen una vez y reutilizan muchas fases

- **Registro central de comandos** (M0 / D1): base de la paleta, atajos, acciones
  de LSP, formateo, git, IA. Todo lo demás registra comandos aquí.
- **Componente DiffView reutilizable** (`@codemirror/merge` lado a lado): lo usan
  C1 (git diff), C2 (diff por commit) y B2 (previsualizar Ctrl+K en grande).
- **Endpoints de modelo del gateway** (`/api/fim`, `/api/embed`): habilitan B1 y B3.

---

## Secuencia recomendada (milestones)

| M | Nombre | Ejes | Por qué en este orden |
|---|--------|------|-----------------------|
| **M0** | Cimientos | D1 | Registro de comandos = base de todo lo demás |
| **M1** | IA nativa — victorias rápidas | B2, B4 | Reutilizan merge + `run_command` ya existentes |
| **M2** | IA nativa — pesado | B1, B3 | Diferenciador real; necesita endpoints de modelo |
| **M3** | Git profesional | C1, C2, C3 | Alto valor visible; solo comandos Rust nuevos |
| **M4** | Inteligencia de código | A1, A2, A3, A4 | El salto grande; LSP es la fase más pesada |
| **M5** | Ergonomía restante | D2, D3, D4, D5 | Pulido de parity con VSCode |

> El orden es una recomendación por dependencia/valor; cada fase es autocontenida
> y se puede reordenar salvo las dependencias marcadas.

---

# M0 — Cimientos  ✅ IMPLEMENTADO (2026-07-12)

> Hecho: registro central `src/lib/commands.js`, keymap `src/lib/keymap.js`
> (chords→comando, `dispatchKeydown`, overrides para D5), comandos base
> `src/commands/builtin.js`, paleta `src/components/CommandPalette.jsx`
> (Ctrl+Mayús+P, toggle, reutiliza CSS de QuickOpen). AppShell ahora despacha
> los atajos por el keymap en vez del handler ad-hoc. `npm run build` OK. Sin Rust.

## D1 · Paleta de comandos + registro central (Ctrl+Shift+P)
**Objetivo:** un registro único de comandos con título, categoría, atajo y `run()`;
paleta difusa (reutiliza el fuzzy de `QuickOpen`); base para atajos configurables (D5).

- **Nuevos:** `src/lib/commands.js` (registry: `register/all/run/find`),
  `src/components/CommandPalette.jsx` (overlay Ctrl+Shift+P, filtra por título/categoría),
  `src/lib/keymap.js` (mapa atajo→commandId, dispara desde un listener global).
- **Tocar:** `App.jsx` (listener global de teclado → paleta / atajos),
  `appStore.js` (`commandPalette: bool`), y registrar los comandos ya existentes
  (abrir archivo, guardar, toggles de panel, git add/commit, run, buscar…).
- **Deps:** ninguna. **Rust:** ninguno.
- **Aceptación:** Ctrl+Shift+P abre la paleta; ejecutar "Guardar todo", "Alternar
  terminal", "Git: commit" desde ahí funciona; los atajos existentes siguen vivos.
- **Riesgo:** colisión de listeners de teclado con CodeMirror → registrar en fase
  captura y respetar `preventDefault` solo en atajos propios.

---

# M1 — IA nativa: victorias rápidas  ✅ IMPLEMENTADO (2026-07-12)

> Hecho B2 y B4. Build OK. Cambio aditivo en el gateway (`no_persist` en
> ChatCompletionRequest) verificado con `ast.parse`; la web no lo envía. B4 no
> añade Rust: `run_command` ya existía en agent.js/lib.rs; lo que se añadió es la
> **capa de seguridad** (comandos siempre piden aprobación salvo allowlist).
> Pendiente: que `run_command` (Rust) compile en un tag `v0.6.x` para ejecutarse
> de verdad; el frontend ya lo maneja y degrada a error si no existe.

## B2 · Edición inline Ctrl+K
**Objetivo:** seleccionar código, describir el cambio en un popup, el modelo lo
reescribe y se muestra como diff inline (verde/rojo) reutilizando `@codemirror/merge`.

- **Reutiliza:** `editorStore.showAgentDiff` / `applyPendingMerge` / `mergeCompartment`
  (ya pinta diff con Aceptar/Rechazar por bloque) y `getActiveContext` (selección).
- **Nuevos:** `src/editor/InlineEdit.jsx` (widget flotante sobre la selección),
  `src/lib/inlineEdit.js` (arma el prompt: selección + N líneas de contexto arriba/abajo,
  streaming, extrae el bloque reescrito). Comando `editor.inlineEdit` en el registro (M0).
- **Tocar:** `editorStore.js` (keymap `Mod-k` → abre widget; helper para reemplazar
  el rango seleccionado y dejar el diff), `stream.js` (reusa el POST de chat sin persistir).
- **Deps/Rust:** ninguno (usa el chat existente del gateway).
- **Aceptación:** Ctrl+K sobre una función + "añade manejo de errores" → diff inline
  aceptable/rechazable; Rechazar deja el original intacto.
- **Riesgo:** el modelo devuelve prosa/valla ```` ``` ````; reusar `agentProtocol`
  (`cleanProse`, extracción de bloque) para quedarnos solo con el código.

## B4 · El agente ejecuta comandos en el terminal (con aprobación)
**Objetivo:** que el agente pueda correr comandos y **leer su salida** (build, tests,
grep), no solo tocar archivos. El comando Rust `run_command` **ya existe**.

- **Reutiliza:** `run_command` (lib.rs), `ApprovalCard` (patrón de aprobación por acción),
  cola del `terminalStore`.
- **Nuevos:** herramienta `run_command` en `src/lib/agent.js` + esquema en
  `agentSchemas.js` + regla en el prompt (`agentProtocol.js`). Tarjeta de aprobación
  específica para comandos (muestra el comando, exige OK salvo allowlist).
- **Tocar:** `chatStore.js` (loop del agente: manejar el tool `run_command`, inyectar
  `EXIT + stdout/stderr` truncado como `TOOL_RESULT`), `ChatInputBar`/Ajustes
  (toggle "permitir comandos" + allowlist de prefijos seguros p. ej. `npm test`).
- **Deps:** ninguna. **Rust:** ninguno nuevo (validar que `run_command` compiló en CI;
  seguía pendiente según la memoria — confirmar en el próximo tag).
- **Aceptación:** pedir "corre los tests y arregla lo que falle" → el agente ejecuta,
  ve el fallo, edita y reintenta (regla de auto-corrección ya redactada en el prompt).
- **Riesgo:** ejecución arbitraria; mitigar con aprobación obligatoria por defecto +
  allowlist explícita + timeout y truncado de salida.

---

# M2 — IA nativa: pesado (diferenciador de lixbon)

> **Estado (2026-07-12):** B1 ghost text ✅ · B3 @-menciones ✅ · B3 índice
> semántico (RAG) ⏳ pendiente. `/api/fim` implementado; `/api/embed` pendiente
> (se hará junto al índice). **Decisión de arquitectura:** el índice RAG se hará
> en **JavaScript** sobre los comandos de archivo Rust existentes (guardar/leer
> `.lixbon/index.json` en el sandbox) + coseno en JS → **sin Rust nuevo, sin tag**
> (cambia lo planeado, que proponía `rusqlite`).

## Habilitador · Endpoints de modelo en el gateway
- **`POST /api/fim`** (fill-in-the-middle): body `{model, prefix, suffix, num_ctx}`,
  llama a `/api/generate` de Ollama con el template FIM del modelo (qwen2.5-coder usa
  `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`), `stream:false`, `stop` adecuados.
  Cobra como el chat. Plantilla: `_routed_chat` → añadir `ollama_generate`.
- **`POST /api/embed`**: body `{model, input:[...]}` → `/api/embeddings` de Ollama;
  cobra por tokens de entrada. Modelo por defecto sugerido: `nomic-embed-text`.
- **Tocar:** `core/gateway/routers/chat.py` (o router nuevo `code.py` incluido en
  `app.py`), `core/**/ollama` helpers (añadir `ollama_generate`/`ollama_embeddings`).
- **Aceptación:** `curl` a ambos con Bearer devuelve completado/vector y descuenta saldo.

## B1 · Autocompletado fantasma (ghost text, estilo Copilot)
**Objetivo:** sugerencia gris en línea mientras escribes; Tab acepta.

- **Nuevos:** `src/editor/ghostText.js` (ViewPlugin + decoración de widget inline;
  debounce ~300 ms; cancela en cambio de cursor/tecleo; Tab acepta, Esc descarta),
  `src/lib/fim.js` (recorta prefijo/sufijo alrededor del cursor por ventana de tokens,
  llama a `/api/fim`, cachea por posición).
- **Tocar:** `editorStore.js` (añadir la extensión al array de `openFile`; compartment
  para activar/desactivar en vivo), `appStore.js` (`ghostText: bool`, modelo FIM),
  Ajustes (toggle + selector de modelo + retraso), registro de comando "Alternar
  autocompletado IA".
- **Deps:** ninguna (todo con `@codemirror/view` ya presente). **Rust:** ninguno.
- **Aceptación:** al escribir dentro de una función aparece continuación gris en <1 s;
  Tab la inserta; desactivable; no dispara con VRAM saturada (respeta el toggle).
- **Riesgo:** latencia/VRAM (RTX 3050 6 GB) → debounce alto, cancelación agresiva,
  `num_predict` corto, y off por defecto hasta validar rendimiento.

## B3 · @-menciones y contexto de codebase (RAG local)
**Objetivo:** `@archivo` y `@símbolo` en el chat; indexado semántico para "preguntar
al repo" sin pegar archivos a mano.

- **Índice (Rust, en `.lixbon/index` dentro del workspace):**
  - Comando `index_build(root)`: recorre archivos de texto, trocea por ventanas,
    pide embeddings (llama al gateway `/api/embed` — o expone un comando que el JS
    orquesta), guarda `{path, chunk, vector}` en SQLite (`rusqlite`, dep Cargo NUEVA)
    o en un JSON comprimido. Respeta `.gitignore` y el sandbox.
  - Comando `index_search(query_vector, k)`: similitud coseno top-k.
  - Comandos `index_status` / `index_clear`.
- **@-menciones (frontend):**
  - `src/chat/MentionMenu.jsx`: al teclear `@` en `ChatInputBar`, autocompleta
    archivos (`list_files`) y símbolos (de A3/outline si existe; si no, solo archivos).
  - `chatStore.js`: expande menciones a contexto real antes de enviar; con RAG activo,
    añade los top-k chunks del índice al prompt (con presupuesto de tokens).
- **Tocar:** `agent.js` (herramienta `search_codebase` que llama a `index_search`),
  `agentSchemas.js`, prompt del agente (regla: usa `search_codebase` antes de asumir).
- **Deps:** Cargo `rusqlite` (o `zip`/serde ya presentes si se opta por JSON).
- **Aceptación:** `@main.py` inserta ese archivo como contexto; "¿dónde se valida el
  login?" con RAG devuelve los fragmentos correctos; reindexado incremental al guardar.
- **Riesgo:** coste de embeddings en repos grandes → indexar bajo demanda, incremental
  por mtime, y tope de tamaño/archivos como en `install_vsix`.

---

# M3 — Git profesional  ✅ IMPLEMENTADO (2026-07-12)

> **Sin Rust nuevo:** `gitRun` ya ejecuta cualquier subcomando git. Hecho en JS:
> C1 visor de diff (`DiffView.jsx`, centerView 'diff', clic en archivo → diff
> unified coloreado; `gitStore.fileDiff`), C2 historial (`gitStore.log/commitDiff`
> + sección Historial en SourceControl, clic → diff del commit), C3 ramas
> (`branches/checkout`, menú en SourceControl) + stash (`stash push/pop`). Build OK.
> ⏳ **Pendiente:** blame gutter (necesita una gutter-extension en el editor).

> Todos los comandos nuevos siguen el patrón `git_run` (CLI del sistema,
> `GIT_TERMINAL_PROMPT=0`, cwd = workspace). Las ops de red siguen yendo al terminal.

## C1 · Visor de diff (working tree y por archivo)
- **Rust nuevos:** `git_diff(path?, staged: bool)` → texto unified diff (o dos blobs
  para el merge lado a lado). Reutiliza `git_run`.
- **Nuevos:** `src/editor/DiffView.jsx` (componente `@codemirror/merge`
  `MergeView` lado a lado, solo lectura), abrir diff como "pestaña" especial.
- **Tocar:** `SourceControl.jsx` (clic en archivo → abre DiffView en el centro),
  `editorStore` (soportar pestañas de tipo `diff`), registro de comandos.
- **Aceptación:** clic en un archivo modificado muestra viejo↔nuevo lado a lado;
  distingue staged vs working.

## C2 · Historial de commits + blame
- **Rust nuevos:** `git_log(path?, limit)` → `[{hash, author, date, subject}]`;
  `git_show(hash)` → diff del commit; `git_blame(path)` → `[{line, hash, author, date}]`.
- **Nuevos:** `src/sections/SourceControl/History.jsx` (lista de commits, clic → diff
  del commit en DiffView), gutter de blame en el editor (`src/editor/blame.js`,
  gutter con autor/fecha por línea, toggle).
- **Tocar:** `gitStore.js` (estado de log/blame), `SourceControl.jsx` (pestaña Historial).
- **Aceptación:** ver los últimos N commits, abrir el diff de uno; activar blame muestra
  autor por línea.

## C3 · Ramas, stash y conflictos
- **Rust nuevos:** `git_branches()` (lista + actual), `git_checkout(branch, create)`,
  `git_merge(branch)`, `git_stash(op)` (push/pop/list), `git_conflicts()` (archivos en
  conflicto).
- **Nuevos:** selector de rama en la StatusBar, panel de stash, **resolución de
  conflictos** con `@codemirror/merge` de 3 vías (ours/theirs/result) — vista dedicada.
- **Tocar:** `StatusBar.jsx` (rama actual + menú), `SourceControl.jsx`, `gitStore.js`.
- **Aceptación:** crear/cambiar rama desde la UI; stash push/pop; un merge con conflicto
  abre la vista de resolución y permite commitear el resultado.
- **Riesgo:** parseo frágil de la salida de `git` → usar `--porcelain`/`-z`/`--format`
  siempre que exista; tests del parser en Rust.

---

# M4 — Inteligencia de código  (A2, A3, A4 ✅ · A1 ⏳)

> **Hecho (2026-07-12):** A2 Problemas/lint (`lib/linters.js` ruff/eslint JSON +
> `editor/lintExt.js` con `@codemirror/lint` [dep declarada] + `problemsStore` +
> `ProblemsPanel` en leftView 'problems' + subrayados en el editor). A3 outline
> (`lib/outline.js` + `OutlinePanel`). A4 formatear (`lib/format.js` + Shift+Alt+F
> + formatOnSave). Build OK. **Pendiente A1 LSP** = única pieza con Rust nuevo real
> (procesos long-lived JSON-RPC por stdio; hacer en la fase de compilar+depurar).

## A1 · Cliente LSP real
**Objetivo:** autocompletado semántico, ir-a-definición, hover, firma y rename vía
Language Server Protocol, lanzando servidores por stdio.

- **Rust (núcleo pesado):**
  - `lsp_start(language, root)`: localiza el server (`rust-analyzer`, `pyright`,
    `typescript-language-server`, `gopls`…), lo lanza como proceso hijo, hace el
    handshake `initialize`. Estado `LspServers` (por lenguaje), hilo lector de stdout.
  - `lsp_request(id, method, params)` / evento `lsp:notify:{id}` para push
    (diagnostics). JSON-RPC sobre stdio con framing `Content-Length`.
  - `lsp_stop(id)`. **Dep Cargo:** ninguna nueva imprescindible (JSON-RPC a mano con
    `serde_json`); opcional `lsp-types` para tipado.
- **Frontend:**
  - `src/lsp/client.js` (envoltura de los comandos + correlación de peticiones por id),
    `src/lsp/codemirror.js` (fuente de `@codemirror/autocomplete` desde `completion`,
    `hoverTooltip` desde `hover`, comando "Ir a definición", "Renombrar símbolo").
  - Ciclo de vida ligado al workspace y al lenguaje del archivo abierto (`openFile`).
- **Tocar:** `editorStore.openFile` (añadir extensiones LSP según lenguaje vía
  compartment), registro de comandos (F12, Shift+F12, F2).
- **Aceptación:** en un proyecto Python con `pyright` instalado: autocompletado real,
  hover con tipos, F12 salta a la definición, F2 renombra en todo el proyecto.
- **Riesgos:** servidores no instalados (detectar y avisar, degradar a snippets);
  arranque lento (indicador en StatusBar); protocolo complejo (empezar por 1 lenguaje,
  p. ej. pyright, y generalizar). **Es la fase más grande de Rust → tag propio.**

## A2 · Panel "Problemas" + subrayados de diagnóstico
- **Nuevos:** `src/sections/Problems/ProblemsPanel.jsx` (lista agrupada por archivo,
  clic → salta a la línea), `src/editor/lint.js` (`@codemirror/lint` `linter`/`setDiagnostics`
  alimentado por A1 o por linters vía `run_command`).
- **Tocar:** `editorStore.openFile` (extensión de lint), dock inferior (pestaña
  Problemas junto al Terminal), `appStore`, ActivityBar/StatusBar (contador de errores).
- **Deps:** `@codemirror/lint`. **Rust:** ninguno (usa A1 o `run_command`).
- **Aceptación:** errores de A1 aparecen subrayados y listados; el contador de la
  StatusBar refleja errores/warnings; clic navega.
- **Nota:** si se hace A2 **antes** de A1, alimentarlo con linters de línea de comando
  (`ruff`, `eslint`, `tsc --noEmit`) vía `run_command` + parser.

## A3 · Outline / símbolos + breadcrumbs
- **Fuente:** `documentSymbol` de A1 (preferido) o tree-sitter (Rust, dep `tree-sitter`)
  como fallback sin LSP.
- **Nuevos:** `src/sections/Outline/OutlinePanel.jsx`, `src/editor/Breadcrumbs.jsx`
  (encima del editor, ruta + símbolo actual según el cursor).
- **Tocar:** `AppShell.jsx` (breadcrumbs), panel izquierdo (vista Outline), `leftView`.
- **Aceptación:** el panel lista clases/funciones del archivo y navega; las migas
  muestran el símbolo bajo el cursor.

## A4 · Formatear documento / format-on-save
- **Nuevos:** `src/lib/format.js` (mapa lenguaje→formateador: `prettier`, `rustfmt`,
  `black`, `gofmt`; ejecuta vía `run_command` sobre un temporal o stdin, o usa
  `textDocument/formatting` de A1 si disponible).
- **Tocar:** comando "Formatear documento" (Shift+Alt+F), Ajustes (`formatOnSave: bool`),
  `editorStore.saveTab` (formatear antes de escribir si está activo).
- **Aceptación:** Shift+Alt+F formatea el archivo activo; con format-on-save el guardado
  aplica el formateador correcto por lenguaje; si no está instalado, avisa sin romper.

---

# M5 — Ergonomía restante (parity VSCode)  (D3, D4, D5 ✅ · D2 ⏳)

> **Hecho (2026-07-12):** D3 vista previa Markdown/HTML (`editor/Preview.jsx`,
> split junto al editor, en vivo vía `editorStore.docVersion`; iframe sandbox para
> HTML). D4 bienvenida + recientes (`sections/Workspace/Welcome.jsx`,
> `appStore.recentFolders`). D5 editor de atajos (`sections/Settings/Keybindings.jsx`
> + overrides persistidos en `keymap.js`: `setBinding/resetBindings/loadKeymap`).
> Build OK. **Pendiente D2** (editores divididos): refactor grande de `editorStore`
> (de una `activePath` global a grupos) — dejado aparte por su tamaño/riesgo.

## D2 · Editores divididos / grupos
- **Objetivo:** ver 2+ archivos lado a lado. Es el cambio de arquitectura de UI más
  grande de este milestone: `editorStore` pasa de una `activePath` global a **grupos**
  (cada grupo con sus tabs y su `activePath`); `CodeMirrorHost` monta una vista por grupo.
- **Tocar:** `editorStore.js` (modelo de grupos; preservar el caché de estados por
  path compartido entre grupos), `AppShell.jsx`/`EditorTabs.jsx` (layout split),
  comandos "Dividir a la derecha/abajo".
- **Aceptación:** arrastrar/comando divide el editor; edición independiente por grupo;
  el mismo archivo en dos grupos comparte contenido.
- **Riesgo:** el patrón actual de "una sola EditorView viva" hay que generalizarlo a N
  vistas → refactor cuidadoso de `registerEditorView`/`liveView`.

## D3 · Vista previa Markdown/HTML
- **Nuevos:** `src/editor/Preview.jsx` (Markdown con `react-markdown` ya presente;
  HTML en `<iframe sandbox>`), botón/atajo "Abrir vista previa al lado".
- **Tocar:** `EditorTabs`/comando; scroll-sync opcional.
- **Deps/Rust:** ninguno. **Aceptación:** `.md` muestra preview en vivo al lado;
  `.html` se renderiza aislado.

## D4 · Bienvenida + proyectos recientes + multi-root
- **Nuevos:** `src/sections/Welcome/Welcome.jsx` (recientes, abrir carpeta, clonar),
  lista de recientes en plugin-store.
- **Multi-root (opcional, mayor esfuerzo):** `WorkspaceRoot` en Rust pasa de una ruta a
  un conjunto de raíces con validación por raíz; el FileTree muestra varias raíces.
- **Tocar:** `appStore` (`recentFolders`, multi-root), `FileTree.jsx`, `TitleBar`.
- **Aceptación:** al abrir sin carpeta se ve Bienvenida con recientes; reabrir uno
  restaura el workspace. (Multi-root si se decide asumir el refactor del sandbox.)

## D5 · Ajustes por workspace + editor de atajos
- **Nuevos:** lectura de `.lixbon/settings.json` (sobrescribe los globales por
  workspace), `src/sections/Settings/Keybindings.jsx` (editar el mapa de M0/D1,
  persistido; detecta colisiones).
- **Tocar:** `settings.js`/`appStore` (fusión global←workspace), `keymap.js` (cargar
  overrides), Ajustes.
- **Aceptación:** un `.lixbon/settings.json` en el repo cambia tabSize/formatOnSave solo
  ahí; el editor de atajos rebindea un comando y persiste.

---

## Resumen de artefactos por milestone (para taggear Rust)

| M | Comandos Rust nuevos | Deps npm | Deps Cargo | Endpoints gateway |
|---|----------------------|----------|------------|-------------------|
| M0 | — | — | — | — |
| M1 | — (usa `run_command`) | — | — | — |
| M2 | `index_build/search/status/clear` | — | `rusqlite`* | `/api/fim`, `/api/embed` |
| M3 | `git_diff/log/show/blame/branches/checkout/merge/stash/conflicts` | — | — | — |
| M4 | `lsp_start/request/stop` | `@codemirror/lint` | `serde_json`(±`lsp-types`,`tree-sitter`) | — |
| M5 | multi-root en `WorkspaceRoot`* | — | — | — |

*opcionales según decisión de diseño.

> Cada milestone que toque `src-tauri/` **debe cerrar con un tag** `vX.Y.Z` (3 versiones
> sincronizadas) para que el CI compile y valide los comandos Rust nuevos, con tests del
> parser (git) y de los guards de ruta (índice/LSP) incluidos.
