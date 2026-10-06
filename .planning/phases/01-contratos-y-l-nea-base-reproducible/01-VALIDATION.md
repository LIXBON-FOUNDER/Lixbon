---
phase: 1
slug: contratos-y-l-nea-base-reproducible
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-10-05
---

# Phase 1 — Validation Strategy

Contrato de validación futura; ningún comando de pruebas de esta página se ejecutó durante la planificación. IDs y comandos corresponden a los cuatro planes; toda ruta nueva se crea por su tarea productora antes de invocarse. Estado draft y nyquist_compliant=false hasta ejecución y aceptación de evidencia.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | pytest existente; versión final fijada en el entorno de referencia |
| Config file | Entorno aislado y plugins externos desactivados; preparar en primer plan |
| Quick run command | python apps/cli/validation/reference_runner.py --suite freshness (después de 01-01-01) |
| Full suite command | python apps/cli/validation/reference_runner.py --suite full (runner elige intérprete fijado y aislamiento) |
| Estimated runtime | Sin medir; registrar al ejecutar y fijar límite basado en evidencia |

## Sampling Rate

- Tras cada tarea ejecutada: comando específico del mapa; usar el intérprete del entorno fijado.
- Tras cada ola: suite y consumidores del corpus disponibles, sin modo watch.
- Antes de aceptar la fase: suite completa, cero skips críticos, corpus Python/JS y resultados documentados.
- Latencia máxima: pendiente de medir; no asumir una duración de CI sin evidencia.
- Guardar collected/pass/fail/skip, returncode, JUnit, stdout/stderr, versiones y commit. Un error de fixture pendiente impide declarar referencia aceptada.

## Per-Task Verification Map

Los comandos de cada fila se ejecutan en el orden indicado dentro de un único bloque PowerShell, usando exactamente los bloques multilinea automated del PLAN correspondiente. Inmediatamente después de cada proceso externo ejecutar `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`; una secuencia separada solo por semicolon no es una verificación válida. Esto también aplica al gate --accepted del checkpoint, una vez existe acta explícita. Los comandos solo se ejecutan cuando existen los archivos y se cumplen las dependencias de la fila.

01-01-01 debe implementar y verificar dentro del --self-check del harness de referencia un caso negativo de propagación: primer comando con código distinto de cero y último comando capaz de devolver cero; el bloque conserva el primer código, devuelve FAIL y no ejecuta el último. El self-check devuelve cero únicamente cuando confirma ese rechazo; un control defectuoso devuelve código distinto de cero. Todos los self-checks de fallos esperados de esta fase siguen esa semántica. Ninguna simulación ni comando de validación se ejecuta durante esta revisión documental.

