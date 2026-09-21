# Arquitectura de lixbon

## Vista general

```
                     ┌──────────────────────────────────────────────┐
   apps/web ────────►│                                              │
   apps/desktop ────►│   Gateway (core/gateway, FastAPI, Railway)   │──► Postgres (BD/)
   apps/cli ────────►│   /v1 OpenAI-compatible · /api/* · /ws/*     │──► Redis (rate limit, cache)
   apps/mobile ─────►│                                              │──► R2 (adjuntos, releases)
   n8n / SDKs ──────►│                                              │──► Stripe · Brevo
                     └───────────────┬──────────────────────────────┘
                                     │ orquestación (core/orchestration)
               ┌─────────────────────┼─────────────────────┐
               ▼                     ▼                     ▼
        node_agent (GPU 1)    node_agent (GPU 2)    Ollama local (fallback dev)
        └─ Ollama             └─ Ollama
```

Todos los clientes hablan con el mismo gateway y comparten cuenta, API keys,
historial y límites. Ollama nunca se expone a internet: siempre hay un
`node_agent` delante.

## Componentes

### Gateway — `core/`

| Paquete | Responsabilidad |
|---|---|
| `core/gateway` | App FastAPI (`app.py`), routers en `routers/`, email (Brevo), hub de sesiones remotas y de equipo |
| `core/inference` | Cliente Ollama, mapa rol→modelo (`roles.py`), alias, contexto, búsqueda web, archivos visuales |
| `core/orchestration` | Selección de nodo por recursos, circuit breaker, enlace WebSocket inverso con nodos (`node_link.py`) |
| `core/node_agent` | Proceso que corre en cada máquina con GPU; se conecta al gateway o expone `/metrics` + proxy |
| `core/billing` | Planes, cuotas de sesión/semana, créditos, webhooks de Stripe |
| `core/delegation` | Enrutamiento por embeddings del historial |
| `core/persistence` | SQLAlchemy: `models.py`, `queries.py`, `database.py` |
| `core/security` | Auth (sesiones, API keys `lixbon_sk_`, JWT), rate limiting |
| `core/storage` | Cloudflare R2 |
| `core/config.py` | Toda la configuración; cada variable está documentada en `.env.example` |

Routers principales (`core/gateway/routers/`):

- `chat`, `conversations`, `attachments`, `images` — inferencia y historial
- `auth`, `oauth`, `ide_auth`, `keys` — cuentas, Google/Apple, canje del desktop, API keys
- `billing`, `payments` — planes, uso, Stripe y créditos
- `nodes_link`, `nodes_admin`, `monitor`, `status`, `ws_status` — clúster y estado público
- `remote` — control remoto de sesiones CLI/desktop desde el móvil (`docs/PLAN_REMOTE.md`)
- `team` — Lixbon Team (proyectos, canales, mensajes, `/ws/team`)
- `installer`, `versions` — sirve `client_cli.py`, `install.sh`/`install.ps1` y los instaladores subidos por CI
- `admin`, `admin_panel` — panel de administración

Convención: los tests viven **junto al módulo** que prueban (`core/gateway/test_*.py`).

### Roles de inferencia

Cinco roles con requisitos incompatibles (`chat`, `fim`, `vision`, `embed`,
`route`), cada uno resuelto a un modelo distinto con precedencia
BD → `MODEL_ROLE_<ROL>` → capability de Ollama. Detalle y motivación en
`docs/CUELLO_DE_BOTELLA_MODELOS.md`.

### Nodos GPU

Dos modos (`core/orchestration/orchestrator.py`):

- **link** (recomendado): el agente abre un WebSocket saliente a `/api/nodes/ws`;
  por ese canal empuja métricas y atiende inferencia. Sirve para GPUs alquiladas
  sin puerto entrante. Enrolamiento con `LIXBON_ENROLL=<token>`.
- **url**: el gateway hace polling a `{agent_url}/metrics` y proxya a `{agent_url}/ollama`.

Instalación del agente: `infra/node/` (Docker + `install-node.sh/.ps1`).

### Base de datos — `BD/`

- `schema.sql` — volcado de referencia (`BD/scripts/dump_schema.py`)
- `migrations/` — Alembic (`alembic.ini` en la raíz; URL de `DATABASE_URL`)
- `seeds/plans.sql` — planes Gratuito/Pro/Advance
- `scripts/` — `reset_staging.py`, `migrate_legacy.py`
- `legacy/` — esquema MySQL original, solo histórico

Operación en producción (`infra/ops/`): `reset_db.py` (vaciado por alcance),
`probar_correo.py` (diagnóstico de Brevo).

### Web — `apps/web`

React 19 + Vite. Chat generalista tipo Claude/GPT, cuenta, planes, uso, docs,
guías, estado público, descargas y panel admin. Se prerenderiza (SSR estático)
en `npm run build` y el gateway la sirve desde `apps/web/dist`. Los tokens
visuales de `src/styles/base.css` son la **fuente de verdad del diseño** para
todas las apps (`docs/DISENO_WEB.md`).

### Desktop — `apps/desktop`

Tauri 2 (Rust en `src-tauri/`) + React. Workspace con explorador, git, GitHub,
equipos, terminal y chat con el clúster. Se autentica con la cuenta web
(`/ide/connect`) o con API key. Compila solo en CI (`tauri.yml`).

### CLI — `apps/cli`

Python sin dependencias externas. Fuente modular en `lixbon_cli/`; `build.py`
concatena todo en `client_cli.py`, que el gateway sirve y actualiza en los
clientes. Modo chat y modo agente con herramientas, MCP por stdio, sesiones,
`/remote`.

### Móvil — `apps/mobile`

React Native + Expo (Android). Mismo historial que la web, control remoto de
sesiones y notificaciones push. Compila solo en CI (`mobile.yml`).

## Contratos compartidos entre gateway y apps

Cambiar cualquiera de estos requiere tocar ambos lados (gateway en `master`,
la app en su rama):

| Contrato | Gateway | Cliente |
|---|---|---|
| Nombre de la API key por producto | `routers/auth.py` (`CLI_KEY_NAME`, `MOBILE_KEY_NAME`) | `apps/cli/lixbon_cli/api.py`, `apps/mobile/src/state.js` |
| Streaming SSE del chat | `routers/chat.py` | `apps/cli/lixbon_cli/sse.py`, `apps/mobile/src/sse.js`, `apps/web/src/lib/stream.js` |
| Detección de archivos visuales | `core/inference/visual_files.py` | `apps/web/src/lib/visuals.js` |
| Protocolo `/remote` | `gateway/remote_hub.py` | `lixbon_cli/remote.py`, `desktop/src/store/remoteStore.js`, `mobile/src/remote.js` |
| Subida de instaladores | `routers/versions.py` | `.github/workflows/tauri.yml`, `mobile.yml` |
| Tokens de diseño | — | `apps/web/src/styles/base.css` → copiados por desktop y mobile |

## Despliegue

`railway.toml` → `Dockerfile` (multi-stage: build de la web con Node, luego
Python 3.12 con `core/`, `BD/`, `infra/node/`, `apps/cli/client_cli.py` y el
`dist` de la web). Uvicorn con `--proxy-headers` porque Railway/Cloudflare
terminan TLS fuera. Health check en `/health`.
