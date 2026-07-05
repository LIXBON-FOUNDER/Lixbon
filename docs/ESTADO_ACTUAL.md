# FOLAX — Estado actual del proyecto

> Actualizado: 2026-07-04 (F7 pagos: integración lista, falta conectar credenciales). Documento para retomar el trabajo.
> Referencias: `docs/PLAN_MAESTRO.md` (plan por fases) · `docs/DISENO_WEB.md` (diseño de la web) · `docs/INFORME_Y_PLAN.md` (diagnóstico original).

---

## 1. Resumen en una línea

**F0–F7 implementadas (backend, web, planes/límites, panel admin, releases R2, pagos Stripe). Pendiente: conectar credenciales de Stripe en Railway, y F8 (calidad/tests).**

---

## 0. Cómo ACTIVAR Stripe (F7 — pagos) 🔴

La integración está completa y verificada en modo degradado + lógica de webhook (20 checks). Para encender los pagos reales:
1. **Cuenta Stripe** (modo test primero): crea 2 **Productos** con precio recurrente mensual — Pro ($9.90) y Advance ($24.90). Copia sus `price_...`.
2. **Conecta los precios**: en el panel admin → tab **Modelos** → "Precios de Stripe", pega cada `price_...` en su plan. (O `PATCH /api/admin/plans/{id}` con `{"stripe_price_id": "price_..."}`.)
3. **Variables de entorno** (`.env` local y Railway): `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`, y `PUBLIC_BASE_URL=https://tu-dominio` (para las URLs de retorno del checkout).
4. **Webhook en Stripe**: apunta un endpoint a `https://tu-dominio/api/billing/webhook` y suscríbelo a `customer.subscription.created/updated/deleted` e `invoice.payment_failed`. Copia el signing secret a `STRIPE_WEBHOOK_SECRET`.
5. **Probar**: en modo test, tarjeta `4242 4242 4242 4242`. Suscríbete desde `/planes` → checkout → vuelve a `/account/facturacion`. El webhook activa el plan solo.
6. Cuando funcione en test, repite con las claves **live**.

Con `STRIPE_SECRET_KEY` vacío, todo degrada: `/planes` y Facturación muestran "Próximamente"; `/api/billing/*` responde 503.

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
| `ADMIN_EMAILS` | `durangogabriel8@gmail.com` | Tu cuenta será admin (necesario para el panel admin F6). El seed te promueve en cada arranque |
| `COOKIE_SECURE` | `1` | Cookies solo por HTTPS |
| `PUBLIC_BASE_URL` | `https://llm-datacent-production.up.railway.app` (o el dominio final) | Links de los emails |
| `RESEND_API_KEY` | (opcional) crear cuenta en resend.com | Sin ella, los emails solo se loguean |
| `R2_ACCOUNT_ID` | `071d1172730bf91c22924d149b67f95d` | Releases privados (F6.5); sin las 4 vars R2, prod cae al disco efímero |
| `R2_BUCKET` | `releases-folax` | Bucket de instaladores |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | (están en el `.env` local) | Credenciales R2 |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | (de tu cuenta Stripe) | Pagos F7; sin ellas todo degrada a "Próximamente" |

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

