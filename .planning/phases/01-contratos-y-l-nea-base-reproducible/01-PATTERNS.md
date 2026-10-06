# Phase 1: Contratos y línea base reproducible — Pattern Map

**Mapped:** 2026-10-05
**Files analyzed:** 10 artefactos nuevos propuestos; nombres ajustables por el planner.
**Analogs found:** 6 / 10, todos parciales o por rol; ningún equivalente integral.

## File Classification

Las rutas siguientes son **nuevas**, no archivos existentes. CONTEXT no fija nombres; RESEARCH propone validation/, CONTRACTS.md, MATRIX.md y los consumidores. Se concretan nombres para los entregables implícitos, sin autorizar su implementación en este mapeo.

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/cli/validation/requirements.lock` (nuevo) | config | batch | Ninguno | sin análogo |
| `apps/cli/validation/preflight.py` (nuevo) | utility | batch | `apps/cli/tests/test_build_fresh.py` | parcial |
| `apps/cli/validation/CONTRACTS.md` (nuevo) | config/documentación | transform | `apps/cli/lixbon_cli/api.py`, `sse.py` | parcial: fuentes del contrato |
| `apps/cli/validation/MATRIX.md` (nuevo) | config/documentación | transform | Ninguno | sin análogo |
| `apps/cli/validation/fixtures/schema.json` (nuevo) | model | transform | Ninguno | sin análogo |
| `apps/cli/validation/fixtures/corpus.json` (nuevo) | model | transform | `apps/cli/tests/test_agent_parsing.py` | parcial: casos iniciales |
| `apps/cli/tests/test_contract_corpus.py` (nuevo) | test | batch, request-response, streaming | `apps/cli/tests/test_agent_parsing.py`, `test_build_fresh.py` | role-match |
| `apps/cli/validation/verify_corpus.mjs` (nuevo) | utility | batch, transform | `apps/desktop/src/lib/agentProtocol.js` | parcial: consumidor puro |
| `apps/cli/validation/measure_baseline.py` (nuevo) | utility | batch, file-I/O, streaming | `apps/cli/audit/benchmark_baseline.py` | role-match |
| `apps/cli/validation/BASELINE.md` (nuevo) | config/documentación | transform | Ninguno | sin análogo |

Los resultados JSON/JUnit/stdout/stderr son salidas futuras del harness, no fuentes a crear manualmente; registrarlos en un subdirectorio nuevo de validation con identidad de ejecución. No modificar `apps/cli/audit/`, las fuentes Python, el artefacto generado, UI ni Go durante esta fase de mapeo. Las reparaciones mínimas de referencia solo se podrán precisar después del diagnóstico; no se inventa una lista de fuentes que modificar.

## Pattern Assignments

### `apps/cli/validation/preflight.py` y comprobación de frescura del consumidor

**Analog:** `apps/cli/tests/test_build_fresh.py` (imports 6-11, carga 14-19, comprobación 22-30).

```python
import hashlib
import importlib.util
import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parents[1]
```

**Core pattern**, líneas 23-28:

```python
build = _load_build_module()
generated = build.generate()
on_disk = (CLI_DIR / "client_cli.py").read_text(encoding="utf-8")
gen_hash = hashlib.sha256(generated.encode("utf-8")).hexdigest()
disk_hash = hashlib.sha256(on_disk.replace("\r\n", "\n").encode("utf-8")).hexdigest()
assert gen_hash == disk_hash, (
```

Copiar carga explícita y comparación sin escritura. La ubicación propuesta del preflight también tiene `parents[1] == apps/cli`; recalcular si cambia. El análogo no fija dependencias, plugins, red ni sandbox: añadir diseño del RESEARCH, fallar por imports críticos ausentes y no importar `cli.py` para instalar automáticamente. No copiar la instrucción de regeneración como efecto automático.

### `apps/cli/validation/fixtures/corpus.json`

**Analog:** `apps/cli/tests/test_agent_parsing.py`, casos 23-35, 62-79 y 88-97. Son insumos sintéticos, no esquema portable existente.

**Core pattern**, líneas 74-79:

```python
def test_native_call_conversion():
    # OpenAI manda arguments como string; Ollama como objeto: los dos valen.
    as_string = {"id": "c1", "function": {"name": "mkdir", "arguments": '{"path": "src"}'}}
    as_object = {"id": "c2", "function": {"name": "mkdir", "arguments": {"path": "src"}}}
    assert native_call_to_internal(as_string) == {"tool": "mkdir", "args": {"path": "src"}}
    assert native_call_to_internal(as_object) == {"tool": "mkdir", "args": {"path": "src"}}
```

Transferir entradas y expectativas pequeñas a una sola copia JSON, conservando origen/commit, ID estable y disposición: aceptado, observación o discrepancia. La salida actual elimina el ID: registrar esto explícitamente, sin imponerlo al Go futuro. Añadir familias payload, SSE, errores, limpieza, cierre/cancelación y config sintética; el conjunto de tests de parsing no cubre todas. Separar bytes codificados base64/hex de eventos semánticos.

### `apps/cli/tests/test_contract_corpus.py`

**Analog:** `apps/cli/tests/test_agent_parsing.py`, imports 8-20 y llamadas directas 62-71.

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```

**Core pattern**, líneas 62-65:

```python
def test_unclosed_call_is_detected_and_hidden():
    raw = 'Voy a crearlo.\n{"tool":"write_file","args":{"path":"a.txt","content":"hola'
    assert has_unclosed_call(raw)
    assert clean_prose(raw) == "Voy a crearlo."
```

Copiar invocación de implementación real y expectativas observables; adaptar a parametrización con ID del corpus. No ejecutar herramientas descritas por fixtures. Inyectar configuración/estado temporal antes de imports con efectos, sustituir transporte y verificar timeout/cierre. El inventario de nombres dispone de comprobación concreta en líneas 82-85:

```python
def test_tool_schemas_match_executor():
    from lixbon_cli.agent import TOOL_SPECS

    assert {t["function"]["name"] for t in TOOL_SCHEMAS} == {name for name, _, _ in TOOL_SPECS}
```

La igualdad de nombres no demuestra equivalencia de argumentos ni permisos; abrir schemas/executor en ejecución antes de congelarlos. Los selectores inventory/baseline deben colectar casos y la ejecución futura debe registrar skips.

### `apps/cli/validation/verify_corpus.mjs`

**Analog:** `apps/desktop/src/lib/agentProtocol.js`, exportaciones puras 280-289 y 328-333. El archivo no tiene imports ni depende de DOM/Tauri; no existe aquí un runner compartido que copiar.

```javascript
export function extractToolCalls(text) {
  return iterToolCallSpans(text).filter((s) => s.call).map((s) => s.call);
}
```

```javascript
export function cleanProse(text) {
  return cutUnclosedCall(stripToolCalls(truncateFabricated(text)))
    .replace(/```[\w-]*\s*```/g, '')
    .replace(/```[\w-]*\s*$/, '')
    .trim();
}
```

Importar estas funciones desde el consumidor `.mjs`, cargar el mismo JSON y emitir resultados por caso, con fallo explícito ante discrepancias no aceptadas. No portar funciones al adaptador ni tratar este espejo como prueba de paridad. Los errores actuales del parser son datos a contrastar: `parseLoose` devuelve null tras el segundo fallo (líneas 144-148). Las políticas de comandos de líneas 53-66 son específicas del producto; no fusionarlas silenciosamente con Python.

### `apps/cli/validation/measure_baseline.py`

**Analog:** `apps/cli/audit/benchmark_baseline.py`, imports 2-18, medición 21-42, escenario 45-50, metadata 57-79 y fixture/limpieza 81-95. Copiar solo al archivo nuevo.

**Relojes y muestras**, líneas 27-38:

```python
wall = time.perf_counter()
cpu = time.process_time()
result = operation()
item = {
    "wall_ms": (time.perf_counter() - wall) * 1000,
    "cpu_ms": (time.process_time() - cpu) * 1000,
    "result_chars": len(result),
}
if allocations:
    item["peak_python_bytes"] = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
