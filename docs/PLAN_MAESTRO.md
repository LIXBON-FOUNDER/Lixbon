# LIXBON — Plan Maestro: de proyecto LAN a servicio SaaS en producción

> Fecha: 2026-07-03
> Complementa a `INFORME_Y_PLAN.md` (diagnóstico y bugs). Este documento es el plan de ejecución definitivo con la topología ya decidida y el alcance nuevo incluido.

---

## 1. Decisiones tomadas (contexto fijo)

| Decisión | Valor |
|---|---|
| Hosting web + gateway + BD | **Railway** |
| Inferencia (primeras versiones) | **Tu GPU en casa**, expuesta vía **Cloudflare Tunnel** (uso personal) |
| Inferencia (futuro) | Servidor propio con GPU grande para modelos grandes |
| Web principal | **Chat tipo Claude/GPT** como producto central — **React + Vite**, manteniendo la organización actual (`components/`, `pages/`, `styles/`, etc.) |
| Monetización | Suscripciones: **3 planes — Gratuito, Pro y Advance** + métodos de pago |
| Base de datos | **Postgres en todos los entornos** — SQLite se abandona. Desarrollo local conecta a una **BD de staging en Railway**; **ninguna BD corre en tu PC**. Scripts versionados en la carpeta `BD/` |
| Cuenta de usuario | Estadísticas de uso, gestión de API keys, facturación |
| Distribución | Endpoints de actualización para **App Desktop** y **CLI** |
| Administración | Panel admin **solo para ti**: releases, modelos, nodos (PCs), usuarios |
| Releases | **Privado** — deja de ser página pública |

### Arquitectura de despliegue objetivo

```
                         INTERNET
                            │
              ┌─────────────┴─────────────┐
              │        RAILWAY            │
              │  ┌─────────────────────┐  │
   Usuarios ──┼─▶│  Gateway (FastAPI)  │  │
   Web/CLI/   │  │  + Web estática     │  │
   Desktop    │  └───┬──────────┬──────┘  │
              │      │          │         │
              │  ┌───▼───┐  ┌───▼───┐     │
              │  │Postgres│  │ Redis │    │
              │  └───────┘  └───────┘     │
              └──────────┬────────────────┘
                         │ HTTPS (Bearer token interno)
                         ▼
            Cloudflare Tunnel (gpu-01.datacentgbx.online)
                         │
              ┌──────────▼──────────┐
              │   TU PC CON GPU     │
              │  node_agent + Ollama│
              └─────────────────────┘
```

Puntos clave de esta topología:
- El gateway en Railway hace llamadas **salientes** al hostname del tunnel → no necesitas abrir puertos en casa.
- El tunnel expone **el node_agent, NO Ollama directo**, y toda llamada gateway→nodo va autenticada con un **token interno compartido** (`NODE_SHARED_SECRET`). Sin esto, cualquiera que descubra el hostname del tunnel podría usar tu GPU gratis.
- Cuando montes el servidor GPU grande, es **solo agregar otro nodo** en el panel admin — el orquestador ya balancea entre nodos; el código no cambia.
- Los archivos de releases (`.msi`, CLI) **no pueden vivir en el disco de Railway** (filesystem efímero). Van a **Cloudflare R2** (S3-compatible, sin costo de egreso) y la BD guarda solo la URL + firma.

---

## 2. Cambios estructurales de base (antes de las features)

### 2.1 Monorepo con Screaming Architecture

