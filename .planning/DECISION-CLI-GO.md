# Decisión de migración del CLI de Lixbon

Fecha: 2026-10-05. Estado: decisión de planificación acordada en esta conversación.

## Objetivo y alcance

Migrar gradualmente `apps/cli` de Python a Go para distribuir el CLI como binarios por plataforma, sin exigir Python ni pip al usuario final. Mantener Python como referencia funcional hasta comprobar paridad y completar la aceptación de distribución. La migración del backend de inferencia queda fuera de este hito.

## Debate en Orca

Run: `run_d06dd487975f`. Las terminales y worktrees del debate se conservan.

| Participante | Perspectiva | Conclusión del debate |
|---|---|---|
| Usuario | Instalación y distribución | Prefiere Go por empaquetado en binarios y sus ventajas operativas. |
| Claude | Viabilidad de migración y secuencia | Go como camino principal; prueba opcional de Rust limitada a dos días y fuera del camino crítico. |
| OpenCode | Rust/Ratatui y reutilización con desktop | Go ahora; Rust solo cambia la decisión si demuestra reutilización real y cumple los contratos, IPC, cancelación y distribución. |
| Codex, este chat | Acoplamiento, reversibilidad y evidencia | Go satisface el objetivo prioritario; compartir fixtures de protocolo antes que una implementación entre runtimes. No prometer rendimiento sin medir. |

- Claude: `C:\Users\USUARIO\orca\workspaces\Lixbon\cli-debate-go`.
- OpenCode: `C:\Users\USUARIO\orca\workspaces\Lixbon\cli-debate-rust`.
- Las respuestas finales de la segunda ronda se recibieron durante esta conversación. Este documento resume el debate; no representa pruebas de compilación ni benchmarks.

## Decisiones

1. Go es el lenguaje elegido para el nuevo CLI. La elección de biblioteca de terminal queda para una prueba concreta de compatibilidad; Ratatui pertenece a la alternativa Rust y no es una dependencia del camino Go.
2. Congelar contratos observables en fixtures portables: payloads, SSE, limpieza de salida, tool calls, errores y cancelación. Python y desktop conservan su implementación mientras se comprueba la nueva implementación Go.
3. La distribución debe producir artefactos por OS/arquitectura; confirmar la matriz soportada y dependencias nativas antes de prometer binarios autónomos para cada destino.
4. Un experimento Rust es opcional, de uno a dos días, y no bloquea Go. Solo iniciarlo con responsable y fecha concretos para trasladar el agente desktop a Rust.
5. Para reabrir la decisión, Rust debe demostrar paridad con el corpus contractual, streaming ordenado y cancelable por Tauri Channel, convivencia Cargo/Tauri, CI de los destinos acordados y ahorro de mantenimiento medible. No adoptar un porcentaje arbitrario de líneas reutilizadas como criterio.
6. Optimizar crecimiento del streaming, lectura parcial y límites de salida por diseño y medición; cambiar de lenguaje por sí mismo no demuestra una mejora.
7. Conservar compatibilidad de configuración, sesiones, permisos, aprobaciones, snapshots/undo, MCP y conexión remota hasta aceptar el reemplazo.

## Evidencia y puntos que resolver

- Fuente principal: `apps/cli/audit/EVALUACION_PYTHON_GO.md`, conservada sin modificar.
- El ADR existente refleja una recomendación anterior de comparar Rust antes de elegir; esta conversación aporta la decisión posterior de Go. Se conserva el ADR original como historial.
- La evaluación registra 131 pruebas aprobadas y dos fallos de fixture; son resultados del documento, no ejecuciones de esta planificación. Reproducir y clasificar antes de usarlos como línea base.
- El README declara Python estándar sin dependencias externas, mientras `apps/cli/lixbon_cli/cli.py` instala `prompt_toolkit`, `rich` y `pypdf`. Resolver la discrepancia en el inventario y documentación de dependencias.
- No hay benchmark equivalente de Go aportado por el debate; cualquier comparación futura debe usar escenarios y mediciones reproducibles.

## Ejecución posterior

Orca coordina los worktrees y terminales. GSD conserva roadmap, planes, dependencias y criterios de aceptación. Cada tarea futura tendrá un dueño de archivos; implementador, validador y revisor tendrán funciones separadas. Esta entrega produce planificación y no autoriza por sí misma una publicación o sustitución del instalador vigente.