**F6.5 — Releases privado en R2 (completada 2026-07-04, verificada E2E contra R2 real 12/12)**:
- `core/storage/r2.py` (NUEVO): cliente boto3 S3 apuntando a R2 (endpoint `https://<account>.r2.cloudflarestorage.com`, firma v4), perezoso y thread-safe. `upload_release()`, `presigned_get_url()` (URLs de descarga temporales), `object_exists`, `delete_object`. `boto3` añadido a `requirements.txt`.
- Config (`core/config.py`): `R2_ACCOUNT_ID/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_PRESIGN_TTL_MIN`, helpers `r2_configured()`/`r2_endpoint()`. **Las credenciales viven solo en `.env` local (gitignored) y deben definirse en Railway.**
- `versions.py` reescrito: la subida (`POST /api/versions/upload`, sigue con `X-Admin-Token`) sube a R2 con key `releases/<archivo>` y guarda en la BD `download_url = "r2:<key>"` (sin cambiar el esquema). **Si R2 no está configurado, cae al disco local** (efímero, solo dev). Toda descarga pasa por `GET /api/updates/download/{version}/{channel}`, que genera una URL prefirmada al vuelo y redirige (302) — el binario nunca se expone y la URL pública es estable. Los manifests (`/api/updates/manifest/{channel}` Tauri, `/api/updates/cli/{channel}` nuevo, `/api/updates/check`) devuelven esa URL del gateway, nunca la key ni el binario. Audit log `release_uploaded`.
- **Eliminada la página pública `/releases-info`** (era dark-theme viejo con fuentes de Google externas).
- Bucket **privado**: R2 nunca queda expuesto; el gateway es el único que firma URLs. El CLI se auto-actualiza descargando su fuente desde `/install/client_cli.py` (mecanismo aparte, sin cambios); el nuevo `/api/updates/cli/{channel}` queda para consultar versión.
- Verificado E2E contra R2 real (bucket `releases-folax`, account `071d1172…`): subida a R2, metadata pública apunta al gateway, descarga redirige a URL prefirmada de `r2.cloudflarestorage.com` que entrega el binario exacto, `/releases-info` eliminada.
- **PENDIENTE OPERATIVO (Railway)** 🔴: definir en el servicio gateway las 4 vars R2 (`R2_ACCOUNT_ID=071d1172730bf91c22924d149b67f95d`, `R2_BUCKET=releases-folax`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — están en el `.env` local). Sin ellas, prod cae al disco efímero. `boto3` ya está en requirements (Docker lo instala).

**F6.6 — UI de releases + Descargas + Folax Docs (completada 2026-07-04, verificada E2E 13/13)**:
- **Tab "Releases" en el panel admin** (`AdminPage.jsx`): formulario de publicación (versión, canal, título, changelog, checksum, archivo) + tabla de versiones. Sube con la **cookie de sesión** (nueva dependencia `admin_or_token` en `core/security/auth.py`: acepta sesión con rol admin O `X-Admin-Token`, para que el panel funcione sin exponer el token y el CI siga con token). Endpoint `POST /api/versions/upload` migrado a `admin_or_token`.
- **Página pública de Descargas** (`/descargas`, `pages/DownloadsPage.jsx`): card de la app de escritorio (botón a la última stable vía `GET /api/updates/latest/{channel}`, endpoint nuevo que nunca da 404) y card del CLI con comandos copiables por SO — Windows `irm <base>/install.ps1 | iex`, Linux/macOS `curl -fsSL <base>/install.sh | bash` — más instalación manual del fuente. Los scripts ya los generaba `installer.py`.
- **Folax Docs** (`/docs` y `/docs/:section`, `pages/DocsPage.jsx` + `pages/docsContent.jsx`): estilo code.claude.com, índice lateral por grupos + contenido central redactado (Introducción, Primeros pasos, CLI, App de escritorio, API, Planes y límites), pager anterior/siguiente. Pública.
- **Componentes**: `components/PublicNav.jsx` (barra común Docs/Descargas/Planes), `components/CodeBlock.jsx` (bloque con botón copiar), iconos nuevos en `Icons.jsx`. Estilos en `styles/public.css`. Enlaces "Documentación" y "Descargas" en el menú del perfil del sidebar.
- **Conflicto de ruta resuelto**: `/docs` colisionaba con la Swagger UI de FastAPI → Swagger movida a `/api/docs`, ReDoc a `/api/redoc`, OpenAPI a `/api/openapi.json` (en `app.py`), liberando `/docs` para la web.
- E2E: admin publica una versión desde el panel y aparece en la tabla; Descargas muestra el Desktop y los comandos del CLI (Windows/Unix); Docs navega entre secciones (SPA) con el código visible; enlaces del sidebar funcionan.