| Plan / task | Requirement | Threat ref | Secure behavior | Test type | Automated command / disposition | File exists | Status |
|---|---|---|---|---|---|---|---|
| 01-01-01 | BASE-01 | T-01-01-I/R/SC | Temp antes de imports, dependencias/colección/skips fallan | Tracer/negative | Bloque PowerShell `<automated>` de 01-01-PLAN.md, tarea 01-01-01: `python apps/cli/validation/reference_runner.py --self-check` → `python apps/cli/validation/reference_runner.py --suite freshness`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Nuevo runner creado en tarea; freshness existente | Pending |
| 01-01-02 | BASE-01 | T-01-01-R | Diagnóstico causal sin xfail ni skips | Unit/integration | Bloque PowerShell `<automated>` de 01-01-PLAN.md, tarea 01-01-02: `python apps/cli/validation/reference_runner.py --suite input-box` → `python apps/cli/validation/reference_runner.py --suite full`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Depende 01-01-01; tests existentes | Pending |
| 01-02-01 | BASE-02 | T-01-02-T/E | Corpus único, Node puro, tools solo datos | Tracer/contract | Bloque PowerShell `<automated>` de 01-02-PLAN.md, tarea 01-02-01: `python apps/cli/validation/reference_runner.py --pytest-file apps/cli/tests/test_contract_corpus.py --nodeid test_corpus_tracer` → `node apps/cli/validation/verify_corpus.mjs --self-check` → `node apps/cli/validation/verify_corpus.mjs`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Nuevos en tarea; depende 01-01 | Pending |
| 01-02-02 | BASE-02 | T-01-02-T/I | Fakes y quirks con provenance diferenciada | Contract | Bloque PowerShell `<automated>` de 01-02-PLAN.md, tarea 01-02-02: `python apps/cli/validation/reference_runner.py --pytest-file apps/cli/tests/test_contract_corpus.py` → `node apps/cli/validation/verify_corpus.mjs`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Depende 01-02-01 | Pending |
| 01-02-03 | BASE-02 | T-01-02-T | Oráculos revisados, diferencias visibles | Contract/manual | Bloque PowerShell `<automated>` de 01-02-PLAN.md, tarea 01-02-03: `python apps/cli/validation/reference_runner.py --pytest-file apps/cli/tests/test_contract_corpus.py --nodeid test_corpus_manifest` → `node apps/cli/validation/verify_corpus.mjs`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Depende 01-02-02 | Pending |
| 01-03-01 | BASE-03 | T-01-03-R/T | Soporte infundado rechazado | Tracer/negative | Bloque PowerShell `<automated>` de 01-03-PLAN.md, tarea 01-03-01: `python apps/cli/validation/verify_inventory.py --self-check` → `python apps/cli/validation/verify_inventory.py --check`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Nuevos en tarea; depende 01-01 | Pending |
| 01-03-02 | BASE-03 | T-01-03-R | Helpers y objetivos/evidencia separados | Source/contract | Bloque PowerShell `<automated>` de 01-03-PLAN.md, tarea 01-03-02: `python apps/cli/validation/verify_inventory.py --check` → `python apps/cli/validation/verify_inventory.py --self-check`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Depende 01-03-01 | Pending |
| 01-04-01 | BASE-04 | T-01-04-D/I | Subproceso/temp/timeout y RSS explícito | Tracer/harness | Bloque PowerShell `<automated>` de 01-04-PLAN.md, tarea 01-04-01: `python apps/cli/validation/reference_runner.py --preflight` → `python apps/cli/validation/measure_baseline.py --self-check` → `python apps/cli/validation/measure_baseline.py --scenario partial-read --smoke`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Nuevo en tarea; depende 01-01/02/03 | Pending |
| 01-04-02 | BASE-04 | T-01-04-D/R | Cinco escenarios, error no equivale a éxito | Harness/negative | Bloque PowerShell `<automated>` de 01-04-PLAN.md, tarea 01-04-02: `python apps/cli/validation/measure_baseline.py --scenario all --smoke` → `python apps/cli/validation/measure_baseline.py --scenario all --instrumentation off` → `python apps/cli/validation/measure_baseline.py --scenario all --instrumentation on` → `python apps/cli/validation/verify_acceptance.py --self-check` → `python apps/cli/validation/verify_acceptance.py --evidence`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Gate nuevo en tarea; depende 01-04-01 | Pending |
| 01-04-03 | BASE-03/04 | T-01-04-R | Decisión humana concreta, sin approval inferido | Decision/manual + mechanical | Bloque PowerShell `<automated>` de 01-04-PLAN.md, tarea 01-04-03: `python apps/cli/validation/verify_acceptance.py --accepted`; comprobar inmediatamente $LASTEXITCODE después de cada proceso y salir ante error | Depende 01-04-02 y acta explícita | Pending |

## Wave 0 Requirements

- [ ] Entorno de referencia fijado, preflight e imports críticos comprobados antes de la suite.
- [ ] Corpus y consumidores Python/JS creados antes de referenciarlos como comprobación disponible.
- [ ] Verificador de inventario y harness con escenarios sintéticos preparados antes del gate final.
- [x] Planner reemplazó filas provisionales con tareas y comandos exactos; ninguno ejecutado. Cero colección falla.

La preparación Wave 0 está embebida en el tracer productor de cada ola: 01-01-01 crea runner/preflight/lock, 01-02-01 crea corpus/tests/Node, 01-03-01 crea verificador de inventario, 01-04-01/02 crean harness/gate. wave_0_complete=false hasta ejecución; no se adelantan comandos sobre rutas ausentes.

## Edge/prohibition review pendiente

Informe de origen: BASE-01/02/03/04 unclassified, unresolved, verification=null; applicable=4, resolved=0, unresolved=4. Disposición manual futura por 01-01-02, 01-02-03, 01-03-02 y 01-04-02; checkpoint 01-04-03 confirma. Conservar original y delta con revisor/fecha/casos añadidos; no transformar revisión pendiente en edge-free PASS. Prohibiciones de producto: no historia como ejecución nueva, no quirks impuestos a Go, no soporte/budgets supuestos aceptados. Controles técnicos rutinarios quedan en registros STRIDE de planes.

## Manual-Only Verifications

| Behavior | Requirement | Why manual | Instructions |
|---|---|---|---|
| Elegir destinos/terminales y política CGO/helpers | BASE-03 | Decisión de producto y evidencia por plataforma | Revisar MATRIX con columnas objetivo, evidencia, pendiente y soporte aceptado; confirmar destinos concretos |
| Aceptar presupuestos comparativos | BASE-04 | Se derivan de línea base y objetivo de producto | Revisar resultados con entorno/método/unidades; aceptar números concretos antes de exigir equivalencia Go |
| Disponer discrepancias Python/desktop | BASE-02 | Observación actual no equivale automáticamente a contrato deseado | Revisar divergencias con expectativas explícitas y registrar disposición por caso |

## Validation Sign-Off

- [ ] Todas las tareas tienen verificación automática o dependencia de preparación explícita.
- [ ] No hay tres tareas consecutivas sin comprobación automática.
- [ ] Preparación cubre todos los comandos/rutas nuevos.
- [ ] No se usan flags watch ni suite parcialmente importable como PASS.
- [ ] Tiempo de feedback medido y aceptado.
- [ ] Estado de validación actualizado solamente después de ejecutar y aceptar evidencia.

Approval: pending.
