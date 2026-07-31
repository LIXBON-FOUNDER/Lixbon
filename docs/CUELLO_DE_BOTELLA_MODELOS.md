# Cuello de botella: un solo modelo para cinco roles

> Estado: **resuelto en su núcleo** (2026-07-31). Escrito el 2026-07-30 a raíz de "el
> agente no usa las herramientas" con `qwen2.5-coder:7b`.
>
> - **A, B, D, E → resueltos.** Existe un mapa rol→modelo en el gateway
>   (`core/inference/roles.py` + tabla `model_roles` + `GET /api/model-roles`), los roles
>   se resuelven por la **capacidad declarada** del modelo, el routing por nodo falla en
>   voz alta y hay `keep_alive` por rol.
> - **C → estaba sobreestimado**, ver la sección corregida.
> - **F y G → siguen abiertos** (fuera del alcance de esa tanda).
>
> Cómo funciona ahora está en la sección **[Solución implementada](#solución-implementada)**,
> al final. Lo de arriba se conserva como registro del diagnóstico.

## El problema en una frase

Lixbon trata «el modelo» como **una sola cosa configurable** (`config.model` en el CLI,
`currentModel` en el IDE, un campo `model` por request en el gateway), pero la aplicación
en realidad tiene **cinco roles de inferencia con requisitos incompatibles entre sí**.
Un único modelo no puede satisfacerlos a la vez, y con una sola GPU tampoco caben cinco
modelos cargados en paralelo.

Hoy el conflicto está tapado porque casi todo apunta al mismo modelo por defecto. En
cuanto se cambia de modelo (que es justo lo que pide el siguiente paso del roadmap),
el conflicto sale por varios sitios a la vez.

---

## Los cinco roles

| # | Rol | Entrada en el código | Requisito dominante | Modelo hoy |
|---|-----|----------------------|---------------------|------------|
| 1 | Chat + **agente** | `POST /v1/chat/completions` con `tools` (`core/gateway/routers/chat.py:85`), loop en `apps/cli/lixbon_cli/agent.py` y `apps/desktop/src/store/chatStore.js` | tool calling fiable + calidad de código + contexto grande | el de chat |
| 2 | **Ghost text / FIM** | `POST /api/fim` (`core/gateway/routers/chat.py:482`) → `ollama.generate(suffix=…)`; cliente en `apps/desktop/src/lib/fim.js` | **latencia** (dispara por pulsación) + tokens FIM | autodetectado |
| 3 | **Visión** | `POST /api/vision/describe` (`core/gateway/routers/chat.py:423`) + `ChatMessage.images` | multimodal | `moondream` |
| 4 | **Embeddings / RAG** | `core/delegation/embeddings.py:13`, búsqueda semántica del codebase | vector estable, barato | `nomic-embed-text` |
| 5 | **Delegación / router** | `core/delegation/embeddings.py:16-21` (`_PLAN_MODELS`, `_AUTO_MODELS`) | rapidez, clasificación | `llama3.x` / `phi` |

Los requisitos chocan de frente:

- **1 vs 2**: el agente quiere el modelo más grande posible; el ghost text quiere el más
  rápido. Son objetivos opuestos y hoy los sirve el mismo id de modelo.
- **1 vs 3**: los modelos de código punteros (qwen3-coder, devstral) **no son multimodales**;
  los multimodales no son los mejores programando.
- **2 vs 1**: FIM necesita que el modelo tenga tokens `<|fim_prefix|>/<|fim_suffix|>/<|fim_middle|>`.
  No todos los modelos con buen tool calling los traen.
- **4 y 5** son baratos y podrían convivir, pero compiten por la misma VRAM que 1.

---

## Puntos de acoplamiento que se rompen al cambiar de modelo

Todos verificados en el código actual. Son los que hay que tocar en cualquier solución.

### A. El ghost text se autoselecciona por el nombre del modelo ✅ resuelto

`apps/desktop/src/store/appStore.js:281` — `effectiveGhostModel()` cae a
`ids.find((id) => /coder|code/i.test(id))`.

Si se migra el chat a `qwen3-coder:30b` y se retira el 7b, **el autocompletado empezará a
usar el 30B en silencio** (su id contiene "coder"), disparando un modelo de 19 GB en cada
pulsación. No falla: se vuelve inusable, que es peor de diagnosticar.

> **Resuelto.** El modelo del ghost text lo decide el rol `fim`, que exige la capacidad
> `insert` de Ollama. El fallback `|| currentModel` desapareció de todos los caminos: sin
> modelo con FIM el autocompletado se **apaga** y Ajustes dice qué instalar.
> Regresión: `core/inference/test_roles.py::test_fim_sin_insert_devuelve_none`.

### B. El router de delegación está anclado a modelos que quizá ya no estén ✅ resuelto

`core/delegation/embeddings.py:16-21` lista literales `llama3.1:8b`, `llama3.2:3b`,
`phi4`, `mistral`, `deepseek-r1:7b`. Si ninguno está instalado, el fallback es
`"llama3.1:8b"` — un modelo que tampoco existe. `/mode delegate` deja de enrutar bien
sin dar un error claro.

> **Resuelto.** Los candidatos se derivan del catálogo real y de sus capabilities
> (`rank_candidates`, `pick_route_model`). Sin ninguno apto se devuelve `None` y
> `/api/delegate` responde 503 `role_model_unavailable`, en vez de llamar a Ollama con un
> modelo inventado. Tests en `core/delegation/test_delegation_routing.py`.

### C. Tarifas: modelo nuevo sin precio = 503 al usuario — ⚠️ sobreestimado

`core/billing/credits.py:68` — `resolve_pricing()` hace longest-prefix-match sobre
`model_pricing` y, si no hay fila aplicable ni `*`, lanza 503 `pricing_unavailable`.

> **Corrección (2026-07-31).** La fila comodín `'*'` («Tarifa estándar», $0.20/$0.60 por
> Mtok) **viene sembrada** en `core/persistence/database.py` y `delete_model_pricing` se
> niega a borrarla (`core/persistence/queries.py`). Un modelo nuevo cae a la tarifa
> estándar; **no** hay 503. Dar de alta el precio sigue siendo recomendable para cobrarlo
> bien, pero no es un bloqueante para añadir un modelo.
>
> El bloqueante real estaba en otro sitio: el plan `free` tenía
> `allowed_models = ["llama3.2","phi","gemma","qwen2.5:0.5b"…]` y `model_allowed()` hace
> prefix-match, así que **ningún modelo instalado casaba** y todo usuario gratuito recibía
> un 403 `model_not_allowed` inarreglable. Corregido a `NULL` (el plan gratuito se limita
> por mensajes/día y tokens/mes) con una migración idempotente que solo pisa el valor si
> sigue siendo el del seed viejo.

### D. El routing por nodo no falla cuando el modelo no está ✅ resuelto

`core/orchestration/orchestrator.py:210` — `best_node_for_model()`: si ningún nodo online
tiene el modelo, **devuelve el de mayor score igualmente**. La petición llega a un Ollama
que no tiene ese modelo y el error que ve el usuario es el crudo de Ollama, no un
"modelo no disponible" del gateway. Con varios modelos por rol repartidos entre nodos,
esto pasa a ser la norma.

> **Resuelto.** `best_node_for_model(model, strict=True)` devuelve `None` si ningún nodo
> online lo tiene, y `ollama_target(model, strict=True)` levanta `ModelUnavailable`, que
> el gateway traduce a 503 `model_not_available` con el modelo y los nodos online. Sin
> nodos online se sigue cayendo al Ollama local: es el camino de desarrollo, no un error.
> La comparación normaliza `:latest`. Tests en
> `core/orchestration/test_orchestrator_routing.py`.

### E. No se controla la residencia de modelos en VRAM ✅ resuelto

No hay ningún `keep_alive` ni `OLLAMA_MAX_LOADED_MODELS` en el repo (`core/inference/ollama.py`
manda `model`, `messages`, `options.num_ctx` y nada más). Con cinco roles activos, Ollama
descarga y recarga modelos constantemente: cada cambio de rol paga el coste de carga
completo. En una máquina con una GPU esto domina la latencia percibida.

> **Resuelto.** `keep_alive` por rol, configurable por env y editable en la BD. Cuidado:
> es un campo **top-level** del payload de Ollama (no va dentro de `options`) y no tiene
> nada que ver con `KEEPALIVE_SECONDS` de `core/inference/ollama.py`, que es el heartbeat
> SSE hacia el cliente.

### F. Los modelos chicos no cumplen el contrato de tool calling — 🔴 abierto

Medido contra Ollama local el 2026-07-30 con `qwen2.5-coder:7b`:

- **No emite los tags `<tool_call>`** aunque su plantilla de Ollama los define, así que
  Ollama nunca devuelve `tool_calls` estructurados: llegan como texto.
- Escribe los argumentos **con comillas simples** (`"content": 'console.log("hola");'`),
  que no es JSON válido.

Consecuencia observada: creaba carpetas y ejecutaba comandos, pero **nunca escribía
archivos**, y el loop se atascaba repitiendo el mismo paso. Mitigado en
`apps/cli/lixbon_cli/agent.py` con parseo tolerante (`_scan_object`, `_quotes_to_json`,
`_loads_lenient`) + regresión en `apps/cli/tests/test_agent_parsing.py`.

**`apps/desktop/src/lib/agentProtocol.js:75` (`parseLoose`) sigue con el mismo defecto: el
IDE fallará igual con este modelo.**

### G. `run_command` no tiene sandbox de rutas — 🔴 abierto

A diferencia de las herramientas de archivo (`resolve_safe_path`), los comandos de shell
corren con `cwd=workspace` pero pueden escribir donde quieran. En una prueba, un
`npm init -y --workspace=./demo` generado por el modelo escribió el `package.json` fuera
del workspace. Es la razón de que la aprobación de comandos sea un flag aparte de
`auto_approve`; conviene no unificarlos.

---

## Restricciones que enmarcan cualquier solución

**Hardware actual del nodo local:** RTX 3050, **6 GB de VRAM**. En esta máquina no entra
nada mayor, así que los cinco roles **se están turnando la misma GPU**: solo un modelo
grande puede estar residente a la vez, y de ahí salen los `keep_alive` por rol.

**Inventario real** (medido contra el Ollama local 0.31.1 el 2026-07-31 vía
`POST /api/show`). Corrige la tabla «Modelo hoy» de arriba: **`qwen2.5-coder:7b` ya no está
instalado**, y ningún modelo presente declara `insert`, así que **el rol FIM no se puede
servir hoy**.

| modelo | tamaño | `capabilities` | rol que resuelve |
|---|---|---|---|
| `deepseek-r1:8b` | 5.2 GB | `completion`, `tools`, `thinking` | `chat` |
| `qwen3:4b` | 2.5 GB | `completion`, `tools`, `thinking` | `route` |
| `moondream:latest` | 1.7 GB | `completion`, `vision` | `vision` |
| `nomic-embed-text:latest` | 0.3 GB | `embedding` | `embed` |
| — | — | ninguno con `insert` | `fim` → **sin servir** |

**Referencia de tamaños** (Q4, para dimensionar el nodo GPU):

| Modelo | Tamaño | Contexto | Tools | Notas |
|---|---|---|---|---|
| Qwen3-Coder 30B (MoE, 3.3B activos) | 19 GB | 256K | sí (~96% en código) | rápido pese al tamaño; FIM **a verificar** en Ollama |
| Qwen3.6 27B | ~17 GB | — | sí (~95%) | 77.2% SWE-bench Verified |
| GLM-4.7 32B | ~20 GB | 128K | sí (~94%) | mejor en contexto largo |
| Devstral Small 2 24B | 14 GB | — | sí | 46.8% SWE-bench Verified, hecho para el loop agéntico |
| Llama 3.3 70B | 48 GB+ | — | sí (~97% bien formadas) | mejor formato de llamada, peor relación calidad/velocidad en código |

**Aviso sobre FIM en Qwen3-Coder:** mantiene FIM, pero introduce formatos nuevos
(chat-FIM y search-and-replace, este último pensado para pasar por un proxy que lo
convierte), y la ficha de Ollama **no declara** capability de completion. `/api/fim`
depende del `suffix` de Ollama, es decir, de los tokens FIM clásicos. **Hay que probarlo
antes de migrar el rol 2.**

---

---

## Solución implementada

**Idea central:** Ollama ya sabe qué puede hacer cada modelo. `POST /api/show` devuelve
`capabilities` (`completion`, `tools`, `thinking`, `vision`, `embedding`, `insert`), así que
los roles se resuelven por **capacidad declarada** en vez de por regex sobre el nombre —
que era la causa raíz de A y B.

### Los cinco roles y su contrato

| rol | capacidad requerida | preferida | consumidores | `keep_alive` |
|---|---|---|---|---|
| `chat` | `completion` | `tools` | `/v1/chat/completions`, `/api/chat`, `/v1/completions`, Ctrl+K | `30m` |
| `fim` | `insert` | — | `/api/fim` | `10m` |
| `vision` | `vision` | — | `/api/vision/describe` | `60s` |
| `embed` | `embedding` | — | `/api/embed`, embeddings de delegación | `-1` (residente, 0.3 GB) |
| `route` | `completion` | `tools` | clasificador de `/api/delegate` + auto-títulos | `5m` |

`chat` y `route` piden ambos `completion` + `tools`, pero `route` elige **el más pequeño**
de los aptos y `chat` **el más grande**: clasificar debe costar poco. **Nunca `-1` en
`chat`** con 6 GB de VRAM: pinnearía 5.2 de 6 GB.

### Precedencia

**Del rol** (`core/inference/roles.py`, `resolve_from` es pura y testeable):

1. fila activa de `model_roles` con `model` no vacío → `source="db"`
2. env `MODEL_ROLE_<ROL>` → `"env"`
3. autodetección por capacidad requerida, prefiriendo la preferida → `"capability"`
4. si **ningún** modelo del catálogo declara capabilities (cluster de node_agents viejos),
   heurístico por nombre → `"capability-legacy"`, **excepto `fim`**, que nunca lo usa
5. nada → `model=None`, `source="none"` + `warning` con qué instalar

**De la petición HTTP** (`core/gateway/model_router.py`): rol `chat` → `payload.model` ›
`key_model` de la API key › rol. Los demás → `payload.model` › rol.

Un `model` explícito **nunca** se veta por capacidad (los clientes compatibles con OpenAI
siguen funcionando igual); solo se loguea un WARNING. `capabilities` ausente significa
**desconocido**, nunca «no soportado»: no descarta el modelo, solo lo ordena al final.

### Superficies

- `GET /api/model-roles` (auth de sesión o API key) → `{roles, capability_by_role, models}`.
  Incluye el catálogo para ahorrar un round-trip a `/v1/models`.
- Panel admin → pestaña **Roles**: las 5 filas editables (modelo, `keep_alive`, `num_ctx`),
  el `source` resuelto y el aviso. Asignar un modelo sin la capacidad da **409
  `capability_mismatch`**, salvo `force:true` (para pre-asignar antes del `ollama pull`).
- `metrics.model_info` + `agent_version` en el node_agent (contrato **aditivo**: `models`
  sigue siendo `list[str]`, así que un gateway viejo no se entera). `/api/show` se cachea
  por digest con tope de 8 por poll.
- El IDE consume los roles (`apps/desktop/src/lib/modelRoles.js`) y tolera 404 → cae a sus
  heurísticos. El CLI solo usa el rol `chat` para no preguntar qué modelo usar.

### Errores nuevos

| status | code | cuándo |
|---|---|---|
| 503 | `role_model_unavailable` | el rol no tiene modelo (ni BD, ni env, ni autodetección) |
| 503 | `model_not_available` | hay nodos online pero ninguno tiene el modelo pedido |
| 409 | `capability_mismatch` | el admin asigna a un rol un modelo sin su capacidad |

Se espera un **pico de 503** tras el despliegue: es lo que antes se enrutaba mal en
silencio, ahora dicho en voz alta.

### Variables de entorno

`MODEL_ROLE_{CHAT,FIM,VISION,EMBED,ROUTE}` (vacío = autodetectar),
`MODEL_KEEPALIVE_{CHAT,FIM,VISION,EMBED,ROUTE}`, `MODEL_ROLES_TTL_S`,
`MODELS_CACHE_TTL_S`. Documentadas en `.env.example`.

### Qué queda pendiente

- **F** — portar `parseLoose` (`apps/desktop/src/lib/agentProtocol.js:75`) al parseo
  tolerante que ya existe en `apps/cli/lixbon_cli/agent.py`.
- **G** — sandbox de rutas para `run_command`.
- **FIM sin modelo**: hasta que se instale uno con `insert` (p. ej.
  `ollama pull qwen2.5-coder:1.5b`) el ghost text queda apagado **a propósito**.
- Verificar FIM en Qwen3-Coder antes de migrar el rol 2 (ver el aviso de arriba).

## Ver también

- `core/inference/roles.py` — el resolvedor rol→modelo (y sus tests al lado)
- `core/gateway/model_router.py` — cómo se aplica a cada petición HTTP
- `docs/ESTADO_ACTUAL.md` — estado general del proyecto
- `apps/cli/tests/test_agent_parsing.py` — regresión del contrato de tool calling
- `core/gateway/routers/chat.py` — todos los endpoints de inferencia
