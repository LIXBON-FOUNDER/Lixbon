# lixbon Desktop

IDE de escritorio (Windows) en **Tauri 2 + React** cuyo centro es el agente.
Cuatro modos sobre un mismo shell: **Agente** (conversación a pantalla completa
y los cambios que hace), **Editor** (archivos, CodeMirror 6, terminal y agente
al lado), **Diseño** (vista previa del servidor de desarrollo con emulación de
móvil, tablet y escritorio) y **Git** (cambios, commit, diff y pull request).
Tema oscuro único: jerarquía por rellenos y por la elevación del panel con
foco, sin bordes ni sombras, radio de 7px. Ajustes (perfil, claves, uso y
límites, agente, editor, índice, atajos) es una página a pantalla completa;
**Ctrl+I** en el editor reescribe la selección con el modelo y deja el cambio
para aceptar o rechazar; los servidores **MCP** (`.lixbon/mcp.json`, igual que
el CLI) añaden herramientas al agente.

Lo que cambia el agente se revisa en el propio editor, por bloques, contra el
archivo anterior a su primera edición (`editor/agentReview.js`,
`store/reviewStore.js`). Puede haber **varios agentes a la vez**: cada
conversación abierta es un store propio (`useSessionsStore` en
`store/chatStore.js`) y `useChatStore` apunta a la activa. Los permisos del
agente van por tipo de herramienta (permitir, preguntar o nunca).

- **Problemas**: no hay servidor de lenguaje; se ejecuta el comprobador del
  proyecto (`tsc`, `cargo check` o `ruff`, según `tsconfig.json`, `Cargo.toml`
  o `pyproject.toml`) al guardar y al terminar un turno del agente
  (`store/problemsStore.js`).
- **GitHub**: pull requests, checks, revisiones y fusión a través de la CLI
  `gh` y su sesión; el IDE no guarda tokens de GitHub. Sin `gh`, solo se ve el
  PR de la rama con la API pública.
- **Inspector del modo Diseño**: `src-tauri/src/preview_proxy.rs` sirve el
  servidor de desarrollo local desde 127.0.0.1 e inyecta `inspector.js`, que
  describe elementos y capas por `postMessage`. Solo acepta destinos
  `http://localhost`.

Rama de trabajo: **`desktop`** (ver `docs/RAMAS_Y_RELEASES.md`).

> Historia: esta carpeta reemplazó a **Lixbon IDE** (`Gabriel-Dmrl/lixbon-IDE`,
> descontinuada) a partir de la v1.1.0. El pipeline publica bajo el producto
> `desktop` de la página de aplicaciones.

## Filosofía de compilación

Igual que el móvil: **el binario compila solo en CI**. En local basta Node
para el frontend; el Rust de `src-tauri/` lo compila el runner de Windows en
`.github/workflows/tauri.yml`. Si quieres compilar en local necesitas Rust
estable y los prerequisitos de Tauri 2 para Windows.

## Desarrollo local

Requiere Node 22 o posterior (`.nvmrc`); compruébalo con `node -v`. Con Node 20 las pruebas (`npm test`) fallan por jsdom/undici (`webidl.util.markAsUncloneable is not a function`).

```bash
cd apps/desktop
npm install
npm run dev              # solo frontend en http://localhost:1420 (API nativa simulada)
npm run tauri dev        # ventana nativa (requiere Rust)
```

La app apunta por defecto a `https://lixbon.com` (`src/lib/settings.js`,
`DEFAULT_SERVER_URL`); se puede cambiar desde Ajustes para trabajar contra un
gateway local en `:8000`. Inicio de sesión con email y contraseña, con el
navegador del sistema (`/ide/connect` + PKCE; la vuelta la recibe
`src-tauri/src/auth_loopback.rs` en 127.0.0.1) o con una API key `lixbon_sk_`.
Tras el primer inicio de sesión hay un recorrido de tres pasos (modelo,
autonomía del agente, carpeta).

