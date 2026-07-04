# FOLAX DTC — Informe honesto de estado y Plan de refactor a producción

> Fecha: 2026-07-03
> Autor del análisis: revisión técnica completa del repositorio
> Alcance: backend (`app/`), CLI (`scripts/`), web (`frontend/`), app desktop (`App Folax/`), CI/CD e infraestructura.

---

## 1. Resumen ejecutivo (TL;DR)

El proyecto **funciona y tiene una base conceptual sólida**: un gateway compatible con la API de OpenAI, orquestación de nodos con scoring de CPU/RAM/GPU, circuit breaker, delegación por embeddings, dashboard web, app desktop Tauri con auto-update y un CLI ambicioso estilo "Claude Code". Para un proyecto LAN, está **por encima del promedio**.

Pero para **publicarlo en la web como un servicio real**, hoy **no está listo**, y hay **1 problema crítico de seguridad** que debe resolverse antes de cualquier despliegue público. La buena noticia: **lo que quieres es totalmente factible**, y la arquitectura actual, aunque desordenada en carpetas, tiene los componentes correctos. El trabajo grande no es reescribir la lógica —es **reorganizar, endurecer la seguridad y decidir la topología de red**.

**Veredicto:** Sí se puede hacer. Requiere un refactor estructural (screaming architecture) + un endurecimiento de seguridad + una decisión clave sobre cómo entran/salen las request cuando la IA corre en tu GPU. Nada de esto es un callejón sin salida.

---

## 2. Qué tan bueno es el proyecto (informe sincero)

### 2.1 Lo que está bien hecho 👍

- **Separación de responsabilidades en el backend.** `orchestrator`, `embeddings`, `security`, `db`, routers por dominio. Se lee y se entiende. El patrón de routers de FastAPI está bien aplicado.
- **Abstracción de base de datos** (`db.py` enruta a `db_sqlite` o `db_mysql` según env). Buena idea, bien ejecutada.
- **Circuit breaker con backoff exponencial** y round-robin de desempate en el orquestador: es lógica real, no de adorno.
- **Compatibilidad con la API de OpenAI** (`/v1/chat/completions`, `/v1/models`): decisión estratégica correcta, te abre integraciones (n8n, SDKs, etc.) gratis.
- **Migraciones idempotentes de esquema** (`_migrate_columns`): pensaste en compatibilidad con BD existente.
- **Hashing de contraseñas con scrypt + salt** y migración automática desde SHA-256 legacy: es lo correcto.
- **Rate limiting** por API key y anti-brute-force por IP.
- **Keep-alive SSE** en streaming para no morir con proxies: detalle que mucha gente olvida.
- **El CLI es sorprendentemente completo** (1.900+ líneas): modos ask/agent/delegate, tools de filesystem, aprobación de herramientas, autocompletado. Es la pieza más ambiciosa.
- **Auto-update de la app desktop** vía Tauri con manifest servido por el propio backend: buen circuito cerrado.

### 2.2 Cómo has trabajado (la parte honesta) 🪞

- **Trabajaste por acumulación, no por diseño.** Se nota que el proyecto creció "capa sobre capa": hay dos apps frontend (`frontend/` y `App Folax/`) con **dos clientes API distintos** (axios con cookies vs fetch con Bearer), tres `.msi` de releases viejos versionados en git, un `cloudflared.exe` de 64 MB commiteado, y **el `.venv` completo (2.100+ archivos, incluidos binarios `.so` de Linux) está en el repo**. Esto es deuda de higiene, no de lógica, pero pesa.
- **La seguridad se trató como "feature", no como "base".** Hay buenas piezas (scrypt, rate limit) al lado de agujeros graves (clave privada de firma commiteada, endpoint de subida de instaladores sin auth, `.env` con contraseña en git). Es el patrón típico de "lo hice funcionar y seguí".
- **Faltan tests por completo.** No hay un solo test automatizado. Para un servicio web esto es un riesgo permanente.
- **La nomenclatura mezcla español e inglés** (variables, endpoints, comentarios). No es un error, pero para una "screaming architecture" comprensible conviene unificar.
- **Copias de lógica duplicada.** `hash_password`/`verify_password` existen a la vez en `security.py` y en `db_sqlite.py`. El streaming SSE está duplicado en `orchestrator.py` y en `chat.py`. Los endpoints de dashboard init cargan de todo en una sola llamada.

