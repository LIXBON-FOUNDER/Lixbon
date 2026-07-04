# FOLAX — Estado actual del proyecto

> Actualizado: 2026-07-04 (F6 completada, salvo releases R2). Documento para retomar el trabajo.
> Referencias: `docs/PLAN_MAESTRO.md` (plan por fases) · `docs/DISENO_WEB.md` (diseño de la web) · `docs/INFORME_Y_PLAN.md` (diagnóstico original).

---

## 1. Resumen en una línea

**Backend, web nueva, planes con límites y panel admin completos (F0–F6 ✅, salvo releases R2). Falta: pagos, calidad (F7–F8).**

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

## 5. ✅ F5 — Planes y límites (completada 2026-07-04, verificada E2E: 20/20 API + 14/14 UI)

**Los límites viven en la BD (tabla `plans`), no en el código.** Postgres es la fuente de verdad de los contadores; Redis es pre-check barato.

**BD y backend**:
- Tablas `plans` / `subscriptions` (única por usuario) / `usage_quotas` (contador atómico por período, `pg_insert ON CONFLICT ... RETURNING`). Seed idempotente en `init_db()` + `BD/seeds/plans.sql`: **Gratuito** (30 msg/día, 150k tokens/mes, 1 key, 10 rpm, solo modelos pequeños por prefijo), **Pro** ($9.90: 500/día, 5M/mes, 5 keys, 60 rpm, todos), **Advance** ($24.90: ilimitados/día, 20M/mes, 20 keys, 120 rpm).
- `core/billing/quota.py`: `ensure_can_chat()` antes de toda inferencia — modelo permitido (403 `model_not_allowed`), rate limit por plan, mensajes/día y tokens/mes (429 con detail estructurado `{code, scope, message, reset_at}` en español con tiempo de reinicio humano); `record_tokens()` al terminar; `usage_snapshot()` para Mi cuenta. Contar ANTES de inferir evita pasarse en paralelo.
- Endpoints (`core/gateway/routers/billing.py`): `GET /api/plans` (público), `GET /api/account/usage` (plan + uso + serie 30 días), `GET /api/admin/users?q=` y `POST /api/admin/users/{id}/plan` (por ROL admin, con audit log) — **asignación manual de planes hasta que lleguen los pagos (F7)**.
- `GET /api/keys` nuevo; `POST /api/keys` respeta `max_api_keys` (403 `keys_quota`). Registro asigna plan free; `/api/auth/me` devuelve `plan_id`/`plan_name`.

**Web**:
- **Mi cuenta** (`/account`): plan actual, barras de cuota (mensajes hoy / tokens mes, roja al llenarse), gráfica SVG de tokens 30 días con tooltip, gestión de API keys (crear con reveal único, desactivar). `pages/AccountPage.jsx` + `components/UsageChart.jsx` + `styles/account.css`.
- **Planes** (`/planes`): 3 tarjetas, Pro destacada; CTA "Próximamente" (pagos F7). Sidebar: pill del plan real (`user.plan_name`) → `/planes`; menú del perfil con "Mi cuenta".
- 429/403 de cuota se ven amigables en el chat (burbuja `⚠️ Alcanzaste los N mensajes diarios... Se reinicia en X h`).

**E2E verificado** (scripts efímeros, gateway local + BD staging): free choca modelo vetado, límite diario y límite de keys; admin busca usuario y asigna Pro; límites se levantan al instante; UI refleja todo. Usuarios de prueba en staging: `f5user_*`, `f5admin_*`, `f5ui_*`, `f5uiadmin_*`, `f5models_*@test.local`.

---

## 6. ✅ F6 — Panel de administración (completada 2026-07-04, verificada E2E: 31/31 API + 15/15 UI)

**Todo lo del dueño, protegido por ROL admin (backend valida cada endpoint).** Falta solo releases en R2 (F6.5, bloqueado por credenciales).