```
LIXBON/
├── core/                          # El motor request ↔ response
│   ├── gateway/                   # FastAPI: app, routers, middleware, lifespan
│   │   ├── routers/
│   │   │   ├── public/            # /v1/* (OpenAI-compat), auth, updates (lectura)
│   │   │   ├── account/           # /api/account/* — chat, stats, keys, billing del usuario
│   │   │   └── admin/             # /api/admin/* — releases, nodos, modelos, usuarios
│   │   └── middleware/            # CORS, security headers, rate limit, quota
│   ├── inference/                 # Cliente Ollama + streaming SSE (UNA implementación)
│   ├── orchestration/             # Orquestador, scoring, circuit breaker, registro de nodos
│   ├── delegation/                # Embeddings, clasificación, routing
│   ├── billing/                   # Planes, límites, suscripciones, webhooks de pago
│   ├── persistence/               # SQLAlchemy models + Alembic migrations (Postgres)
│   ├── security/                  # Sesiones, API keys, roles, hashing
│   └── node_agent/                # Agente que corre en cada PC con GPU
├── apps/
│   ├── web/                       # React + Vite — chat principal + cuenta + panel admin
│   │   └── src/
│   │       ├── components/        # UI reutilizable (se mantiene la organización actual)
│   │       ├── pages/             # chat, cuenta, precios, admin/...
│   │       ├── styles/            # CSS por página/componente como hasta ahora
│   │       ├── lib/               # cliente API único, helpers
│   │       └── hooks/ store/      # lógica separada de la presentación
│   ├── desktop/                   # Tauri (hoy "App LIXBON")
│   └── cli/                       # CLI modularizado (hoy client_cli.py)
├── BD/                            # Scripts de base de datos (esquema, migraciones, seeds)
│   ├── schema.sql
│   ├── migrations/                # Alembic
│   ├── seeds/                     # planes, usuario admin
│   └── scripts/                   # migración legacy, reset de staging, backups
├── infra/
│   ├── railway/                   # Dockerfile, railway.toml, healthchecks
│   ├── tunnel/                    # config de cloudflared para el nodo GPU
│   └── ci/                        # GitHub Actions (con secrets reales)
└── docs/
```

### 2.2 Base de datos: una sola, Postgres — en TODOS los entornos

Hoy mantienes `db_sqlite.py` y `db_mysql.py` **duplicados a mano (1.800 líneas)**. Eso muere. **SQLite se abandona por completo**, también en desarrollo:

- **SQLAlchemy** (modelos declarativos) + **Alembic** (migraciones versionadas) → un solo código de persistencia.
- **Producción**: Postgres gestionado de Railway (BD `LIXBON-prod`).
- **Desarrollo local**: el gateway corriendo en tu PC se conecta a una **BD de staging en Railway** (`LIXBON-staging`). **No corre ninguna base de datos en tu PC** — ni Postgres local, ni Docker, ni SQLite.
- Dos bases separadas en Railway, mismo esquema: staging para depurar, prod para usuarios. Cambiar entre ellas = cambiar `DATABASE_URL` en tu `.env` local. **Nunca apuntar el entorno de desarrollo a prod.**
- Consideración honesta: depurar contra staging requiere internet y añade ~50–150 ms de latencia por query respecto a una BD local. Para este proyecto es un trade-off aceptable a cambio de no tener nada corriendo en tu PC; si algún día molesta, levantar un Postgres local es trivial porque el código solo conoce `DATABASE_URL`.
- Ventaja clave: los bugs de concurrencia/SQL se ven en desarrollo igual que en producción — con SQLite se ocultaban.
- La única BD que existe es Postgres: sin ramas `if DB_BACKEND == ...` en el código.

**Carpeta `BD/` — scripts de base de datos versionados en el repo:**

```
BD/
├── schema.sql          # Esquema completo de referencia (generado desde los modelos)
├── migrations/         # Migraciones Alembic (histórico versionado de cambios)
├── seeds/
│   ├── plans.sql       # Seed de los 3 planes (Gratuito, Pro, Advance)
│   └── admin.sql       # Seed de tu usuario admin
└── scripts/
    ├── migrate_legacy.py   # Migración one-shot de los datos actuales (SQLite → Postgres staging/prod)
    ├── reset_staging.py    # Limpiar/recrear staging sin tocar prod
    └── backup.md           # Cómo respaldar/restaurar la BD de Railway
```

- Esquema nuevo (además de lo existente):

| Tabla | Propósito |
|---|---|
| `users` | + `email`, `role` (user/admin), `plan_id`, `email_verified` |
| `sessions` | Tokens de sesión web separados de API keys, con expiración |
| `plans` | los 3 planes — **Gratuito, Pro, Advance**: límites de req/día, tokens/mes, modelos permitidos, rate limit |
| `subscriptions` | usuario ↔ plan, estado, período, renovación |
| `payments` | historial de transacciones (id externo del proveedor) |
| `nodes` | registro de PCs GPU (reemplaza `nodes.json`): url, token, estado, gestionado desde el panel |
| `releases` | producto (`desktop`/`cli`), canal, versión, URL en R2, firma, changelog |
| `usage_quotas` | contadores por usuario/período para enforcement de límites |

