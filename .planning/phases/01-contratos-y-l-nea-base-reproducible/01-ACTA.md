# Acta de Phase 1 — contratos y línea base

Fecha: 2026-10-07 · Issue #25 · Requisitos BASE-01 a BASE-04 y REL-05 · Rama `cli` (`6a30592`)

Qué es: el registro de lo que Phase 1 entregó, lo que se decidió de hecho al adelantar Go (2026-10-06, opción B) y lo que sigue sin evidencia. Distingue **hecho con evidencia**, **decidido de hecho** (existe en el código y el CI, pero nadie lo aceptó explícitamente) y **pendiente**. No presume mejoras de rendimiento.

## 1. Estado por requisito

| Req. | Estado | Evidencia | Falta |
|---|---|---|---|
| BASE-01 línea base Python | Hecho (versión reducida) | `apps/cli/validation/REFERENCE.md`: 133 passed, 0 failed, entorno fijado con `requirements.lock` | Harness 01-01 (preflight, `--self-check`, hashes, bloqueo de red) |
| BASE-02 inventario y corpus | Parcial | 8 corpus en `validation/fixtures/` (`sse`, `tool_parse`, `workspace`, `edit`, `agent`, `state`, `mcp`, `documents`) que consumen Python y Go | Corpus de payloads/errores del gateway y de cancelación |
| BASE-03 destinos, CGO, helpers | Decidido de hecho, sin aceptar | §3 y §4 | Aceptación explícita del usuario |
| BASE-04 mediciones | **Pendiente** | Solo `apps/cli/audit/baseline-python.json` (histórica) | Escenarios equivalentes Python/Go (§6) |

## 2. Los dos fallos históricos

