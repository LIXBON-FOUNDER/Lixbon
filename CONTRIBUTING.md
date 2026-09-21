# Contribuir a lixbon

Gracias por querer aportar. Esta guía cubre cómo montar el entorno, en qué
rama trabajar, cómo escribir commits y qué tiene que cumplir un PR.

## 1. Elige la rama según lo que vas a tocar

| Vas a cambiar… | Trabaja en | Y luego |
|---|---|---|
| `core/`, `BD/`, `infra/`, `apps/web/`, docs generales | `master` (o rama corta desde `master`) | PR a `master` |
| `apps/desktop/**` | `desktop` | PR `desktop` → `master` |
| `apps/cli/**` | `cli` | PR `cli` → `master` |
| `apps/mobile/**` | `mobile` | PR `mobile` → `master` |

```bash
git checkout cli && git pull
git merge master              # traer lo último del gateway antes de empezar
git checkout -b cli/mi-cambio # opcional: rama corta para cambios grandes
```

Siempre **merge**, nunca rebase, sobre `desktop`/`cli`/`mobile`: son ramas
compartidas. Detalle en [`docs/RAMAS_Y_RELEASES.md`](docs/RAMAS_Y_RELEASES.md).

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
cd apps/cli && python -m lixbon_cli chat       # fuente modular
python apps/cli/build.py                       # regenera client_cli.py — OBLIGATORIO tras editar lixbon_cli/
```

### Móvil
```bash
cd apps/mobile && npm install && npx expo start   # Expo Go en el teléfono
```

## 3. Estilo

- **Idioma**: español en código de UI, docs, commits y mensajes de error.
- **Comentarios**: solo para decisiones no evidentes, workarounds, límites de una
  API o reglas de negocio. Nada de comentarios que repitan el código
  (`.claude/claude.md`).
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
- **ámbito**: `gateway` `web` `desktop` `cli` `mobile` `agent` `billing` `bd` `infra` `repo`

Ejemplos: `fix(billing): activa el gate de sesión/semana`,
`feat(cli): cliente MCP por stdio`, `docs(repo): índice de documentación`.

## 5. Antes de abrir el PR

- [ ] `python -m pytest core` si tocaste el gateway.
- [ ] `python -m pytest apps/cli/tests` y `python apps/cli/build.py` si tocaste el CLI
      (`test_build_fresh` falla si el artefacto no está regenerado).
- [ ] Si cambias un **contrato gateway↔app** (nombre de API key, SSE, `/remote`,
      subida de instaladores, detección de archivos visuales — tabla en
      `docs/ARQUITECTURA.md`), el PR toca ambos lados o enlaza el PR pareja.
- [ ] Si añades una variable de entorno, documéntala en `.env.example`.
- [ ] Si cambias estructura de carpetas o comandos, actualiza el README afectado.
- [ ] Rellena la plantilla de PR (`.github/pull_request_template.md`).

`ci.yml` corre los tests del CLI automáticamente en cada PR a `master`.

## 6. Publicar una versión

Solo mantenedores. Pasos por producto en
[`docs/RAMAS_Y_RELEASES.md`](docs/RAMAS_Y_RELEASES.md#releases-por-producto):
`desktop-vX.Y.Z` y `mobile-vX.Y.Z` disparan el CI; el CLI se publica con el
siguiente deploy del gateway; gateway y web se despliegan con cada push a `master`.

## 7. Reportar bugs y proponer funciones

Abre un issue con: producto afectado (web / desktop / cli / mobile / gateway),
versión, pasos para reproducir y qué esperabas. Para vulnerabilidades **no
abras un issue**: sigue [`SECURITY.md`](SECURITY.md).
