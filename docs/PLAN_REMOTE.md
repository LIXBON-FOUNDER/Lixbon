# PLAN_REMOTE — Herramienta `/remote` (control remoto de sesiones IDE/CLI desde el móvil)

> Estado: **IMPLEMENTADO R0–R5 (2026-07-20)** — backend (hub + router + modelos +
> QR con segno + push Expo), CLI 2.1.0 (`/remote` con takeover y QR en terminal),
> IDE (modal QR + remoteStore por suscripción a chatStore + `/remote` en el chat),
> móvil 0.3.0 (sección Remote + deep link + push best-effort) y web (`/remote/:token`).
> Pendiente operativo: publicar `/.well-known/assetlinks.json` (App Links) y
> `google-services.json` en el build Android para que el push funcione.
> Equivalente funcional a `/remote-control` de Claude Code, adaptado a la
> arquitectura de Lixbon (gateway FastAPI + Postgres, CLI stdlib, IDE Tauri,
> móvil Expo RN, web React).

---

## 1. Objetivo

El usuario está trabajando con el agente en el IDE o el CLI y tiene que salir
de casa. Escribe `/remote` y, sin abrir puertos ni configurar nada:

1. La sesión aparece **inmediatamente** en la sección **Remote** de la app
   móvil (si la tiene abierta o instalada).
2. Se genera un **link** `https://lixbon.com/remote/<token>` y un **QR** que
   lleva a la misma sesión en la web, para quien no tenga la app.
3. Desde el móvil/web se ve el transcript **en vivo**, se pueden enviar
   prompts nuevos, interrumpir el turno y responder aprobaciones de
   herramientas. **Todo se ejecuta en la máquina de casa** — el móvil es un
   mando a distancia, nunca ejecuta herramientas.

`/remote stop` (o cerrar el IDE/CLI) termina la sesión y revoca el link.

---

## 2. Arquitectura general

```
   CASA                          NUBE (gateway Railway)              BOLSILLO
┌─────────────┐   SSE ↓ cmds   ┌──────────────────────┐  SSE ↓ eventos ┌──────────┐
│  CLI / IDE  │◄───────────────│      RemoteHub       │───────────────►│ App móvil│
│   (HOST)    │───────────────►│  (relay en memoria)  │◄───────────────│ (CONTROL)│
└─────────────┘  POST ↑ events └──────────────────────┘  POST ↑ cmds   └──────────┘
                                        │                               ┌──────────┐
                                   Postgres                             │ Web /remote│
                              (remote_sessions)                         │  (CONTROL) │
                                                                        └──────────┘
```

- El **host** (CLI/IDE) solo hace conexiones **salientes** al gateway →
  atraviesa NAT/firewall sin configuración.
- El **gateway** actúa de relay puro: no ejecuta nada, solo reenvía frames y
  persiste metadatos de la sesión.
- Los **controllers** (móvil, web) se conectan al mismo canal y reciben el
  transcript en vivo; sus comandos (prompt/interrupt/approve) viajan al host,
  que es la única autoridad de ejecución.

### 2.1 Transporte: SSE + POST (decisión clave)

El CLI es **stdlib puro** (`urllib` + parser SSE propio en `lixbon_cli/sse.py`)
— no hay cliente WebSocket disponible y no queremos añadir dependencias. El
móvil (`src/sse.js`), la web y el IDE ya consumen SSE del chat. Por tanto el
relay usa el mismo patrón **en los cuatro clientes**:

- **Bajada** (tiempo real): stream SSE de larga duración.
- **Subida**: `POST` normales. El host agrupa deltas del asistente en lotes
  (flush cada ~150 ms o al cerrar el turno) para no hacer un POST por token.

WS quedaría como optimización futura; no cambia el protocolo de frames.

### 2.2 RemoteHub (gateway, en memoria)

`core/gateway/remote_hub.py`:

```python
class RemoteHub:
    sessions: dict[str, RemoteChannel]
    # RemoteChannel: cola → host (comandos), colas → controllers (eventos),
    # buffer circular de los últimos N eventos (replay por seq), last_seen.
```

- Railway corre **1 réplica** → un hub en memoria es correcto. Si algún día
  hay N réplicas, se sustituyen las colas por Redis pub/sub sin tocar clientes.
- Cada evento lleva `seq` monotónico (lo asigna el host). El hub guarda un
  buffer de los últimos 500 eventos para reconexiones (`?from_seq=`).
- Heartbeat: el host manda `ping` cada 20 s; si el hub no ve nada en 60 s
  marca la sesión `offline` (no `ended` — el host puede reconectar).

---

## 3. Modelo de datos

Nueva tabla en `core/persistence/models.py` + migración Alembic:

```python
class RemoteSession(Base):
    __tablename__ = "remote_sessions"
    id            # str uuid corto (12 hex), PK
    user_id       # FK users
    source        # "cli" | "ide"
    title         # nombre del workspace/carpeta (p.ej. "LLM-DataCent")
    machine       # hostname de la máquina host
    status        # "online" | "offline" | "ended"
    share_token_hash  # sha256 del token del link/QR (nunca en claro)
    token_expires_at  # expiración del link (defecto: 24 h)
    created_at / last_seen_at / ended_at
```

Y para el aviso con la app cerrada (fase R5):

```python
class DeviceToken(Base):
    __tablename__ = "device_tokens"
    id, user_id, expo_push_token, platform, created_at, last_seen_at
```

---

## 4. Protocolo de frames (JSON)

Todos los frames: `{"type": ..., "seq": int, "ts": float, ...}`.

**Host → controllers** (vía `POST /events`, reenviados por SSE):

| type | payload | uso |
|---|---|---|
| `hello` | source, title, machine, mode, model | al conectar |
| `snapshot` | historial completo (mensajes ya renderizables) | al unirse un controller |
| `user_msg` | text, origin ("local"\|"remote") | eco de lo que se envió |
| `assistant_delta` | text acumulable | streaming del asistente |
| `assistant_done` | — | fin del turno |
| `tool_use` / `tool_result` | name, args resumidos / resumen del resultado | actividad del agente |
| `status` | "idle" \| "thinking" \| "running_tool" | indicador en el móvil |
| `approval_request` | id, tool, args, riesgo | tarjeta de aprobación remota |
| `bye` | reason | fin de sesión |

**Controllers → host** (vía `POST /commands`, reenviados por el SSE del host):

| type | payload | efecto en el host |
|---|---|---|
| `prompt` | text | se encola como si el usuario lo hubiera tecleado |
| `interrupt` | — | equivale a Ctrl+C del turno actual |
| `approve` | id, decision ("allow"\|"deny") | resuelve una `approval_request` |
| `request_snapshot` | from_seq | el host reemite snapshot/replay |

Reglas: el host aplica los comandos **entre turnos** (si está en medio de un
turno, `prompt` se encola y se muestra "1 en cola" en el móvil). El host
imprime/renderiza localmente todo lo que llega remoto, con etiqueta
`[remote]`, para que al volver a casa el contexto esté íntegro.

---

## 5. API del gateway (`core/gateway/routers/remote.py`)

Auth: API key `Bearer` (CLI/IDE/móvil) o cookie `lixbon_session` (web), igual
que el resto de routers.

