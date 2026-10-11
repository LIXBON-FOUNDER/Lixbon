# Lixbon · Resumen del proyecto

> Generado el 2026-10-09 a partir de la exploración del repositorio (run r9 del orquestador).
> Informes de detalle: `.lixbon/informes/r9/`.

## 1. Qué es Lixbon

Lixbon es una **plataforma SaaS de LLMs auto-hospedados** que corren sobre un **clúster distribuido de GPUs**
(Ollama en cada nodo). Ofrece una **API compatible con OpenAI** (`/v1/chat/completions`, `/v1/models`…)
y varios clientes que comparten la misma cuenta:

| Superficie | Qué ofrece |
|---|---|
| **Web** (lixbon.com) | Chat con streaming, cuenta y API keys, planes y pagos, uso, documentación (es/en), estado del clúster, descargas, panel admin |
| **Desktop** (Tauri) | Chat/IDE ligero, orquestador de agentes (`lxo`), Lixbon Team (mensajería e issues), mascota |
| **CLI** (Go) | Agente de terminal con TUI, herramientas, MCP y control remoto |
| **Android** (Expo) | Chat, historial, control remoto del IDE/CLI, uso del plan |

Otras piezas del producto: **Visuals** (render de piezas HTML → PNG/MP4), **servidor MCP** (`lixbon.com/mcp`),
**skills oficiales** (`/marketing-lxo`, `/adversary`), **control remoto desde el móvil** (`/remote`) y
**Lixbon Team** (issues tipo `LXB-12`).

**Público objetivo:** desarrolladores y usuarios técnicos. Interfaz en español; marca crema `#F6F7ED` y tinta
`#171717`, solo tema claro.

### Planes (seed en `core/persistence/database.py`)

| Plan | Precio/mes | Mensajes/día | Tokens/mes | API keys | Req/min | Visuals |
|---|---|---|---|---|---|---|
| Gratuito | $0 | 30 | 150 000 | 1 | 10 | No |
| Pro | $9,90 | 500 | 5 M | 5 | 60 | Sí |
| Advance | $24,90 | Ilimitados | 20 M | 20 | 120 | Sí |

Además hay **créditos prepago** para modelos con tarifa (`core/billing/credits.py`).

## 2. Arquitectura general

```
 Web (React) ─┐
 Desktop ─────┤  HTTPS / SSE / WebSocket   ┌──────────────────────────┐   WebSocket saliente   ┌──────────────┐
 CLI (Go) ────┼──────────────────────────► │  Gateway FastAPI (core/) │ ◄───────────────────── │ Nodo GPU      │
 Android ─────┘                            │  Postgres · Redis · R2   │                        │ Ollama +      │
                                           │  Stripe · FCM · email    │                        │ node_agent.py │
                                           └────────────┬─────────────┘                        └──────────────┘
                                                        │ cola visual_render_jobs
                                                        ▼
                                              Render worker (Playwright + ffmpeg)
```

- Ollama **nunca se expone directamente**: los nodos abren un WebSocket saliente al gateway y este enruta las
  peticiones (`core/gateway/model_router.py`, `core/orchestration/orchestrator.py`).
- La web compilada la sirve el propio gateway (misma imagen Docker).

## 3. Tecnologías

| Componente | Stack |
|---|---|
| **Backend / gateway** | Python 3.12, FastAPI, uvicorn, SQLAlchemy 2 + psycopg 3, Alembic, Redis (rate limit), Stripe, boto3 (Cloudflare R2), PyJWT, httpx, websockets, segno (QR), ddgs/Tavily/Brave (búsqueda web), pypdf, python-docx |
| **Base de datos** | PostgreSQL (39 modelos ORM); esquema creado con `create_all` + `ALTER … IF NOT EXISTS` al arrancar |
| **Inferencia** | Ollama en nodos GPU. Por defecto: `deepseek-r1:8b` (chat), `moondream` (visión), `nomic-embed-text` (embeddings) |
| **Web** | React 19.2, Vite 8, React Router 7, axios, Stripe Elements, react-markdown, oxlint; SSR estático + prerender |
| **Desktop** | Tauri 2 (Rust) + React 19.1, Vite 7, Zustand 5, CodeMirror 6, xterm 5.5, portable-pty |
| **Orquestador `lxo`** | Binario Rust mínimo (solo `serde_json`) que habla por HTTP local con la app desktop |
| **CLI** | Go 1.26, Bubble Tea v2, Bubbles, Lip Gloss, Glamour (migrada desde Python) |
| **Móvil** | Expo 54, React Native 0.81, Reanimated 4, SecureStore, expo-notifications (FCM), OAuth PKCE |
| **Render worker** | Playwright 1.63 (Python) + ffmpeg |
| **Infra / despliegue** | Docker, Railway, GitHub Actions, Cloudflare Tunnel (LAN), Cloudflare R2 |

## 4. Estructura del repositorio