**BD y backend**:
- Columna `users.is_active` (migración idempotente en `init_db`): bloquear a un usuario invalida su sesión y sus API keys **al instante** (`verify_user`, `validate_web_session`, `validate_api_key` lo checan). Bloquear = 403/401 inmediato, sin esperar expiración.
- `core/gateway/routers/admin_panel.py` (NUEVO, prefijo `/api/admin`, `admin_required`): `GET /metrics` (dashboard global: usuarios/activos/bloqueados/conversaciones/mensajes/nodos + serie diaria + suscripciones por plan), `GET /users` + `GET /users/{id}` (detalle con plan/uso/keys/eventos), `POST /users/{id}/plan`, `POST /users/{id}/active` (bloqueo; no puedes bloquearte a ti mismo), `GET /plans` + `PATCH /plans/{id}` (editar límites/allowed_models sin tocar la BD), `GET /models` (modelos del cluster: en qué nodos, en qué planes), `GET /audit` (log global paginado con filtro por `event_type`/`user_id`).
- `nodes_admin.py`: **migrado de `X-Admin-Token` a `admin_required`** (salda la deuda de F3) + audit log de `node_upserted`/`node_deleted`. `/api/nodes*` de `admin.py` ahora exige rol admin (eran métricas internas expuestas a cualquier usuario).
- Queries nuevas: `set_user_active`, `update_plan`, `get_global_stats`; `list_audit_events` con offset/event_type; `list_users_admin` y `_user_to_dict` exponen `is_active`/`created_at`.

**Web** (`pages/AdminPage.jsx` + `styles/admin.css`, ruta `/admin`):
- Tabs: **Resumen** (stat tiles + gráfica global reusando `UsageChart` + suscripciones por plan), **Usuarios** (buscar, cambiar plan por `<select>`, bloquear/desbloquear con badge, detalle expandible con uso y eventos), **Nodos** (CRUD + estado en vivo del orquestador: online/circuit-breaker, score, CPU/RAM, modelos como chips; alta muestra el token una vez), **Modelos** (tabla del cluster + editor de `allowed_models` por plan), **Auditoría** (log paginado "cargar más" + filtro por tipo).
- Acceso: entrada "Panel admin" en el menú del perfil (solo `role=admin`); `/admin` redirige al chat si no eres admin. `/api/auth/me` ya exponía `role`.

**E2E verificado**: user normal recibe 403 en todo `/api/admin` y la SPA lo expulsa de `/admin`; admin ve dashboard, bloquea (login del bloqueado → 401) y desbloquea, cambia plan, edita `allowed_models` (se refleja en `/api/plans` público y se revierte), gestiona nodos, ve modelos y filtra auditoría. Usuarios de prueba en staging: `f6admin_*`, `f6user_*`, `f6uiadmin_*`, `f6uiuser_*@test.local`.

**Pendiente F6.5 (releases privado)** 🔴 requiere que el usuario cree el bucket: subir instaladores Desktop/CLI a **Cloudflare R2** (disco de Railway efímero), canales stable/beta, quitar la página pública de releases, endpoints de update de solo lectura `/api/updates/desktop/{channel}` y `/api/updates/cli/{channel}`. Necesita bucket R2 + access keys.

---

## 7. Fases posteriores (sin iniciar)

- **F6.5 — Releases en R2** (bloqueado): ver arriba. Necesito que crees el bucket R2 y me pases las credenciales.
- **F7 — Pagos**: Stripe o Mercado Pago (decisión pendiente del usuario), checkout hosted + webhooks. El backend ya tiene planes/suscripciones; falta el cobro y el CTA "Próximamente" de `/planes`.
- **F8 — Calidad**: tests automatizados (no hay ninguno aún), ruff/mypy, Sentry, backups verificados, docs de API, ToS/privacidad.

---

## 7. Mapa rápido de dónde está cada cosa

| Cosa | Dónde |
|---|---|
| Gateway (entry) | `core/gateway/app.py` → `uvicorn core.gateway.app:app` |
| Rutas API | `core/gateway/routers/` (auth, chat, conversations, billing, keys, versions, nodes_admin, admin, monitor, ws_status, installer) |
| Cuotas por plan | `core/billing/quota.py` (límites en tabla `plans`; seed en `BD/seeds/plans.sql`) |
| Panel admin (API) | `core/gateway/routers/admin_panel.py` (`/api/admin/*`, rol) + `nodes_admin.py` |
| Panel admin (web) | `apps/web/src/pages/AdminPage.jsx` + `styles/admin.css` (ruta `/admin`) |
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

## 8. Cómo arrancar el entorno de desarrollo

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
