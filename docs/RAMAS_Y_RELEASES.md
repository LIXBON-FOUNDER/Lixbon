# Ramas, flujo de trabajo y releases

## Modelo de ramas

El repositorio es un monorepo con **una rama larga por producto**. Todas
contienen el árbol completo (así el Dockerfile, los tests y las rutas de CI
funcionan igual en cualquiera), pero cada una es el sitio donde se trabaja un
producto concreto.

```
master  ── gateway + web (core/, BD/, infra/, apps/web). Es lo que despliega Railway.
  ├── desktop ── apps/desktop
  ├── cli     ── apps/cli
  └── mobile  ── apps/mobile
```

| Rama | Qué se toca aquí | Se integra a `master` |
|---|---|---|
| `master` | `core/`, `BD/`, `infra/`, `apps/web/`, docs, CI | — (es la rama principal) |
| `desktop` | `apps/desktop/**` | por PR |
| `cli` | `apps/cli/**` | por PR |
| `mobile` | `apps/mobile/**` | por PR |

Reglas:

1. **Un cambio de producto nace en su rama** (`desktop`, `cli`, `mobile`) o en
   una rama corta que parte de ella (`desktop/feat-git-panel`). Cuando está
   listo se abre PR contra `master`.
2. **Cambios de gateway/web van directo a `master`** (o rama corta desde `master`
   + PR). Un cambio de contrato de API que afecte a una app se hace en `master`
   primero y luego se sincroniza la rama de la app (paso 3).
3. **Mantener las ramas de producto al día**: tras cada merge a `master`,
   `git checkout desktop && git merge master` (igual para `cli` y `mobile`).
   Merge, no rebase: las ramas son públicas y compartidas.
4. `master` debe estar siempre desplegable: Railway construye cada push.

## Comandos habituales

```bash
# Empezar trabajo en el desktop
git checkout desktop && git pull
git merge master                     # traer lo último del gateway
# ... commits ...
git push
gh pr create --base master --head desktop --title "feat(desktop): ..."

# Rama corta para algo grande
git checkout -b cli/mcp-http cli
# ... al terminar: PR contra cli (o contra master si ya está estable)
```

## Convención de commits

`tipo(ámbito): resumen en español, en presente`

- tipos: `feat`, `fix`, `refactor`, `docs`, `chore`, `ci`, `test`
- ámbitos: `gateway`, `web`, `desktop`, `cli`, `mobile`, `agent`, `billing`, `bd`, `infra`

Ejemplos reales del historial: `fix(billing): activa el gate de sesion/semana`,
`feat(desktop): revive release pipeline`.

## Releases por producto

Los tags llevan prefijo de producto para que los workflows no se pisen.

### Gateway + web
No hay tag: cada push a `master` despliega en Railway (`railway.toml` → `Dockerfile`).
La imagen compila `apps/web` y copia `apps/cli/client_cli.py`, por eso la web y
el artefacto del CLI viven en `master`.

### Desktop (`desktop-vX.Y.Z`)
1. Subir la versión en **`apps/desktop/src-tauri/tauri.conf.json`** y `apps/desktop/package.json` (deben coincidir).
2. Merge a `master` por PR.
3. `git tag desktop-v1.2.0 && git push origin desktop-v1.2.0`.
4. `.github/workflows/tauri.yml` compila el MSI en Windows, crea un release
   borrador y lo sube a `POST /api/versions/upload` (producto `desktop`).
   El CI falla si el tag no coincide con `tauri.conf.json`. Sufijo `-beta`/`-rc`
   → canal beta.

### CLI (sin tag)
1. Subir `CLI_VERSION` en `apps/cli/lixbon_cli/config.py`.
2. `python apps/cli/build.py` regenera `apps/cli/client_cli.py` (el test
   `test_build_fresh` falla si se olvida).
3. Merge a `master`: el siguiente deploy del gateway sirve la nueva versión en
   `/install/client_cli.py`; los clientes la reciben con `lixbon update` o `/update`.