| Método y ruta | Quién | Descripción |
|---|---|---|
| `POST /api/remote/sessions` | host | Crea sesión → `{id, share_url, share_token}` (token en claro solo aquí) |
| `GET  /api/remote/sessions` | controller | Lista sesiones del usuario (para la pantalla Remote) |
| `GET  /api/remote/sessions/{id}/commands` (SSE) | host | Stream de comandos hacia el host |
| `POST /api/remote/sessions/{id}/events` | host | Lote de eventos del transcript |
| `GET  /api/remote/sessions/{id}/stream?from_seq=` (SSE) | controller | Eventos en vivo (+replay) |
| `POST /api/remote/sessions/{id}/commands` | controller | prompt / interrupt / approve |
| `DELETE /api/remote/sessions/{id}` | ambos | Termina sesión + revoca token |
| `GET  /api/remote/subscribe` (SSE) | controller | Avisos en vivo: sesión creada/online/offline/ended → **la app ve la sesión al instante** |
| `POST /api/remote/claim` | dueño autenticado | `{token}` → valida hash+expiración+dueño → devuelve la sesión (la web sin login pasa antes por `/auth?next=…`) |
| `GET  /api/remote/sessions/{id}/qr.png` y `qr.txt` | host | QR del share_url: PNG/SVG para IDE y web, **unicode half-blocks para la terminal** |

QR generado en el gateway con **`segno`** (pure Python, sin dependencias
nativas — una línea en `requirements.txt`). Así el CLI sigue siendo stdlib.

### 5.1 Seguridad

- `share_token`: 32 bytes url-safe (`secrets.token_urlsafe`), guardado
  **hasheado** (mismo patrón que las API keys). Expira a las 24 h o al
  terminar la sesión; revocable desde CLI (`/remote stop`), IDE, app y web.
- **El token del link NO es una llave**: solo identifica la sesión. Todo
  acceso de controller (claim, stream, comandos, terminar) exige estar
  **autenticado como el dueño** (cookie de sesión web o API key). La web sin
  sesión redirige a `/auth?next=/remote/<token>` y vuelve tras el login; un
  token válido presentado por otra cuenta responde 404 (no revela nada).
  Mitigaciones extra: expiración corta, revocación, rate-limit en `/claim` y
  evento en `audit_events` por cada claim con IP.
- Las aprobaciones remotas respetan la **allowlist del agente ya existente**
  en el IDE: lo auto-permitido no pregunta; lo sensible genera
  `approval_request` que viaja al móvil.
- El transcript viaja por el relay y **se persiste** en `remote_events`
  (tabla propia, un evento por fila con el `seq` que reparte el hub). Se
  guardan los eventos con valor de conversación —`hello`, `snapshot`,
  `user_msg`, `assistant_done`, `tool_use`, `tool_result`, `notice`, `error`,
  `bye`—, no los deltas del streaming ni el estado. Con eso:
  - el replay al (re)conectar sale de la BD y sobrevive a un reinicio del
    gateway, no solo del buffer de 500 eventos en memoria;
  - una sesión **terminada** se sigue abriendo en modo lectura desde la app y
    la web (`GET /api/remote/sessions/{id}/transcript`), en vez de
    desaparecer; `GET /api/remote/sessions` devuelve `transcript_events` para
    saber cuáles tienen algo que releer.
  - tope de `REMOTE_MAX_EVENTS` por sesión (se conservan los últimos) y
    recorte de textos largos por evento.

---

## 6. Integración por cliente

### 6.1 CLI (`apps/cli/lixbon_cli/`) — recordar: `client_cli.py` se regenera con `build.py`, nunca a mano

- Nuevo `remote.py`: clase `RemoteLink` con un **hilo lector** del SSE de
  comandos (urllib, igual que el chat) y un publicador con cola + batching
  para `POST /events`.
- `cmd_remote(arg)` en `app.py`: sin arg → crea sesión, imprime link, QR
  unicode (`qr.txt`) y "Sesión visible en tu app móvil"; `stop` → termina;
  `status` → estado y controllers conectados.
- Los prompts remotos entran por la misma ruta que `_handle_input` → se
  ejecutan con `run_agent_turn` en el workspace local. Instrumentar
  `_stream_assistant` y el loop del agente para emitir los frames
  (callback opcional `on_event` para no acoplar).
- La cabecera de estado del CLI muestra `⛓ remote` mientras está activo.

### 6.2 IDE (`apps/desktop/`)

