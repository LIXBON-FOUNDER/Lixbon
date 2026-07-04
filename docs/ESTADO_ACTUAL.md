# FOLAX — Estado actual del proyecto

> Actualizado: 2026-07-04 (F4 completada). Documento para retomar el trabajo.
> Referencias: `docs/PLAN_MAESTRO.md` (plan por fases) · `docs/DISENO_WEB.md` (diseño de la web) · `docs/INFORME_Y_PLAN.md` (diagnóstico original).

---

## 1. Resumen en una línea

**Backend y web nueva completos (F0–F4 ✅). Falta todo lo de producto: planes, panel admin, pagos (F5–F8).**

---

## 2. Lo que YA está hecho y verificado

### ✅ F0 — Seguridad (completada)
- Clave de firma Tauri **rotada** (privada nueva en `C:\Users\Usuario\.tauri\folax_update.key`, fuera del repo; pubkey nueva en `apps/desktop/src-tauri/tauri.conf.json`).
- GitHub Secrets creados: `TAURI_SIGNING_PRIVATE_KEY`, `FOLAX_ADMIN_TOKEN` (no existe `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — la clave no tiene contraseña, el workflow lo tolera).
- `POST /api/versions/upload` autenticado con `X-Admin-Token`.
- Historial de git purgado (`.env`, `.venv`, `cloudflared.exe`, MSIs, clave vieja) — repo pasó de 72 MB a <1 MB. Backup completo en `Desktop\LLM-DataCent-BACKUP\` (bundle + .env viejo).

### ✅ F1 — Fundaciones (completada)
- **Monorepo screaming architecture**: `core/` (gateway, persistence, security, orchestration, delegation, inference, node_agent) · `apps/` (web, desktop, cli) · `BD/` · `infra/` · `docs/`.
- **Postgres únicamente** (SQLAlchemy 2.0): `core/persistence/{database,models,queries}.py`. `db_sqlite`/`db_mysql` eliminados. Dos BDs en Railway: staging (la usa tu PC vía `DATABASE_URL` del `.env`) y prod (enlazada al servicio).
- **Redis** en Railway para rate limiting (`core/security/ratelimit.py`, fallback en memoria sin `REDIS_URL`).
- `Dockerfile` multi-stage (build de la web + gateway) + `railway.toml` (healthcheck `/health`).
- Desplegado y online: `https://llm-datacent-production.up.railway.app`.
- Entry point: `uvicorn core.gateway.app:app`. Lifespan + logging JSON (`LOG_FORMAT=plain` para dev).

### ✅ F2 — GPU vía tunnel + bugs del core (completada, validada EN PRODUCCIÓN)
- **node_agent** (`core/node_agent/agent.py`): FastAPI, exige `X-Node-Token` == `NODE_SHARED_SECRET` (env, se lee también del `.env`), proxy allowlist a Ollama (`/ollama/api/{chat,tags,embed}`) con streaming. Ollama nunca se expone directo. Arranque: `python -m core.node_agent.agent`.
- **Nodos en BD** (tabla `nodes`, token por nodo). CRUD: `/api/admin/nodes` con `X-Admin-Token`. `nodes.json` eliminado.
- **Nodo registrado en PROD**: `gpu-01` → `https://gpu-01.datacentgbx.online`. Su token está como `NODE_SHARED_SECRET` en el `.env` local.
- **Cloudflare Tunnel**: `folax-gpu-01` (ID `cb1067aa-...`), config correcta en `C:\Users\Usuario\.cloudflared\config.yml` → `localhost:8765`.
- **Bugs corregidos**: agente muerto = offline (antes score perfecto); `/api/chat` y `/api/delegate` enrutan por el orquestador; streaming persiste mensaje+tokens; keep-alive SSE real por tiempo (`core/inference/ollama.py` — única implementación de streaming); watchdog sin duplicados; `packaging.version` para updates.
- **E2E validado**: chat desde la URL de producción → tunnel → GPU (respuesta real, `node: gpu-01`).

### ✅ F3 — Auth nuevo (completada, verificada en staging)
- **Login por email**; registro con `first_name`/`last_name` (lo que exige el diseño). Username sigue funcionando para CLI/desktop legacy.
- **Sesiones web** en tabla `sessions` (cookie `folax_session`, HttpOnly, SameSite=Lax, `COOKIE_SECURE=1` para prod) — separadas de las API keys.
- **API keys solo-hash**: `raw_key` ya no se persiste; prefijo `folax_sk_`; se muestran UNA vez al crearse/regenerarse.
- **Roles** `user`/`admin`: seed automático vía env `ADMIN_EMAILS`; dependencia `admin_required` en `core/security/auth.py`.
- **Verificación de email + reset de contraseña**: `core/gateway/email.py` (Resend; sin `RESEND_API_KEY` los links se imprimen en el log — modo dev). Reset rotan las API keys.
- **IDOR corregido**: borrar keys ajenas → 404.
- Migración de columnas idempotente en `init_db()` (se aplica sola al arrancar en cualquier entorno).

---

## 3. Pendientes INMEDIATOS (antes o durante F4)

### Variables de Railway que faltan definir (servicio gateway) 🔴
| Variable | Valor | Por qué |
|---|---|---|
| `ADMIN_EMAILS` | tu email real | Tu cuenta será admin al registrarte |
| `COOKIE_SECURE` | `1` | Cookies solo por HTTPS |
| `PUBLIC_BASE_URL` | `https://llm-datacent-production.up.railway.app` (o el dominio final) | Links de los emails |
| `RESEND_API_KEY` | (opcional) crear cuenta en resend.com | Sin ella, los emails solo se loguean |

### Operativos (tu PC)
- [x] **node_agent y tunnel al iniciar sesión** (2026-07-04): tareas programadas de usuario "FOLAX Node Agent (usuario)" y "FOLAX Tunnel (usuario)" (ONLOGON, sin límite de tiempo, PowerShell oculto — el alias pythonw de la Store no funciona en Task Scheduler). Arrancan al iniciar sesión de Windows; no requieren admin.
- [ ] (Opcional, más robusto) **Servicio cloudflared sin config**: el servicio Windows corre pero sin config → no conecta (fue la causa del "No hay modelos" del 2026-07-04). Fix en PowerShell **admin** para que el tunnel viva sin sesión iniciada: `Copy-Item "$env:USERPROFILE\.cloudflared\*" "C:\Windows\System32\config\systemprofile\.cloudflared\" -Force; Restart-Service Cloudflared` (luego se puede borrar la tarea de usuario del tunnel).
- [ ] (Opcional) `python -m core.node_agent.agent --install` como admin (corre como SYSTEM sin sesión) — reemplazaría la tarea de usuario.
- [ ] Dominio final: apuntar `datacentgbx.online` al gateway de Railway (custom domain en Railway + CNAME en Cloudflare).

### Datos de prueba a limpiar (cuando exista el panel admin)
- Prod: usuarios `smoke_e2e`, `f4tunnel_*@test.local`. Staging: `smoke_test_f1`, `f3admin@test.local`, usuarios `f4smoke_*`/`f4idor_*`/`f4ui_*`/`f4dbg_*@test.local` (E2E de F4), nodo `gpu-01` apuntando a `http://127.0.0.1:8765` (localhost — coherente para dev).

---

## 4. ✅ F4 — La web nueva (completada 2026-07-04, verificada E2E con Playwright)

**El dashboard oscuro viejo fue reemplazado** por la web del diseño nuevo (docs/DISENO_WEB.md): chat tipo Claude/GPT con streaming.

**Frontend (`apps/web/src` reescrito)** — estructura `components/ pages/ styles/ lib/ hooks/`:
- Fuentes self-hosted en `public/fonts/` (Bruno Ace SC + Bricolage Grotesque variable, woff2 latin y latin-ext); tokens CSS en `styles/base.css` (`--bg`, `--bg-secondary #F6F7ED`, `--ink #171717`, `--accent` verde-amarillo, todo pill).
- Iconos SVG inline de trazo fino en `components/Icons.jsx`.
- **Auth** (`pages/AuthPage.jsx`): crema, toggle segmentado, labels flotantes outlined, modo "olvidé mi contraseña" + `pages/ResetPasswordPage.jsx` (`/reset-password?token=`). OAuth oculto (decisión).
- **Chat** (`pages/ChatPage.jsx` + `components/{Sidebar,ChatInput,Markdown}.jsx`): sidebar colapsable con búsqueda (filtro cliente), historial con renombrar/eliminar (updates optimistas — la BD remota es lenta), footer de perfil con inicial + "Plan Gratuito" (real en F5); streaming SSE vía fetch a `/v1/chat/completions` con cookie; memoria = ventana de 20 mensajes enviada por el cliente; markdown con react-markdown (títulos Semibold); botón "más ↓"; selector de modelos (`/v1/models`); auto-título tras el primer intercambio; visitante anónimo ve "¿Qué investigaremos hoy?" y al enviar → `/auth?mode=register`.
- Rutas: `/` y `/c/:id` (chat), `/auth`, `/reset-password`; `/login`→`/auth` legacy. Dev: proxy Vite `/api` y `/v1` → :8000.

**Backend añadido en F4**:
- `core/gateway/routers/conversations.py`: `GET /api/conversations` (paginado + `?q=` búsqueda), `GET /api/conversations/{id}/messages`, `PATCH/DELETE /api/conversations/{id}`, `POST /api/conversations/{id}/generate-title` (modelo pequeño vía orquestador; limpia markdown residual). Todo con check de pertenencia.
- `web_or_api_key_auth` en `core/security/auth.py`: `/v1/models` y `/v1/chat/completions` aceptan cookie de sesión **o** API key (el rate limit por token se mantiene para keys).
- Fix IDOR: `ensure_conversation` ahora rechaza escribir en conversaciones de otro usuario (404 en `/api/chat`, `/v1/chat/completions`, `/v1/completions`).

**Pendiente que quedó fuera de F4** (decidido): botón "Compartir" visible pero muestra "disponible pronto" (link público = feature posterior); micrófono oculto; adjuntar/web deshabilitados; "Aplicaciones" placeholder.

---

## 5. Fases posteriores (sin iniciar)

- **F5 — Planes y límites**: tablas `plans`/`subscriptions`/`usage_quotas`, 3 planes **Gratuito/Pro/Advance** (límites en BD, no hardcodeados), middleware de cuotas con Redis, página "Mi cuenta" con stats (backend de métricas ya existe: `token_usage_daily`).
- **F6 — Panel admin**: releases privado (subida a **Cloudflare R2** — el disco de Railway es efímero, pendiente de F1.8), nodos con UI, modelos por plan, usuarios, audit log. **Deuda anotada**: `nodes_admin` usa `X-Admin-Token`; migrar a `admin_required` (rol) aquí. Endpoints de update: `/api/updates/manifest/{channel}` ya existe para Tauri; falta el del CLI.
- **F7 — Pagos**: Stripe o Mercado Pago (decisión pendiente del usuario), checkout hosted + webhooks.
- **F8 — Calidad**: tests automatizados (no hay ninguno aún), ruff/mypy, Sentry, backups verificados, docs de API, ToS/privacidad.

---

## 6. Mapa rápido de dónde está cada cosa

| Cosa | Dónde |
|---|---|
| Gateway (entry) | `core/gateway/app.py` → `uvicorn core.gateway.app:app` |
| Rutas API | `core/gateway/routers/` (auth, chat, keys, versions, nodes_admin, admin, monitor, ws_status, installer) |
| BD (modelos/queries) | `core/persistence/models.py` · `queries.py` (staging vía `DATABASE_URL` del `.env`) |
| Inferencia/streaming | `core/inference/ollama.py` (única implementación) |
| Orquestador | `core/orchestration/orchestrator.py` (`ollama_target()` decide nodo vs local) |
| Agente GPU | `core/node_agent/agent.py` (puerto 8765, token en `.env` `NODE_SHARED_SECRET`) |
| Web vieja (a reemplazar en F4) | `apps/web/` (React+Vite; mantener organización components/pages/styles) |
| Desktop Tauri | `apps/desktop/` |
| CLI | `apps/cli/client_cli.py` (monolito, se moderniza post-F4) |
| Esquema BD + scripts | `BD/` (schema.sql se regenera con `python BD/scripts/dump_schema.py`) |
| Diseño web (specs) | `docs/DISENO_WEB.md` |
| Plan por fases | `docs/PLAN_MAESTRO.md` |
| Secretos locales | `.env` (staging URL, ADMIN_TOKEN, NODE_SHARED_SECRET) — NUNCA en git |
| Clave firma Tauri | `C:\Users\Usuario\.tauri\folax_update.key` (+ GitHub Secrets) |
| Config tunnel | `C:\Users\Usuario\.cloudflared\config.yml` (tunnel `folax-gpu-01`) |

## 7. Cómo arrancar el entorno de desarrollo

```powershell
# 1. Gateway local (usa la BD de staging de Railway automáticamente por .env)
python -m uvicorn core.gateway.app:app --reload --port 8000

# 2. Node agent (para probar inferencia local con la GPU)
python -m core.node_agent.agent

# 3. Web en dev (proxy al gateway)
cd apps/web; npm run dev   # http://localhost:5173

# 4. Tunnel (solo si quieres probar el flujo de producción completo)
.\cloudflared.exe tunnel run folax-gpu-01
```

Nota: el nodo `gpu-01` en la BD de **staging** apunta a `http://127.0.0.1:8765` (test local) — coherente para desarrollo. El de **prod** apunta al tunnel.
