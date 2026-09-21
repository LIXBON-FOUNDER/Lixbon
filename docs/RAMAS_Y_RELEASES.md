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

### Móvil (`mobile-vX.Y.Z`)
1. Subir `version` en `apps/mobile/package.json` (única fuente; `app.config.js` la lee).
2. Merge a `master`.
3. `git tag mobile-v0.3.5 && git push origin mobile-v0.3.5`.
4. `.github/workflows/mobile.yml` hace `expo prebuild`, compila el APK, publica
   release borrador y lo sube a `/api/versions/upload` (producto `android`).

## CI

| Workflow | Disparador | Qué hace |
|---|---|---|
| `ci.yml` | PR a `master`, push a `master`/`cli` | Tests del CLI (`apps/cli/tests`) |
| `tauri.yml` | tag `desktop-v*`, manual | Build + release del MSI |
| `mobile.yml` | tag `mobile-v*`, manual | Build + release del APK |

Los tests del gateway (`python -m pytest core`) se ejecutan en local por ahora:
varios módulos comparten estado de BD y fallan al correr juntos; cuando eso se
aísle se añaden a `ci.yml`.

## Protección de ramas (recomendado en GitHub → Settings → Branches)

- `master`: exigir PR, exigir que `ci.yml` pase, prohibir force-push.
- `desktop`, `cli`, `mobile`: prohibir force-push (son ramas compartidas).