### 2.3 Modelo de autenticación (rediseño completo)

| Credencial | Uso | Vida | Almacenamiento |
|---|---|---|---|
| **Sesión web** | Navegador (cookie `Secure`, `HttpOnly`, `SameSite=Lax`) | Horas/días, renovable | Hash en tabla `sessions` |
| **API key** (`LIXBON_sk_...`) | CLI, desktop, integraciones | Larga, revocable | **Solo hash** — se muestra una única vez |
| **Token interno de nodo** | Gateway → node_agent por el tunnel | Rotable | Env var en ambos lados |
| **Rol admin** | Panel admin | — | Columna `role`; tu usuario se marca por seed/env |

Esto elimina los tres defectos actuales: raw keys en BD, cookie==API key, y endpoints admin accesibles a cualquier registrado.

---

## 3. Plan por fases

Cada fase tiene **entregable verificable** y criterio de "hecho". Ninguna fase deja el sistema roto. Las estimaciones asumen dedicación parcial y sesiones de trabajo con IA.

---

### 🔴 FASE 0 — Contención de seguridad (1–2 días) — BLOQUEANTE

Nada se publica antes de esto. Sin dependencias, se puede hacer hoy.

| # | Tarea |
|---|---|
| 0.1 | Generar **nuevo par de claves Tauri**; invalidar el actual; mover a GitHub Secrets (`TAURI_SIGNING_PRIVATE_KEY`) |
| 0.2 | Proteger `POST /api/versions/upload` con token admin (parche mínimo mientras llega el rediseño de auth) |
| 0.3 | Sacar `.env` de git; **rotar** `MYSQL_PASSWORD` y `ADMIN_TOKEN` |
| 0.4 | `.gitignore` completo: `.venv/`, `*.db`, `*.msi`, `cloudflared.exe`, `.env`, `node_modules/`, `target/`, `dist/` |
| 0.5 | Purgar del historial: `.venv/` (2.100 archivos), `cloudflared.exe` (64 MB), `.msi`, `.env` — con `git filter-repo` |

**Hecho cuando:** el repo no contiene ningún secreto ni binario, la clave vieja no firma nada, y subir una versión requiere autenticación.

---

### 🟠 FASE 1 — Fundaciones: monorepo, Postgres, Railway (4–6 días)

El esqueleto sobre el que se construye todo lo demás.

| # | Tarea |
|---|---|
| 1.1 | Reorganizar a la estructura `core/ apps/ infra/ docs/` (mover código, arreglar imports — sin cambiar lógica) |
| 1.2 | Migrar persistencia a **SQLAlchemy + Alembic sobre Postgres**; eliminar `db_sqlite.py`/`db_mysql.py` y todo rastro de SQLite |
| 1.2b | Crear en Railway **dos Postgres**: `LIXBON-staging` (para depurar desde tu PC) y `LIXBON-prod`. El `.env` local apunta a staging vía `DATABASE_URL`; **nada de BD corriendo en tu PC** |
| 1.2c | Crear la carpeta **`BD/`** con `schema.sql`, `migrations/` (Alembic), `seeds/` (planes + admin) y `scripts/` (migración de datos legacy, reset de staging, guía de backups) |
| 1.3 | **Redis** para rate limiting, bloqueos de IP y sesiones (adiós dicts en memoria). Igual que la BD: el Redis vive en Railway; en desarrollo te conectas al de staging |
| 1.4 | `Dockerfile` del gateway + `railway.toml`; respetar `PORT` de Railway; healthcheck `/health` |
| 1.5 | Crear proyecto Railway: servicio gateway + Postgres + Redis; variables de entorno completas |
| 1.6 | Build de `apps/web` servido por el gateway (como hoy) — un solo servicio para simplificar |
| 1.7 | Migrar `on_event` → `lifespan`; logging estructurado (JSON) para los logs de Railway |
| 1.8 | Storage de releases → **Cloudflare R2**; el upload va a R2, la BD guarda URL + firma |
| 1.9 | Tests de humo: login, `/v1/models`, `/v1/chat/completions` (mock de Ollama), health |

**Hecho cuando:** `https://<tu-dominio>` responde desde Railway con la web actual funcionando contra Postgres, y un redeploy no pierde ningún dato.