En resumen: **buen instinto de producto, ejecución apresurada en los cimientos.** Es recuperable y vale la pena recuperarlo.

---

## 3. Bugs y problemas encontrados (por severidad)

### 🔴 CRÍTICO — resolver antes de exponer a internet

1. **La clave privada de firma de Tauri está commiteada en texto en el repo.**
   `.github/workflows/tauri.yml` contiene `TAURI_SIGNING_PRIVATE_KEY: "dW50cnVzd..."` en claro.
   → Cualquiera con acceso al repo puede **firmar actualizaciones maliciosas** que la app desktop instalará como legítimas. Es un compromiso total de la cadena de actualización.
   **Acción:** invalidar esa clave, generar un par nuevo, moverla a **GitHub Secrets** (`${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}`), y reescribir historia git o rotar por completo.

2. **`POST /api/versions/upload` no tiene autenticación.**
   `app/routers/versions.py` — cualquiera puede subir un `.msi` y registrarlo como versión "stable". Combinado con el punto anterior (o incluso sin él, si el cliente no verifica bien la firma), es un vector de **distribución de malware a todos los usuarios** vía auto-update.
   **Acción:** exigir token de admin / rol autenticado en ese endpoint. Ya mismo.

3. **`.env` versionado con credenciales reales** (`MYSQL_PASSWORD`, `ADMIN_TOKEN`).
   **Acción:** sacar `.env` de git, rotar esas credenciales, dejar solo `.env.example`.

### 🟠 ALTO — rompen funcionalidad o son inseguros en producción

4. **El nodo con el agente caído obtiene el MÁXIMO score (inversión de lógica).**
   `orchestrator.py:_poll_nodo` — si el agente de métricas no responde pero Ollama sí, se inyectan métricas falsas `cpu=0, ram=0, gpu_free=100`, dando **score perfecto**. Resultado: el orquestador prefiere justamente el nodo del que **no sabe nada**. En un cluster real, la carga se iría al peor sitio.
   **Acción:** cuando no hay métricas reales, usar un score neutro/penalizado, no perfecto.

5. **El chat del dashboard web y la delegación IGNORAN los nodos GPU.**
   `chat.py:api_chat` (`/api/chat`) y `chat.py:delegate_request` (`/api/delegate`) llaman directo a `_ollama_chat`, que usa `OLLAMA_BASE_URL` local — **nunca pasan por el orquestador**. Solo `/v1/chat/completions` usa los nodos. Es decir: tu propio dashboard no aprovecha el balanceo que construiste.
   **Acción:** enrutar ambos por `deps.orquestador.best_node_for_model(...)` con fallback local.

6. **En streaming NO se guarda la respuesta ni el consumo de tokens.**
   `chat.py:chat_completions` — cuando `stream=True`, el generador emite chunks pero **jamás llama a `save_message`**. Toda conversación en streaming se pierde del historial y de las métricas (`token_usage_daily`). Como la web/CLI usarán streaming, tus dashboards de uso quedarán vacíos o falsos.
   **Acción:** acumular el texto en el generador y persistir al terminar (`done`).

7. **CORS `allow_origins=["*"]` + `allow_credentials=True`.**
   `main.py` — combinación inválida/insegura: los navegadores rechazan credenciales con wildcard, y en producción abre la puerta a cualquier origen. `config.py` tiene `ALLOWED_ORIGINS="*"` por defecto.
   **Acción:** lista blanca explícita de dominios en producción.

8. **Las API keys se guardan en CLARO en la base de datos** (`api_keys.raw_key`) y `list_api_keys` las devuelve completas.
   Se hashea la key (`key_hash`) —bien— pero además se guarda el original, anulando el beneficio. Una filtración de BD = todas las keys expuestas.
   **Acción:** no persistir `raw_key`; mostrarla una sola vez al crearla. (Requiere ajustar el flujo de "reutilizar key en login").

9. **La cookie de sesión ES la API key.**
   `auth.py` guarda el `raw_key` como `session_token`. Sesión web y credencial de API son el mismo secreto: no se pueden revocar por separado y amplían el impacto de cualquier fuga.
   **Acción:** separar sesión (token de sesión con expiración corta) de API key (credencial programática).