### CLI Go (`cli-vX.Y.Z`)
1. Escribir las notas de la versión en `apps/cli/go/CHANGELOG.md`: una sección `## <versión>` con viñetas (`- …`) en español, pensadas para quien usa el CLI. Sin esa sección la release falla antes de compilar.
2. Merge a `master` por PR.
3. `git tag cli-v2.4.0 && git push origin cli-v2.4.0`. La versión sale de la etiqueta: no hay constante que subir. **La etapa también:** sin sufijo (`cli-v2.4.0`) es *estable*; con sufijo (`cli-v2.4.0-beta.1`, `cli-v2.3.0-go.2`) es *beta*.
4. `.github/workflows/release-cli.yml`:
   - `preparar`: valida la etiqueta, decide la etapa y comprueba que existan las notas.
   - `build`: inyecta la versión con `-ldflags "-X …config.Version"`, falla si `lixbon --version` no informa exactamente esa versión, ejecuta `go test` y compila seis binarios (linux, darwin y windows en amd64 y arm64, sin CGO).
   - `release`: genera `SHA256SUMS` y publica la release con las notas del CHANGELOG; solo las betas se marcan *prerelease*.
   - `registrar`: guarda en el gateway la URL, el SHA-256, la etapa (`channel`) y las notas (`changelog`) de cada binario.
   - `smoke`: instala desde `lixbon.com` en Linux, macOS y Windows y comprueba la versión que sirven los instaladores.

Una compilación local (`go build`) informa `0.0.0-dev` y `lixbon update` no la toca.

**Qué sirve el gateway.** `GET /api/updates/cli/stable` devuelve la última estable; `GET /api/updates/cli/beta`, la más nueva entre beta y estable (el orden es semver, `go.10` > `go.9`). `lixbon update` elige el canal por la versión instalada: sin sufijo sigue `stable`; con sufijo, `beta`. `/install.sh` e `/install.ps1` sirven la última estable y, mientras no haya ninguna, la última beta. La página `/apps` lee `GET /api/versions` y muestra la etapa, las notas y el historial de cada versión. Diseño en `.planning/DECISION-UPDATE-GO.md`; primera ejecución: `cli-v2.3.0-go.0` (beta, 2026-10-07).

Para corregir las notas de una versión ya publicada, vuelve a registrarla (`POST /api/versions/register` actualiza la fila de cada plataforma por producto y versión).

### Móvil (`mobile-vX.Y.Z`)
1. Subir `version` en `apps/mobile/package.json` (única fuente; `app.config.js` la lee).
2. Merge a `master`.
3. `git tag mobile-v0.3.5 && git push origin mobile-v0.3.5`.
4. `.github/workflows/mobile.yml` hace `expo prebuild`, compila el APK, publica
   release borrador y lo sube a `/api/versions/upload` (producto `android`).

## CI

| Workflow | Disparador | Qué hace |
|---|---|---|
| `ci.yml` | PR a `master`, push a `master`/`cli` | Tests del CLI Python (`apps/cli/tests`), del CLI Go y de los instaladores (`infra/ci/install_e2e.py`: ejecuta `install.sh`/`install.ps1` reales en Linux, macOS y Windows contra un servidor de releases local, con digest alterado, `SHA256SUMS` alterado y actualización con el binario en uso) |
| `tauri.yml` | tag `desktop-v*`, manual | Build + release del MSI |
| `mobile.yml` | tag `mobile-v*`, manual | Build + release del APK |
| `release-cli.yml` | tag `cli-v*` | Binarios del CLI Go por plataforma + `SHA256SUMS` + registro en el gateway + smoke test: instala desde `lixbon.com/install.sh` e `install.ps1` y comprueba la versión |

El job `Gateway · tests` de `ci.yml` ejecuta cada `core/gateway/test_*.py` en un proceso
aparte (`python infra/ci/gateway_tests.py`, SQLite temporal), porque los módulos fijan
`DATABASE_URL` al importarse y fallan al correr juntos. Cubre los 23 módulos del gateway,
incluidos `/api/updates/cli/*`, `/api/versions/register` y los instaladores. Siguen fuera
los tests de los demás paquetes de `core` (`billing`, `inference`, `delegation`,
`orchestration`, `persistence`, `node_agent`).

## Protección de ramas (recomendado en GitHub → Settings → Branches)

- `master`: exigir PR, exigir que `ci.yml` pase, prohibir force-push.
- `desktop`, `cli`, `mobile`: prohibir force-push (son ramas compartidas).