`test_input_box.py` (`KeyError: 'rows'`) no se reproduce en Windows con Python 3.13.14: pasan en la suite completa y 15/15 veces aisladas. Clasificación: **causa original no determinada**. La cifra 131/2 de `audit/EVALUACION_PYTHON_GO.md` no cuenta como ejecución nueva y el documento se conserva sin modificar. Si Python se retira (#36), esta clasificación queda como historia y no bloquea nada.

## 3. Matriz de destinos

Fuente: `release-cli.yml` (seis destinos, `CGO_ENABLED=0`) y `ci.yml` (job `cli-go` en tres sistemas). Cada celda separa lo que se ha comprobado de lo que no.

| Destino | Compila en release | Tests Go en CI | Instalador en CI (`install_e2e.py`) | Instalación/`update` en máquina real | Terminal física |
|---|---|---|---|---|---|
| windows/amd64 | sí | sí (windows-latest) | sí | **sí** (Windows 11: `install.ps1` de producción, `update` con el `.exe` en uso) | prueba manual en Windows |
| windows/arm64 | sí | no | no | no | no |
| linux/amd64 | sí | sí (ubuntu-latest) | sí | **sí**, según el autor (2026-10-07) | sin registrar |
| linux/arm64 | sí | no | no | no | no |
| darwin/arm64 | sí | sí (macos-latest, que es arm64) | sí | no | no |
| darwin/amd64 | sí | no | no | no | no |

Lectura honesta: arm64 de Windows y Linux y amd64 de macOS **solo se compilan**; no se ejecutan en ninguna parte. Hasta que alguien los pruebe, la matriz de soporte real es Windows amd64, Linux amd64 y macOS arm64 (esta última solo con CI).

Terminales (TERM-01/02, #22): matriz manual pendiente. Solo hay uso en Windows y emulación con `x/vt`.

## 4. Política CGO y helpers

Decidido de hecho y verificable en el código:

- **`CGO_ENABLED=0` en todos los binarios de release.** Ninguna función depende de una biblioteca nativa. Consecuencia: `go test -race` no corre en el entorno de desarrollo del autor (sin compilador C); el CI no lo usa.
- **PDF y Word**: extracción local en Go puro (`ledongthuc/pdf`, `archive/zip`), sin helpers (`DECISION-PDF-GO.md`). Límite conocido: PDF con `ToUnicode` roto.
- **Helpers opcionales**, solo para una función concreta y con mensaje claro si faltan:

| Función | Windows | macOS | Linux |
|---|---|---|---|
| `/paste`, Alt+V (imagen) | API de Win32, sin helper | `pngpaste` | `wl-paste` o `xclip` |
| Búsqueda (`search`) | recorrido propio en Go | igual | igual |
| Ejecutar comandos (`run_shell`, `!cmd`) | shell del sistema | shell del sistema | shell del sistema |
| Servidores MCP | lo que lance cada servidor (p. ej. `npx`) | igual | igual |

- **Sin `rg`**: a diferencia de Python, la búsqueda no lo necesita (el orden de salida difiere: léxico del recorrido).
- Python, `pip` y `prompt_toolkit`/`rich`/`pypdf` **no** son requisitos del binario Go.

## 5. Discrepancia del README

El README del CLI Python decía «Python 3 estándar, sin dependencias externas», pero `cli.py` instalaba `prompt_toolkit`, `rich` y `pypdf` con `pip` y `documents.py` usaba `python-docx` de forma opcional. Está reconciliada: los READMEs describen el binario Go (`700f938`) y la discrepancia deja de existir al retirar Python. Referencia: `REFERENCE.md`.

## 6. Mediciones (BASE-04) — pendiente

No hay mediciones comparables Python vs Go. Para que la comparación valga hay que fijar antes:

| Escenario | Qué se mide | Cómo |
|---|---|---|
| Arranque | tiempo hasta `status` y hasta caja de chat | 20 ejecuciones en frío y en caliente, mediana y p95 |
| Memoria | RSS tras el arranque y tras 100 turnos | `psutil`/`Get-Process` |
| Streaming | latencia al primer token y rendimiento con una respuesta larga | servidor SSE local con los bytes del corpus `sse` |
| Lectura parcial | `read_file` de rangos en un archivo grande | mismo archivo en ambos |
| Cancelación | tiempo desde Ctrl+C hasta el prompt con SSE silencioso | servidor falso que no envía datos |

Reglas: misma máquina, entorno, versiones y commit registrados; sin conexión a modelos; no se mide inferencia; no se afirma mejora sin la tabla. `apps/cli/audit/benchmark_baseline.py` puede servir de base para el lado Python.

## 7. Matriz de paridad (resumen para REL-05)

| Área | Implementada en Go | Con pruebas automáticas | Con evidencia real |
|---|---|---|---|
| Chat, SSE, cancelación (CHAT) | sí | sí, tres sistemas | proveedor OpenAI-compatible: sí (#21, ver abajo); gateway autenticado: sin registrar |
| Agente, 20 herramientas, aprobaciones (AGNT/TOOL) | sí | sí | chat con modelo local y Kilo Code (según el autor); uso de herramientas sin detallar |
| Sesiones, configuración (STATE) | sí | sí (corpus `state`) | sin registrar |
| TUI (TERM) | sí | emulador `x/vt` | solo Windows |
| Adjuntos, PDF/Word, portapapeles (DOC) | sí | sí (corpus `documents`) | PDF de Edge real; sin PDF de Word ni LaTeX |
| MCP (MCP-01) | sí | sí (corpus `mcp`) | `server-filesystem` real en Windows |
| Remoto móvil (REMOTE-01) | sí | sí (`internal/remote` y `test_remote_hub.py` del gateway) | **sin app móvil real** |
| Instalación y `update` (REL) | sí | sí, tres sistemas | Windows y Linux; macOS sin registrar |

Verificado por el autor el 2026-10-07 (#21): un modelo local y una API key de Kilo Code (compatible con OpenAI). No se registraron versiones ni qué servidor local era; queda pendiente anotarlos en `apps/cli/go/README.md`.

## 8. Decisiones registradas

1. Go es el lenguaje del CLI y Bubble Tea la UI (2026-10-05/06).
2. Se adelantó Go a Phase 1 (opción B). Esta acta es el cierre parcial de lo que se saltó.
3. La retirada de Python (#36) no se ejecuta hasta aceptar la paridad con esta acta, #21 y #22.
4. Sin firma de binarios del sistema operativo por ahora (#34).

## 9. Aceptación

Para dar Phase 1 por cerrada falta que el usuario marque:

- [ ] Acepta la matriz de §3 como soporte actual, con arm64 de Windows/Linux y amd64 de macOS como «solo compila».
- [ ] Acepta la política de §4 (`CGO_ENABLED=0`, helpers opcionales).
- [ ] Acepta cerrar BASE-01 con la referencia reducida (sin el harness 01-01), o pide construirlo.
- [ ] Acepta diferir las mediciones de §6 o pide hacerlas antes del cutover.

Mientras esas casillas estén vacías, BASE-03 y BASE-04 siguen pendientes y REL-05 no puede darse por aceptado.