### 🟡 MEDIO — deuda que escala mal en web

10. **Rate limiting y estado en memoria de proceso.** `security.py` guarda contadores en dicts globales. Con varios workers (gunicorn/uvicorn `--workers N`) cada proceso tiene su propio contador → el límite real se multiplica y es inconsistente. En web con múltiples réplicas, no sirve. **→ Redis.**
11. **SQLite sin WAL bajo concurrencia.** `check_same_thread=False` + conexión por request + escrituras concurrentes → "database is locked" bajo carga. Para web, o activar WAL/timeout o ir directo a MySQL/Postgres.
12. **`@app.on_event("startup"/"shutdown")` está deprecado** en FastAPI moderno. Migrar a `lifespan`.
13. **Comparación de versiones por igualdad de string** (`versions.py:check_update`: `latest_v != v`). `2.10.0` vs `2.9.0` no se compara bien. Usar `packaging.version`.
14. **El manifest de Tauri mete la firma en un campo llamado `checksum_sha256`.** Funciona por casualidad (el workflow sube ahí el `.msi.sig`), pero es confuso y frágil. Nombrar bien.
15. **`_ollama_chat` crea un `AsyncClient` nuevo si el compartido es `None` y nunca lo cierra** → fuga de conexiones en el path de fallback.
16. **El watchdog del node_agent hace `ollama serve` en subprocess** sin control de duplicados; puede lanzar múltiples instancias.

### 🟢 BAJO — higiene

17. `.venv/` completo commiteado (2.100+ archivos, binarios Linux en proyecto Windows). Sacar del repo.
18. `cloudflared.exe` (64 MB) y tres `.msi` viejos en git. Sacar; usar releases/artefactos.
19. Nomenclatura mixta español/inglés.
20. Sin tests, sin linter configurado en backend, sin type-checking.
21. Dos frontends con dos clientes API distintos y estilos duplicados.

---

## 4. Factibilidad: ¿se puede hacer lo que quieres?

**Sí, completamente.** Pero hay **una decisión de arquitectura de red que es tuya** y que define todo lo demás. La menciono con honestidad porque afecta directamente tu frase *"ya no tendremos que usar tunnels de cloudflare"*.

### El punto clave que debemos aclarar

Quieres: **(a)** publicar la web y el CLI en internet, y **(b)** ejecutar la IA con TU GPU. Eso implica que un usuario en internet manda una request → llega a tu servidor web → **debe llegar hasta tu GPU en casa** → vuelve la respuesta.

La pregunta es **dónde vive cada pieza**:

| Topología | Web/Gateway | GPU/Ollama | ¿Necesita túnel/ingress? |
|---|---|---|---|
| **A. Todo en tu PC con GPU** (con IP pública o port-forward) | Tu PC | Tu PC | No túnel, pero SÍ abrir puerto / DNS dinámico / reverse proxy |
| **B. Web en VPS + GPU en casa** | VPS cloud | Tu PC | **SÍ**, necesitas túnel, VPN o conexión saliente persistente |
| **C. Todo en un VPS con GPU** (alquilado) | VPS GPU | VPS GPU | No, es un servidor público normal |

**La honestidad técnica:** eliminar Cloudflare Tunnel **solo es posible en la topología A o C**. Si la web queda en un hosting y la GPU en tu casa (topología B, la más común y barata), **seguirás necesitando algún ingress** —puede no ser Cloudflare, pero será un túnel, una VPN (Tailscale/WireGuard) o que el gateway en casa abra un puerto público. No hay magia que evite eso: internet no puede alcanzar una GPU detrás de un router doméstico sin *algo* que cree el camino.

**Recomendación:** para empezar, **Topología A** — corre gateway + Ollama en tu PC con GPU, y expón el puerto 8000 a internet mediante:
- un **reverse proxy (Caddy/Nginx)** con TLS automático + tu dominio `datacentgbx.online`, y
- **port-forwarding** en tu router o un **DNS dinámico** si tu IP cambia.

Así el usuario y la IA se comunican por HTTPS directo contra tu máquina, sin Cloudflare, con request/response garantizadas. Cuando escales, migras a Topología C (VPS con GPU) sin tocar el código, solo el DNS.