---

### 🟠 FASE 2 — Conectividad GPU + corrección de bugs del core (3–5 días)

Conectar Railway con tu GPU de forma segura y arreglar la lógica rota detectada en el informe.

| # | Tarea |
|---|---|
| 2.1 | **Cloudflare Tunnel** en tu PC GPU: `cloudflared` exponiendo el node_agent en `gpu-01.datacentgbx.online` |
| 2.2 | **Auth gateway↔nodo**: `NODE_SHARED_SECRET` en header; el node_agent rechaza requests sin él. El node_agent pasa a hacer proxy de Ollama (Ollama nunca se expone directo) |
| 2.3 | Nodos en BD + CRUD (la gestión visual llega en Fase 6); eliminar `nodes.json` |
| 2.4 | 🐛 Scoring: nodo sin métricas ⇒ score penalizado, no perfecto |
| 2.5 | 🐛 `/api/chat` y `/api/delegate` enrutados por el **orquestador** (hoy ignoran los nodos) |
| 2.6 | 🐛 **Streaming persiste** mensaje del asistente + tokens al terminar |
| 2.7 | Unificar el streaming SSE en `core/inference` (hoy duplicado en 2 archivos); keep-alive real basado en tiempo (el actual solo se evalúa al llegar un chunk — no protege contra silencios largos del modelo) |
| 2.8 | `packaging.version` para comparar versiones; cerrar el `AsyncClient` fugado; watchdog sin duplicar procesos |
| 2.9 | Prueba end-to-end: request desde Railway → tunnel → tu GPU → respuesta streaming al navegador |

**Hecho cuando:** un chat desde la web pública en Railway genera tokens con tu GPU de casa, se guarda en historial y aparece en métricas.

---

### 🟡 FASE 3 — Rediseño de autenticación y roles (3–4 días)

Prerrequisito de suscripciones, panel admin y releases privado.

Decisiones de producto (2026-07-04): visitante sin cuenta VE el chat pero al enviar se le pide registro; OAuth Google/Apple pospuesto (botones ocultos) — email/contraseña primero. El diseño de la web (docs/DISENO_WEB.md) fija: login por email, registro con Nombre+Apellido.

| # | Tarea |
|---|---|
| 3.1 | Tabla `sessions` — cookie de sesión separada de API keys, expiración y renovación |
| 3.2 | API keys: solo hash en BD, prefijo visible (`LIXBON_sk_abc...`), se muestra completa una única vez |
| 3.3 | Roles `user`/`admin`; dependencia `admin_required`; tu cuenta marcada como admin por seed (ADMIN_EMAILS) |
| 3.4 | **Login por email** + registro con Nombre/Apellido + verificación de email (necesario para pagos y recuperación) |
| 3.5 | Recuperación de contraseña por email (Resend/SES — proveedor sencillo) |
| 3.6 | CORS con lista blanca real; cookies `Secure`; rate limits desde Redis |
| 3.7 | **IDOR fixes**: toda operación sobre keys/conversaciones verifica pertenencia al usuario |
| 3.8 | Migración de usuarios actuales (probablemente solo tú — trivial) |

**Hecho cuando:** existen dos niveles de acceso reales; una API key filtrada no da acceso a la web; un usuario no puede tocar recursos de otro.

---

### 🟡 FASE 4 — La web principal: chat tipo Claude/GPT (5–8 días)

El producto central. Se construye sobre streaming + historial ya arreglados en Fase 2.

| # | Tarea |
|---|---|
| 4.1 | Unificar los 2 frontends en `apps/web` (**React + Vite**), manteniendo la organización actual de `components/`, `pages/`, `styles/`; **un solo cliente API**; el desktop reutiliza módulos compartidos |
| 4.2 | UI de chat: sidebar de conversaciones, historial persistente, retomar conversaciones |
| 4.3 | **Streaming en la web** (hoy el dashboard espera la respuesta completa) con render markdown + código con copy |
| 4.4 | Memoria de conversación: enviar historial (con ventana de contexto) — hoy `/api/chat` manda solo el último mensaje, el bug de "chat sin memoria" |
| 4.5 | Títulos autogenerados (modelo pequeño), renombrar/eliminar conversaciones |
| 4.6 | Selector de modelos según plan del usuario; estados de nodo ocupado/offline con mensajes claros |
| 4.7 | Layout listo para tu nuevo diseño: la lógica (hooks/stores) separada de la presentación para que el re-skin no rompa nada |

