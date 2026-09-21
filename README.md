<div align="center">

<img src="assets/brand/icon-192.png" width="72" alt="lixbon">

# lixbon

**Modelos LLM auto-hospedados sobre un clúster GPU distribuido, con API compatible con OpenAI y clientes web, escritorio, CLI y móvil.**

[Arquitectura](docs/ARQUITECTURA.md) · [Ramas y releases](docs/RAMAS_Y_RELEASES.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md) · [Toda la documentación](docs/README.md)

</div>

---

## Índice

1. [Qué es lixbon](#qué-es-lixbon)
2. [Productos y ramas](#productos-y-ramas)
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
- **Control remoto**: una sesión del CLI o del desktop se puede seguir y dirigir desde el móvil (`/remote`).

## Productos y ramas

Monorepo con una rama larga por producto. Todas contienen el árbol completo;
la rama es *dónde se trabaja*, y se integra a `master` por PR.

| Producto | Carpeta | Stack | Rama | Versión | Release |
|---|---|---|---|---|---|
| **Gateway** + node agent | `core/`, `BD/`, `infra/` | Python 3.12 · FastAPI · SQLAlchemy · Postgres · Redis | `master` | — | Railway despliega cada push a `master` |
| **Web** — lixbon.com | `apps/web` | React 19 · Vite · SSR estático | `master` | — | Dentro de la imagen del gateway |
| **Desktop** — Windows | `apps/desktop` | Tauri 2 · Rust · React | `desktop` | 1.2.0 | Tag `desktop-vX.Y.Z` → CI → MSI con auto-update |
| **CLI** | `apps/cli` | Python 3, sin dependencias | `cli` | 2.3.0 | `build.py` → un solo archivo servido por el gateway |
| **Móvil** — Android | `apps/mobile` | React Native · Expo | `mobile` | 0.3.4 | Tag `mobile-vX.Y.Z` → CI → APK |

```
master ─┬─ desktop   (apps/desktop)  ─► PR a master
        ├─ cli       (apps/cli)      ─► PR a master
        └─ mobile    (apps/mobile)   ─► PR a master
```

Detalle del flujo, convención de commits y pasos de release: [`docs/RAMAS_Y_RELEASES.md`](docs/RAMAS_Y_RELEASES.md).

## Estructura del repositorio

```
.
├── core/                gateway y todo lo que corre en servidor
│   ├── gateway/         app FastAPI, routers/, email, hubs de remote y team
│   ├── inference/       cliente Ollama, roles rol→modelo, contexto, websearch
│   ├── orchestration/   selección de nodo, circuit breaker, enlace WebSocket con nodos
│   ├── node_agent/      proceso que corre en cada GPU
│   ├── billing/         planes, cuotas, créditos, Stripe
│   ├── persistence/     modelos SQLAlchemy y queries
│   └── security/        auth, API keys, rate limit
├── BD/                  schema.sql, migraciones Alembic, seeds, scripts de BD
├── infra/
│   ├── node/            Docker e instaladores del nodo GPU
│   ├── scripts/         lanzadores locales (lixbon.bat / lixbon.sh)
│   └── ops/             herramientas de operación en producción
├── apps/
│   ├── web/             lixbon.com
│   ├── desktop/         app de escritorio
│   ├── cli/             lixbon_cli/ (fuente) + client_cli.py (artefacto)
│   └── mobile/          app Android
├── assets/brand/        iconos y favicon oficiales
├── docs/                documentación técnica y de producto
├── .github/             ci.yml, tauri.yml, mobile.yml, plantilla de PR
├── Dockerfile           imagen del gateway (compila la web e incluye el CLI)
├── railway.toml         despliegue
├── alembic.ini          migraciones → BD/migrations
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
git clone https://github.com/gabriel-DgMr/Lixbon.git && cd Lixbon
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
| `BREVO_API_KEY`, `EMAIL_FROM` | Correos de verificación y recuperación |
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
```

## Tests

```bash
python -m pytest core             # gateway — los tests viven junto al módulo que prueban
python -m pytest apps/cli/tests   # CLI — incluye la verificación de que client_cli.py está al día
cd apps/web && npm run lint       # web
```

`ci.yml` corre los tests del CLI en cada PR a `master`. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Despliegue

`railway.toml` → `Dockerfile` multi-stage: Node compila `apps/web`, y la
imagen final de Python 3.12 lleva `core/`, `BD/`, `infra/node/`, el `dist` de
la web y `apps/cli/client_cli.py`. Uvicorn arranca con `--proxy-headers`
porque Railway/Cloudflare terminan TLS fuera. Health check en `/health`.

Migraciones: `alembic upgrade head` (usa `DATABASE_URL`).

## Documentación

| | |
|---|---|
| [`docs/README.md`](docs/README.md) | Índice completo |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Componentes, routers, nodos, contratos gateway↔apps |
| [`docs/RAMAS_Y_RELEASES.md`](docs/RAMAS_Y_RELEASES.md) | Flujo de ramas y cómo publicar cada producto |
| [`docs/LIMITES_DE_USO.md`](docs/LIMITES_DE_USO.md) | Modelo de límites sesión + semanal |
| [`docs/CUELLO_DE_BOTELLA_MODELOS.md`](docs/CUELLO_DE_BOTELLA_MODELOS.md) | Por qué hay un modelo por rol |
| [`docs/DISENO_WEB.md`](docs/DISENO_WEB.md) | Identidad visual y tokens |
| [`docs/PLAN_REMOTE.md`](docs/PLAN_REMOTE.md) | Protocolo `/remote` |
| [`docs/ESTADO_ACTUAL.md`](docs/ESTADO_ACTUAL.md) | Estado del proyecto para retomar el trabajo |
| [`PRODUCT.md`](PRODUCT.md) | Brief de producto y principios de diseño |