> ⚠️ Decisión pendiente para ti: **¿la web vivirá en tu PC-GPU (A), en un VPS separado (B), o alquilarás un VPS con GPU (C)?** El plan de abajo asume **A** como punto de partida y deja B/C como evolución.

---

## 5. Arquitectura objetivo (Screaming Architecture)

La idea de "screaming architecture" es que al abrir el repo, la estructura **grite qué hace el sistema**, no qué framework usa. Propuesta de reorganización en 4 dominios claros + núcleo compartido:

```
folax/
├── core/                      # ⚙️ EL MOTOR: request ↔ response entre Usuario e IA
│   ├── gateway/               #    FastAPI: la API pública (OpenAI-compatible + interna)
│   │   ├── routers/           #    chat, auth, keys, versions, monitor, admin, ws
│   │   ├── middleware/        #    CORS, security headers, rate-limit
│   │   └── app.py             #    ensamblado + lifespan
│   ├── orchestration/         #    orquestador de nodos, scoring, circuit breaker
│   ├── inference/             #    clientes Ollama, streaming SSE (UNA sola implementación)
│   ├── delegation/            #    embeddings, clasificación, routing inteligente
│   ├── persistence/           #    db (sqlite/mysql/postgres), modelos, migraciones
│   ├── security/              #    hashing, sesiones, api keys, auth deps
│   └── node_agent/            #    agente de métricas que corre en cada máquina con GPU
│
├── apps/
│   ├── web/                   # 🌐 WEB: SPA React (unificar frontend/ aquí)
│   │   ├── src/features/      #    dashboard, chat, nodes, keys, delegation, releases
│   │   ├── src/shared/        #    ui, lib/api (UN cliente API), hooks
│   │   └── ...
│   ├── desktop/               # 🖥️ APP DESKTOP: Tauri (mover "App Folax" aquí)
│   │   ├── src/               #    React del desktop
│   │   └── src-tauri/         #    Rust + updater
│   └── cli/                   # ⌨️ CLI: cliente terminal estilo Claude Code
│       └── folax_cli/         #    dividir client_cli.py (1.900 líneas) en módulos
│
├── infra/                     # 🚀 INFRAESTRUCTURA
│   ├── docker/                #    Dockerfile del gateway, docker-compose
│   ├── reverse-proxy/         #    Caddyfile / nginx.conf con TLS
│   ├── scripts/               #    arranque, despliegue
│   └── ci/                    #    workflows (con secrets, no claves en claro)
│
├── docs/                      # 📚 este informe, arquitectura, runbooks
├── .env.example
└── README.md
```

**Regla mental:** *Web, CLI y Desktop son solo "caras" (clientes). El `core/` es el cerebro. La comunicación request/response vive en `core/gateway` + `core/inference` + `core/orchestration`.* Eso es exactamente lo que pediste separado.

Comparación con el modelo Claude que mencionaste:
- `core/gateway` ≈ la API de Anthropic (el servicio).
- `apps/web` ≈ claude.ai (chat + dashboard).
- `apps/cli` ≈ Claude Code.
- `apps/desktop` ≈ la app de escritorio / IDE.
- `core/orchestration` + `core/inference` ≈ el plano de cómputo que enruta a la GPU.

---

## 6. Plan de trabajo por fases

Ordenado para que en cada fase el sistema **siga funcionando** y de forma que lo urgente (seguridad) vaya primero.

### FASE 0 — Contención de seguridad (1–2 días) 🔴 BLOQUEANTE
Antes de tocar arquitectura. No se publica nada hasta cerrar esto.
- [ ] Rotar e **invalidar la clave de firma Tauri**; moverla a GitHub Secrets.
- [ ] **Autenticar** `POST /api/versions/upload` (token admin).
- [ ] Sacar `.env` de git, **rotar** `MYSQL_PASSWORD` y `ADMIN_TOKEN`, dejar solo `.env.example`.
- [ ] Añadir `.gitignore` correcto: `.venv/`, `*.db`, `*.msi`, `cloudflared.exe`, `.env`, `node_modules/`, `target/`, `dist/`.
- [ ] Purgar del repo `.venv/`, `cloudflared.exe`, `.msi` y (opcional) reescribir historia con `git filter-repo` para borrar los secretos ya commiteados.