**F6.7 — Navegación del sidebar + rediseño de Ajustes (completada 2026-07-04, E2E 14/14)**:
- **Sidebar**: "Aplicaciones" ahora navega a `/descargas` (ya no es placeholder); botón destacado **"Mejorar plan"** (accent) → `/planes`, visible salvo plan advance; menú del engranaje reorganizado: **Planes** (→/planes), **Lenguaje** (deshabilitado, "Pronto"), **Ajustes** (→/account), Documentación, Panel admin (si admin), Cerrar sesión.
- **Ajustes** (`/account` y `/account/:section`, `pages/AccountPage.jsx` reescrito): la vista plana de "Mi cuenta" se convirtió en una sección con **sidebar interno** (estilo settings de Claude, con nuestro diseño crema/ink) y 5 secciones: **General** (perfil editable: nombre/apellido vía `PATCH /api/account/profile`; correo readonly; apariencia/idioma "Próximamente"), **Cuenta** (correo+verificación, cambiar contraseña por enlace usando `request-password-reset`, gestión de API keys movida aquí, cerrar sesión, eliminar cuenta "Próximamente"), **Privacidad** (texto + toggles y exportar "Próximamente"), **Facturación** (plan actual + "Ajustar plan"→/planes; método de pago/facturas/cancelar "Próximamente", F7), **Uso** (barras de cuota + gráfica 30 días). Estilos `.settings*`/`.set-*` en `account.css`.
- Backend: `PATCH /api/account/profile` (billing.py) + query `update_user_profile`.

**F6.9 — Pulido de UI: tabs animadas, logo, skeleton loading (2026-07-04, E2E 8/8)**:
- **Indicador deslizante** en las tabs del panel admin (`admin-tabs__indicator`): mide `offsetLeft/offsetWidth` de la tab activa con refs y anima `left/width`; el texto activo pasa a blanco con transición (ya no hay salto de fondo).
- **Logo a 30px** en los headers de página (AdminPage, AccountPage) y en `PublicNav`.
- **Skeleton loading** (`components/Skeleton.jsx` + shimmer en `base.css`, respeta `prefers-reduced-motion`) en las cargas reales: **historial del sidebar** (`HistorySkeleton`, mientras carga `/api/conversations`), **hilo de mensajes** al abrir `/c/:id` (`ThreadSkeleton`, mientras carga `/api/conversations/:id/messages`) y **contenido de Docs** (`DocsSkeleton`, transición breve al montar/cambiar sección). El resto sigue con la pantalla `app-loading`.

**F6.8 — Identidad de planes + header público + "Aplicaciones" (2026-07-04, E2E 11/11)**:
- **Color por plan** (`lib/planColors.js`): Gratuito `#676767`, Pro `#CE7F25`, Advance `#98A61F`. Aplicado al nombre del plan en `/planes` y al badge/pill del plan (fondo del color + texto blanco) en Ajustes y en el footer del sidebar.
- **"Descargas" renombrado a "Aplicaciones"**: ruta `/aplicaciones` (con redirect de `/descargas`), título de la página, enlaces del nav, botón del sidebar y textos de Docs.
- **Header público rediseñado** (`PublicNav.jsx`, usado en Planes/Aplicaciones/Docs): enlaces Documentación, Aplicaciones, Planes; a la derecha botón **Soporte** (`mailto:soporte@datacentgbx.online` — placeholder, ajustar el correo), enlace **Iniciar sesión** (→/auth, solo si no hay sesión) y botón **Probar FOLAX** (→ chat). Condicional a `useAuth`.

**Releases automáticos por CI — YA EXISTÍA** (`.github/workflows/tauri.yml`): al pushear un tag `v*`, compila el `.msi` de Tauri firmado (`tauri-action`, `TAURI_SIGNING_PRIVATE_KEY`) y lo sube solo a `POST /api/versions/upload` con `X-Admin-Token: FOLAX_ADMIN_TOKEN`; el gateway lo guarda en R2. Compatible con el backend reescrito. **Mejorado 2026-07-04**: deriva versión y canal del tag (`v1.2.3` → stable, `v1.2.3-beta`/`-rc` → beta), y la URL del server sale de la variable de repo `FOLAX_SERVER_URL` (default `remote.datacentgbx.online`). Requisitos operativos: que `ADMIN_TOKEN` del gateway de prod == secret `FOLAX_ADMIN_TOKEN`, y las vars R2 en Railway (si no, el .msi cae al disco efímero). Para publicar: `git tag v0.3.0 && git push --tags`.

---

## 6.10 ✅ F7 — Pagos con Stripe (implementada 2026-07-04; falta conectar credenciales)

**Proveedor: Stripe** (elegido por el usuario). Integración completa lista por variables de entorno (como R2). Verificada en modo degradado (10/10) + lógica de webhook con eventos simulados (10/10).

