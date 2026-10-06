# ADR-001: CLI Go modular con migración gradual

**Status:** Reconsidered; compare Rust shared core before selecting implementation language
**Date:** 2026-10-05
**Deciders:** Mantenedores de Lixbon y responsable del producto CLI.

## Context

Se acordó trabajar en `cli` y evaluar primero la transición del cliente Python a Go; el backend se considera después. La CLI actual, versión 2.3.0 en `e169868`, integra chat, un agente con 20 herramientas, sesiones, MCP stdio y remoto. La fuente tiene 9.963 líneas y tres archivos concentran el 62,2 %.

La distribución de un archivo Python depende de Python/pip y de paquetes instalados durante el uso. La revisión y los benchmarks locales detectaron procesamiento repetido de prefijos durante streaming y lecturas completas para rangos pequeños. La suite local produjo 131 aprobadas y dos fallos del fixture de caja de entrada. Evidencia y contratos: [evaluación](EVALUACION_PYTHON_GO.md).

No se ha implementado Go ni comparado ambos runtimes. Latencia de inferencia, GPU y funcionamiento en producción no se midieron.

## Decision

Proponer una nueva CLI en `apps/cli/go/`, con núcleo separado de terminal y transportes, estado explícito, cancelación propagada y buffers acotados. Migrar por grupos funcionales, usando el cliente Python como referencia hasta alcanzar paridad y mejores resultados medidos.

Mantener API del gateway, `key_name="lixbon CLI"`, `source="cli"`, formatos de configuración y sesiones, herramientas y mecanismos de aprobación. El backend de inferencia permanece fuera de la primera fase. La distribución de binarios exige una integración posterior con los instaladores del gateway.

## Options Considered

| Dimensión | A: optimizar Python actual | B: traducir directamente a Go | C: CLI Go modular por etapas |
|---|---|---|---|
| Complejidad inicial | Baja a media | Alta: UI, SO, documentos y releases siguen requiriendo rediseño | Alta, controlada por entregables pequeños |
| Costo de transición | Menor; reutiliza comportamiento existente | Alto; abundante trabajo antes de comparar paridad | Alto; coexistencia y fixtures, con evidencia temprana |
| Rendimiento potencial | Puede resolver los costos algorítmicos detectados | Limitado si conserva reconstrucciones y capturas completas | Mejora algoritmos, presupuestos y coordinación de recursos |
| Distribución | Conserva Python y dependencias o requiere empaquetarlos | Ejecutable central; resolver extractores y plataformas | Ejecutable central y estrategia explícita de funciones opcionales |
| Concurrencia/mantenimiento | Hilos y estado mutable requieren disciplina | Puede conservar acoplamiento y crear carreras nuevas | Estado por dueño, interfaces, contexto y pruebas de carreras |
| Familiaridad del equipo | El repositorio evidencia experiencia en Python | Experiencia Go del equipo por confirmar | Curva de aprendizaje explícita; estándar Go y pocas dependencias |

**A — Pros:** entrega mejoras locales con menor esfuerzo y conserva compatibilidad. **Cons:** no satisface por sí sola el objetivo de un núcleo ejecutable sin Python y mantiene la distribución autoinstalable actual.

**B — Pros:** puede adelantar cobertura sintáctica de funciones. **Cons:** conserva costos del diseño original y hace difícil atribuir diferencias funcionales o de rendimiento. La traducción de parsing, shell y terminal no es mecánica.

**C — Pros:** satisface el objetivo Go y permite comprobar compatibilidad y límites en cada etapa. **Cons:** requiere mantener temporalmente dos clientes, reconstruir cobertura de contratos y resolver extracción documental y actualización Windows.

## Trade-off Analysis

Se recomienda C por el objetivo explícito de transición y por la amplitud de funciones actuales. A continúa siendo una opción válida si el primer prototipo muestra beneficios insuficientes frente al costo; sus mejoras algorítmicas no dependen del lenguaje. La inferencia corre remotamente, por lo que los beneficios esperados se concentran en distribución, trabajo local y respuesta de la interfaz.

El SDK MCP oficial reduce mantenimiento del protocolo. Bubble Tea v2 se propone para unificar I/O, sujeto a una prueba de scrollback, teclado y resize en los terminales objetivo. PDF necesita evaluación de fidelidad y licencia: un helper temporal conserva funciones, pero introduce una dependencia opcional que debe declararse. No se cambia a SQLite, CGO o procesamiento remoto de documentos sin evidencia de necesidad.

## Consequences

- Se vuelve posible distribuir el núcleo sin Python/pip y coordinar requests y herramientas con cancelación explícita.
- La optimización exige limitar copias, lectura, salida y renderizado; usar Go por sí solo no valida una mejora.
- La interfaz del agente se desacopla de la terminal, facilitando replays y comparación funcional.
- Se añade mantenimiento temporal de Python/Go y una matriz de build/update por OS/arquitectura.
- Se conservan datos locales; compatibilidad de caracteres Unicode y BOM requiere tratamiento explícito.
- Se deben revisar dependencias y fidelidad documental, cierre de procesos hijos, varias CLI concurrentes y protocolo remoto durante desconexiones.

## Action Items

