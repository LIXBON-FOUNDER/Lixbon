# Contribuir a lixbon

Gracias por querer aportar. Esta guía cubre cómo montar el entorno, en qué
rama trabajar, cómo escribir commits y qué tiene que cumplir un PR.

## 1. Ramas

`master` es la única rama larga y está protegida: nadie hace push directo, todo
entra por PR con el CI en verde. Trabaja en una rama corta desde `master`:

```bash
git switch master && git pull
git switch -c usuario/lxo-123-resumen   # o fix/…, feat/…, chore/…
```

- Una rama por cambio; si la tarea tiene issue, su clave va en el nombre (`lxo-83`).
- Antes de pedir revisión, trae `master` a tu rama (`git merge master`).
- La rama se borra sola al mergear el PR.

## 2. Entorno por producto

### Gateway
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn core.gateway.app:app --port 8000 --reload   # desde la raíz
```

### Web
```bash
cd apps/web && npm install && npm run dev      # proxy a :8000
```

### Desktop
```bash
cd apps/desktop && npm install && npm run dev  # frontend; `npm run tauri dev` requiere Rust
```

### CLI
```bash
cd apps/cli && go vet ./... && go test -count=1 ./...   # CLI Go
```

Los JSON de `apps/cli/validation/fixtures/` son el contrato congelado del CLI: si un cambio de comportamiento los contradice, se actualiza el JSON a propósito en el mismo PR.

### Móvil
```bash
cd apps/mobile && npm install && npx expo start   # Expo Go en el teléfono
```

## 3. Estilo

- **Idioma**: español en código de UI, docs, commits y mensajes de error.
- **Comentarios**: solo para decisiones no evidentes, workarounds, límites de una
  API o reglas de negocio. Nada de comentarios que repitan el código ni JSDoc
  innecesario: prioriza nombres claros y buena estructura.
- **Agentes de IA**: la configuración de Claude Code, Cursor, Codex, etc.
  (`.claude/`, `CLAUDE.md`, `.agents/`, `.mcp.json`…) es personal y está en
  `.gitignore`; no la subas al repo.
- **Formato**: `.editorconfig` fija indentación y finales de línea por lenguaje.
- **Diseño**: los tokens de `apps/web/src/styles/base.css` son la fuente de
  verdad; desktop y móvil los copian. Nada de temas oscuros con gradientes ni
  glassmorphism (`PRODUCT.md`).
- **Python**: tests junto al módulo (`core/x/test_y.py`); nada de estado global
  nuevo sin pasar por `core/config.py`.
- **JS**: `npm run lint` en la web (oxlint) antes del PR.

## 4. Commits

```
tipo(ámbito): resumen en español, en presente
```

- **tipo**: `feat` `fix` `refactor` `docs` `chore` `ci` `test`
- **ámbito**: `gateway` `web` `desktop` `cli` `mobile` `agent` `billing` `db` `infra` `repo`

Ejemplos: `fix(billing): activa el gate de sesión/semana`,
`feat(cli): cliente MCP por stdio`, `docs(repo): índice de documentación`.

## 5. Antes de abrir el PR

- [ ] `python -m pytest core` si tocaste el gateway.
- [ ] `go vet ./... && go test -count=1 ./...` en `apps/cli` si tocaste el CLI.
- [ ] Si cambias un **contrato gateway↔app** (nombre de API key, SSE, `/remote`,
      subida de instaladores, detección de archivos visuales — tabla en
      `docs/ARQUITECTURA.md`), el PR toca ambos lados o enlaza el PR pareja.
- [ ] Si añades una variable de entorno, documéntala en `.env.example`.
- [ ] Si cambias estructura de carpetas o comandos, actualiza el README afectado.
- [ ] Rellena la plantilla de PR (`.github/pull_request_template.md`).

Para mergear a `master` tienen que pasar `Gateway · tests` y `CLI Go` (Linux y
Windows) de `ci.yml`. `desktop-ci.yml` solo corre si el PR toca `apps/desktop/`.

## 6. Publicar una versión

Solo mantenedores, siempre desde `master` ya mergeado:

| Producto | Pasos |
|---|---|
| Gateway y web | Se despliegan solos en Railway con cada push a `master` |
| CLI | Nota en `apps/cli/CHANGELOG.md` → `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`. `release-cli.yml` compila, sube los binarios a lixbon.com (R2) y los registra en el gateway. Un sufijo (`-beta.1`) la publica como beta |
| Desktop | Sube `version` en `apps/desktop/src-tauri/tauri.conf.json` → tag `desktop-vX.Y.Z`. `tauri.yml` sube MSI/DMG y el auto-update |
| Móvil | Sube `version` en `apps/mobile/package.json` (el CI lo comprueba) → tag `mobile-vX.Y.Z`. `mobile.yml` publica el APK |

Si una funcionalidad del desktop, CLI o móvil llama a una ruta nueva del
gateway, mergea primero el gateway: hasta que llega a `master` esa ruta da 404
en producción.

## 7. Reportar bugs y proponer funciones

Usa las plantillas de issue (bug o propuesta): producto afectado, versión,
pasos para reproducir y qué esperabas. Para vulnerabilidades **no abras un
issue**: sigue [`SECURITY.md`](SECURITY.md).