runs.append(item)
```

**Fixture y limpieza**, líneas 81-91:

```python
scratch = Path(tempfile.mkdtemp(prefix="lixbon-cli-audit-")).resolve()
fixture = scratch / "large.txt"
try:
    fixture.write_bytes((b"x" * 1023 + b"\n") * 16384)
    report["read_first_20_lines"] = {
        "file_bytes": fixture.stat().st_size,
        **measure(lambda: tool_read_file(scratch, "large.txt", 1, 20), allocations=True),
    }
finally:
    fixture.unlink(missing_ok=True)
    scratch.rmdir()
```

Preservar las muestras individuales; la implementación histórica retorna solo medianas. Añadir metadata requerida por RESEARCH y control de subproceso aislado para startup/cancelación. Medir RSS con método externo documentado por OS; `peak_python_bytes` mide asignaciones, nunca RSS. `stream_work` es replay de prefijos, no red/SSE/terminal. Tres repeticiones no justifican p95. Definir warm/cold y presupuestos después de medir; instrumentación on/off separada. Limpieza debe abarcar procesos/streams aun ante excepción, no solo fixture.

### `apps/cli/validation/CONTRACTS.md`

**Fuentes**, no plantilla documental: `apps/cli/lixbon_cli/api.py` 80-111, 215-238 y `apps/cli/lixbon_cli/sse.py` 70-113. Citar origen, commit y clasificación de cada comportamiento. Mantener API, terminal, permisos y recursos en secciones distintas; las discrepancias requieren decisión.

**Payload y omisiones**, `api.py` 229-238:

```python
if num_ctx:
    payload["num_ctx"] = int(num_ctx)
