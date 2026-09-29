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