En el navegador (`npm run dev` sin Tauri) `src/dev/tauriMock.js` simula los
comandos nativos con un proyecto de ejemplo en memoria, para trabajar la
interfaz sin compilar Rust, y responde las rutas del gateway que usan Ajustes
y el chat. `?auth` abre la pantalla de entrada y `?onboarding` el recorrido
inicial. No entra en el build de producción.

## Estructura

```
src/
  App.jsx, main.jsx      raíz
  layout/                AppShell, TitleBar, StatusBar, Panel (foco), Gutter (redimensionar), Collapse (plegar animado), AccountMenu
  modes/                 AgentMode, EditorMode, DesignMode, GitMode, SettingsPage, Onboarding, Welcome, ActivityRail
  sections/              Workspace, SourceControl, Search, Extensions, Settings, Auth
  chat/                  chat, panel lateral del agente, cambios de la sesión, aprobación, selector de modelo
  editor/                CodeEditor (CodeMirror 6), EditorArea (pestañas), InlineEdit (Ctrl+I), revisión del agente, diagnósticos, BottomDock (Terminal · Problemas · Salida)
  dev/                   simulación de la API de Tauri para el navegador
  commands/builtin.js    paleta de comandos
  store/                 estado por dominio (app, workbench, fileView = pestañas, chat + sesiones, review, problems, output, usage, git, team, remote, terminal, index, mcp)
  lib/                   api.js, stream.js, agent*.js, tauri.js, settings.js, keymap.js, theme.js …
  styles/                CSS con los tokens de la web
src-tauri/
  src/lib.rs, main.rs    comandos nativos
  src/mcp.rs             procesos de servidores MCP por stdio
  src/auth_loopback.rs   vuelta del navegador en el inicio de sesión
  src/preview_proxy.rs   proxy de la vista previa + inspector.js (modo Diseño)
  tauri.conf.json        versión, ventana, updater (endpoint /api/updates/manifest/stable)
  capabilities/          permisos de plugins (opener, store, updater, process, notification, dialog)
  icons/                 generados desde assets/brand/icon-1024.png con `tauri icon`
```

## Release

1. Subir la versión en **`src-tauri/tauri.conf.json`** y en `package.json`
   (deben coincidir; la de `tauri.conf.json` es la que estampa el MSI).
2. PR de `desktop` a `master`.
3. `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`.

El CI compila el MSI, crea un release borrador en GitHub y lo sube a
`POST /api/versions/upload` (producto `desktop`). Falla si el tag no coincide
con `tauri.conf.json`. Un sufijo `-beta`/`-rc` lo publica en el canal beta.
La app instalada se actualiza sola vía `tauri-plugin-updater`.

