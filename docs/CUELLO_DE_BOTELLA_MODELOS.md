# Cuello de botella: un solo modelo para cinco roles

> Estado: **diagnóstico, sin resolver**. Escrito el 2026-07-30 a raíz de "el agente no
> usa las herramientas" con `qwen2.5-coder:7b`. Documenta el problema estructural que
> hay debajo de ese síntoma para poder atacarlo después.

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

### A. El ghost text se autoselecciona por el nombre del modelo

`apps/desktop/src/store/appStore.js:281` — `effectiveGhostModel()` cae a
`ids.find((id) => /coder|code/i.test(id))`.

Si se migra el chat a `qwen3-coder:30b` y se retira el 7b, **el autocompletado empezará a
usar el 30B en silencio** (su id contiene "coder"), disparando un modelo de 19 GB en cada
pulsación. No falla: se vuelve inusable, que es peor de diagnosticar.

### B. El router de delegación está anclado a modelos que quizá ya no estén

`core/delegation/embeddings.py:16-21` lista literales `llama3.1:8b`, `llama3.2:3b`,
`phi4`, `mistral`, `deepseek-r1:7b`. Si ninguno está instalado, el fallback es
`"llama3.1:8b"` — un modelo que tampoco existe. `/mode delegate` deja de enrutar bien
sin dar un error claro.

### C. Tarifas: modelo nuevo sin precio = 503 al usuario

`core/billing/credits.py:68` — `resolve_pricing()` hace longest-prefix-match sobre
`model_pricing` y, si no hay fila aplicable ni `*`, lanza **503 `pricing_unavailable`**.
Añadir un modelo al nodo GPU **no es suficiente**: hay que darlo de alta en Tarifas o los
usuarios de pago se lo comen. Cada rol nuevo multiplica esta tarea.

### D. El routing por nodo no falla cuando el modelo no está

`core/orchestration/orchestrator.py:210` — `best_node_for_model()`: si ningún nodo online
tiene el modelo, **devuelve el de mayor score igualmente**. La petición llega a un Ollama
que no tiene ese modelo y el error que ve el usuario es el crudo de Ollama, no un
"modelo no disponible" del gateway. Con varios modelos por rol repartidos entre nodos,
esto pasa a ser la norma.

### E. No se controla la residencia de modelos en VRAM

No hay ningún `keep_alive` ni `OLLAMA_MAX_LOADED_MODELS` en el repo (`core/inference/ollama.py`
manda `model`, `messages`, `options.num_ctx` y nada más). Con cinco roles activos, Ollama
descarga y recarga modelos constantemente: cada cambio de rol paga el coste de carga
completo. En una máquina con una GPU esto domina la latencia percibida.

### F. Los modelos chicos no cumplen el contrato de tool calling

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

### G. `run_command` no tiene sandbox de rutas

A diferencia de las herramientas de archivo (`resolve_safe_path`), los comandos de shell
corren con `cwd=workspace` pero pueden escribir donde quieran. En una prueba, un
`npm init -y --workspace=./demo` generado por el modelo escribió el `package.json` fuera
del workspace. Es la razón de que la aprobación de comandos sea un flag aparte de
`auto_approve`; conviene no unificarlos.

---

## Restricciones que enmarcan cualquier solución

**Hardware actual del nodo local:** RTX 3050, **6 GB de VRAM**. `qwen2.5-coder:7b` (Q4, 4.7 GB)
ya va justo; con `num_ctx: 16000` se desborda a RAM. En esta máquina no entra nada mayor,
así que los cinco roles **se están turnando la misma GPU**.

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

## Direcciones de solución (sin decidir)

1. **Modelo por rol, no por sesión.** Introducir un mapa `rol → modelo` en el gateway
   (`chat`, `fim`, `vision`, `embed`, `route`) en vez de que cada cliente mande un `model`
   suelto. Resuelve A, B y D de raíz y deja las tarifas (C) en un solo sitio.
2. **Separar el modelo del agente del de autocompletado** aunque el resto siga igual: es
   el 80% del beneficio con el menor cambio (hoy ya son endpoints distintos).
3. **Fijar residencia en VRAM** con `keep_alive` por rol: largo para chat/agente, corto
   para visión, permanente para embeddings (es diminuto).
4. **Que el gateway falle claro** cuando el modelo pedido no esté en ningún nodo, en vez
   de enrutar a ciegas (D).
5. **Portar el parser tolerante al IDE** (F) — mismo bug, mismo fix ya escrito en Python.
6. **Sanear las listas de delegación** (B) para que se deriven de los modelos realmente
   disponibles en los nodos, no de literales.

## Decisiones abiertas

- ¿El nodo GPU va a tener VRAM para dos modelos grandes a la vez, o los roles 1 y 2
  comparten uno y se asume la latencia?
- ¿La visión se queda con un modelo pequeño dedicado (`moondream`) o se adopta un
  multimodal grande y se acepta que programe peor?
- ¿El mapa rol→modelo es global del gateway, por nodo, o configurable por usuario
  (y entonces, cómo se tarifa)?

## Ver también

- `docs/ESTADO_ACTUAL.md` — estado general del proyecto
- `apps/cli/tests/test_agent_parsing.py` — regresión del contrato de tool calling
- `core/gateway/routers/chat.py` — todos los endpoints de inferencia