- Comando `/remote` en `src/commands/builtin.js` → store `remoteStore` que
  hace el mismo ciclo (crear sesión → `EventSource` de comandos → POST de
  eventos). Todo en el webview con `fetch`/`EventSource`: **cero Rust nuevo**.
- Modal con QR (SVG del gateway), link copiable, lista de controllers
  conectados y botón "Terminar sesión". Indicador persistente en la
  status bar del IDE.
- Los prompts remotos entran al mismo pipeline del chat en modo agente; las
  `approval_request` son las mismas tarjetas de `ApprovalCard.jsx`, ahora
  también resolubles desde el móvil (el primero que responda gana; el otro
  recibe el resultado).

### 6.3 App móvil (`apps/mobile/`) — sección **Remote**

- Entrada nueva en `Sidebar.js` (icono = mismo path que use la web) →
  `RemoteScreen.js`:
  - **Lista**: sesiones con título, máquina, badge CLI/IDE, estado
    (punto verde/gris) y última actividad. Suscrita a
    `/api/remote/subscribe` mientras está montada → **cuando el usuario
    ejecuta `/remote` en casa, la tarjeta aparece al instante**.
  - **Detalle** (`RemoteSessionScreen.js`): transcript en vivo reutilizando
    los componentes de burbujas/markdown de `ChatScreen`, indicador de
    estado del agente, input para prompts, botón interrumpir y tarjetas de
    aprobación. Reconexión con `from_seq` al volver de background.
- Deep link `lixbon://remote/{id}` (expo-linking ya está): si se escanea el
  QR con la app instalada, Android abre la app directo en la sesión
  (App Link verificado sobre `https://lixbon.com/remote/*`); si no, cae a
  la web. Es exactamente el comportamiento pedido.

### 6.4 Web (`apps/web/`)

- Ruta nueva `/remote/:token` → `RemotePage.jsx`: hace `claim`, y muestra la
  misma vista de detalle (reutilizando el renderizado de mensajes de
  `ChatPage`). Banner "Controlando la sesión de <machine>".
- Con sesión web iniciada, `/account` no cambia; la lista de sesiones remotas
  vive en la app móvil y en `/remote` (índice si logueado).

---

## 7. Fases de implementación

| Fase | Alcance | Toca |
|---|---|---|
| **R0** | Backend: modelo + migración, `remote_hub.py`, router `remote.py`, QR (`segno`), auditoría | core |
| **R1** | CLI `/remote` (host): remote.py, cmd_remote, instrumentación del agente, QR unicode | apps/cli (+ regenerar client_cli.py) |
| **R2** | IDE `/remote` (host): remoteStore, modal QR, status bar, aprobaciones compartidas | apps/desktop (solo JS) |
| **R3** | Móvil: sección Remote (lista + detalle en vivo + deep link) | apps/mobile |
| **R4** | Web: `RemotePage.jsx` + claim por token | apps/web |
| **R5** | Push con app cerrada: `expo-notifications`, tabla `device_tokens`, envío al crear sesión y en `approval_request` | mobile + core |
| **R6** | Hardening: rate-limits, expiraciones, tests del hub, docs de usuario | todo |

Orden de valor: R0→R1→R3 ya cumple el flujo principal (CLI → app móvil);
R2 y R4 completan IDE y fallback web.

## 8. Riesgos y decisiones abiertas

- **Batching vs. latencia**: 150 ms de flush es imperceptible; ajustar si el
  streaming se siente a saltos en el móvil.
- **Multi-controller**: permitido (móvil + web a la vez); las aprobaciones
  las resuelve el primero. Límite razonable: 5 controllers por sesión.
- **Sesión huérfana**: si el host muere sin `bye`, el timeout de 60 s la deja
  `offline` y un barrido diario la pasa a `ended` tras 24 h sin señales.
- **Privacidad del link**: quien tenga el link controla la sesión hasta que
  expire o se revoque — documentarlo en la UI ("no compartas este link").