**BD**: `plans.stripe_price_id`; `subscriptions.{stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end}` (migración idempotente en `init_db`). Queries nuevas en `queries.py`: `get_plan_by_stripe_price`, `get_subscription`, `get_user_by_stripe_customer`, `set_stripe_customer`, `apply_stripe_subscription`, `downgrade_to_free`; `update_plan` admite `stripe_price_id`.

**Backend**: `core/billing/stripe_gateway.py` (checkout session modo subscription con Customer reusable, customer portal, `list_invoices`, `payment_method_summary`, verificación de firma y `handle_event`: `subscription.created/updated` → `apply_stripe_subscription`/activa plan, `subscription.deleted` → `downgrade_to_free`, `invoice.payment_failed` → audit; resuelve usuario por metadata o `stripe_customer_id`, plan por `stripe_price_id` o metadata). Router `payments.py` (`/api/billing`): `GET /config` (público, `{enabled, publishable_key}`), `POST /checkout`, `POST /portal`, `GET /status` (plan+renovación+método+facturas), `POST /webhook` (público, firma). `stripe` en requirements; `stripe_configured()`/`STRIPE_*`/`PUBLIC_BASE_URL` en `config.py`. Sin `STRIPE_SECRET_KEY` → `enabled:false` y 503.

**Web**: `PlansPage` consulta `/api/billing/config`; si habilitado, CTA "Suscribirme a X" → `POST /checkout` → redirige al checkout de Stripe; si no, "Próximamente". `AccountPage` sección Facturación con `/api/billing/status`: plan real, fecha de renovación/cancelación, método de pago, historial de facturas (enlace a Stripe), botón "Ajustar plan"/"Gestionar" → portal; retorno `?checkout=success` muestra aviso. Panel admin → tab Modelos → "Precios de Stripe" para pegar los `price_...` por plan.

**Cómo activarlo**: ver sección 0 arriba. **Pendiente**: crear productos/precios en Stripe, conectar `price_...`, poner `STRIPE_*` + `PUBLIC_BASE_URL` en Railway, configurar el webhook, probar en modo test (`4242...`).

---

## 6.11 ✅ Funciones de chat: compartir, adjuntar documentos, búsqueda web (2026-07-04)

Tres features de producto sobre el chat, verificadas E2E (12/9/9).

- **Compartir chat** (`conversations.share_token`): enlace público de solo lectura. Endpoints GET/POST/DELETE `/api/conversations/:id/share` (ownership) + `GET /api/shared/:token` (público, sin datos del dueño). Web: botón "Compartir" abre `ShareDialog` (crear/copiar/revocar); página `/s/:token` (`SharedPage`) con branding + CTA de registro.
- **Adjuntar documentos** (`POST /api/attachments`, `routers/attachments.py`): extrae texto de PDF (pypdf) / texto / código, trunca a 12k chars, rechaza binarios e imágenes (415), límite 5 MB. Web: botón de clip en `ChatInput` sube el archivo, muestra chips (con marca "recortado") y antepone el texto del documento al mensaje. `pypdf` en requirements.
- **Búsqueda en internet** ("modo investigar"): toggle del globo en `ChatInput`. Enfoque robusto (no tool-calling nativo, poco fiable en modelos pequeños): el gateway ejecuta la búsqueda e **inyecta los resultados como contexto** antes de responder, pidiendo citar fuentes. `core/inference/websearch.py` con proveedor configurable por env `WEBSEARCH_PROVIDER`: **duckduckgo** (default, sin key, `ddgs` en requirements), tavily (`TAVILY_API_KEY`), brave (`BRAVE_API_KEY`). El request `/v1/chat/completions` gana `web_search: bool`; el stream emite primero un chunk `{"folax_sources": [...]}` que el cliente muestra como cajita de "Fuentes". `apps/web/src/lib/stream.js` pasa el flag y captura las fuentes; `ChatPage` muestra el indicador "Buscando en internet…" y el componente `Sources`.

**Multimodal pendiente** (imágenes/audio/vídeo): imágenes requieren un modelo de visión en Ollama (VRAM); audio requiere Whisper aparte; vídeo se pospone. El endpoint de adjuntos ya rechaza esos tipos con un mensaje claro.

---

## 6.12 ✅ Rediseño completo de la app desktop → IDE FOLAX (2026-07-05)