if tools:
    # Tool-calling nativo: el gateway se las pasa a Ollama, que las mete
    # en el template del modelo (modo agent).
    payload["tools"] = tools
if think is not None:
    payload["think"] = think
response = self._open("POST", f"{self.base_url}/chat/completions", payload, timeout=300)
return ChatStream(response)
```

Inventariar explícitamente false/null/vacío, source/client_id y headers; capturar con fake, sin login real. Las fuentes restantes señaladas por RESEARCH (cli, commands, agent, config, documents) son entradas para extracción posterior, no archivos nuevos ni autorización de edición.

## Shared Patterns

### Auth y errores observables del transporte

**Source:** `apps/cli/lixbon_cli/api.py`, líneas 82-93. **Apply to:** corpus, consumidor Python y CONTRACTS.

```python
headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
if auth and self.api_key:
    headers["Authorization"] = f"Bearer {self.api_key}"
data = None if payload is None else json.dumps(payload).encode("utf-8")
req = request.Request(url=url, method=method, headers=headers, data=data)
try:
    return request.urlopen(req, timeout=timeout)
except error.HTTPError as exc:
    body = exc.read().decode("utf-8", errors="replace")
    raise ApiError(_friendly_detail(body), status=exc.code) from exc
except Exception as exc:
    raise ApiError(f"Error de conexión: {exc}") from exc
```

`login` usa `auth=False` (108-111). Usar secretos sintéticos; no copiar red real al harness. Verificar status y mensaje con entradas controladas; sanitizar evidencia.

### Cierre y cancelación

**Source:** `apps/cli/lixbon_cli/api.py`, líneas 57-69. **Apply to:** consumidor Python y medición.

```python
def __iter__(self):
    try:
        yield from events_from_stream(self._response)
    finally:
        self.close()

def close(self) -> None:
    if not self.closed:
        self.closed = True
        try:
            self._response.close()
        except Exception:
            pass
```

Fake response debe registrar cierre/orden y permitir bloqueo controlado. La existencia de close no prueba cancelación de lectura bloqueada ni terminal real; conservar esa brecha en resultados.

### Transporte versus semántica

**Source:** `apps/cli/lixbon_cli/sse.py`, líneas 75-87 y 112-113. **Apply to:** corpus y contratos.

```python
for raw in response:
    line = raw.decode("utf-8", errors="replace").strip()
```

```python
yield from think_filter.flush()
yield ("done", None)
```

Registrar JSON inválido ignorado y EOF indistinguible de DONE como observaciones pendientes de aceptación. No asumir reconstrucción UTF-8 fragmentada por estas líneas. El filtro ThinkTagFilter retiene sufijos de tags (43-60): incluir tags divididos, separado de fragmentación de bytes.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/cli/validation/requirements.lock` | config | batch | No lock Python identificado en apps/cli; CI instala pytest sin fijarlo. Versiones/hashes se obtienen en ejecución, no se inventan. |
| `apps/cli/validation/MATRIX.md` | config/documentación | transform | No matriz verificable OS/arch/terminal/helpers/CGO. README e instaladores declaran objetivos, no soporte demostrado. |
| `apps/cli/validation/fixtures/schema.json` | model | transform | Los tests usan objetos inline; no hay esquema portable con origen/disposición/bytes. Usar diseño RESEARCH. |
| `apps/cli/validation/BASELINE.md` | config/documentación | transform | No documento con diagnóstico reproducido, gates y presupuestos aceptados. Evaluación histórica es fuente preservada, no PASS ni plantilla de soporte. |

## Metadata

**Analog search scope:** apps/cli (audit, tests, lixbon_cli), apps/desktop/src/lib y .github/workflows; listado acotado de 76 rutas.
**Files scanned:** 6 archivos fuente con lectura de contenido (5 analogías principales más api.py para contratos/transporte); búsquedas adicionales en CI/README/cli/documents.
**Pattern extraction date:** 2026-10-05.
**Project context:** AGENTS.md y directorios locales .codex/skills/.agents/skills no presentes en la consulta. Estado inicial: .planning/ y apps/cli/audit/ sin seguimiento; preservados.
**Limitaciones:** inspección estática; ningún test, benchmark, instalación, red externa, cambio de código/audit/config ni commit. Solo se escribe este mapa. Herramientas Read/Write nominales no disponibles en la sesión; lectura por Get-Content y escritura mediante apply_patch.