Secrets necesarios en el repo: `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `LIXBON_ADMIN_TOKEN`; variable opcional
`LIXBON_SERVER_URL`.

## Compilar el host (src-tauri)

1. Rust 1.87 o superior (`rustup` estable). En Windows, toolchain MSVC y Build Tools de Visual Studio.
2. Generar el sidecar `lxo` (ignorado por git) antes de `cargo test`: `npm run build:lxo` (ejecuta `node scripts/build-lxo.mjs`). Sin él, el build de Tauri falla porque no encuentra `binaries/lxo-<target>`.
3. `cd src-tauri && cargo test`

En una copia limpia (worktree recién creado o `git clean`), `npm run build:lxo` es obligatorio antes del primer `cargo test`: en Windows falta `src-tauri/binaries/lxo-x86_64-pc-windows-msvc.exe` y la compilación del host falla hasta generarlo.

## E2E de `lxo events` contra el Core HTTP real

En Windows, desde `apps/desktop`, instala y construye el sidecar y el frontend que requiere `tauri-build`; luego ejecuta la prueba ignorada con el binario compilado:

```powershell
npm ci
npm run build:lxo
npm run build
$env:LXO_BIN = (Resolve-Path .\src-tauri\binaries\lxo-x86_64-pc-windows-msvc.exe).Path
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml orch::events_read_tests::lxo_bin_e2e_events_empty_history_pagination_and_follow_resume_no_duplicates -- --ignored --exact --nocapture
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml orch::events_read_tests::lxo_bin_e2e_attention_question_appears_and_reply_resolves_it -- --ignored --exact --nocapture
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml orch::projects_overview_tests::lxo_bin_e2e_projects_person_real_store -- --ignored --exact --nocapture
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml orch::projects_overview_tests::lxo_bin_e2e_tasks_person_real_store -- --ignored --exact --nocapture
```

El test arranca el servidor HTTP del Core dentro del harness y usa una credencial Agent de fixture. `lxo` recibe un `USERPROFILE` temporal y solo lee el `orch.json` y los cursores de esa carpeta; no utiliza el home ni las credenciales del usuario. La prueba cubre cursor vacío en el head actual, history, paginación y reanudación de `--follow` tras reiniciar el proceso, sin secuencias duplicadas. La segunda (`lxo attention`, LXO-105) cubre el estado vacío, la pregunta de una hija que aparece en su inbox, la respuesta externa que la saca de las activas y el detalle resuelto. CI ejecuta todas en Windows desde `.github/workflows/ci.yml`.

La tercera (`lxo projects`, LXO-103) entra como **persona**: el Core aprovisiona la credencial CLI en el almacén seguro real del sistema (como al abrir Lixbon), con un `installation_id` aleatorio, y la borra al terminar. Cubre 0 y N proyectos, archivados, filtro de máquina, que el JSON de `lxo` es el overview del Core sin tocar y los códigos de salida de filtro inválido (2), agente (3) y Core caído (5). La cuarta (`lxo tasks` y `lxo task show`, LXO-104 y LXO-38) usa el mismo arranque como persona y lee `tasks_by_project`, `task_detail` y `activity_list`: árbol raíz → hija con worktree que falla e hija en checkout compartido, más una raíz sin proyecto que se cuenta y no se lista; cubre filtros, JSON sin el encargo, detalle con la Activity traducida, tarea inexistente o sin proyecto (6), agente (3) y Core caído (5). La quinta (`lxo summary`, LXO-106) usa el mismo arranque: vacío y con trabajo y Attention. Comprueba que la salida solo cuenta (sin nombres, títulos ni ids) y que con Lixbon cerrado responde 5 enseguida. La sexta (`lxo attempts --task` y `lxo attempt show`, LXO-124, en `orch/model_read_tests.rs`) usa el mismo arranque contra un Core **cortado** (la fixture de la ADR, más una Task sin intentos y otra con dos): antes del corte sale con 4; después cubre 0/1/N intentos, filtros de estado y proveedor, la ficha con sesión, worktree, artifacts y revisión, intento inexistente (6), el id de una Task en `attempt show` (2), el aviso de compatibilidad de `lxo tasks` y `lxo task show`, agente (3) y Core caído (5).


## Entorno del worktree de una tarea del orquestador

Un worktree nuevo es un checkout limpio: no trae `node_modules` ni `.env`. El repo declara qué llevarse y el host lo hace al crear la hija, sin ejecutar nada suyo. Las reglas se leen del checkout principal y solo valen para rutas **relativas, existentes e ignoradas por git** (nada absoluto, con `..`, con `.git` ni con comodines).

- `.lixbon/worktree.json`: `{"sharedDirectories": ["node_modules"]}`. Esos directorios se **enlazan** (junction en Windows, symlink en el resto): comparten los archivos con el repo.
- `.worktreeinclude`: una ruta por línea (`#` comenta), p. ej. `.env`. Se **copian** y cada worktree tiene los suyos (tope de 2 GiB y 50 000 entradas).

La aprobación del lanzamiento muestra qué se enlazará y qué se copiará, y solo se aplica lo que se vio; la actividad de la tarea cuenta lo que se hizo y lo que se omitió con su motivo. Los enlaces no cuentan como cambios de la tarea. Al borrar el worktree se quitan primero: sin eso, `git worktree remove --force` atraviesa el enlace y borra el original del repo (comprobado en las pruebas). No hay script de setup: ejecutar comandos del repo al crear un worktree necesita su propia aprobación y queda para más adelante.

Inspirado en `.worktreeinclude` y `worktree.sharedDirectories` de [Orca](https://github.com/stablyai/orca) (MIT).
