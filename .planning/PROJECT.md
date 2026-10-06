# Lixbon CLI — migración gradual de Python a Go

## What This Is

Migración gradual del cliente CLI de Lixbon para que sus usuarios puedan instalar binarios autónomos por plataforma. Go reemplazará el cliente Python después de comprobar los contratos de chat, agente, herramientas, terminal y conexiones; el backend de inferencia conserva su alcance actual.

## Core Value

El usuario instala y ejecuta un binario CLI soportado sin Python ni pip, conservando los contratos funcionales del cliente existente.

## Requirements

### Validated

La evaluación documenta funciones existentes del cliente Python como referencia contractual. Ningún requisito del nuevo cliente Go está validado ni implementado por esta planificación.

### Active

- [ ] Congelar contratos y reproducir la línea base Python.
- [ ] Entregar chat --once Go cancelable en los destinos acordados.
- [ ] Conservar agente, 20 herramientas, aprobaciones, workspace y JSON local.
- [ ] Alcanzar paridad de terminal, documentos, MCP y control remoto.
- [ ] Distribuir, actualizar y recuperar binarios con autenticidad y aceptación de sustitución.

El detalle y la trazabilidad están en REQUIREMENTS.md.

### Out of Scope

- Migrar inferencia/backend o prometer aceleración del modelo — cambiar el cliente no modifica GPU, colas ni generación.
- Reescribir desktop o unificar sus políticas — el contrato compartido usa fixtures portables.
- OCR — no es paridad actual.
- Publicar o sustituir el instalador vigente durante esta planificación — distribución y aceptación pertenecen a la fase 5.

## Context

Fuente principal: apps/cli/audit/EVALUACION_PYTHON_GO.md, conservada sin modificaciones. El ingest de .planning/intel/SYNTHESIS.md y constraints.md no extrajo IDs de requisitos ni decisiones bloqueadas. La fuente recomienda comparar Rust antes de escoger lenguaje; la decisión posterior del usuario en .planning/DECISION-CLI-GO.md y debate Orca run_d06dd487975f elige Go ahora. Se conserva el historial sin atribuir al SPEC una elección que no hizo.

La auditoría registra en commit e1698683c0e9a787e0709f57bc8b6c880419db5d (CLI 2.3.0) 131 pruebas aprobadas y dos fallos con KeyError 'rows'. Son evidencia histórica, no resultados de esta planificación; no prueban un defecto visible de terminal. También registra benchmarks sintéticos Python con limitaciones de instrumentación. No hay benchmark equivalente Go ni aceptación contra gateway autenticado, móvil o terminal física.

El README afirma Python estándar sin dependencias externas; la evaluación identifica instalación de rich, prompt_toolkit y pypdf. La fase 1 debe reconciliarlo con un inventario real y distinguir núcleo autónomo de programas externos elegidos para shell, MCP o extracción.

## Constraints

- **Stack**: Go elegido; módulo propuesto apps/cli/go/ para coexistir con Python. Biblioteca de terminal, toolchain, PDF y versiones se deciden con evidencia, no están adoptadas.
- **Compatibility**: Python y su artefacto siguen siendo referencia hasta aceptar paridad y cutover; JSON, contratos del gateway e identidad key_name deben preservarse.
- **Platforms**: Matriz OS/arquitectura/terminales y política CGO/dependencias nativas pendientes en fase 1; no se promete soporte de destinos sin acuerdo y evidencia.
- **Architecture**: Compartir JSON Schema/fixtures con Python y desktop; no introducir core Rust vía CGO ni copiar indiscriminadamente políticas del desktop.
- **Safety**: Mantener aprobaciones, modo plan, rutas seguras, snapshots, límites, cancelación y limpieza de árboles de procesos por plataforma.
- **Evidence**: Comparaciones de rendimiento con mismo host, escenarios, payloads y gateway; distinguir builds instrumentados, p50/p95 y RSS. Objetivos numéricos se acuerdan antes de aceptación; ninguna promesa de velocidad actual.
- **Scope**: Integración futura de distribución gateway/Docker solo para artefactos CLI; no migra lógica de inferencia.
- **Coordination**: Trabajo posterior en Orca/GSD con dueños de archivos y separación de implementación, validación y revisión; esta entrega no ejecuta implementación ni publicación.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Go elegido por el usuario el 2026-10-05 tras debate Orca | Prioridad: binarios autónomos y distribución CLI; supersede la recomendación anterior de esperar un spike Rust | — Pending: decisión tomada, entrega aún no validada |
| Python permanece referencia y rollback hasta aceptación | Evitar sustitución con paridad parcial | — Pending |
| Compartir fixtures portables, no implementación desktop | Un contrato común sin acoplar Go, JS y Tauri | — Pending |
| Confirmar matriz OS/arquitectura y política CGO en fase 1 | Dependencias nativas pueden alterar autonomía y compilación | — Pending |
| Spike Rust opcional de 1–2 días, fuera del camino crítico Go | Solo iniciar con dueño desktop y fecha concretos; reabrir elección únicamente con paridad del corpus, Tauri Channel ordenado/cancelable, convivencia Cargo/Tauri, CI por destinos y ahorro de mantenimiento medible; sin porcentaje arbitrario de reutilización | — Pending: experimento no iniciado |
| Autenticidad y reemplazo recuperable antes del cutover | SHA-256 comparativo actual no acredita autenticidad de release | — Pending |

## Evolution

Después de cada fase, actualizar Active/Validated/Out of Scope y decisiones con evidencia; no marcar aceptación por resultados parciales. Al cerrar el hito revisar alcance, valor principal, paridad y reversibilidad.

---
*Last updated: 2026-10-05 after initialization from ingest and explicit Go decision.*

