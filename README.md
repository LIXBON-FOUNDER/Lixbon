<div align="center">

<img src="assets/brand/icon-192.png" width="72" alt="lixbon">

# LIXBON

**Modelos LLM auto-hospedados sobre un clúster GPU distribuido, con API compatible con OpenAI y clientes web, escritorio, CLI y móvil.**

[lixbon.com](https://lixbon.com) · [Arquitectura](docs/ARQUITECTURA.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md) · [Toda la documentación](docs/README.md)

</div>

---

## Índice

1. [Qué es lixbon](#qué-es-lixbon)
2. [Productos](#productos)
3. [Estructura del repositorio](#estructura-del-repositorio)
4. [Arranque rápido](#arranque-rápido)
5. [Añadir un nodo GPU](#añadir-un-nodo-gpu)
6. [Usar la API](#usar-la-api)
7. [Tests](#tests)
8. [Despliegue](#despliegue)
9. [Documentación](#documentación)

## Qué es lixbon

Un **gateway** central (FastAPI) recibe todas las peticiones, autentica al
usuario (cuenta web o API key `lixbon_sk_`), aplica los límites de su plan y
enruta la inferencia al mejor **nodo GPU** disponible. Cada nodo corre Ollama
detrás de un `node_agent` que se conecta al gateway por WebSocket saliente, así
que una GPU alquilada no necesita puerto entrante, túnel ni DNS.

- **API compatible con OpenAI** en `/v1`: funciona con cualquier SDK, n8n, LangChain…
- **Un modelo por rol de inferencia** (chat, autocompletado, visión, embeddings, router) resuelto por capability real de Ollama.
- **Límites por plan** con dos relojes: sesión de 5 h y cap semanal, compartidos entre todos los clientes.
- **Orquestación**: selección por CPU/RAM/GPU, circuit breaker con backoff, nodos por conexión inversa.
- **Cuatro clientes con la misma cuenta e historial**: web, desktop (Tauri), CLI (agente con herramientas y MCP) y Android.
- **Orquestador de agentes** en el desktop (`lxo`): reparte un objetivo entre agentes hijos por rol, con Event Log y almacén seguro locales.
- **Visuals y MCP**: diseños y piezas de marketing con versiones con nombre, editables en la web y creables desde cualquier agente (Claude Code, Cursor, VS Code, el CLI…) por el servidor MCP `lixbon.com/mcp`. Catálogo de skills oficiales (`/marketing-lxo`, `/adversary`) en `lixbon.com/skills`.
- **Control remoto**: una sesión del CLI o del desktop se puede seguir y dirigir desde el móvil (`/remote`).

## Productos

Monorepo: todo vive en `master`. Cada cambio se hace en una rama corta y entra
por PR; cada producto se publica con su propia etiqueta.

| Producto | Carpeta | Stack | Versión | Cómo se publica |
|---|---|---|---|---|
| **Gateway** + node agent | `core/`, `db/`, `infra/` | Python 3.12 · FastAPI · SQLAlchemy · Postgres · Redis | — | Railway despliega cada push a `master` |
| **Web** — lixbon.com | `apps/web` | React 19 · Vite · SSR estático | — | Dentro de la imagen del gateway |
| **Desktop** — Windows / macOS | `apps/desktop` | Tauri 2 · Rust · React | 2.0.29 | Tag `desktop-vX.Y.Z` → `tauri.yml` → MSI/DMG con auto-update |
| **CLI** | `apps/cli` | Go · un solo ejecutable | 2.8.0 | Tag `cli-vX.Y.Z` → `release-cli.yml` → binarios servidos desde lixbon.com (R2) y registrados en el gateway |
| **Móvil** — Android | `apps/mobile` | React Native · Expo | 0.6.1 | Tag `mobile-vX.Y.Z` → `mobile.yml` → APK |

Flujo de ramas, commits y releases: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Estructura del repositorio

```
.
├── core/                gateway y todo lo que corre en servidor
│   ├── gateway/         app FastAPI, routers/, email, hubs de remote y team
│   ├── inference/       cliente Ollama, roles rol→modelo, contexto, websearch
│   ├── orchestration/   selección de nodo, circuit breaker, enlace WebSocket con nodos
│   ├── node_agent/      proceso que corre en cada GPU
│   ├── delegation/      enrutado de tareas por embeddings
│   ├── billing/         planes, cuotas, créditos, Stripe
│   ├── persistence/     modelos SQLAlchemy y queries
│   ├── render/          worker que renderiza los Visuals
│   ├── storage/         almacenamiento de objetos (R2)
│   └── security/        auth, API keys, rate limit
├── db/                  schema.sql, migraciones Alembic y scripts de BD (reset, dump, backups)
├── infra/
│   ├── node/            Docker e instaladores del nodo GPU
│   ├── render_worker/   imagen y despliegue del worker de render
│   ├── ci/              pruebas que lanza el CI (gateway, instaladores)
│   ├── scripts/         lanzador local (lixbon.bat / lixbon.sh)
│   └── ops/             herramientas de operación en producción
├── apps/
│   ├── web/             lixbon.com
│   ├── desktop/         app de escritorio y orquestador de agentes
│   ├── cli/             CLI en Go · validation/ (corpus congelados) · audit/ (decisiones)
│   └── mobile/          app Android
├── contracts/           contratos compartidos entre Core, desktop, CLI y móvil
├── skills/              skills oficiales del catálogo (lixbon.com/skills)
├── assets/brand/        iconos y favicon oficiales
├── docs/                documentación técnica y de producto
├── .github/             workflows de CI y releases, plantillas de PR e issues
├── Dockerfile           imagen del gateway (compila la web)
├── railway.toml         despliegue
├── alembic.ini          migraciones → db/migrations
├── requirements.txt     dependencias del gateway
└── .env.example         todas las variables de entorno, documentadas
```

Cada app tiene su README:
[`apps/web`](apps/web/README.md) ·
[`apps/desktop`](apps/desktop/README.md) ·
[`apps/cli`](apps/cli/README.md) ·
[`apps/mobile`](apps/mobile/README.md)

## Arranque rápido

Requisitos: Python 3.12+, Node 20+, Ollama en local para inferencia sin nodos.

```bash
git clone https://github.com/LIXBON-FOUNDER/Lixbon.git && cd Lixbon
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # DATABASE_URL apunta a staging
```

```bash
# Terminal 1 — gateway (SIEMPRE desde la raíz: importa el paquete `core`)
python -m uvicorn core.gateway.app:app --port 8000 --reload

# Terminal 2 — web con proxy /api y /v1 → :8000
cd apps/web && npm install && npm run dev              # http://localhost:5173
```

| Comprobación | URL |
|---|---|
| Salud del gateway | `http://127.0.0.1:8000/health` |
| Ollama local | `http://127.0.0.1:11434/api/tags` |
| Estado público | `http://localhost:5173/status` |

Lanzador con menú (gateway + node agent + Ollama en LAN + túnel Cloudflare):
`infra/scripts/lixbon.bat` en Windows, `infra/scripts/lixbon.sh` en Linux/macOS.

### Variables de entorno más importantes

Todas están explicadas en [`.env.example`](.env.example). Las que hay que
rellenar sí o sí:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres (staging en desarrollo; Railway la inyecta en producción) |
| `REDIS_URL` | Rate limiting y sesiones; vacío = memoria |
| `OLLAMA_BASE_URL` | Ollama de respaldo cuando no hay nodos online |
| `MODEL_ROLE_CHAT` … `MODEL_ROLE_ROUTE` | Modelo por rol; vacío = autodetección por capability |
| `MODEL_NUM_CTX` | Ventana de contexto global |
| `ADMIN_TOKEN`, `ADMIN_EMAILS` | Acceso al panel admin y a `/api/versions/upload` |
| `NODE_SHARED_SECRET` | Autenticación gateway ↔ nodos |
| `BREVO_API_KEY`, `EMAIL_FROM`, `SUPPORT_INBOX` | Correos de verificación y recuperación; buzón del formulario de soporte |
| `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS` | URL pública y CORS |

## Añadir un nodo GPU

En la máquina con GPU, con un token generado en el panel admin (Nodos → Añadir GPU):

```bash
curl -fsSL https://lixbon.com/install-node.sh | LIXBON_ENROLL=<token> bash    # Linux
```

Deja Ollama + `node_agent` corriendo en modo conexión: el nodo abre un
WebSocket hacia el gateway y por ahí recibe las peticiones. Sin túnel ni
puertos. Para Windows, `$env:LIXBON_ENROLL="<token>"; irm https://lixbon.com/install-node.ps1 | iex`; para Docker,
`infra/node/Dockerfile`.

## Usar la API

```bash
curl https://lixbon.com/v1/chat/completions \
  -H "Authorization: Bearer lixbon_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.1:8b", "messages": [{"role": "user", "content": "Hola"}], "stream": true}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://lixbon.com/v1", api_key="lixbon_sk_...")
client.chat.completions.create(model="llama3.1:8b", messages=[{"role": "user", "content": "Hola"}])
```

Las API keys se crean desde la cuenta en la web. Los errores de plan (cuota
agotada, modelo no permitido) llegan en español con la fecha de reinicio.

### CLI

```bash
curl -fsSL https://lixbon.com/install.sh | bash     # Linux / macOS
irm https://lixbon.com/install.ps1 | iex             # Windows
lixbon setup && lixbon chat
lixbon update                                        # o lixbon --update; lixbon --version muestra la versión
```

Es un único ejecutable (no necesita Python). Los instaladores verifican su SHA-256 contra el gateway y contra el `SHA256SUMS` de la release; la página [lixbon.com/apps](https://lixbon.com/apps) muestra la etapa, las novedades y el historial de versiones, y la instalación manual con verificación. Las notas de cada versión se escriben en `apps/cli/CHANGELOG.md`.

## Tests

```bash
python infra/ci/gateway_tests.py  # gateway — un proceso por módulo, como en el CI
(cd apps/cli && go test ./...)    # CLI Go
python infra/ci/install_e2e.py    # instaladores install.sh / install.ps1 contra un servidor de releases local
(cd apps/desktop && npm test)     # desktop (vitest); el Core en Rust con `cargo test` en src-tauri
(cd apps/web && npm run lint)     # web
```

En cada PR a `master`, `ci.yml` corre los tests del gateway, del CLI Go (Linux,
macOS y Windows) y de los instaladores; `desktop-ci.yml` valida el desktop
cuando el PR toca `apps/desktop/`.

## Despliegue

`railway.toml` → `Dockerfile` multi-stage: Node compila `apps/web`, y la
imagen final de Python 3.12 lleva `core/`, `db/`, `infra/node/` y el `dist` de
la web. Uvicorn arranca con `--proxy-headers`
porque Railway/Cloudflare terminan TLS fuera. Health check en `/health`.

Migraciones: `alembic upgrade head` (usa `DATABASE_URL`).

## Documentación

| | |
|---|---|
| [`docs/README.md`](docs/README.md) | Índice completo |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Componentes, routers, nodos, contratos gateway↔apps |
| [`docs/RESUMEN_PROYECTO.md`](docs/RESUMEN_PROYECTO.md) | Resumen del proyecto y deuda conocida |
| [`docs/VOCABULARIO.md`](docs/VOCABULARIO.md) | Vocabulario canónico de estados |
| [`docs/core/`](docs/core/) | Core del orquestador: autoridad, eventos, migraciones, proyectos |
| [`docs/INCIDENTES.md`](docs/INCIDENTES.md) | Registro de incidentes en producción |
| [`PRODUCT.md`](PRODUCT.md) | Brief de producto y principios de diseño |

## Licencia

Código propietario. Todos los derechos reservados; ver [`LICENSE`](LICENSE).