```
Lixbon/
├── core/                    Backend Python
│   ├── gateway/             App FastAPI (app.py), ~31 routers (~230 endpoints), email, push, hubs WebSocket
│   ├── persistence/         Engine, modelos SQLAlchemy, queries, seed de planes
│   ├── security/            Auth (cookie / API key / Bearer), rate limit, control de acceso
│   ├── billing/             Planes, cuotas, créditos, Stripe
│   ├── inference/           Cliente Ollama, roles/alias de modelos, búsqueda web, visión, FIM
│   ├── orchestration/       Orquestador y enlace de nodos GPU
│   ├── delegation/          Embeddings y clasificación/routing de peticiones
│   ├── storage/             Cliente R2 con URLs prefirmadas
│   ├── render/              Render HTML → PNG/MP4 (Visuals)
│   ├── node_agent/          Agente que corre en cada nodo GPU
│   └── config.py            Variables de entorno
├── BD/                      schema.sql, configuración Alembic, scripts (dump, reset de staging, backups)
├── apps/
│   ├── web/                 Frontend React (lixbon.com)
│   ├── desktop/             App Tauri + `lxo/` (CLI del orquestador en Rust)
│   ├── cli/                 CLI en Go (cmd/, internal/, validation/, audit/)
│   └── mobile/              App Android con Expo
├── infra/
│   ├── ci/                  Runner de tests del gateway, e2e de instaladores
│   ├── node/                Imagen Docker GPU (Ollama + agente) e instaladores de nodo
│   ├── render_worker/       Imagen y despliegue del worker de render
│   ├── ops/                 Scripts manuales (reset de BD, diagnóstico de correo)
│   └── scripts/             Lanzadores locales/LAN (gateway, nodo, Ollama, túnel)
├── skills/adversary/        Skill oficial /adversary
├── docs/                    ARQUITECTURA.md, INCIDENTES.md
├── .planning/               Planificación de la migración del CLI a Go
├── .agents/                 Contexto de producto para skills de marketing
├── .github/workflows/       CI y releases
├── Dockerfile · railway.toml · requirements.txt · alembic.ini · .env.example
└── README.md · PRODUCT.md · CONTRIBUTING.md · SECURITY.md · CODE_OF_CONDUCT.md
```

## 5. Backend: piezas clave

- **Entrada:** `core/gateway/app.py:76`. El lifespan inicializa logging, BD, versiones, clientes HTTP, orquestador
  de nodos, sampler y archiver. Healthcheck en `/health`.
- **Autenticación:** cookie `lixbon_session` o API key `lixbon_sk_` como Bearer (`core/security/auth.py`);
  contraseñas con scrypt; OAuth con Google y GitHub; verificación de correo opcional.
- **Rutas principales:**
  - Auth: `/api/auth/*`, `/oauth/*`
  - Inferencia: `/api/chat`, `/v1/chat/completions`, `/v1/completions`, `/api/fim`, `/api/embed`,
    `/api/delegate`, `/api/websearch`, `/api/vision/describe`
  - Facturación: `/api/plans`, `/api/billing/*`, `/api/credits/*`
  - Además: conversaciones, remoto, MCP (`/mcp`), Team (`/ws/team`) y admin (`/api/admin`)
- **Servicios externos:** Stripe (suscripciones + webhook), Cloudflare R2, FCM (push), email transaccional,
  Redis (rate limit).

## 6. Desarrollo local

```bash
# Gateway (desde la raíz, con .env basado en .env.example)
python -m uvicorn core.gateway.app:app --port 8000 --reload

# Web (proxy de /api, /v1 y /mcp a :8000)
cd apps/web && npm install && npm run dev        # http://localhost:5173

# Móvil
cd apps/mobile && npm install && npx expo start

# Desktop
cd apps/desktop && npm install && npm run tauri dev   # compila antes lxo (npm run build:lxo)
```

Los scripts de `infra/scripts/` levantan el stack completo en LAN (gateway + Ollama + agente de nodo + túnel).

## 7. CI/CD y releases

| Disparador | Workflow | Qué hace |
|---|---|---|
| Push a `master`/`cli`, PR a `master` | `ci.yml` | Tests del gateway (pytest), CLI Go en matriz de SO, e2e de instaladores |
| Push a `master` | Railway | Construye el `Dockerfile` (web + gateway) y despliega |
| Tag `desktop-v*` | `tauri.yml` | Build y release de la app desktop (con updater) |
| Tag `mobile-v*` | `mobile.yml` | `expo prebuild` → APK, release y subida vía `/api/versions/upload` |
| Tag `cli-v*` | `release-cli.yml` | Build multiplataforma, release, registro y smoke test (exige entrada en CHANGELOG) |

**Ramas:** `master` es la rama de integración. `desktop`, `cli` y `mobile` se integran por PR, con merge y no rebase.
El render worker se despliega aparte con `infra/render_worker/deploy.sh`.

## 8. Estado actual y roadmap

- **Proyecto activo:** migración del CLI de Python a Go (`.planning/`). Hay 20 de 31 requisitos implementados y
  0 de 5 fases cerradas formalmente. Falta la validación contra el gateway real, la primera release estable con
  `update` y retirar la versión en Python.
- **Versiones actuales:** Desktop 2.0.28 · Móvil 0.4.0 · CLI 2.3.0-go.6.

## 9. Incoherencias detectadas (conviene revisarlas)

1. `README.md` enlaza `docs/RAMAS_Y_RELEASES.md` y `docs/README.md`, que **no existen**.
2. Versiones del README desfasadas: Desktop pone 1.2.0 (real 2.0.28), Móvil 0.3.4 (real 0.4.0) y CLI 2.3.0-go.2 (real 2.3.0-go.6).
3. `BD/schema.sql` tiene 11 tablas frente a 39 modelos ORM, y no hay migraciones Alembic versionadas: la fuente de
   verdad del esquema es `init_db()`.
4. `requirements.txt` no fija versiones (no hay lock).
5. `PRODUCT.md` y `tauri.yml` no coinciden sobre el papel del desktop (Lixbon IDE descontinuada frente a desktop oficial).
6. No está claro qué `base.css` es la fuente de los tokens de diseño compartidos (web o desktop).