**Hecho cuando:** la experiencia de chat es comparable a Claude/GPT en lo esencial: streaming fluido, historial, multi-conversación.

---

### 🟢 FASE 5 — Cuentas, límites y suscripciones (5–7 días)

Primero el sistema de planes y enforcement; el cobro real llega en Fase 7.

Los 3 planes del producto:

| Plan | Perfil | Límites (propuesta inicial — ajustables en BD sin tocar código) |
|---|---|---|
| **Gratuito** | Probar el producto | Modelos pequeños solamente; ~20–50 mensajes/día; 1 API key; rate limit bajo; sin acceso API programática o muy limitada |
| **Pro** | Usuario habitual | Todos los modelos estándar; cuota amplia de mensajes y tokens/mes; varias API keys; rate limit medio; estadísticas completas |
| **Advance** | Power user / integraciones | Todos los modelos incl. los grandes; cuotas máximas; API keys ilimitadas o tope alto; rate limit alto; prioridad en cola cuando haya contención de GPU |

Los números finales se calibran cuando midas el costo real por token en tu GPU (F2.9 da esos datos). Lo importante: los límites viven en la tabla `plans`, no hardcodeados.

| # | Tarea |
|---|---|
| 5.1 | Tablas `plans`, `subscriptions`, `usage_quotas`; seed de los 3 planes (**Gratuito, Pro, Advance**); plan **Gratuito** por defecto al registrarse |
| 5.2 | Definir límites por plan (tabla de arriba): mensajes/día, tokens/mes, modelos permitidos, nº de API keys, rate limit, prioridad |
| 5.3 | **Middleware de cuotas**: verifica límites antes de inferir; contadores en Redis con persistencia periódica a Postgres |
| 5.4 | Respuestas 429 con detalle (`límite alcanzado, se reinicia en X`) que la web muestra amigablemente |
| 5.5 | Página "Mi cuenta": plan actual, uso del período (gráficas — ya tienes `token_usage_daily`), gestión de API keys |
| 5.6 | Página de precios/planes (aunque el pago aún sea manual) |
| 5.7 | Asignación manual de planes desde admin (para dar Pro/Advance a testers antes de tener pagos) |

**Hecho cuando:** un usuario Gratuito choca con sus límites, lo ve claramente en su cuenta, y tú puedes subirle el plan a Pro o Advance a mano.

---

### 🟢 FASE 6 — Panel de administración (4–6 días)

Todo lo tuyo, protegido por rol admin. Releases deja de ser público.

| # | Tarea |
|---|---|
| 6.1 | Sección admin en la SPA, visible solo con `role=admin` (y validado en backend en cada endpoint) |
| 6.2 | **Releases (privado)**: subir instaladores Desktop y CLI a R2, canales stable/beta, changelog, firma; eliminar la página pública `/releases-info` |
| 6.3 | **Nodos**: alta/baja/edición de PCs GPU, ver métricas en vivo (CPU/RAM/GPU/modelos), forzar circuit breaker, token por nodo |
| 6.4 | **Modelos**: qué modelos existen en el cluster, en qué nodos, y a qué planes pertenecen |
| 6.5 | **Usuarios**: listado, plan, uso, bloquear/desbloquear, audit log |
| 6.6 | Dashboard global: requests/día, tokens totales, latencias, errores, estado de nodos |
| 6.7 | Endpoints de actualización públicos de **solo lectura**: `/api/updates/desktop/{channel}` (manifest Tauri) y `/api/updates/cli/{channel}` — el CLI ya tiene `/update`, se apunta aquí |

**Hecho cuando:** gestionas versiones, nodos, modelos y usuarios sin tocar la BD ni el código, y nadie sin rol admin ve nada de eso.

---

### 🔵 FASE 7 — Pagos (4–6 días)

