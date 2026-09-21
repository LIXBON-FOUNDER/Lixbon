# lixbon Desktop

App de escritorio (Windows) en **Tauri 2 + React**: workspace con explorador
de archivos, git y GitHub, terminal, equipos (Lixbon Team) y chat/agente con
los modelos del clúster. Misma identidad visual que la web (tokens de
`docs/DISENO_WEB.md`).

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
npm run dev              # solo frontend en http://localhost:1420
npm run tauri dev        # ventana nativa (requiere Rust)
```

La app apunta por defecto a `https://lixbon.com` (`src/lib/settings.js`,
`DEFAULT_SERVER_URL`); se puede cambiar desde Ajustes para trabajar contra un
gateway local en `:8000`. Inicio de sesión con la cuenta web (`/ide/connect`)
o con una API key `lixbon_sk_`.

## Estructura

```
src/
  App.jsx, main.jsx      raíz
  layout/                AppShell, Sidebar, TitleBar, BottomPanel, AccountMenu
  sections/              Workspace, SourceControl, Search, Outline, Problems, Extensions, Settings, Auth
  chat/                  panel de chat, mensajes, aprobación de herramientas, selector de modelo
  editor/                TerminalPanel
  commands/builtin.js    paleta de comandos
  store/                 estado por dominio (app, chat, git, team, remote, terminal, index, ext, fileView)
  lib/                   api.js, stream.js, agent*.js, tauri.js, settings.js, keymap.js, theme.js …
  styles/                CSS con los tokens de la web
src-tauri/
  src/lib.rs, main.rs    comandos nativos
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
