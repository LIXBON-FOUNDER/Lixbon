# Lixbon CLI — migración gradual de Python a Go

## What This Is

Migración gradual del cliente CLI de Lixbon para que sus usuarios puedan instalar binarios autónomos por plataforma. Go reemplazará el cliente Python después de comprobar los contratos de chat, agente, herramientas, terminal y conexiones; el backend de inferencia conserva su alcance actual.

## Core Value

El usuario instala y ejecuta un binario CLI soportado sin Python ni pip, conservando los contratos funcionales del cliente existente.

## Requirements

### Validated

Implementado en Go con pruebas automáticas, verde en el CI de Linux, macOS y Windows (14 de 31 requisitos v1, ver REQUIREMENTS.md): `status`, `models` y `chat --once` cancelable; protocolo SSE; agente con las 20 herramientas, aprobaciones, `/plan`, `/diff`, `/undo` y verificadores; contexto y compactación; sesiones y configuración compatibles con Python; límites de lectura/shell y limpieza del árbol de procesos; TUI Bubble Tea con 35 de 41 comandos `/`; perfiles de proveedor para servidores compatibles con OpenAI.

Nada está **aceptado**: falta evidencia con gateway autenticado, modelos reales, terminales físicas, móvil y release por plataforma.

### Active

- [~] Congelar contratos y reproducir la línea base Python (parcial: referencia y 6 corpus; faltan acta, matriz de destinos y mediciones).
- [~] Entregar chat --once Go cancelable en los destinos acordados (implementado; falta `setup` y validarlo contra gateway real).
- [x] Conservar agente, 20 herramientas, aprobaciones, workspace y JSON local (implementado con pruebas; falta PDF/Word en `read_file`).
- [ ] Alcanzar paridad de terminal, documentos, MCP y control remoto (en curso: TUI hecha; faltan MCP, remoto, adjuntos, PDF/Word, `/paste`, `/visual`, `setup`, `usage`).
- [ ] Distribuir, actualizar y recuperar binarios con autenticidad y aceptación de sustitución (no iniciado).
- [ ] Retirar la base Python del CLI y reorganizar el repositorio una vez aceptada la paridad (ver «Retirada de Python» en ROADMAP.md).

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

- **Stack**: Go 1.26 (`go.mod`); módulo `lixbon.com/cli` en `apps/cli/go/`, coexistiendo con Python. Terminal: Bubble Tea v2 a pantalla completa (decisión del usuario; el modo inline falló). Biblioteca PDF y política CGO siguen sin decidir.
- **Compatibility**: Python y su artefacto siguen siendo referencia hasta aceptar paridad y cutover; JSON, contratos del gateway e identidad key_name deben preservarse.
- **Platforms**: el CI ejecuta vet, pruebas y build en ubuntu, macOS y Windows, pero la matriz OS/arquitectura/terminales y la política CGO siguen sin acordar; no se promete soporte de destinos sin acuerdo y evidencia.
- **Architecture**: Compartir JSON Schema/fixtures con Python y desktop; no introducir core Rust vía CGO ni copiar indiscriminadamente políticas del desktop.
- **Safety**: Mantener aprobaciones, modo plan, rutas seguras, snapshots, límites, cancelación y limpieza de árboles de procesos por plataforma.
- **Evidence**: Comparaciones de rendimiento con mismo host, escenarios, payloads y gateway; distinguir builds instrumentados, p50/p95 y RSS. Objetivos numéricos se acuerdan antes de aceptación; ninguna promesa de velocidad actual.
- **Scope**: Integración futura de distribución gateway/Docker solo para artefactos CLI; no migra lógica de inferencia.
- **Coordination**: el trabajo de Go se hizo en una sola rama (`cli`) fuera de los planes GSD de Phase 1. Publicación y sustitución del instalador vigente no se han ejecutado y requieren autorización.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Go elegido por el usuario el 2026-10-05 tras debate Orca | Prioridad: binarios autónomos y distribución CLI; supersede la recomendación anterior de esperar un spike Rust | Confirmada: 14/31 requisitos implementados en Go; entrega aún no aceptada |
| Adelantar Go sin cerrar Phase 1 (opción B, 2026-10-06) | Avanzar el producto sin esperar acta, matriz ni mediciones | Desviación asumida; esos entregables siguen pendientes (issue #25) |
| Bubble Tea v2 a pantalla completa con scroll propio (2026-10-06) | El modo inline duplicaba la caja de entrada al encogerse la vista | Adoptada; se pierde el scrollback nativo y la selección exige Mayús |
| Perfiles de proveedor y modo genérico OpenAI (2026-10-06) | Usar el CLI con LM Studio, Ollama u OpenAI además del gateway Lixbon | Implementada; sin probar contra proveedores reales (issue #21) |
| Python permanece referencia y rollback hasta aceptación | Evitar sustitución con paridad parcial | — Pending |
| Compartir fixtures portables, no implementación desktop | Un contrato común sin acoplar Go, JS y Tauri | — Pending |
| Confirmar matriz OS/arquitectura y política CGO en fase 1 | Dependencias nativas pueden alterar autonomía y compilación | — Pending |
| Spike Rust opcional de 1–2 días, fuera del camino crítico Go | Solo iniciar con dueño desktop y fecha concretos; reabrir elección únicamente con paridad del corpus, Tauri Channel ordenado/cancelable, convivencia Cargo/Tauri, CI por destinos y ahorro de mantenimiento medible; sin porcentaje arbitrario de reutilización | — Pending: experimento no iniciado |
| Autenticidad y reemplazo recuperable antes del cutover | SHA-256 comparativo actual no acredita autenticidad de release | — Pending |

## Evolution

Después de cada fase, actualizar Active/Validated/Out of Scope y decisiones con evidencia; no marcar aceptación por resultados parciales. Al cerrar el hito revisar alcance, valor principal, paridad y reversibilidad.

---
*Last updated: 2026-10-06 tras alinear los documentos con el estado real del código (14/31 requisitos implementados).*