### FASE 1 — Higiene y base de red para producción (2–4 días)
- [ ] `Dockerfile` para el gateway + `docker-compose` (gateway + Ollama + Redis + reverse proxy).
- [ ] **Caddy** (o Nginx) con TLS automático para `datacentgbx.online`, apuntando al gateway. Esto reemplaza a Cloudflare Tunnel en Topología A.
- [ ] CORS con lista blanca real; `lifespan` en vez de `on_event`.
- [ ] Health checks y logging estructurado.
- [ ] Definir y documentar la **topología de red elegida** (A/B/C).

### FASE 2 — Corrección de bugs de lógica (2–3 días)
- [ ] Arreglar el **scoring del nodo con agente caído** (score penalizado, no perfecto).
- [ ] Enrutar `/api/chat` y `/api/delegate` por el **orquestador**.
- [ ] **Persistir mensajes y tokens en streaming**.
- [ ] Unificar la implementación de streaming SSE (una sola, en `core/inference`).
- [ ] Comparación de versiones con `packaging.version`.
- [ ] Cerrar `AsyncClient` de fallback; arreglar watchdog duplicado.

### FASE 3 — Endurecimiento de auth para web pública (3–5 días)
- [ ] **Separar sesión de API key** (tokens de sesión con expiración; keys como credencial aparte).
- [ ] **Dejar de guardar `raw_key`** en claro; mostrarla una sola vez.
- [ ] Rate limiting y bloqueo de IP en **Redis** (compartido entre workers/réplicas).
- [ ] Cookies `Secure` + `SameSite` correctos para dominio HTTPS.

### FASE 4 — Refactor a Screaming Architecture (5–8 días)
- [ ] Crear la estructura `core/ apps/ infra/ docs/`.
- [ ] Mover backend a `core/` con los submódulos por dominio (sin cambiar lógica, solo ubicación + imports).
- [ ] **Unificar los dos frontends**: quedarte con uno (recomiendo `frontend/` como base web) y **un solo cliente API**. El desktop reusa componentes compartidos.
- [ ] Partir `client_cli.py` (1.900 líneas) en módulos dentro de `apps/cli/folax_cli/`.
- [ ] Mover CI a `infra/ci/` con secretos correctos.

### FASE 5 — Calidad y preparación de lanzamiento (3–5 días)
- [ ] Tests: unitarios del orquestador/scoring/routing + de integración de los endpoints de chat/auth.
- [ ] Linter + type-check en backend (`ruff` + `mypy`) y frontend (`oxlint` ya está).
- [ ] Documentación: README por dominio, runbook de despliegue, diagrama de topología.
- [ ] Nuevo diseño de web y desktop (cuando lo tengas) montado sobre `apps/web` y `apps/desktop`.

### FASE 6 — Escala (post-lanzamiento, opcional)
- [ ] Migrar SQLite → Postgres/MySQL gestionado.
- [ ] Métricas/observabilidad (Prometheus/Grafana) reusando el node_agent.
- [ ] Multi-GPU / multi-nodo real; probar el balanceo bajo carga.
- [ ] Si eliges Topología B/C: automatizar el ingress GPU (Tailscale/WireGuard o VPS-GPU).

---

## 7. Riesgos y cosas a vigilar

- **Reescribir historia de git** (para borrar secretos) es destructivo si hay otros clones/ramas. Coordinar antes.
- **Unificar los dos frontends** puede romper referencias; hacerlo en una rama y con el sistema andando en paralelo.
- **La decisión de topología** condiciona Fase 1. No avanzar en infra hasta decidirla.
- **Sin tests hoy**, cada refactor es a ciegas: por eso la Fase 5 (tests) idealmente se adelanta parcialmente a la Fase 4.

---

## 8. Conclusión

Construiste un producto con las piezas correctas y buen instinto, pero con los cimientos apurados. **No hay que tirar nada**: hay que ordenar, tapar los agujeros de seguridad (uno es crítico), arreglar cuatro bugs de lógica reales, y decidir cómo va a entrar y salir el tráfico hacia tu GPU. Lo que pides —web + CLI + desktop como servicio estilo Claude, con la IA en tu GPU y sin depender de Cloudflare— **es factible**, y esta estructura de carpetas lo deja explícito y mantenible.

El siguiente paso concreto es tuyo: **decidir la topología de red (A/B/C)**. Con eso definido, arranco la Fase 0 (seguridad) que no depende de nada más.