| # | Tarea |
|---|---|
| 7.1 | Elegir proveedor: **Stripe** (global, mejor DX) o **Mercado Pago** (si tu mercado es LATAM y necesitas medios locales). Recomendación: Stripe si aceptas tarjetas internacionales; decisión tuya según tu país/usuarios |
| 7.2 | Checkout de suscripción (redirect al checkout del proveedor — no tocas datos de tarjeta, simplifica PCI) |
| 7.3 | **Webhooks**: pago exitoso → activar Pro/Advance; fallo/cancelación → degradar a Gratuito con período de gracia |
| 7.4 | Página de facturación en "Mi cuenta": método de pago, historial, cancelar/cambiar plan |
| 7.5 | Manejo de estados intermedios (pago pendiente, reintentos, reembolsos) |
| 7.6 | Modo test end-to-end antes de activar producción |

**Hecho cuando:** un usuario paga, su plan se activa solo, y una cancelación lo degrada sin intervención manual.

---

### 🔵 FASE 8 — Calidad, observabilidad y lanzamiento (continuo, 4–6 días de arranque)

| # | Tarea |
|---|---|
| 8.1 | Tests: unitarios (scoring, routing, cuotas, billing) + integración (auth, chat, límites) + CI que corre en cada PR |
| 8.2 | `ruff` + `mypy` en backend; `oxlint` ya está en frontend |
| 8.3 | Sentry (u similar) para errores en producción; alertas si el nodo GPU se cae |
| 8.4 | Backups automáticos de Postgres (Railway los tiene; verificar retención) |
| 8.5 | Página de estado simple (gateway, nodos, BD) — ya tienes el WS de status como base, agregándole auth |
| 8.6 | Documentación: onboarding de nodo GPU nuevo (para cuando armes el servidor grande), runbook de incidentes, docs de API pública |
| 8.7 | Términos de servicio y política de privacidad (necesarios al cobrar) |

---

## 4. Orden de dependencias

```
F0 (seguridad) ──▶ F1 (fundaciones) ──▶ F2 (GPU + bugs) ──▶ F3 (auth/roles) ──┬─▶ F4 (chat web)
                                                                              ├─▶ F5 (planes/límites) ──▶ F7 (pagos)
                                                                              └─▶ F6 (panel admin)
F8 (calidad) — transversal, empieza en F1 y nunca termina
```

F4, F5 y F6 pueden intercalarse según lo que quieras ver funcionando primero. Mi sugerencia de orden: **F4 → F6 → F5 → F7** (primero el producto que usas tú, luego tu panel, luego límites, y pagos al final cuando haya usuarios reales).

**Total estimado: ~5–7 semanas** de trabajo constante. Con sesiones intensivas de IA se comprime; lo que no se comprime es la validación end-to-end (tunnel, pagos, updates firmados).

---

## 5. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Tunnel caído = servicio sin IA | Alto | El gateway detecta nodo offline y muestra estado claro; alerta (F8.3); el circuit breaker ya existe |
| Tu PC GPU apagada mientras hay usuarios | Alto | Al inicio solo tú usas — aceptable. Antes de abrir a usuarios: horario definido o el servidor GPU dedicado |
| Costos Railway crecen con uso | Medio | Gateway es liviano (la inferencia va afuera); monitorear; los límites por plan controlan el consumo |
| Migración de BD rompe datos | Medio | Alembic + backup previo + toda migración se prueba primero en `LIXBON-staging` antes de aplicarse a prod |
| Depurar contra staging requiere internet / añade latencia | Bajo | Trade-off aceptado (nada corre en tu PC); si molesta, `DATABASE_URL` permite apuntar a un Postgres local sin cambiar código |
| Confundir staging con prod al depurar | Medio | `.env` local solo conoce staging; la URL de prod no se guarda en tu PC — vive únicamente en las variables de Railway |
| Reescritura de historia git | Medio | Hacerla en F0 con el repo respaldado; avisar si hay otros clones |
| Refactor grande sin tests | Alto | Tests de humo desde F1 (1.9), no esperar a F8 |
| Streaming SSE a través de CF Tunnel + Railway | Medio | Ambos soportan SSE; el keep-alive real de F2.7 lo protege; validar en F2.9 con prompts largos |

---

## 6. Primer paso inmediato

**Fase 0 completa** — es corta, no depende de ninguna decisión pendiente y elimina el riesgo crítico. Concretamente: rotar la clave Tauri, autenticar el upload, sacar secretos y binarios del repo.

A partir de ahí, el orden es el del diagrama. Cada fase termina con su criterio de "hecho" verificado en el entorno real (Railway + tunnel), no solo en local.