1. [ ] Completar baseline de arranque/RSS y aclarar fallos actuales de terminal; hacer reproducible el entorno de CI.
2. [ ] Extraer fixtures de HTTP/SSE, llamadas del agente, remoto y JSON legado sin credenciales reales; compartir el corpus de protocolo con el desktop JavaScript.
3. [ ] Crear núcleo Go: configuración, subcomandos, HTTP/SSE y chat `--once`; medir contra la misma entrada.
4. [ ] Resolver prototipo de terminal y corpus documental; fijar toolchain y dependencias.
5. [ ] Migrar herramientas, contexto y aprobación; añadir validación de rutas, procesos y concurrencia.
6. [ ] Completar UI, sesiones, MCP y remoto; comprobar paridad de todos los comandos.
7. [ ] Coordinar instaladores, releases, actualización recuperable y rollback.
8. [ ] Sustituir el cliente distribuido únicamente después de cumplir los criterios funcionales y de rendimiento.

## Revisión de stack: Rust compartido con Tauri

La CLI no es el único consumidor del protocolo de agente. El escritorio Tauri ya tiene un host Rust (`apps/desktop/src-tauri`) y un parser JavaScript que se declara espejo del parser Python (`apps/desktop/src/lib/agentProtocol.js`). Si la prioridad principal ahora es reducir implementaciones duplicadas entre CLI y desktop, comparar Rust como lenguaje del núcleo antes de empezar Go.

| Stack | Reutilización | Coste y riesgo | Cuándo conviene |
|---|---|---|---|
| Go CLI + Bubble Tea + SDK MCP Go | Mantiene Go para CLI; parser/agente del desktop permanece JS salvo contrato compartido | Dos o tres implementaciones del agente; corpus común evita deriva contractual, pero no comparte ejecución | Si pesa más experiencia del equipo, distribución Go o autonomía de la CLI |
| Rust CLI + Ratatui + `lixbon-core` compartido con Tauri | Una implementación Rust del protocolo y de las partes puras del agente; frontend JS se limita a presentación e IPC | Reorganiza el agente actual y requiere adaptar comandos/canales Tauri; curva de aprendizaje Rust | Si pesa más reducir duplicación y aprovechar el host Rust ya existente |
| Go CLI que llama a una biblioteca Rust por cgo | Reutiliza una parte del core | Añade ABI C, ownership/memoria entre runtimes, compilador nativo y matriz de builds por OS/arquitectura | No recomendado para el núcleo del producto |

### Stack Rust concreto para un prototipo

- `apps/cli/rust/` como binario CLI y `crates/lixbon-core/` como biblioteca compartida con el crate Tauri existente. Preferir una dependencia Cargo por ruta y decidir el workspace/lockfile al prototipar.
- `lixbon-core`: tipos y normalización de mensajes/tool calls, parser tolerante, historial, límites, loop de agente y estados de streaming. Mantener interfaces para capacidades del host (workspace, ejecución de procesos y aprobación); no meter la TUI ni APIs de Tauri en el core.
- `apps/desktop/src-tauri`: adaptar comandos Rust existentes para invocar el core. La UI JS conserva presentación y estado visual. Para stream hacia la UI usar Tauri channels, que la documentación reserva para streaming de datos; no mandar cada token como un evento genérico.
- CLI: Ratatui 0.30.2 + Crossterm 0.29 para TUI; Tokio para async/cancelación, reqwest para HTTP/SSE, Serde/serde_json para contratos y RMCP (`modelcontextprotocol/rust-sdk`) para MCP. Fijar versiones después del prototipo y revisar MSRV y licencias.
- Ambas interfaces consumen el mismo `lixbon-core`, pero inyectan políticas/capacidades propias. Especialmente aprobación de shell, paths y comandos; compartir parser no significa igualar permisos distintos.

### Cómo decidir sin migrar a ciegas

Hacer un spike Rust corto que implemente solo contratos y piezas puras del agente compartidas con Tauri, más el chat `--once` y un TUI mínimo. Criterios: mismo corpus Python/JS/Rust, comandos Tauri conservados, stream cancelable, build Windows/Linux/macOS y terminal inline utilizable. Medir arranque, RSS, parser por replay y lectura parcial contra baseline. Si el coste de integrar el core en Tauri supera el ahorro verificable, conservar Go y fijar el contrato con JSON Schema y fixtures multiplataforma.

No combinar Go y Rust dentro de cada llamada del agente. cgo llama C, así que Rust tendría que exponer ABI C estable; cgo además requiere toolchain nativo y configurar compilador para cross-compilation. Si por una etapa fuese imprescindible conservar ambos procesos, preferir una frontera de proceso JSONL solo para una función aislada, no para pasar tokens o cada tool call.

Referencias consultadas (05-10-2026): [Ratatui 0.30.2 e instalación](https://ratatui.rs/installation/), [renderizado de Ratatui](https://ratatui.rs/concepts/rendering/under-the-hood/), [SDK oficial MCP Rust](https://github.com/modelcontextprotocol/rust-sdk), [canales Tauri](https://tauri.app/develop/calling-frontend/), [Bubble Tea](https://github.com/charmbracelet/bubbletea), [SDK oficial MCP Go](https://go.sdk.modelcontextprotocol.io/), [documentación cgo](https://pkg.go.dev/cmd/cgo).