`apps/desktop` (Tauri v2 + React 19) reescrita como **IDE ligero** con la identidad de la web (copia sincronizada de `base.css` + fuentes woff2 self-hosted en `apps/desktop/public/fonts/`; solo tema claro). Versión unificada **0.3.0** (package.json, Cargo.toml, tauri.conf.json). `productName`/`identifier` NO se tocaron (cadena del updater intacta).

- **Layout IDE**: ActivityBar 48px + explorador (FileTree) + editor central + chat derecho (paneles colapsables/redimensionables, persistidos) + StatusBar (conexión/modelo/plan con `planColors`/versión). `src/layout/`.
- **Auth dual** (`sections/Auth/AuthScreen.jsx`): login por email (endpoint nuevo; si el usuario ya tiene keys, crea una "FOLAX Desktop" vía `POST /api/keys` con la cookie de sesión) **o** pegar `folax_sk_` (validada con `GET /api/auth/me` Bearer). Config en **plugin-store** (`folax.settings.json`), ya no en localStorage; URL default `https://remote.datacentgbx.online` con opciones avanzadas.
- **Editor CodeMirror 6** (`src/editor/`, `src/store/editorStore.js`): tabs múltiples (un EditorState por pestaña, una sola EditorView), tema FOLAX claro, 7 lenguajes, Ctrl+S/W/Tab, confirmación al cerrar con cambios.
- **Chat SSE** (`src/chat/`, `src/store/chatStore.js`, `src/lib/stream.js` adaptado con Bearer): streaming token a token, detener, historial del backend (buscar/renombrar/borrar), markdown con bloques "Copiar"/"Insertar en editor", chip de contexto (archivo activo o selección), errores de cuota 429/403 en español con fecha de reset.
- **Seguridad Rust** (`src-tauri/src/lib.rs`): comandos fs confinados a la carpeta de trabajo (`set_workspace_root` + `ensure_inside_root` con canonicalize), sin fallback hardcodeado, límite 5 MB, CSP no nula en `tauri.conf.json`. Capability `dialog:default` añadida (faltaba).
- **Eliminado**: Terminal/Commands/Services/Workspace.jsx/Onboarding/Sidebar/TopBar legacy, CSS embebido (`dangerouslySetInnerHTML` → 0), CustomEvents, `react-icons` y `recharts` (Metrics ahora usa la gráfica SVG portada de la web + tiles de cuota de `GET /api/account/usage`).
- **Backend**: `core/gateway/app.py` añade orígenes CORS de Tauri (`http://tauri.localhost`, `tauri://localhost`, `localhost:1420`).
- **Pendiente de verificar**: build del MSI (no hay toolchain Rust en esta máquina; compila en CI `tauri.yml`) y prueba E2E de upgrade 0.2.x → 0.3.0 con el updater.

---

## 7. Fases posteriores (sin iniciar)

- **F8 — Calidad**: tests automatizados (no hay ninguno aún; los scripts E2E de verificación viven en scratchpad, no versionados), ruff/mypy, Sentry, backups verificados, docs de API, ToS/privacidad.

---

## 7. Mapa rápido de dónde está cada cosa

| Cosa | Dónde |
|---|---|
| Gateway (entry) | `core/gateway/app.py` → `uvicorn core.gateway.app:app` |
| Rutas API | `core/gateway/routers/` (auth, chat, conversations, billing, keys, versions, nodes_admin, admin, monitor, ws_status, installer) |
| Cuotas por plan | `core/billing/quota.py` (límites en tabla `plans`; seed en `BD/seeds/plans.sql`) |
| Panel admin (API) | `core/gateway/routers/admin_panel.py` (`/api/admin/*`, rol) + `nodes_admin.py` |
| Panel admin (web) | `apps/web/src/pages/AdminPage.jsx` + `styles/admin.css` (ruta `/admin`) |
| Releases / updates | `core/gateway/routers/versions.py` + `core/storage/r2.py` (R2 privado; descargas prefirmadas) |
| Descargas / Docs (web) | `apps/web/src/pages/{DownloadsPage,DocsPage,docsContent}.jsx` (rutas `/descargas`, `/docs`) |
| Swagger / OpenAPI | `/api/docs`, `/api/redoc`, `/api/openapi.json` (movidos para liberar `/docs`) |
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
